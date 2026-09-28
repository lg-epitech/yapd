import { describe, expect, test } from "bun:test"
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
