import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentMessages } from "./AgentMessages.ts"
import { Codex } from "./Codex.ts"
import { Session } from "./Session.ts"
import { Store } from "./Store.ts"
import type { ConversationItem, ModelEvent } from "./Types.ts"

const owned: { model: Codex; directory: string }[] = []
afterEach(async () => {
  for (const { model, directory } of owned.splice(0)) {
    await model.close()
    await rm(directory, { recursive: true, force: true })
  }
})

// A real stdio child exercises framing, request/reply continuation and process
// isolation without using a model or writing to an actual T3 thread.
const fixture = String.raw`
const scenario = process.argv[2];
const log = process.argv[3];
if (process.argv.includes("mcp")) { console.log("[]"); process.exit(0); }
const send = (x) => console.log(JSON.stringify(x));
let threads = 0, turns = 0;
const response = (threadId, turnId, text) => {
  if(scenario==="boundaries") send({method:"item/agentMessage/delta",params:{threadId,turnId,itemId:"commentary",delta:"I’ll read the French thread."}});
  send({method:"item/agentMessage/delta",params:{threadId,turnId,itemId:"a"+turnId,delta:text}});
  send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed"}}});
};
let waiting;
const consume = async (m) => {
  await Bun.write(log, (await Bun.file(log).exists() ? await Bun.file(log).text() : "") + JSON.stringify(m) + "\n");
  if (m.method === "initialize") send({id:m.id,result:{}});
  else if (m.method === "account/read") send({id:m.id,result:{account:{type:scenario==="api"?"apiKey":"chatgpt"}}});
  else if (m.method === "thread/start") send({id:m.id,result:{thread:{id:"thread-"+(++threads)}}});
  else if (m.method === "thread/unsubscribe" || m.method === "turn/interrupt") send({id:m.id,result:{}});
  else if (m.method === "turn/start") {
    const threadId=m.params.threadId, turnId="turn-"+(++turns);
    send({id:m.id,result:{turn:{id:turnId}}});
    if (scenario === "die") process.exit(1);
    if (scenario === "stall") return;
    if (turns===1) {
      waiting={threadId,turnId};
      send({id:"tool-request",method:"item/tool/call",params:{threadId,turnId,callId:"call-1",namespace:null,tool:"lookup",arguments:{project:"yapd"}}});
    } else response(threadId,turnId,"The next request is answered.");
  } else if (m.id === "tool-request" && m.result) {
    response(waiting.threadId,waiting.turnId,"Verified: "+m.result.contentItems[0].text);
  }
};
let buffer=""; const decoder=new TextDecoder();
for await (const bytes of Bun.stdin.stream()) {
  buffer+=decoder.decode(bytes,{stream:true});
  let end;
  while((end=buffer.indexOf("\n"))!==-1) {
    const line=buffer.slice(0,end); buffer=buffer.slice(end+1);
    if(line.trim()) await consume(JSON.parse(line));
  }
}
`

const tools = [{ name: "lookup", description: "Read current project state.", parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false }, mode: "read" as const }]
const user = (turnId: string, text: string): ConversationItem => ({ type: "message", role: "user", turnId, text })

const setup = async (scenario = "normal") => {
  const directory = await mkdtemp(join(tmpdir(), "yapd-codex-v2-test-"))
  const script = join(directory, "server.ts")
  const log = join(directory, "rpc.jsonl")
  await writeFile(script, fixture)
  const model = new Codex({ command: [process.execPath, script, scenario, log], timeoutMs: 3000, generationTimeoutMs: scenario === "stall" ? 40 : 3000, model: "test-model" })
  owned.push({ model, directory })
  const messages = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>)
  return { model, messages }
}

test("subscription app-server consumes real dynamic-tool replies in the same run and keeps the thread warm", async () => {
  const { model, messages } = await setup()
  await model.prepare(tools)
  expect((await messages()).some((m) => m.method === "turn/start")).toBe(false)
  let text = ""
  const calls: ModelEvent[] = []
  const first = user("u1", "What needs me on yapd?")
  for await (const event of model.stream({ items: [first], tools, signal: new AbortController().signal })) {
    if (event.type === "tool_call") {
      calls.push(event)
      expect(event.name).toBe("lookup")
      expect(event.arguments).toEqual({ project: "yapd" })
      await event.respond!({ waiting: "review" })
    }
    if (event.type === "text_delta") text += event.delta
  }
  expect(calls).toHaveLength(1)
  expect(text).toBe('Verified: {"waiting":"review"}')
  for await (const _ of model.stream({ items: [first, user("u2", "Explain that review.")], tools, signal: new AbortController().signal })) { /* drain */ }
  const sent = await messages()
  expect(sent.filter((m) => m.method === "thread/start")).toHaveLength(1)
  const start = sent.find((m) => m.method === "thread/start")!
  expect(start.params.modelProvider).toBe("openai")
  expect(start.params.dynamicTools).toEqual([{ type: "function", name: "lookup", description: tools[0]!.description, inputSchema: tools[0]!.parameters }])
  expect(start.params.baseInstructions).toContain(agentMessages)
  expect(start.params.sandbox).toBe("read-only")
  const turns = sent.filter((m) => m.method === "turn/start")
  expect(turns[1]!.params.input[0].text).toContain("Explain that review.")
  expect(turns[1]!.params.input[0].text).not.toContain("What needs me on yapd?")
  expect(sent.find((m) => m.id === "tool-request" && m.result)?.result).toEqual({ contentItems: [{ type: "inputText", text: '{"waiting":"review"}' }], success: true })
})

