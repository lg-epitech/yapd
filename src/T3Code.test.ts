import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Schema } from "effect"
import { make as makeRelays, type Thread } from "./Relay.ts"
import * as T3Code from "./T3Code.ts"
import * as Server from "./T3CodeServer.ts"

const thread = (overrides: Partial<T3Code.ShellThread> = {}): T3Code.ShellThread => ({
  id: "thread-1",
  projectId: "project-1",
  worktreePath: null,
  archivedAt: null,
  updatedAt: "2026-09-27T10:00:00.000Z",
  status: "idle",
  activeRunId: null,
  ...overrides,
})

const shell = (threads: ReadonlyArray<T3Code.ShellThread>, archivedThreads: ReadonlyArray<T3Code.ShellThread> = []): T3Code.Shell => ({
  projects: [{ id: "project-1", workspaceRoot: "/repo" }],
  threads,
  archivedThreads,
})

const same = (path: string) => path

const update: Thread = { agent: "codex", session: "provider-1", cwd: "/repo", message: "Fixed the loader.", origin: {} }

type Call = { readonly method: string; readonly payload: unknown }

/** T3 Code as the relay reaches it: what it answers at each path, and what was dispatched. */
const makeRelay = (
  answers: Record<string, unknown>,
  dispatched: Array<Call> = [],
  dispatch: Effect.Effect<unknown, Server.Trouble | Server.Refusal> = Effect.succeed({ sequence: 1 }),
) => {
  const transport: Server.Transport = {
    api: (path, schema) =>
      path in answers ? Effect.orDie(Schema.decodeUnknown(schema)(answers[path])) : Effect.die(`Unexpected request: ${path}`),
    call: (method, payload, schema) => {
      dispatched.push({ method, payload })
      return Effect.flatMap(dispatch, (value) => Effect.orDie(Schema.decodeUnknown(schema)(value)))
    },
    asset: () => Effect.die("not expected"),
  }
  return Effect.runPromise(T3Code.make(() => Effect.succeed(transport)).pipe(
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_T3CODE_TOKEN", "test-token"]]))),
  ))
}

describe("T3Code", () => {
  test("finds threads by worktree, or by project when there's none", () => {
    const worktree = thread({ id: "worktree", worktreePath: "/worktrees/a" })
    const local = thread({ id: "local" })
    const threads = shell([worktree, local])
    expect(T3Code.inDirectory(threads, "/worktrees/a", same).map(({ id }) => id)).toEqual(["worktree"])
    expect(T3Code.inDirectory(threads, "/repo", same).map(({ id }) => id)).toEqual(["local"])
  })

  test("matches the message yapd read, even when T3 Code split it", () => {
    const messages = [
      { role: "user", text: "Fix it" },
      { role: "assistant", text: "Looking into it." },
      { role: "assistant", text: "Fixed the loader.\n\nCI  is green." },
    ]
    expect(T3Code.endsWith(messages, "Fixed the loader. CI is green.")).toBe(true)
    expect(T3Code.endsWith(messages, "Looking into it. Fixed the loader. CI is green.")).toBe(true)
    expect(T3Code.endsWith(messages, "Something else entirely.")).toBe(false)
    expect(T3Code.endsWith([{ role: "user", text: "Fix it" }], "Fix it")).toBe(false)
  })

  test("doesn't take a thread that merely ends the same way", () => {
    const messages = [{ role: "assistant", text: "All tests pass." }]
    expect(T3Code.endsWith(messages, "Fixed the parser. All tests pass.")).toBe(false)
  })

  test("counts a run under way as busy, even when the status lags behind it", () => {
    expect(T3Code.busy(thread())).toBe(false)
    expect(T3Code.busy(thread({ status: "running" }))).toBe(true)
    expect(T3Code.busy(thread({ status: "idle", activeRunId: "run-1" }))).toBe(true)
  })
})

describe("T3Code follow-ups", () => {
  const original = { role: "user", text: "Fix the loader" }
  const clarification = { role: "user", text: "Include the streaming case" }
  const reply = { role: "assistant", text: update.message }
  const messages = (...messages: ReadonlyArray<{ role: string; text: string }>) => ({ projection: { messages } })

  test("doesn't try another relay after an uncertain T3 dispatch", async () => {
    let fallbacks = 0
    const dispatched: Array<Call> = []
    const relay = await makeRelay(
      { "/api/orchestration/shell": shell([thread()]), "/api/orchestration/threads/thread-1/bounded": messages(original, reply) },
      dispatched,
      Effect.fail(new Server.Trouble({ reason: "T3 Code hung up on me." })),
    )
    const relays = makeRelays([relay, { send: () => Effect.sync(() => { fallbacks++ }) }])
    expect(await Effect.runPromise(Effect.flip(relays.send(update, "Merge it."))))
      .toMatchObject({ _tag: "RelayError" })
    expect([dispatched.length, fallbacks]).toEqual([1, 0])
  })

  test("sends to the thread whose latest reply it was, over the app's socket", async () => {
    const dispatched: Array<Call> = []
    const relay = await makeRelay(
      { "/api/orchestration/shell": shell([thread()]), "/api/orchestration/threads/thread-1/bounded": messages(original, reply) },
      dispatched,
    )
    await Effect.runPromise(relay.send(update, "Please commit it."))
    expect(dispatched).toEqual([{
      method: "orchestration.dispatchCommand",
      payload: expect.objectContaining({ type: "message.dispatch", threadId: "thread-1", text: "Please commit it." }),
    }])
  })

  test("doesn't send to an older reply when the user has moved on", async () => {
    const dispatched: Array<Call> = []
    const relay = await makeRelay(
      { "/api/orchestration/shell": shell([thread()]), "/api/orchestration/threads/thread-1/bounded": messages(original, reply, clarification) },
      dispatched,
    )
    expect(await Effect.runPromise(Effect.flip(relay.send(update, "Please commit it.")))).toMatchObject({ _tag: "Unreachable" })
    expect(dispatched).toEqual([])
  })
})
