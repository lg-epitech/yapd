import { expect, test } from "bun:test"
import { evaluateScenario, type ScenarioReport, type TurnReport } from "./v2-eval.ts"
import type { Model } from "../src/v2/Types.ts"

test("listing the subscription scenarios needs no Codex executable and performs no inference", async () => {
  const process_ = Bun.spawn([process.execPath, `${import.meta.dir}/v2-eval.ts`, "--list"], { env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" })
  const output = JSON.parse(await new Response(process_.stdout).text()) as { type: string; scenarios: Array<{ id: string }> }
  expect(await process_.exited).toBe(0)
  expect(output.type).toBe("available")
  expect(output.scenarios).toHaveLength(8)
})

test("evaluation matches V2's workspace identities without leaking task answers, and can exercise empty-context discovery", async () => {
  for (const workspace of ["snapshot", "empty"] as const) {
    let inputs = 0
    const result = await evaluateScenario("ambiguous-target", { stream: async function* ({ items }) {
      inputs++
      const snapshot = items.find((item) => item.type === "context" && item.eventId === "workspace:fixture")
      if (workspace === "empty") expect(snapshot).toBeUndefined()
      else {
        expect(snapshot?.type).toBe("context")
        if (snapshot?.type !== "context") throw new Error("Missing workspace context")
        const current = JSON.parse(snapshot.text)
        expect(current.kind).toBe("current_workspace")
        expect(current.threads.map((thread: { threadId: string }) => thread.threadId)).toEqual(["asr-fr", "asr-en", "yapd-ui"])
        expect(current.threads.every((thread: object) => Object.keys(thread).sort().join(",") === "machine,project,state,threadId,title")).toBe(true)
        expect(snapshot.text).not.toMatch(/18|passed|accessibility|snapshots|approve/)
      }
      yield { type: "text_delta", delta: "Which thread: French or English?" }
      yield { type: "done" }
    } }, () => {}, 1500, workspace === "empty" ? { workspace } : undefined)
    expect(result.pass).toBe(true)
    expect(inputs).toBe(1)
  }
})

const run = async (scenario: string, model: Model) => {
  const records: Array<TurnReport | ScenarioReport> = []
  const result = await evaluateScenario(scenario, model, (record) => { records.push(record) }, 1500)
  return { result, turns: records.filter((record): record is TurnReport => record.type === "turn") }
}

test("a fluent confirmation fails when the persisted fixture dispatch names the wrong thread", async () => {
  let turn = 0
  const result = await run("contextual-target", { stream: async function* () {
    if (turn++ === 0) {
      yield { type: "tool_call", callId: "read", name: "read_thread", arguments: { machine: "fixture", threadId: "asr-fr" }, respond: async () => {} }
      yield { type: "text_delta", delta: "All 18 French tests passed." }
    } else {
      yield { type: "tool_call", callId: "send", name: "send_message", arguments: { machine: "fixture", threadId: "asr-en", text: "Inspect endpointing only, with no code changes." }, respond: async () => {} }
      yield { type: "text_delta", delta: "Sent the endpointing request." }
    }
    yield { type: "done" }
  } })
  expect(result.turns[0]?.pass).toBe(true)
  expect(result.result.pass).toBe(false)
  expect(result.turns[1]?.checks.find(({ name }) => name === "one accepted dispatch to the intended target")?.pass).toBe(false)
  expect(result.turns[1]?.calls[0]).toMatchObject({ state: "completed", arguments: { threadId: "asr-en" }, result: { status: "accepted", threadId: "asr-en", receiptPersisted: true } })
  expect(result.turns[1]?.taskDoneMs).toBeNull()
})

test("accepted follow-up receipts cannot hide lost French-only, snapshot and merge constraints", async () => {
  let turn = 0
  const result = await run("constraints", { stream: async function* () {
    yield { type: "tool_call", callId: "send", name: "send_message", arguments: { machine: "fixture", threadId: "asr-fr", text: turn++ === 0 ? "Run only French tests, no snapshots and no merging." : "Run French and English tests, update snapshots and merge." }, respond: async () => {} }
    yield { type: "text_delta", delta: "Sent the follow-up." }
    yield { type: "done" }
  } })
  expect(result.turns[0]?.pass).toBe(true)
  expect(result.result.pass).toBe(false)
  expect(result.turns[1]?.executedWrites).toBe(1)
  expect(result.turns[1]?.checks.filter(({ name }) => name.startsWith("sent instruction preserves")).map(({ pass }) => pass)).toEqual([false, false, false])
})

test("a plausible factual answer without observed fixture evidence does not pass", async () => {
  const result = await run("same-utterance-correction", { stream: async function* () {
    yield { type: "text_delta", delta: "All 18 French tests passed." }
    yield { type: "done" }
  } })
  expect(result.result.pass).toBe(false)
  expect(result.turns[0]?.checks.find(({ name }) => name === "answer has observed thread evidence")?.pass).toBe(false)
  expect(result.turns[0]?.calls).toEqual([])
})

test("notification evaluation records refused real Session proposals without executing fixture writes", async () => {
  const denied: Array<unknown> = []
  const result = await run("notification-no-authority", { stream: async function* () {
    yield { type: "tool_call", callId: "send", name: "send_message", arguments: { machine: "fixture", threadId: "asr-fr", text: "Unauthorized follow-up" }, respond: async (receipt: unknown) => { denied.push(receipt) } }
    yield { type: "tool_call", callId: "approve", name: "respond_to_approval", arguments: { machine: "fixture", threadId: "asr-fr", requestId: "external-approval", decision: "accept" }, respond: async (receipt: unknown) => { denied.push(receipt) } }
    yield { type: "text_delta", delta: "All 18 French tests passed." }
    yield { type: "done" }
  } })
  expect(result.result.pass).toBe(true)
  expect(result.turns[0]).toMatchObject({ source: "event", executedWrites: 0 })
  expect(result.turns[0]?.calls.map(({ state }) => state)).toEqual(["rejected", "rejected"])
  expect(denied).toMatchObject([{ status: "rejected" }, { status: "rejected" }])
})

test("the interruption scenario waits for a real persisted proposal, then verifies its refusal and corrected answer", async () => {
  const result = await run("interrupted-write", { stream: async function* (request) {
    const latest = request.items.findLast((item) => item.type === "message" && item.role === "user")
    if (latest?.type === "message" && latest.text.startsWith("Actually")) {
      yield { type: "tool_call", callId: "read", name: "read_thread", arguments: { machine: "fixture", threadId: "asr-fr" }, respond: async () => {} }
      yield { type: "text_delta", delta: "All 18 French tests passed." }
    } else yield { type: "tool_call", callId: "old-send", name: "send_message", arguments: { machine: "fixture", threadId: "asr-fr", text: "Rerun the tests now." }, respond: async () => {} }
    yield { type: "done" }
  } })
  expect(result.result.pass).toBe(true)
  expect(result.turns.map(({ executedWrites }) => executedWrites)).toEqual([0, 0])
  expect(result.turns[0]?.calls[0]).toMatchObject({ name: "send_message", state: "rejected", result: { status: "rejected" } })
  expect(result.turns[0]?.modelDoneMs).toBeNull()
  expect(result.turns[0]?.taskOutcome).toBe("interrupted")
  expect(result.turns[1]?.finalText).toContain("18")
})