test("separately billed API authentication is rejected before any model turn", async () => {
  const { model, messages } = await setup("api")
  await expect(model.prepare()).rejects.toThrow("signed in with ChatGPT")
  expect((await messages()).some((m) => m.method === "thread/start" || m.method === "turn/start")).toBe(false)
})

test("a warm subscription thread receives changed playback and late tool facts under stable context IDs", async () => {
  const { model, messages } = await setup()
  const before: ConversationItem = { type: "context", eventId: "speech:answer", text: "Generated reply; playback unconfirmed." }
  const first = user("u1", "Read the current task.")
  for await (const event of model.stream({ items: [before, first], tools, signal: new AbortController().signal })) {
    if (event.type === "tool_call") await event.respond!({ status: "accepted" })
  }
  const after: ConversationItem = { ...before, text: "Playback interrupted after the first phrase. Later words were not heard." }
  for await (const _ of model.stream({ items: [after, first, user("u2", "Repeat what I missed.")], tools, signal: new AbortController().signal })) { /* drain */ }
  const turns = (await messages()).filter((m) => m.method === "turn/start")
  expect(turns[1]!.params.input[0].text).toContain(after.text)
  expect(turns[1]!.params.input[0].text).not.toContain(before.text)
  expect((await messages()).filter((m) => m.method === "thread/start")).toHaveLength(1)
})

test("a warm subscription receives the empty pending-update status after dismissal", async () => {
  const { model, messages } = await setup()
  const store = new Store()
  const session = new Session({ conversationId: "c", store, model, tools: [{ ...tools[0]!, mode: "read", execute: async () => ({ ok: true }) }] })
  try {
    session.external({ eventId: "pending", text: "A retained result.", notification: { key: "thread", id: "result", version: 1, eligible: true, automatic: false } })
    await session.commit({ text: "First question.", source: "text" }); await session.idle()
    store.dismissNotifications("c", ["result"])
    await session.commit({ text: "A different question.", source: "text" }); await session.idle()
    const turns = (await messages()).filter((m) => m.method === "turn/start")
    const context = turns[1]!.params.input[0].text.split("\n").slice(1).map((line: string) => JSON.parse(line)).find((item: ConversationItem) => item.type === "context" && item.eventId === "notification_updates")
    expect(JSON.parse(context.text).pending).toEqual([])
    expect((await messages()).filter((m) => m.method === "thread/start")).toHaveLength(1)
  } finally { await session.close(); store.close() }
})

test("an interrupted pending tool cannot block a new turn or clear its newer thread", async () => {
  const { model, messages } = await setup()
  const cancel = new AbortController()
  const first = model.stream({ items: [user("u1", "Read the old task.")], tools, signal: cancel.signal })[Symbol.asyncIterator]()
  const call = await first.next()
  expect(call.value?.type).toBe("tool_call")
  cancel.abort()
  let text = ""
  for await (const event of model.stream({ items: [user("u2", "A different question.")], tools, signal: new AbortController().signal })) {
    if (event.type === "text_delta") text += event.delta
  }
  expect(text).toBe("The next request is answered.")
  await first.return?.()
  for await (const _ of model.stream({ items: [user("u2", "A different question."), user("u3", "Continue that.")], tools, signal: new AbortController().signal })) { /* drain */ }
  const sent = await messages()
  expect(sent.filter((m) => m.method === "thread/start")).toHaveLength(2)
  const turns = sent.filter((m) => m.method === "turn/start")
  expect(turns[2]!.params.threadId).toBe(turns[1]!.params.threadId)
  expect(sent.some((m) => m.method === "turn/interrupt" && m.params.threadId === turns[0]!.params.threadId)).toBe(true)
})

test("a lost app-server during inference fails rather than fabricating an answer", async () => {
  const { model } = await setup("die")
  const run = async () => { for await (const _ of model.stream({ items: [user("u1", "Read the task.")], tools, signal: new AbortController().signal })) { /* drain */ } }
  await expect(run()).rejects.toThrow("connection closed")
})

test("an alive app-server that acknowledges a turn then stalls cannot block the conversation indefinitely", async () => {
  const { model, messages } = await setup("stall")
  const run = async () => { for await (const _ of model.stream({ items: [user("u1", "Read the task.")], tools, signal: new AbortController().signal })) { /* drain */ } }
  await expect(run()).rejects.toThrow("exceeded its time limit")
  let interrupted = false
  for (let at = 0; at < 30 && !interrupted; at++) {
    interrupted = (await messages()).some((m) => m.method === "turn/interrupt")
    if (!interrupted) await Bun.sleep(2)
  }
  expect(interrupted).toBe(true)
})

test("commentary and final assistant items retain their spoken word boundary", async () => {
  const { model } = await setup("boundaries")
  let text = ""
  for await (const event of model.stream({ items: [user("u1", "Read that thread.")], tools, signal: new AbortController().signal })) {
    if (event.type === "tool_call") await event.respond!({ passed: 18 })
    if (event.type === "text_delta") text += event.delta
  }
  expect(text).toBe('I’ll read the French thread.\n\nVerified: {"passed":18}')
})
