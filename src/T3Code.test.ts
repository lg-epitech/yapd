import { describe, expect, spyOn, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { make as makeRelays, type Thread } from "./Relay.ts"
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

const update: Thread = { agent: "codex", session: "provider-1", cwd: "/repo", message: "Fixed the loader.", origin: {} }
const makeRelay = () => Effect.runPromise(T3Code.make(Effect.succeed({ origin: "http://t3.invalid" })).pipe(
  Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_T3CODE_TOKEN", "test-token"]]))),
))

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

describe("T3Code follow-ups", () => {
  const original = { role: "user", text: "Fix the loader" }
  const clarification = { role: "user", text: "Include the streaming case" }
  const reply = { role: "assistant", text: update.message }

  test("doesn't try another relay after an uncertain T3 dispatch", async () => {
    let dispatches = 0
    let fallbacks = 0
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const path = new URL(String(input)).pathname
      if (path === "/api/orchestration/shell") return Response.json(shell([thread()]))
      if (path === "/api/orchestration/threads/thread-1") return Response.json({ thread: { messages: [original, reply] } })
      dispatches++
      throw new Error("Connection lost after dispatch")
    }, { preconnect: globalThis.fetch.preconnect }))
    try {
      const relays = makeRelays([await makeRelay(), { send: () => Effect.sync(() => { fallbacks++ }) }])
      expect(await Effect.runPromise(Effect.flip(relays.send(update, "Merge it."))))
        .toMatchObject({ _tag: "RelayError", reason: "T3 Code isn't answering." })
      expect([dispatches, fallbacks]).toEqual([1, 0])
    } finally { fetch.mockRestore() }
  })

  test("finds the completed reply behind a pending steering message", async () => {
    const sent: Array<unknown> = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/api/orchestration/shell") {
        return Response.json(shell([thread({ latestTurn: { state: "pending" } })]))
      }
      if (url.pathname === "/api/orchestration/threads/thread-1") {
        // T3's user-anchored window omits the provider turn's reply when it
        // includes only the pending turn created by a message sent mid-turn.
        return Response.json({ thread: { messages: url.searchParams.get("turnLimit") === "1"
          ? [clarification] : [original, clarification, reply] } })
      }
      if (url.pathname === "/api/orchestration/dispatch") {
        sent.push(JSON.parse(String(init?.body)))
        return Response.json({})
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }, { preconnect: globalThis.fetch.preconnect }))
    try {
      await Effect.runPromise((await makeRelay()).send(update, "Please commit it."))
      expect(sent).toEqual([expect.objectContaining({
        threadId: "thread-1", message: expect.objectContaining({ role: "user", text: "Please commit it." }),
      })])
    } finally { fetch.mockRestore() }
  })

  test("doesn't send to an older reply when the user has moved on", async () => {
    const paths: Array<string> = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === "/api/orchestration/shell") return Response.json(shell([thread()]))
      if (path === "/api/orchestration/threads/thread-1") {
        return Response.json({ thread: { messages: [original, reply, clarification] } })
      }
      throw new Error(`Unexpected request: ${path}`)
    }, { preconnect: globalThis.fetch.preconnect }))
    try {
      expect(await Effect.runPromise(Effect.flip((await makeRelay()).send(update, "Please commit it."))))
        .toMatchObject({ _tag: "Unreachable" })
      expect(paths).not.toContain("/api/orchestration/dispatch")
    } finally { fetch.mockRestore() }
  })

  test("doesn't confuse a thread's older matching reply with another thread's latest reply", async () => {
    const sent: Array<{ threadId: string }> = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === "/api/orchestration/shell") return Response.json(shell([thread(), thread({ id: "thread-2" })]))
      if (path === "/api/orchestration/threads/thread-1") return Response.json({ thread: { messages: [original, reply, clarification] } })
      if (path === "/api/orchestration/threads/thread-2") return Response.json({ thread: { messages: [original, clarification, reply] } })
      if (path === "/api/orchestration/dispatch") {
        sent.push(JSON.parse(String(init?.body)))
        return Response.json({})
      }
      throw new Error(`Unexpected request: ${path}`)
    }, { preconnect: globalThis.fetch.preconnect }))
    try {
      await Effect.runPromise((await makeRelay()).send(update, "Please commit it."))
      expect(sent.map(({ threadId }) => threadId)).toEqual(["thread-2"])
    } finally { fetch.mockRestore() }
  })
})
