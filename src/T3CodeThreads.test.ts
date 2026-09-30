import { describe, expect, test } from "bun:test"
import { Effect, Option, Redacted, Schema } from "effect"
import * as Server from "./T3CodeServer.ts"
import * as T3CodeThreads from "./T3CodeThreads.ts"
import type { ThreadsError } from "./Threads.ts"

/** A thread as T3 Code 0.0.44 lists it, trimmed to what matters, with fields of every kind left out. */
const shell = {
  snapshotSequence: 162193,
  projects: [{ id: "project-1", title: "yapd", workspaceRoot: "/code/yapd", autoPull: false }],
  threads: [
    {
      id: "done",
      projectId: "project-1",
      title: "Fix the loader",
      branch: "t3code/0a1b2c3d",
      worktreePath: "/worktrees/yapd/t3code-0a1b2c3d",
      archivedAt: null,
      updatedAt: "2026-09-29T10:00:00.000Z",
      runtimeMode: "full-access",
      interactionMode: "default",
      latestTurn: { turnId: "t1", state: "completed", requestedAt: "2026-09-29T09:00:00.000Z", completedAt: "2026-09-29T09:05:00.000Z" },
      session: { threadId: "done", status: "stopped", lastError: null, activeTurnId: null },
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
    {
      id: "running",
      projectId: "project-1",
      title: "Investigate latency",
      branch: null,
      worktreePath: null,
      updatedAt: "2026-09-29T12:00:00.000Z",
      runtimeMode: "full-access",
      latestTurn: { state: "running", requestedAt: "2026-09-29T11:59:00.000Z", completedAt: null },
      session: { status: "running", lastError: null },
    },
    // Still running, but stopped on an approval: T3 Code raises it before the turn ends, and waiting comes first.
    {
      id: "approving",
      projectId: "project-1",
      title: "Rename the store",
      updatedAt: "2026-09-29T11:30:00.000Z",
      latestTurn: { state: "running", requestedAt: "2026-09-29T11:29:00.000Z", completedAt: null },
      session: { status: "running", lastError: null },
      hasPendingApprovals: true,
    },
    // No latest turn, no session, and most fields missing.
    { id: "new", projectId: "project-1", title: "Untitled", updatedAt: "2026-09-29T11:00:00.000Z" },
    {
      id: "waiting",
      projectId: "project-1",
      title: "Retry fix",
      updatedAt: "2026-09-29T08:00:00.000Z",
      latestTurn: { state: "completed" },
      session: { status: "ready" },
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
    },
    { id: "planned", projectId: "project-1", title: "Plan the migration", updatedAt: "2026-09-29T07:30:00.000Z", latestTurn: { state: "completed" }, session: { status: "ready" }, hasActionableProposedPlan: true },
    {
      id: "failed",
      projectId: "project-2",
      title: "Orphan",
      updatedAt: "2026-09-29T07:00:00.000Z",
      latestTurn: { state: "error" },
      session: { status: "error", lastError: "Provider went away." },
    },
    { id: "stopped", projectId: "project-1", title: "Stopped", updatedAt: "2026-09-29T06:00:00.000Z", latestTurn: { state: "interrupted" } },
    { id: "archived", projectId: "project-1", title: "Old", updatedAt: "2026-09-30T00:00:00.000Z", archivedAt: "2026-09-29T00:00:00.000Z" },
  ],
}

/** T3 Code as the threads reach it, answering GETs by path and keeping what's POSTed. */
const reached = (dispatched: Array<unknown> = [], answers: Record<string, unknown> = {}) => {
  const transport: T3CodeThreads.Transport = {
    api: (path, schema, init) => {
      if (init?.method === "POST") {
        dispatched.push(JSON.parse(String(init.body)))
        return Effect.orDie(Schema.decodeUnknown(schema)({ sequence: 1 }))
      }
      const answer = answers[path] ?? (path === "/api/orchestration/shell" ? shell : undefined)
      return answer === undefined
        ? Effect.fail(new Server.Trouble({ reason: "T3 Code wouldn't take it.", cause: `404 from ${path}` }))
        : Effect.orDie(Schema.decodeUnknown(schema)(answer))
    },
  }
  return T3CodeThreads.threads(Option.some(Redacted.make("token")), () => Effect.succeed(transport))
}

const failure = <A>(effect: Effect.Effect<A, ThreadsError>) => Effect.runPromise(Effect.flip(effect))

const outgoing = { commandId: "yapd:command-1", messageId: "message-1", text: "/compact keep the public API unchanged" }

describe("T3CodeThreads", () => {
  test("lists what's still around, newest first, with where each thread stands", async () => {
    const listed = await Effect.runPromise(reached().list)
    expect(listed.map(({ id, state }) => [id, state])).toEqual([
      ["running", "running"],
      ["approving", "waiting"],
      ["new", "new"],
      ["done", "done"],
      ["waiting", "waiting"],
      ["planned", "waiting"],
      ["failed", "failed"],
      ["stopped", "stopped"],
    ])
    expect(listed[3]).toEqual({
      id: "done",
      project: "yapd",
      directory: "/worktrees/yapd/t3code-0a1b2c3d",
      title: "Fix the loader",
      branch: "t3code/0a1b2c3d",
      state: "done",
      needs: [],
      requestedAt: "2026-09-29T09:00:00.000Z",
      completedAt: "2026-09-29T09:05:00.000Z",
      updatedAt: "2026-09-29T10:00:00.000Z",
      error: null,
    })
    expect(listed[0]).toMatchObject({ directory: "/code/yapd", needs: [] })
    expect(listed[1]?.needs).toEqual(["approval"])
    expect(listed[4]?.needs).toEqual(["input", "plan"])
    expect(listed[6]).toMatchObject({ project: "", directory: "", error: "Provider went away." })
  })

  test("has no threads without a token, whatever else is there", async () => {
    const threads = T3CodeThreads.threads(Option.none(), () => Effect.die("not reached"))
    expect((await failure(threads.list)).reason).toBe(T3CodeThreads.tokenless)
    // Nothing was sent, and nothing will be until a token is set up.
    expect(await failure(threads.send("done", outgoing))).toMatchObject({ reason: T3CodeThreads.tokenless, gone: true })
  })

  test("reads a thread's latest turns as what was said, and the whole of it for its opening", async () => {
    const detail = {
      thread: {
        ...shell.threads[0],
        messages: [
          { id: "m1", role: "user", text: "Fix the loader.", createdAt: "2026-09-29T09:00:00.000Z", turnId: null },
          { id: "m2", role: "system", text: "Context compacted.", createdAt: "2026-09-29T09:01:00.000Z" },
          { id: "m3", role: "assistant", text: "", streaming: true, createdAt: "2026-09-29T09:02:00.000Z" },
          { id: "m4", role: "assistant", text: "Done.", createdAt: "2026-09-29T09:05:00.000Z" },
        ],
      },
      page: { beforeCursor: null, hasMore: false },
    }
    const threads = reached([], { "/api/orchestration/threads/done?turnLimit=2": detail, "/api/orchestration/threads/done": detail })
    const read = await Effect.runPromise(threads.detail("done", 2))
    expect(read.thread).toMatchObject({ id: "done", project: "yapd", state: "done" })
    expect(read.messages).toEqual([
      { role: "user", text: "Fix the loader.", at: "2026-09-29T09:00:00.000Z" },
      { role: "assistant", text: "Done.", at: "2026-09-29T09:05:00.000Z" },
    ])
    expect(await Effect.runPromise(threads.opening("done"))).toBe("Fix the loader.")
    // Unknown to T3 Code, so asking again won't help. One it lists but can't read right now is another matter.
    expect(await failure(threads.detail("missing", 2))).toMatchObject({ gone: true })
    expect((await failure(threads.detail("new", 2))).gone).toBeUndefined()
  })

  test("sends with the ids it was given, unless the thread is mid-turn, waiting on the user, or gone", async () => {
    const dispatched: Array<unknown> = []
    /** The thread's latest turns, as they're read before a busy or waiting thread is turned down. */
    const turns = (id: string, messages: Array<{ id: string; role: string; text: string }>) => ({
      [`/api/orchestration/threads/${id}?turnLimit=3`]: { thread: { ...shell.threads.find((thread) => thread.id === id), messages } },
    })
    const threads = reached(dispatched, {
      ...turns("running", [{ id: "someone-else", role: "user", text: "Go on." }]),
      ...turns("approving", [{ id: "someone-else", role: "user", text: "Go on." }]),
      ...turns("waiting", []),
    })
    expect(await Effect.runPromise(threads.send("running", outgoing))).toBe("busy")
    expect(await Effect.runPromise(threads.send("approving", outgoing))).toBe("waiting")
    // Not mid-turn, but stopped on a question only the user can answer in T3 Code. A plan alone doesn't stop a message: that's how it's answered.
    expect(await Effect.runPromise(threads.send("waiting", outgoing))).toBe("waiting")
    expect(dispatched).toEqual([])
    expect(await Effect.runPromise(threads.send("planned", outgoing))).toBe("sent")
    expect(await Effect.runPromise(threads.send("done", outgoing))).toBe("sent")
    expect(dispatched[1]).toMatchObject({
      type: "thread.turn.start",
      commandId: "yapd:command-1",
      threadId: "done",
      message: { messageId: "message-1", role: "user", text: "compact keep the public API unchanged", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
    })
    expect(await failure(threads.send("archived", outgoing))).toMatchObject({ gone: true })
    expect(await failure(threads.send("missing", outgoing))).toMatchObject({ gone: true })
    expect((await failure(threads.send("done", { ...outgoing, text: " / " }))).reason).toBe("I didn't catch what to send.")
    expect(dispatched).toHaveLength(2)
  })

  test("takes a message as sent when the thread already has it, however the thread stands, rather than send it twice", async () => {
    const dispatched: Array<unknown> = []
    // The first try's answer was lost, and the turn it started has since stopped on an approval.
    const threads = reached(dispatched, {
      "/api/orchestration/threads/approving?turnLimit=3": {
        thread: { ...shell.threads[2], messages: [{ id: "message-1", role: "user", text: "compact keep the public API unchanged" }] },
      },
    })
    expect(await Effect.runPromise(threads.send("approving", outgoing))).toBe("sent")
    expect(await Effect.runPromise(threads.send("approving", { ...outgoing, messageId: "message-2" }))).toBe("waiting")
    expect(dispatched).toEqual([])
  })
})
