import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Schema, Stream, TestClock, TestContext } from "effect"
import * as Journal from "./Journal.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3CodeServer from "./T3CodeServer.ts"
import type * as Server from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
import type * as Tunnel from "./Tunnel.ts"

const now = Date.parse("2026-10-08T22:00:00.000Z")

const thread = (id: string, title: string, updatedAt: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId: "p",
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  })

const viewing = (...threads: ReadonlyArray<T3Live.Thread>): T3Live.View => ({
  projects: new Map([["p", { id: "p", title: "integration", workspaceRoot: "/code/integration" }]]),
  threads: new Map(threads.map((thread) => [thread.id, thread])),
  sequence: 1,
  synced: true,
})

/** What a hook is linked to when it's a thread's own. */
const linkedTo = (machine: string, id: string) => Option.some<Threads.Linked>({ _tag: "Thread", ref: { machine, id } })

/**
 * Threads on Rosie over a T3 Code whose threads have the agent conversations
 * `sessions` says, by the agent's own ids, as T3 Code references them, and
 * which counts how often each thread is read.
 */
const linking = (
  view: Option.Option<T3Live.View>,
  sessions: Readonly<Record<string, ReadonlyArray<string>>>,
  /** Rig's own threads and their sessions, when they aren't the same as here. */
  rig: { readonly view: Option.Option<T3Live.View>; readonly sessions: Readonly<Record<string, ReadonlyArray<string>>> } = { view, sessions },
) =>
  Effect.gen(function* () {
    const reads: Array<string> = []
    const reaching = (name: string, sessions: Readonly<Record<string, ReadonlyArray<string>>>): Effect.Effect<Server.Transport, Server.Trouble> =>
      Effect.succeed({
        api: (<A, I>(path: string, schema: Schema.Schema<A, I>) => {
          const id = decodeURIComponent(path.split("/").at(-2) ?? "")
          reads.push(name === "Rosie" ? id : `${name} ${id}`)
          const providerThreads = (sessions[id] ?? []).map((nativeId) => ({ nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" } }))
          return Schema.decodeUnknown(schema)({ projection: { runs: [], messages: [], turnItems: [], providerThreads } }).pipe(Effect.orDie)
        }) as Server.Transport["api"],
        // With no scratch project to tell of.
        call: (<A, I>(method: string, _: unknown, schema: Schema.Schema<A, I>) =>
          method === "server.getConfig" ? Schema.decodeUnknown(schema)({}).pipe(Effect.orDie) : Effect.die("not expected")) as Server.Transport["call"],
        asset: () => Effect.die("not expected"),
      })
    const store = yield* Store.make(":memory:")
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: { view: Effect.succeed(view), changes: Stream.never },
      actions: Option.some(T3Actions.make(reaching("Rosie", sessions))),
      // Rig, followed too, with the same threads as here unless said.
      others: [{ machine: "rig", live: { view: Effect.succeed(rig.view), changes: Stream.never }, actions: T3Actions.make(reaching("rig", rig.sessions)), status: Effect.succeed({ _tag: "Up" }) }],
      journal: Journal.fromStore(store),
      store,
    })
    return { threads, reads }
  })

describe("Threads", () => {
  test("puts threads whose titles have his words up front, however speech spelt them, and the rest of the month's by name", () => {
    const busy = Array.from({ length: 40 }, (_, index) =>
      thread(`busy-${index}`, `Busy work number ${index}`, `2026-10-08T${String(10 + (index % 10)).padStart(2, "0")}:00:00.000Z`),
    )
    const tickets = thread("tickets", "Open Mina SSV2 Bug Tickets", "2026-09-30T16:00:00.000Z")
    const wallet = thread("wallet", "Confirm Mina Wallet Migration", "2026-10-05T18:00:00.000Z")
    const old = thread("old", "Something from the summer", "2026-07-01T00:00:00.000Z")
    const view: T3Live.View = {
      projects: new Map([["p", { id: "p", title: "integration", workspaceRoot: "/code/integration" }]]),
      threads: new Map([...busy, tickets, wallet, old].map((thread) => [thread.id, thread])),
      sequence: 1,
      synced: true,
    }
    const listed = Threads.shortlist({
      machine: "Rosie",
      view,
      focus: Option.none(),
      pending: [],
      heard: "Can you please tell me what's the status on MiNAS SV2?",
      most: 30,
      more: 120,
      started: new Map(),
      said: new Map(),
      now,
    })
    // Its title has both his words, as Whisper spelt them, so it's among those seen in full.
    expect(listed.find(({ ref }) => ref.id === "tickets")).toMatchObject({ handle: "t1", brief: false })
    // One word in common isn't enough to move it up, but it's still there by name.
    expect(listed.find(({ ref }) => ref.id === "wallet")?.brief).toBe(true)
    // Older than a month, it's left out.
    expect(listed.some(({ ref }) => ref.id === "old")).toBe(false)
    expect(listed.filter(({ brief }) => !brief)).toHaveLength(30)
  })

  test("a hook is linked to its thread by the agent's own session id, even with two threads in one directory", async () => {
    // Two threads in the integration project, the Mina one the newer, and one in a worktree of its own.
    const tezos = thread("tezos", "Migrate Tezos Integration", "2026-10-08T20:00:00.000Z")
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", "2026-10-08T21:00:00.000Z")
    const loader = thread("loader", "Fix the loader", "2026-10-08T21:30:00.000Z", { worktreePath: "/code/integration-loader" })
    const result = await Effect.gen(function* () {
      const { threads, reads } = yield* linking(Option.some(viewing(tezos, mina, loader)), { tezos: ["s-tezos"], mina: ["s-mina"], loader: ["s-loader"] })
      const tezosHook = yield* threads.link("Rosie", "s-tezos", "/code/integration")
      const minaHook = yield* threads.link("Rosie", "s-mina", "/code/integration")
      const first = reads.length
      // Told again, each is known, and nothing is read for it.
      const again = yield* threads.link("Rosie", "s-tezos", "/code/integration")
      // A terminal session in the same directory is no thread's, and threads that haven't run since aren't read for it twice.
      const terminal = [yield* threads.link("Rosie", "s-terminal", "/code/integration"), yield* threads.link("Rosie", "s-terminal", "/code/integration")]
      return { tezosHook, minaHook, first, again, terminal, reads }
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(result.tezosHook).toEqual(linkedTo("Rosie", "tezos"))
    expect(result.minaHook).toEqual(linkedTo("Rosie", "mina"))
    // The newest first: the Mina one, which didn't have it, then the Tezos one; never the one in another directory.
    expect(result.reads.slice(0, result.first)).toEqual(["mina", "tezos"])
    expect(result.again).toEqual(linkedTo("Rosie", "tezos"))
    expect(result.terminal).toEqual([Option.none(), Option.none()])
    expect(result.reads).toEqual(["mina", "tezos"])
  })

  test("a hook from a folder of a thread's directory, where its agent went, is linked to it by its session, the nearest directory first", async () => {
    // One thread works in the integration project, one in a worktree of it, and one in a project next to it whose name starts the same.
    const tezos = thread("tezos", "Migrate Tezos Integration", "2026-10-08T21:00:00.000Z")
    const fees = thread("fees", "Fee tables", "2026-10-08T20:00:00.000Z", { worktreePath: "/code/integration/.worktrees/fees" })
    const loader = thread("loader", "Fix the loader", "2026-10-08T21:30:00.000Z", { worktreePath: "/code/integration-loader" })
    const result = await Effect.gen(function* () {
      const { threads, reads } = yield* linking(Option.some(viewing(tezos, fees, loader)), { tezos: ["s-tezos"], fees: ["s-fees"], loader: ["s-loader"] })
      const deep = yield* threads.link("Rosie", "s-fees", "/code/integration/.worktrees/fees/src")
      const api = yield* threads.link("Rosie", "s-tezos", "/code/integration/packages/api")
      return { api, deep, reads }
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(result.api).toEqual(linkedTo("Rosie", "tezos"))
    expect(result.deep).toEqual(linkedTo("Rosie", "fees"))
    // For the worktree's folder, the worktree's thread first, the nearest, though the project's is newer; never the one next to it.
    expect(result.reads).toEqual(["fees", "tezos"])
  })

  test("a hook from rig is found in rig's T3 Code by the agent's own session id, its directory taken as rig gives it, and never for a session of this machine's", async () => {
    // The same Tezos thread id on both machines, each with its own session; rig's works in a folder this Mac doesn't have.
    const tezos = thread("tezos", "Migrate Tezos Integration", "2026-10-08T20:00:00.000Z")
    const rigView: T3Live.View = {
      projects: new Map([["p", { id: "p", title: "integration", workspaceRoot: "/home/laurent/code/integration" }]]),
      threads: new Map([["tezos", tezos]]),
      sequence: 1,
      synced: true,
    }
    const result = await Effect.gen(function* () {
      const { threads, reads } = yield* linking(Option.some(viewing(tezos)), { tezos: ["s-here"] }, { view: Option.some(rigView), sessions: { tezos: ["s-rig"] } })
      const rig = yield* threads.link("rig", "s-rig", "/home/laurent/code/integration/src")
      // Rig's session is rig's, never this machine's, and this machine's isn't rig's.
      const crossed = [yield* threads.link("Rosie", "s-rig", "/code/integration"), yield* threads.link("rig", "s-here", "/home/laurent/code/integration")]
      const here = yield* threads.link("Rosie", "s-here", "/code/integration")
      // Known once read, it's found without reading rig's T3 Code again.
      const again = yield* threads.link("rig", "s-rig", "/home/laurent/code/integration")
      return { rig, crossed, here, again, reads }
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(result.rig).toEqual(linkedTo("rig", "tezos"))
    expect(result.crossed).toEqual([Option.none(), Option.none()])
    expect(result.here).toEqual(linkedTo("Rosie", "tezos"))
    expect(result.again).toEqual(linkedTo("rig", "tezos"))
    expect(result.reads).toEqual(["rig tezos", "tezos"])
  })

  test("a thread's project is found by the thread, or by the nearest folder holding a directory: a project's, or a worktree of one", async () => {
    const view: T3Live.View = {
      projects: new Map([
        ["p", { id: "p", title: "integration", workspaceRoot: "/code/integration" }],
        ["q", { id: "q", title: "integration connectors", workspaceRoot: "/code/integration/connectors" }],
        ["y", { id: "y", title: "yapd", workspaceRoot: "/code/yapd" }],
      ]),
      threads: new Map([
        ["tezos", thread("tezos", "Migrate Tezos Integration", "2026-10-08T20:00:00.000Z")],
        ["menu", thread("menu", "Thread menu", "2026-10-08T21:00:00.000Z", { projectId: "y", worktreePath: "/worktrees/yapd/t3-menu" })],
      ]),
      sequence: 1,
      synced: true,
    }
    const result = await Effect.gen(function* () {
      const { threads } = yield* linking(Option.some(view), {}, { view: Option.none(), sessions: {} })
      const name = (found: Option.Option<T3Live.Project>) => Option.getOrUndefined(Option.map(found, ({ title }) => title))
      return {
        byThread: name(yield* threads.project("Rosie", { thread: "menu", directory: "/code/integration" })),
        nearest: name(yield* threads.project("Rosie", { directory: "/code/integration/connectors/src" })),
        outer: name(yield* threads.project("Rosie", { directory: "/code/integration/packages" })),
        worktree: name(yield* threads.project("Rosie", { directory: "/worktrees/yapd/t3-menu/app" })),
        // Next to it, with a name that starts the same, isn't in it.
        beside: name(yield* threads.project("Rosie", { directory: "/code/integration-loader" })),
        gone: name(yield* threads.project("Rosie", { thread: "gone" })),
        // Rig's T3 Code isn't followed right now.
        rig: name(yield* threads.project("rig", { directory: "/code/integration" })),
      }
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(result).toEqual({ byThread: "yapd", nearest: "integration connectors", outer: "integration", worktree: "yapd", beside: undefined, gone: undefined, rig: undefined })
  })

  test("a review T3 Code runs for a thread is found as its subagent, and only once one at work there is to be read is waiting on it worth it", async () => {
    const worktree = { worktreePath: "/worktrees/yapd/jarvis" }
    const of = (parent: string) => ({ ...worktree, lineage: { parentThreadId: parent, relationshipToParent: "subagent" } })
    const jarvis = thread("jarvis", "Reimagine Yapd as a Jarvis Companion", "2026-10-08T20:00:00.000Z", worktree)
    // At work now, one done an hour or more ago, and one Claude made inside the thread's own session, at work too.
    const review = thread("review", "Sol review: release blockers", "2026-10-08T21:00:00.000Z", { ...of("jarvis"), activeRunId: "run-1" })
    const old = thread("old", "Sol review: first pass", "2026-10-08T19:00:00.000Z", { ...of("jarvis"), latestRunCompletedAt: "2026-10-08T19:30:00.000Z" })
    const agent = thread("agent", "Explore the loader", "2026-10-08T21:30:00.000Z", { ...of("jarvis"), activeRunId: "run-2", creationSource: "provider" })
    const sessions = { jarvis: ["s-jarvis"], review: ["s-review"], old: ["s-old"], agent: ["s-agent"] }
    const result = await Effect.gen(function* () {
      const { threads, reads } = yield* linking(Option.some(viewing(jarvis, review, old, agent)), sessions)
      /** What a hook in the worktree is linked to, and whether it was told waiting on it may pay. */
      const hook = (machine: string, session: string) =>
        Effect.gen(function* () {
          const promising = yield* Deferred.make<void>()
          const linked = yield* threads.link(machine, session, "/worktrees/yapd/jarvis/src", promising)
          return { linked, promising: yield* Deferred.isDone(promising) }
        })
      const own = yield* hook("Rosie", "s-jarvis")
      const child = yield* hook("Rosie", "s-review")
      const read = [...reads]
      // Known now, it's found again without reading anything, and nothing's left to be worth waiting on for a session no thread has.
      const again = yield* hook("Rosie", "s-review")
      const terminal = yield* hook("Rosie", "s-terminal")
      const idle = yield* hook("Rosie", "s-old")
      const inside = yield* hook("Rosie", "s-agent")
      const rig = yield* hook("rig", "s-review")
      return { own, child, read, again, terminal, idle, inside, rig, reads }
    }).pipe(Effect.scoped, Effect.runPromise)
    const subagentOf = (machine: string) =>
      Option.some<Threads.Linked>({
        _tag: "Subagent",
        child: { machine, id: "review" },
        called: "Sol review: release blockers",
        head: Option.some({ ref: { machine, id: "jarvis" }, called: "Reimagine Yapd as a Jarvis Companion" }),
      })
    expect(result.own).toEqual({ linked: linkedTo("Rosie", "jarvis"), promising: false })
    expect(result.child).toEqual({ linked: subagentOf("Rosie"), promising: true })
    expect(result.read).toEqual(["jarvis", "review"])
    expect(result.again).toEqual({ linked: subagentOf("Rosie"), promising: false })
    expect(result.terminal).toEqual({ linked: Option.none(), promising: false })
    // Never one done long ago, nor one inside its parent's session, which are never read for it.
    expect(result.idle).toEqual({ linked: Option.none(), promising: false })
    expect(result.inside).toEqual({ linked: Option.none(), promising: false })
    // Rig's are found in rig's T3 Code, the same way.
    expect(result.rig).toEqual({ linked: subagentOf("rig"), promising: true })
    expect(result.reads).toEqual(["jarvis", "review", "rig jarvis", "rig review"])
  })

  test("a subagent is part of the first thread up its chain that isn't one: never a fork's source, and none once its chain is broken", () => {
    const subagentOf = (parent: string) => ({ lineage: { parentThreadId: parent, relationshipToParent: "subagent" } })
    const top = thread("top", "Migrate Tezos Integration", "2026-10-08T20:00:00.000Z")
    const child = thread("child", "Review it", "2026-10-08T20:10:00.000Z", subagentOf("top"))
    const grandchild = thread("grandchild", "Check the fees", "2026-10-08T20:20:00.000Z", subagentOf("child"))
    const fork = thread("fork", "Try another way", "2026-10-08T20:30:00.000Z", { lineage: { parentThreadId: "top", relationshipToParent: "fork" } })
    const forked = thread("forked", "Review the other way", "2026-10-08T20:40:00.000Z", subagentOf("fork"))
    const orphan = thread("orphan", "Review something gone", "2026-10-08T20:50:00.000Z", subagentOf("gone"))
    const archived = thread("archived", "Old work", "2026-10-08T19:00:00.000Z", { archivedAt: "2026-10-08T19:30:00.000Z" })
    const left = thread("left", "Review old work", "2026-10-08T19:10:00.000Z", subagentOf("archived"))
    const view = viewing(top, child, grandchild, fork, forked, orphan, archived, left)
    const headOf = (one: T3Live.Thread) => Option.getOrUndefined(Option.map(Threads.head(view, one), ({ id }) => id))
    expect([grandchild, child, forked, orphan, left, top, fork].map(headOf)).toEqual(["top", "top", "fork", undefined, undefined, undefined, undefined])
  })
})

describe("Threads on several machines", () => {
  /** What a machine's T3 Code is asked, by which machine, and what it answers a search with. */
  const machine = (name: string, asked: Array<string>, found: Effect.Effect<ReadonlyArray<{ threadId: string; snippet: string }>, T3CodeServer.Trouble> = Effect.succeed([])) =>
    ({
      detail: (threadId: string) => Effect.sync(() => void asked.push(`${name}: detail ${threadId}`)).pipe(Effect.as({ messages: [], runs: [], request: Option.none(), plan: Option.none() })),
      search: (query: string) => Effect.zipRight(Effect.sync(() => void asked.push(`${name}: search ${query}`)), found),
      scratchRoot: Effect.succeedNone,
    }) as unknown as T3Actions.Actions

  const live = (view: Option.Option<T3Live.View>): T3Live.T3Live["Type"] => ({ view: Effect.succeed(view), changes: Stream.never })

  const make = (rig: { readonly view: Option.Option<T3Live.View>; readonly status: Tunnel.Status; readonly found?: Effect.Effect<ReadonlyArray<{ threadId: string; snippet: string }>, T3CodeServer.Trouble> }, asked: Array<string>) =>
    Effect.gen(function* () {
      const store = yield* Store.make(":memory:")
      return yield* Threads.make({
        machine: "Rosie",
        live: live(Option.some(viewing(thread("tests", "Fix the flaky tests", "2026-10-08T21:00:00.000Z")))),
        actions: Option.some(machine("Rosie", asked, Effect.succeed([{ threadId: "tests", snippet: "the std tests" }]))),
        others: [{ machine: "rig", live: live(rig.view), actions: machine("rig", asked, rig.found), status: Effect.succeed(rig.status) }],
        journal: Journal.fromStore(store),
        store,
      })
    })

  test("ranks rig's threads in with this machine's, by its machine, and reads one from the machine it's on", async () => {
    const asked: Array<string> = []
    // The same id on both machines, as nothing stops it being: only its machine tells them apart.
    const running = thread("tests", "Add the std fee test", "2026-10-08T20:00:00.000Z", { activeRunId: "run-1" })
    const seen = await Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const threads = yield* make({ view: Option.some(viewing(running)), status: { _tag: "Up" } }, asked)
      const desk = yield* threads.desk(Option.none(), [], 30)
      yield* threads.detail({ machine: "rig", id: "tests" })
      return {
        desk: desk.threads.map(({ handle, ref, here, state }) => ({ handle, ref, here, state })),
        away: desk.away,
      }
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise)
    // What's running on rig matters more than what's idle here.
    expect(seen.desk).toEqual([
      { handle: "t1", ref: { machine: "rig", id: "tests" }, here: false, state: "running" },
      { handle: "t2", ref: { machine: "Rosie", id: "tests" }, here: true, state: "idle" },
    ])
    expect(seen.away).toEqual([])
    expect(asked).toEqual(["rig: detail tests"])
  })

  test("a search leaves out a machine that hasn't answered in time, keeping what the others found", async () => {
    const asked: Array<string> = []
    const found = await Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const threads = yield* make({ view: Option.some(viewing()), status: { _tag: "Up" }, found: Effect.never }, asked)
      const searching = yield* Effect.fork(threads.search("std tests", "100 millis"))
      yield* TestClock.adjust("100 millis")
      return yield* Fiber.join(searching)
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise)
    expect(found).toEqual({ matches: [{ ref: { machine: "Rosie", id: "tests" }, snippet: "the std tests" }], missed: ["rig"] })
    expect(asked.toSorted()).toEqual(["Rosie: search std tests", "rig: search std tests"])
  })
})
