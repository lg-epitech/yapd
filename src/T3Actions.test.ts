import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as T3Actions from "./T3Actions.ts"
import type * as Server from "./T3CodeServer.ts"

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

/** A T3 Code that answers from what it's given, and keeps what it was sent. */
const transport = (bounded: object) => {
  const sent: Array<{ method: string; payload: Record<string, unknown> }> = []
  const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
    api: (<A, I>(_: string, schema: Schema.Schema<A, I>) => Schema.decodeUnknown(schema)(bounded).pipe(Effect.orDie)) as Server.Transport["api"],
    call: (<A, I>(method: string, payload: unknown, schema: Schema.Schema<A, I>) =>
      Effect.sync(() => sent.push({ method, payload: payload as Record<string, unknown> })).pipe(
        Effect.zipRight(Schema.decodeUnknown(schema)({ sequence: 1 }).pipe(Effect.orDie)),
      )) as Server.Transport["call"],
  })
  return { actions: T3Actions.make(reach), sent }
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
    plans: [{ kind: "todo_list", status: "active", steps: [{ text: "Push", status: "running" }] }],
    ...overrides,
  },
})

describe("T3Actions", () => {
  test("reads what a thread waits on, in words that can be said", () => {
    expect(T3Actions.request([approval], "r1")).toEqual(
      Option.some({ _tag: "Approval", id: "r1", what: "Run git push origin main", kind: "command", decisions: approval.options }),
    )
    expect(Option.map(T3Actions.request([question], "r2"), (found) => found._tag)).toEqual(Option.some("Question"))
    expect(T3Actions.request([approval], "other")).toEqual(Option.none())
    // An option whose answer isn't its label answers with its value.
    const form = T3Actions.request(
      [{ ...question, questions: [{ id: "env", question: "Which environment?", options: [{ label: "Production", value: "prod" }, { label: "Staging" }] }] }],
      "r2",
    )
    const options = Option.match(form, { onNone: () => [], onSome: (found) => (found._tag === "Question" ? found.questions[0]!.options : []) })
    expect(options.map(T3Actions.choice)).toEqual(["prod", "Staging"])
    // An approval that names no decisions takes the usual ones.
    const bare = T3Actions.request([{ ...approval, options: undefined }], "r1")
    expect(Option.map(bare, (found) => (found._tag === "Approval" ? found.decisions.map(({ decision }) => decision) : []))).toEqual(
      Option.some(["accept", "acceptForSession", "decline"]),
    )
  })

  test("gives back a thread's last messages, its plan and what it waits on", async () => {
    const { actions } = transport(projection())
    const detail = await Effect.runPromise(actions.detail("t1"))
    expect(detail.messages.map(({ text }) => text)).toEqual(["Fix it.", "Pushing now."])
    expect(Option.map(detail.request, ({ id }) => id)).toEqual(Option.some("r1"))
    expect(detail.plan).toEqual(Option.some("- [running] Push"))
    const settled = transport(projection({ turnItems: [{ ...approval, status: "completed" }] }))
    expect((await Effect.runPromise(settled.actions.detail("t1"))).request).toEqual(Option.none())
  })

  test("stops the run under way, and holds what's queued behind it", async () => {
    const { actions, sent } = transport(projection())
    await Effect.runPromise(actions.run("t1", { _tag: "Stop" }, "yapd:stop"))
    expect(sent).toEqual([
      {
        method: "orchestration.dispatchCommand",
        payload: { commandId: "yapd:stop", threadId: "t1", type: "run.interrupt", runId: "run-2", holdQueue: true },
      },
    ])
    const idle = transport(projection({ runs: [{ id: "run-1", status: "completed", ordinal: 1 }] }))
    expect(await Effect.runPromise(Effect.flip(idle.actions.run("t1", { _tag: "Stop" }, "yapd:stop")))).toMatchObject({ _tag: "Refusal" })
    expect(idle.sent).toEqual([])
  })

  test("finds a message it sent by its id, how it went in, and the run it waits in, held or not", async () => {
    const queued = projection({
      runs: [
        { id: "run-2", status: "running", ordinal: 2, userMessageId: "m-2" },
        { id: "run-3", status: "queued", ordinal: 3, userMessageId: "m-3" },
        { id: "run-5", status: "queued", ordinal: 5, userMessageId: "m-5", queueHeld: true },
      ],
      messages: [{ id: "m-2", role: "user", text: "Fix it.", createdAt: "a" }],
      turnItems: [{ type: "user_message", messageId: "m-4", inputIntent: "steer", status: "completed" }],
    })
    const { actions } = transport(queued)
    const found = (messageId: string) =>
      Effect.runPromise(Effect.map(actions.message("t1", messageId), Option.map(({ intent, run }) => ({ intent: Option.getOrNull(intent), run: Option.getOrNull(run) }))))
    expect(await found("m-3")).toEqual(Option.some({ intent: "queued_turn", run: { id: "run-3", status: "queued", held: false } }))
    // In a queue a stop put on hold.
    expect(await found("m-5")).toEqual(Option.some({ intent: "queued_turn", run: { id: "run-5", status: "queued", held: true } }))
    expect(await found("m-4")).toEqual(Option.some({ intent: "steer", run: null }))
    // A run it started that has no turn item yet, as right after it went in: a turn of its own.
    expect(await found("m-2")).toEqual(Option.some({ intent: "turn_start", run: { id: "run-2", status: "running", held: false } }))
    expect(await Effect.runPromise(actions.has("t1", "m-9"))).toBe(false)
  })

  test("sends what the app sends", () => {
    const send = (how: T3Actions.When) => T3Actions.command("t1", { _tag: "Send", text: "Merge it.", messageId: "m", how }, undefined, "c")
    expect(send("now")).toEqual({
      commandId: "c",
      threadId: "t1",
      type: "message.dispatch",
      messageId: "m",
      text: "Merge it.",
      createdBy: "user",
      creationSource: "web",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
    })
    // After the turn under way, it goes in T3 Code's own queue, as the app's queue button sends it.
    expect(send("after")).toMatchObject({ dispatchMode: { type: "queue_after_active" } })
    expect(send("after")).not.toHaveProperty("deliveryIntent")
    // In place of the turn under way, it goes once yapd has stopped it, never as T3 Code's own restart, which it turns down in too many ordinary states.
    expect(send("restart")).toMatchObject({ dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" })
    expect(T3Actions.command("t1", { _tag: "Resume" }, undefined, "c")).toEqual({ commandId: "c", threadId: "t1", type: "queue.resume" })
    expect(T3Actions.command("t1", { _tag: "Cancel", runId: "run-3" }, undefined, "c")).toEqual({ commandId: "c", threadId: "t1", type: "queued-run.cancel", runId: "run-3" })
    expect(T3Actions.command("t1", { _tag: "Decide", requestId: "r1", decision: "accept" }, undefined, "c")).toEqual({
      commandId: "c",
      threadId: "t1",
      type: "runtime-request.respond",
      requestId: "r1",
      decision: "accept",
    })
    expect(T3Actions.command("t1", { _tag: "Answer", requestId: "r2", answers: { "Which database?": "SQLite" } }, undefined, "c")).toMatchObject({
      answers: { "Which database?": "SQLite" },
    })
    expect(T3Actions.command("t1", { _tag: "Rename", title: "Loader fix" }, undefined, "c")).toMatchObject({ type: "thread.metadata.update", title: "Loader fix" })
  })
})
