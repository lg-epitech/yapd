import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as T3Actions from "./T3Actions.ts"
import * as Server from "./T3CodeServer.ts"

const approval = {
  type: "approval_request",
  status: "waiting",
  requestId: "r1",
  requestKind: "command",
  prompt: "Run git push origin main",
  options: [
    { decision: "accept", label: "Yes" },
    { decision: "decline", label: "No" },
  ],
}

const question = {
  type: "user_input_request",
  status: "waiting",
  requestId: "r2",
  questions: [{ id: "Which database?", header: "Storage", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }],
}

/**
 * A T3 Code that answers from what it's given, the thread's last turns as
 * `bounded`, and the whole of it as `whole`, or too slow to; and keeps what it
 * was sent, and where it was read.
 */
const transport = (bounded: object, whole: object | "fails" = bounded) => {
  const sent: Array<{ method: string; payload: Record<string, unknown> }> = []
  const read: Array<string> = []
  const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
    api: (<A, I>(path: string, schema: Schema.Schema<A, I>) =>
      Effect.suspend(() => {
        read.push(path)
        const answer = path.endsWith("/bounded") ? bounded : whole
        return answer === "fails" ? Effect.fail(new Server.Trouble({ reason: "T3 Code isn't answering." })) : Schema.decodeUnknown(schema)(answer).pipe(Effect.orDie)
      })) as Server.Transport["api"],
    call: (<A, I>(method: string, payload: unknown, schema: Schema.Schema<A, I>) =>
      Effect.sync(() => sent.push({ method, payload: payload as Record<string, unknown> })).pipe(
        Effect.zipRight(Schema.decodeUnknown(schema)({ sequence: 1 }).pipe(Effect.orDie)),
      )) as Server.Transport["call"],
    asset: () => Effect.die("not expected"),
  })
  return { actions: T3Actions.make(reach), sent, read }
}

const projection = (overrides: object = {}) => ({
  projection: {
    runs: [
      { id: "run-1", status: "completed", ordinal: 1 },
      { id: "run-2", status: "running", ordinal: 2 },
    ],
    messages: [
      { role: "user", text: "Fix it.", createdAt: "a" },
      { role: "system", text: "noise", createdAt: "b" },
      { role: "assistant", text: "Pushing now.", createdAt: "c" },
    ],
    turnItems: [approval, { type: "assistant_message", text: "x" }],
    ...overrides,
  },
})

