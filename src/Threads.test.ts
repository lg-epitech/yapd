import { describe, expect, test } from "bun:test"
import { Clock, Effect, Option, Schema, Stream, TestClock, TestContext } from "effect"
import * as Brain from "./Brain.ts"
import * as Journal from "./Journal.ts"
import * as Persona from "./Persona.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import type * as Server from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"

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

/**
 * Threads on Rosie over a T3 Code whose threads have the agent conversations
 * `sessions` says, by the agent's own ids, as T3 Code references them, and
 * which counts how often each thread is read.
 */
const linking = (view: Option.Option<T3Live.View>, sessions: Readonly<Record<string, ReadonlyArray<string>>>) =>
  Effect.gen(function* () {
    const reads: Array<string> = []
    const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
      api: (<A, I>(path: string, schema: Schema.Schema<A, I>) => {
        const id = decodeURIComponent(path.split("/").at(-2) ?? "")
        reads.push(id)
        const providerThreads = (sessions[id] ?? []).map((nativeId) => ({ nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" } }))
        return Schema.decodeUnknown(schema)({ projection: { runs: [], messages: [], turnItems: [], providerThreads } }).pipe(Effect.orDie)
      }) as Server.Transport["api"],
      call: (() => Effect.die("not expected")) as Server.Transport["call"],
    })
    const store = yield* Store.make(":memory:")
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: { view: Effect.succeed(view), changes: Stream.never },
      actions: Option.some(T3Actions.make(reach)),
      others: ["rig"],
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

  test("words too common to tell threads apart, like \"status\", \"still\" or \"need\", never count as a title's", () => {
    const running = thread("running", "Refactor auth middleware", "2026-10-08T20:00:00.000Z", { activeRunId: "run-1" })
    const first = (heard: string, title: string) => {
      const view = viewing(thread("titled", title, "2026-10-01T10:00:00.000Z"), running)
      const listed = Threads.shortlist({ machine: "Rosie", view, focus: Option.none(), pending: [], heard, most: 30, started: new Map(), said: new Map(), now })
      return { first: listed[0]?.ref.id, entitled: Threads.entitled(heard, view) }
    }
    // Only "billing" tells it apart, which isn't enough to put it ahead of what's running.
    expect(first("What's the status of the billing export?", "Status page for billing")).toEqual({ first: "running", entitled: [] })
    expect(first("I still need the billing done.", "Need billing export")).toEqual({ first: "running", entitled: [] })
    expect(first("Will it look at the billing?", "Look at billing, it will")).toEqual({ first: "running", entitled: [] })
    // Two words that do, and it is.
    expect(first("What's the status of the billing export?", "Need billing export")).toEqual({ first: "titled", entitled: ["titled"] })
  })

  test("usage read hours ago is read again before it's said, and said as of then without what has reset since when T3 Code can't answer", async () => {
    const nine = Date.parse("2026-10-08T09:00:00.000Z")
    const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    // Its five-hour window resets when it says, and its weekly one in three days.
    const reading = (session: number, resetsAt: string): T3Actions.Usage => [
      {
        provider: "Claude",
        windows: [
          { kind: "session", label: "Session", minutes: 300, usedPercent: session, resetsAt },
          { kind: "weekly", label: "Weekly", minutes: 10080, usedPercent: 40, resetsAt: "2026-10-11T09:00:00.000Z" },
        ],
      },
    ]
    const said = await Effect.gen(function* () {
      yield* TestClock.setTime(nine)
      const store = yield* Store.make(":memory:")
      let answer: Effect.Effect<T3Actions.Usage, Error> = Effect.succeed(reading(95, "2026-10-08T13:00:00.000Z"))
      const threads = yield* Threads.make({
        machine: "Rosie",
        live: { view: Effect.succeed(Option.none()), changes: Stream.never },
        actions: Option.some({ usage: Effect.suspend(() => answer) } as unknown as T3Actions.Actions),
        others: [],
        journal: Journal.fromStore(store),
        store,
      })
      const usage = Effect.flatMap(Effect.zip(threads.usage, Clock.currentTimeMillis), ([usage, now]) =>
        Effect.succeed(Brain.used(usage, "how's my usage", Persona.plain, now)),
      )
      const first = yield* usage
      // Its token expires, and six hours go by.
      answer = Effect.fail(new Error("token expired"))
      yield* TestClock.adjust("6 hours")
      const dated = yield* usage
      // It answers again, which is waited for rather than the morning's said.
      answer = Effect.succeed(reading(10, "2026-10-08T20:00:00.000Z"))
      yield* TestClock.adjust("6 minutes")
      return { first, dated, again: yield* usage }
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise)
    expect(said.first).toStartWith("Claude is at 95 percent of its five-hour window, resetting at ")
    expect(said.dated).toStartWith(`As of ${time(nine)}, Claude was at 40 percent of its weekly window, resetting `)
    // The five-hour window reset at one, two hours ago.
    expect(said.dated).not.toContain("95 percent")
    expect(said.again).toStartWith("Claude is at 10 percent of its five-hour window, resetting ")
  })

  test("calls a thread by its title when what yapd once noted about it is too long to say", () => {
    const at = Date.parse("2026-10-01T00:00:00.000Z")
    const long =
      "In integration, review the process used for the Mina migration and begin work on the Tezos migration in the main checkout."
    expect(Threads.called("Migrate Tezos Integration", long, "integration", at, now)).toBe("Migrate Tezos Integration")
    expect(Threads.called("Migrate Tezos Integration", "the Tezos migration", "integration", at, now)).toBe("the Tezos migration")
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
    expect(result.tezosHook).toEqual(Option.some({ machine: "Rosie", id: "tezos" }))
    expect(result.minaHook).toEqual(Option.some({ machine: "Rosie", id: "mina" }))
    // The newest first: the Mina one, which didn't have it, then the Tezos one; never the one in another directory.
    expect(result.reads.slice(0, result.first)).toEqual(["mina", "tezos"])
    expect(result.again).toEqual(Option.some({ machine: "Rosie", id: "tezos" }))
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
    expect(result.api).toEqual(Option.some({ machine: "Rosie", id: "tezos" }))
    expect(result.deep).toEqual(Option.some({ machine: "Rosie", id: "fees" }))
    // For the worktree's folder, the worktree's thread first, the nearest, though the project's is newer; never the one next to it.
    expect(result.reads).toEqual(["fees", "tezos"])
  })

  test("a hook is never linked while that machine's T3 Code isn't followed", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", "2026-10-08T20:00:00.000Z")
    const result = await Effect.gen(function* () {
      // T3 Code isn't running, or hasn't caught up.
      const away = yield* linking(Option.none(), { tezos: ["s-tezos"] })
      const unfollowed = yield* away.threads.link("Rosie", "s-tezos", "/code/integration")
      // Rig's hooks come through the tunnel, but its T3 Code isn't followed, even with the same directory and session as here.
      const here = yield* linking(Option.some(viewing(tezos)), { tezos: ["s-tezos"] })
      const rig = yield* here.threads.link("rig", "s-tezos", "/code/integration")
      return { unfollowed, rig, reads: [...away.reads, ...here.reads] }
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(result).toEqual({ unfollowed: Option.none(), rig: Option.none(), reads: [] })
  })
})
