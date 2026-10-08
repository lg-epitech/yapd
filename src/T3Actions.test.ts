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
    expect(await Effect.runPromise(Effect.flip(idle.actions.run("t1", { _tag: "Stop" })))).toMatchObject({ _tag: "Refusal" })
    expect(idle.sent).toEqual([])
  })

  test("sends what the app sends", () => {
    expect(T3Actions.command("t1", { _tag: "Send", text: "Merge it.", steer: true }, undefined, "c")).toMatchObject({
      type: "message.dispatch",
      text: "Merge it.",
      createdBy: "user",
      creationSource: "web",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
    })
    expect(T3Actions.command("t1", { _tag: "Send", text: "Later.", steer: false }, undefined, "c")).not.toHaveProperty("deliveryIntent")
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