describe("T3Actions", () => {
  test("reads what a thread waits on, in words that can be said", () => {
    expect(T3Actions.request([approval], "r1")).toEqual(
      Option.some({ _tag: "Approval", id: "r1", what: "Run git push origin main", kind: "command", decisions: approval.options }),
    )
    // What it would run comes from the command it shares the agent's id with.
    const command = { type: "command_execution", status: "pending", nativeItemRef: { nativeId: "toolu_1" }, input: "git push --force origin main" }
    const pushing = T3Actions.request([command, { ...approval, prompt: "Push the branch", nativeItemRef: { nativeId: "toolu_1" } }], "r1")
    expect(Option.map(pushing, (found) => (found._tag === "Approval" ? [found.what, found.command] : []))).toEqual(
      Option.some(["Push the branch", "git push --force origin main"]),
    )
    // Cut short to be said, a long one is still kept whole, to tell by all of it whether it's risky; one the thread doesn't show has neither.
    const long = `echo '${"a".repeat(650)}'; rm -rf /tmp/example-data`
    const cleaning = T3Actions.request([{ ...command, input: long }, { ...approval, nativeItemRef: { nativeId: "toolu_1" } }], "r1")
    expect(Option.map(cleaning, (found) => (found._tag === "Approval" ? [found.command?.length, found.whole] : []))).toEqual(Option.some([600, long]))
    // One too long to look through, like a tool given a whole file, is said as it starts, and taken for unread.
    const huge = T3Actions.request([{ ...command, input: `echo '${"a".repeat(30_000)}'` }, { ...approval, nativeItemRef: { nativeId: "toolu_1" } }], "r1")
    expect(Option.map(huge, (found) => (found._tag === "Approval" ? [found.command?.length, found.whole] : []))).toEqual(Option.some([600, undefined]))
    // A tool's input is looked through as the tool gets it, each line on its own, and is unread when T3 Code sent only how it starts.
    const tool = (input: unknown) =>
      Option.map(
        T3Actions.request([{ type: "dynamic_tool", status: "running", toolName: "Monitor", input, nativeItemRef: { nativeId: "toolu_1" } }, { ...approval, nativeItemRef: { nativeId: "toolu_1" } }], "r1"),
        (found) => (found._tag === "Approval" ? [found.command, found.whole] : []),
      )
    expect(tool({ command: "cd build\nrm -rf ~/work", timeout: 30 })).toEqual(
      Option.some(['Monitor {"command":"cd build\\nrm -rf ~/work","timeout":30}', "Monitor\ncommand\ncd build\nrm -rf ~/work\ntimeout\n30"]),
    )
    // A secret goes by its own item's id, which is what the thread says it waits on.
    const secret = { type: "secret_request", id: "turn-item:secret-request:t1:deploy", status: "waiting", label: "Deploy key", reason: "To deploy", secretStatus: "pending" }
    expect(T3Actions.request([secret], "turn-item:secret-request:t1:deploy")).toEqual(
      Option.some({ _tag: "Secret", id: "turn-item:secret-request:t1:deploy", label: "Deploy key" }),
    )
    // A question that asks him to type in a secret, as Codex marks one and T3 Code passes on as any other, is a secret too.
    const typed = (header: string, asked: string) =>
      Option.map(T3Actions.request([{ ...question, questions: [{ id: "k", header, question: asked, options: [] }] }], "r2"), (found) => (found._tag === "Secret" ? found.label : found._tag))
    expect(typed("Question", "Paste your OpenAI API key.")).toEqual(Option.some("API key"))
    // However it's written: as code names it.
    expect(typed("Question", "Please provide OPENAI_API_KEY so I can run the evals.")).toEqual(Option.some("OPENAI_API_KEY"))
    // A token or a key he's asked to pick, like a coin, is a question.
    expect(typed("Question", "Which token should the indexer track first?")).toEqual(Option.some("Question"))
  })

  test("takes what he'd send for a secret when it looks like one, however the question it answers was worded", () => {
    for (const said of ["Four two seven one nine three.", "sk-proj-abc123"]) {
      expect([said, T3Actions.revealing(said)]).toEqual([said, true])
    }
    // A port or a PR number isn't.
    for (const said of ["Use port 8080.", "PR 4271 please"]) {
      expect([said, T3Actions.revealing(said)]).toEqual([said, false])
    }
  })

  test("gives back a thread's last messages, its plan and what it waits on", async () => {
    const { actions } = transport(projection())
    const detail = await Effect.runPromise(actions.detail("t1"))
    expect(detail.messages.map(({ text }) => text)).toEqual(["Fix it.", "Pushing now."])
    expect(Option.map(detail.request, ({ id }) => id)).toEqual(Option.some("r1"))
    expect(detail.pending).toEqual(["r1"])
    // What it still waits on, by T3 Code's own record of each when it keeps one, even one hidden behind a newer one.
    const both = transport(projection({ runtimeRequests: [{ id: "r0", status: "pending" }, { id: "r1", status: "resolved" }, { id: "r2", status: "pending" }] }))
    expect((await Effect.runPromise(both.actions.detail("t1"))).pending).toEqual(["r0", "r2"])
    const settled = transport(projection({ turnItems: [{ ...approval, status: "completed" }] }))
    expect((await Effect.runPromise(settled.actions.detail("t1"))).request).toEqual(Option.none())
  })

  test("stops the run under way, and holds what's queued behind it", async () => {
    const { actions, sent } = transport(projection())
    await Effect.runPromise(actions.run("t1", { _tag: "Stop" }, "yapd:stop"))
    expect(sent).toMatchObject([{ payload: { type: "run.interrupt", runId: "run-2", holdQueue: true } }])
    const idle = transport(projection({ runs: [{ id: "run-1", status: "completed", ordinal: 1 }] }))
    expect(await Effect.runPromise(Effect.flip(idle.actions.run("t1", { _tag: "Stop" }, "yapd:stop")))).toMatchObject({ _tag: "Refusal" })
    expect(idle.sent).toEqual([])
  })

  test("finds a message it sent by its id, how it went in, the run it waits in, held or not, and the run whose turn it went into", async () => {
    const queued = projection({
      runs: [
        { id: "run-2", status: "running", ordinal: 2, userMessageId: "m-2" },
        { id: "run-3", status: "queued", ordinal: 3, userMessageId: "m-3" },
        // Taken out of the queue into the turn under way, which cancels the run it waited in.
        { id: "run-6", status: "cancelled", ordinal: 6, userMessageId: "m-6" },
      ],
      messages: [{ id: "m-2", role: "user", text: "Fix it.", createdAt: "a" }],
      turnItems: [
        { type: "user_message", messageId: "m-6", inputIntent: "promoted_queued_to_steer", status: "completed", runId: "run-2" },
      ],
    })
    const { actions } = transport(queued)
    const found = (messageId: string) =>
      Effect.runPromise(
        Effect.map(
          actions.message("t1", messageId),
          Option.map(({ intent, run, into }) => ({ intent: Option.getOrNull(intent), run: Option.getOrNull(run), into: Option.getOrNull(into) })),
        ),
      )
    expect(await found("m-3")).toEqual(Option.some({ intent: "queued_turn", run: { id: "run-3", status: "queued", held: false }, into: null }))
    // Steered in from the queue, it's in the turn T3 Code names on it, never the run it waited in.
    expect(await found("m-6")).toEqual(
      Option.some({ intent: "promoted_queued_to_steer", run: { id: "run-6", status: "cancelled", held: false }, into: { id: "run-2", status: "running" } }),
    )
    // A run it started that has no turn item yet, as right after it went in: a turn of its own.
    expect(await found("m-2")).toEqual(Option.some({ intent: "turn_start", run: { id: "run-2", status: "running", held: false }, into: null }))
  })

  test("traces a message the thread's last turns show only by the run it waited in, cancelled, through the whole thread, read once, and only then", async () => {
    const whole = projection({
      runs: [
        { id: "run-1", status: "completed", ordinal: 1, userMessageId: "m-1" },
        { id: "run-2", status: "cancelled", ordinal: 2, userMessageId: "m-2" },
        { id: "run-4", status: "completed", ordinal: 4, userMessageId: "m-4" },
      ],
      messages: [
        // Moved from the queue into the turn under way, it's that turn's.
        { id: "m-2", role: "user", text: "Open a PR.", createdAt: "2026-10-08T22:01:00.000Z", runId: "run-1" },
      ],
      turnItems: [{ type: "user_message", messageId: "m-2", inputIntent: "promoted_queued_to_steer", runId: "run-1" }],
    })
    // Enough turns since have pushed every message and turn item out of the bounded read, which keeps every run.
    const bounded = projection({ runs: whole.projection.runs, messages: [], turnItems: [] })
    const traced = async (messageId: string) => {
      const reads = transport(bounded, whole)
      const found = await Effect.runPromise(
        Effect.map(
          reads.actions.traced("t1", messageId),
          Option.map(({ intent, run, into }) => ({ intent: Option.getOrNull(intent), run: Option.getOrNull(run)?.status, into: Option.getOrNull(into)?.id })),
        ),
      )
      return { found, read: reads.read.map((path) => path.replace("/api/orchestration/threads/t1", "") || "whole") }
    }
    expect(await traced("m-2")).toEqual({ found: Option.some({ intent: "promoted_queued_to_steer", run: "cancelled", into: "run-1" }), read: ["/bounded", "whole"] })
    // Its run not cancelled, it says what came of it, so the bounded read is enough.
    expect(await traced("m-4")).toEqual({ found: Option.some({ intent: "turn_start", run: "completed", into: undefined }), read: ["/bounded"] })
    // The whole thread too slow to read, it's taken as neither.
    expect(await Effect.runPromise(Effect.flip(transport(bounded, "fails").actions.traced("t1", "m-2")))).toMatchObject({ _tag: "Trouble" })
  })
})
