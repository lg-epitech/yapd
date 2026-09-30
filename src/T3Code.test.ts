import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as T3Code from "./T3Code.ts"

const thread = (overrides: Partial<T3Code.ShellThread> = {}): T3Code.ShellThread => ({
  id: "thread-1",
  projectId: "project-1",
  runtimeMode: "full-access",
  interactionMode: "plan",
  worktreePath: null,
  archivedAt: null,
  updatedAt: "2026-09-27T10:00:00.000Z",
  latestTurn: { state: "completed" },
  session: { status: "ready" },
  ...overrides,
})

const shell = (threads: ReadonlyArray<T3Code.ShellThread>): T3Code.Shell => ({
  projects: [{ id: "project-1", workspaceRoot: "/repo" }],
  threads,
})

const same = (path: string) => path

describe("T3Code", () => {
  test("finds threads by worktree, or by project when there's none", () => {
    const worktree = thread({ id: "worktree", worktreePath: "/worktrees/a" })
    const local = thread({ id: "local" })
    const threads = shell([worktree, local])
    expect(T3Code.inDirectory(threads, "/worktrees/a", same).map(({ id }) => id)).toEqual(["worktree"])
    expect(T3Code.inDirectory(threads, "/repo", same).map(({ id }) => id)).toEqual(["local"])
  })

  test("tries the most recently active thread first", () => {
    const older = thread({ id: "older", updatedAt: "2026-09-27T09:00:00.000Z" })
    const newer = thread({ id: "newer", updatedAt: "2026-09-27T11:00:00.000Z" })
    expect(T3Code.inDirectory(shell([older, newer]), "/repo", same).map(({ id }) => id)).toEqual(["newer", "older"])
  })

  test("compares canonical paths", () => {
    const threads = shell([thread({ worktreePath: "/tmp/w" })])
    const resolve = (path: string) => path.replace(/^\/tmp/, "/private/tmp")
    expect(T3Code.inDirectory(threads, "/private/tmp/w", resolve)).toHaveLength(1)
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

  test("tells which thread an update came from only when exactly one ends with its message", async () => {
    const ended = { older: "All tests pass.", twin: "All tests pass.", newer: "Fixed the loader. All tests pass.", elsewhere: "All tests pass." }
    const listed = shell([
      thread({ id: "older", updatedAt: "2026-09-27T09:00:00.000Z" }),
      thread({ id: "twin", updatedAt: "2026-09-27T10:00:00.000Z" }),
      thread({ id: "newer", updatedAt: "2026-09-27T11:00:00.000Z" }),
      thread({ id: "elsewhere", worktreePath: "/worktrees/a" }),
    ])
    const reads: Array<string> = []
    // Answers as T3 Code would, with the shell and each thread's last message.
    const api = <A, I>(path: string, schema: Schema.Schema<A, I>) => {
      reads.push(path)
      const id = /threads\/([^?]+)/.exec(path)?.[1]
      const body = id === undefined ? listed : { thread: { messages: [{ role: "assistant", text: ended[id as keyof typeof ended] }] } }
      return Schema.decodeUnknown(schema)(body)
    }
    const identified = (message: string, cwd = "/repo") => Effect.runPromise(T3Code.identified(api, { cwd, message }))
    expect(await identified("Fixed the loader. All tests pass.")).toEqual(Option.some("newer"))
    expect(await identified("All tests pass.", "/worktrees/a")).toEqual(Option.some("elsewhere"))
    // Two in the same place that ended the same way, and none at all.
    expect(await identified("All tests pass.")).toEqual(Option.none())
    expect(await identified("Something else.")).toEqual(Option.none())
    // Only the threads in the update's directory are read.
    expect(reads.filter((path) => path.includes("elsewhere"))).toHaveLength(1)
  })

  test("counts a running turn as busy", () => {
    expect(T3Code.busy(thread())).toBe(false)
    expect(T3Code.busy(thread({ latestTurn: { state: "running" } }))).toBe(true)
    expect(T3Code.busy(thread({ session: { status: "starting" } }))).toBe(true)
  })

  test("sends a plain user message, echoing the thread's modes", () => {
    const command = T3Code.turnStart(thread(), "Merge it now.")
    expect(command).toMatchObject({
      type: "thread.turn.start",
      threadId: "thread-1",
      message: { role: "user", text: "Merge it now.", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "plan",
    })
    expect(command).not.toHaveProperty("modelSelection")
  })
})


describe("T3Code hook references", () => {
  test("captures the matched turn from its detail, rather than a shell read that was already out of date", async () => {
    const context = { turnId: "turn-a", userMessageId: "user-a" }
    const read = (turnId: string, newestUserTurn = "turn-a") => T3Code.matching((path, schema) => Effect.orDie(Schema.decodeUnknown(schema)(
      path === "/api/orchestration/shell" ? shell([thread()]) : { thread: { latestTurn: { turnId }, messages: [
        { id: "user-a", role: "user", text: "Fix it", turnId: newestUserTurn },
        { id: "assistant-a", role: "assistant", text: "Ready.", turnId: "turn-a" },
      ] } })), { cwd: "/repo", message: "Ready." })
    expect((await Effect.runPromise(read("turn-a")))[0]?.reference).toEqual(context)
    expect((await Effect.runPromise(read("turn-b")))[0]?.reference).toBeUndefined()
    expect((await Effect.runPromise(read("turn-a", "turn-b")))[0]?.reference).toBeUndefined()
  })
})


test("T3Code ties null user turn ids by the request timestamp and rejects a queued newer request", async () => {
  const requestedAt = "2026-09-30T10:00:00.000Z"
  for (const createdAt of [requestedAt, "2026-09-30T10:00:01.000Z"]) {
    const matches = await Effect.runPromise(T3Code.matching((path, schema) => Effect.orDie(Schema.decodeUnknown(schema)(
      path === "/api/orchestration/shell" ? shell([thread()]) : { thread: { latestTurn: { turnId: "turn-a", requestedAt }, messages: [
        { id: "user-a", role: "user", text: "Fix it", turnId: null, createdAt },
        { id: "assistant-a", role: "assistant", text: "Ready.", turnId: "turn-a" },
      ] } })), { cwd: "/repo", message: "Ready." }))
    expect(matches[0]?.reference).toEqual(createdAt === requestedAt ? { turnId: "turn-a", userMessageId: "user-a" } : undefined)
  }
})
