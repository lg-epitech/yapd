import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import type * as Assistant from "./Assistant.ts"
import { Condenser } from "./Condenser.ts"
import type { Notice } from "./Inbox.ts"
import * as Journal from "./Journal.ts"
import * as Notices from "./Notices.ts"
import * as Persona from "./Persona.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import type * as Server from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"

const now = Date.parse("2026-10-08T22:00:00.000Z")
const minutes = (count: number) => new Date(now - count * 60_000).toISOString()

const thread = (id: string, title: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId: "p",
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    createdAt: minutes(600),
    updatedAt: minutes(1),
    ...overrides,
  })

/** A thread's latest turns, as T3 Code bounds them: its runs, what was said in them, its turn items and its agents' sessions. */
interface Bounded {
  readonly runs?: ReadonlyArray<Record<string, unknown>>
  readonly messages?: ReadonlyArray<Record<string, unknown>>
  readonly turnItems?: ReadonlyArray<Record<string, unknown>>
  readonly sessions?: ReadonlyArray<string>
  /** T3 Code's own record of each request, which keeps one its summary of the thread hides behind a newer one. */
  readonly runtimeRequests?: ReadonlyArray<Record<string, unknown>>
}

/** The thread's run ending, as T3Live tells of it: it was going, and now isn't. */
const ended = (after: T3Live.Thread, runId: string): T3Live.Change => ({ _tag: "Finished", thread: after, before: { ...after, activeRunId: runId } })

/** A failed run's error item, as T3 Code keeps it. */
const failure = (runId: string, kind: string, message: string, resetAt?: string) => ({
  type: "error",
  id: `terminal-failure:${runId}`,
  runId,
  status: "failed",
  failure: { class: kind, message, code: null, retryable: null, ...(resetAt === undefined ? {} : { resetAt }) },
})

const persona = Layer.succeed(Persona.Persona, {
  lines: Effect.succeed({ ...Persona.plain, address: "sir" }),
  onIt: () => Effect.succeed(Persona.plain.onIt),
  said: () => Effect.void,
})

/** The model, which words an approval, and a part of a question whose words can't be said as they are, kept in `rewritten`. */
const condenser = (rewritten: Array<string>) =>
  Layer.succeed(Condenser, {
    condense: () => Effect.die("not expected"),
    ask: () => Effect.succeed({ spoken: "wants to push the branch", risk: "low" as const }),
    question: (part) => Effect.sync(() => (rewritten.push(part.question), { spoken: "Which date helper should the fee table use?" })),
  })

/**
 * Notices on Rosie over a journal of its own, or one kept from before a
 * restart, and a T3 Code with the threads in `view`, whose bounded reads
 * are `bounded` says. What it says is said at once, to the end, unless it's
 * stale by then; and the Stop hooks that came are in `stops`.
 */
const notices = (
  given: {
    readonly view: ReadonlyArray<T3Live.Thread>
    readonly bounded: Readonly<Record<string, Bounded>>
    readonly stops?: ReadonlyMap<string, ReadonlyArray<Notices.Stop>>
    readonly store?: Store.Store["Type"]
    /** Reading the journal, as reading the desk does, waits for `resume` once it's begun, which `reading` says. */
    readonly slow?: { readonly reading: Deferred.Deferred<void>; readonly resume: Deferred.Deferred<void> }
    /** Rig, followed too, through a T3 Code of its own with these threads and reads, which can be seen once it's `up`. */
    readonly rig?: { readonly view: ReadonlyArray<T3Live.Thread>; readonly bounded: Readonly<Record<string, Bounded>> }
    /** Failures left to the Stops that told of them, with what says them, should what those told of be kept quiet. */
    readonly left?: Array<{ readonly stops: ReadonlyArray<Notices.Stop>; readonly failure: Effect.Effect<void> }>
    /** When yapd was last up before it started, and when it started, for what finished meanwhile. */
    readonly offline?: { readonly alive: Option.Option<number>; readonly started: number }
    /** Whether yapd is on, as it is unless said. */
    readonly on?: boolean
    /** The threads he muted, by key. */
    readonly muted?: ReadonlyArray<string>
    /** What yapd sent each thread for him, by its id, when and how T3 Code took it. */
    readonly sent?: Readonly<Record<string, ReadonlyArray<{ readonly at: number; readonly how: string }>>>
  },
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const store = given.store ?? (yield* Store.make(":memory:"))
    const kept = Journal.fromStore(store)
    const { slow } = given
    const journal: Journal.Journal["Type"] =
      slow === undefined
        ? kept
        : { ...kept, since: (at, options) => Deferred.succeed(slow.reading, undefined).pipe(Effect.zipRight(Deferred.await(slow.resume)), Effect.zipRight(kept.since(at, options))) }
    const changes = yield* Queue.unbounded<T3Live.Change>()
    let view: T3Live.View = {
      projects: new Map([["p", { id: "p", title: "integration", workspaceRoot: "/code/integration" }]]),
      threads: new Map(given.view.map((thread) => [thread.id, thread])),
      sequence: 1,
      synced: true,
    }
    /** Each machine's T3 Code, reading what `bounded` says, and noting which thread each read was of, by machine. */
    const reads: Array<string> = []
    const reaching = (machine: string, bounded: Readonly<Record<string, Bounded>>): Effect.Effect<Server.Transport, Server.Trouble> =>
      Effect.succeed({
        api: (<A, I>(path: string, schema: Schema.Schema<A, I>) => {
          const id = decodeURIComponent(path.split("/").at(-2) ?? "")
          reads.push(`${machine} ${id}`)
          const read = bounded[id] ?? {}
          const providerThreads = (read.sessions ?? []).map((nativeId) => ({ nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" } }))
          return Schema.decodeUnknown(schema)({
            projection: { runs: read.runs ?? [], messages: read.messages ?? [], turnItems: read.turnItems ?? [], providerThreads, runtimeRequests: read.runtimeRequests ?? [] },
          }).pipe(Effect.orDie)
        }) as Server.Transport["api"],
        call: (() => Effect.die("not expected")) as Server.Transport["call"],
        asset: () => Effect.die("not expected"),
      })
    /** Whether rig's threads can be seen, and what its T3 Code tells of. */
    let rigUp = false
    const rigChanges = yield* Queue.unbounded<T3Live.Change>()
    const rigView = (): T3Live.View => ({ ...view, threads: new Map((given.rig?.view ?? []).map((thread) => [thread.id, thread])) })
    const rigLive: T3Live.T3Live["Type"] = { view: Effect.sync(() => (rigUp ? Option.some(rigView()) : Option.none())), changes: Stream.fromQueue(rigChanges) }
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: { view: Effect.sync(() => Option.some(view)), changes: Stream.fromQueue(changes) },
      actions: Option.some(T3Actions.make(reaching("Rosie", given.bounded))),
      others:
        given.rig === undefined
          ? []
          : [{ machine: "rig", live: rigLive, actions: T3Actions.make(reaching("rig", given.rig.bounded)), status: Effect.succeed({ _tag: "Up" as const }) }],
      journal,
      store,
    })
    const told: Array<string> = []
    /** What was asked as the one question open, as the assistant asks it: kept under its key, or the entry it was kept under before, and heard to the end. */
    const asked: Array<string> = []
    /** And how it was worded, every part of it. */
    const worded: Array<Assistant.Asking> = []
    /** The parts of questions the model was asked to put in words that can be said. */
    const rewritten: Array<string> = []
    const settled: Array<string> = []
    /** The machines whose T3 Code caught up again, in turn. */
    const returned: Array<string> = []
    const finished: Array<{ readonly key: string; readonly message: string; readonly answering?: true }> = []
    /** The threads whose turn no hook told of was overtaken, by starting again or going. */
    const overtaken: Array<string> = []
    const tell = (notice: Notice) =>
      Effect.gen(function* () {
        if (yield* notice.stale) return
        yield* notice.saying ?? Effect.void
        told.push(notice.spoken)
        yield* notice.heard ?? Effect.void
      })
    const made = yield* Notices.make({
      threads,
      journal,
      tell,
      power: Effect.succeed({ on: given.on ?? true, turns: 1 }),
      stopped: (sessions) => Effect.sync(() => sessions.flatMap((session) => given.stops?.get(session) ?? []).toSorted((a, b) => a.at - b.at)),
      ...(given.left === undefined ? {} : { unheard: (stops, failure) => Effect.sync(() => void given.left?.push({ stops, failure })) }),
      finished: (input) => Effect.sync(() => void finished.push({ key: input.key, message: input.turn.message, ...(input.answering === true ? { answering: true as const } : {}) })),
      overtaken: (ref) => Effect.sync(() => void overtaken.push(ref.id)),
      mention: () => Effect.void,
      ask: (asking) =>
        Effect.gen(function* () {
          const kept = asking.kept === undefined ? yield* journal.claim(asking.entry) : Option.some(Option.some(asking.kept))
          if (Option.isNone(kept)) return
          asked.push(asking.asked)
          worded.push(asking)
          yield* journal.markHeard(Option.toArray(kept.value), now)
        }),
      settled: (requestId) => Effect.sync(() => void settled.push(requestId)),
      returned: (machine) => Effect.sync(() => void returned.push(machine)),
      shortest: 60_000,
      ...(given.offline === undefined ? {} : given.offline),
      muted: (keys) => Effect.succeed(Option.fromNullable(keys.find((key) => given.muted?.includes(key))).pipe(Option.map((key) => ({ key, at: 0 })))),
      sent: (to, since) => Effect.succeed((given.sent?.[to.id] ?? []).filter(({ at }) => at >= since)),
    }).pipe(Effect.provide(Layer.merge(persona, condenser(rewritten))))
    yield* Effect.forkScoped(made.follow)
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    return {
      ...made,
      store,
      journal,
      told,
      asked,
      worded,
      rewritten,
      settled,
      returned,
      finished,
      overtaken,
      /** T3 Code tells of these. */
      hear: (...happened: ReadonlyArray<T3Live.Change>) => Queue.offerAll(changes, happened).pipe(Effect.zipRight(flush)),
      /** Which machine's T3 Code each thread was read from. */
      reads,
      rig: {
        live: rigLive,
        /** Rig's T3 Code tells of these. */
        hear: (...happened: ReadonlyArray<T3Live.Change>) => Queue.offerAll(rigChanges, happened).pipe(Effect.zipRight(flush)),
        /** Rig can be reached, and its T3 Code has caught up, or it can't. */
        reached: (up: boolean) =>
          Effect.sync(() => {
            rigUp = up
          }),
      },
      /** T3 Code has the thread as it is now, without telling of it. */
      becomes: (thread: T3Live.Thread) =>
        Effect.sync(() => {
          view = { ...view, threads: new Map([...view.threads, [thread.id, thread]]) }
        }),
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
      flush,
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Notices", () => {
  test("a failed run is said once with its reason, and not again after a restart", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-1", lastErrorClass: "provider_error" })
    const bounded = {
      tezos: {
        runs: [{ id: "run-1", status: "failed", ordinal: 1, startedAt: minutes(5) }],
        turnItems: [failure("run-1", "provider_error", "API Error: 500 Internal server error")],
        sessions: ["s-tezos"],
      },
    }
    const result = await run(
      Effect.gen(function* () {
        const first = yield* notices({ view: [tezos], bounded })
        yield* first.hear(ended(tezos, "run-1"))
        // A hook that tells of it has ten seconds to come.
        yield* first.wait(9)
        const early = [...first.told]
        yield* first.wait(1)
        // yapd restarts, and hears of the same run again.
        const second = yield* notices({ view: [tezos], bounded, store: first.store })
        yield* second.hear(ended(tezos, "run-1"))
        yield* second.wait(10)
        return { early, told: first.told, again: second.told }
      }),
    )
    expect(result.early).toEqual([])
    expect(result.told).toEqual(["Migrate Tezos Integration failed, sir: the model provider had an error."])
    expect(result.again).toEqual([])
  })

  test("a run that finished with no hook is spoken after the grace, and one whose hook was skipped as quick is not", async () => {
    // Claude's hook for the Tezos turn came, and was skipped as quick by its own measure, though T3 Code's run is long enough to be
    // said; the Mina run failed, and its hook came too; nothing has hooks for the loader's agent.
    const tezos = thread("tezos", "Migrate Tezos Integration", { latestRunId: "run-1" })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { status: "failed", latestRunId: "run-3", lastErrorClass: "provider_error" })
    const loader = thread("loader", "Fix the loader", { latestRunId: "run-2", modelSelection: { instanceId: "opencode", model: "kimi-k3" } })
    const bounded = {
      tezos: {
        runs: [{ id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), userMessageId: "m1" }],
        messages: [{ id: "a1", runId: "run-1", role: "assistant", text: "Done, the fee table is in.", createdAt: minutes(0) }],
        sessions: ["s-tezos"],
      },
      mina: {
        runs: [{ id: "run-3", status: "failed", ordinal: 1, startedAt: minutes(5) }],
        turnItems: [failure("run-3", "provider_error", "API Error: 500 Internal server error")],
        sessions: ["s-mina"],
      },
      loader: {
        // Its checkpoint isn't taken yet, which is how a turn that went well first ends.
        runs: [{ id: "run-2", status: "waiting", ordinal: 1, startedAt: minutes(4), userMessageId: "m2" }],
        messages: [
          { id: "m2", runId: "run-2", role: "user", text: "Fix the loader.", createdAt: minutes(4) },
          { id: "a2", runId: "run-2", role: "assistant", text: "The loader is fixed.", createdAt: minutes(0) },
        ],
        sessions: ["oc-loader"],
      },
    }
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, finished, told } = yield* notices({
          view: [tezos, mina, loader],
          bounded,
          stops: new Map([
            ["s-tezos", [{ at: now - 2_000, message: "Done, the fee table is in." }]],
            ["s-mina", [{ at: now - 1_000, message: "The provider had an error, so I stopped." }]],
          ]),
        })
        yield* hear(ended(tezos, "run-1"), ended(mina, "run-3"), ended(loader, "run-2"))
        yield* wait(19)
        const early = [...finished]
        yield* wait(1)
        return { early, finished, told }
      }),
    )
    expect(result.early).toEqual([])
    expect(result.finished).toEqual([{ key: "done:Rosie:run-2", message: "The loader is fixed." }])
    // The failure its hook told of isn't said again.
    expect(result.told).toEqual([])
  })

  test("a failed run left to the Stop that told of it is said after all should what that Stop told of be kept quiet, as his muting the thread does", async () => {
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { status: "failed", latestRunId: "run-3", lastErrorClass: "provider_error" })
    const tezos = thread("tezos", "Migrate Tezos Integration", { latestRunId: "run-1" })
    const stop: Notices.Stop = { at: now - 1_000, message: "The provider had an error, so I stopped." }
    const result = await run(
      Effect.gen(function* () {
        const left: Array<{ readonly stops: ReadonlyArray<Notices.Stop>; readonly failure: Effect.Effect<void> }> = []
        const { hear, wait, told, finished } = yield* notices({
          view: [mina, tezos],
          bounded: {
            mina: {
              runs: [{ id: "run-3", status: "failed", ordinal: 1, startedAt: minutes(5) }],
              turnItems: [failure("run-3", "provider_error", "API Error: 500 Internal server error")],
              sessions: ["s-mina"],
            },
            // A run that went well, which its Stop told of: nothing of it is a failure to say, kept quiet or not.
            tezos: {
              runs: [{ id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), userMessageId: "m1" }],
              messages: [{ id: "a1", runId: "run-1", role: "assistant", text: "Done, the fee table is in.", createdAt: minutes(0) }],
              sessions: ["s-tezos"],
            },
          },
          stops: new Map([
            ["s-mina", [stop]],
            ["s-tezos", [{ at: now - 2_000, message: "Done, the fee table is in." }]],
          ]),
          left,
        })
        yield* hear(ended(mina, "run-3"), ended(tezos, "run-1"))
        yield* wait(20)
        expect(finished).toEqual([])
        const before = [...told]
        // What the Stop told of was kept quiet.
        for (const { failure } of left) yield* failure
        return { before, left: left.map(({ stops }) => stops), told }
      }),
    )
    expect(result.before).toEqual([])
    expect(result.left).toEqual([[stop]])
    expect(result.told).toEqual(["Open Mina SSV2 Bug Tickets failed, sir: the model provider had an error."])
  })

  test("a turn no hook told of that a message of yapd's started answers what he asked, so it's said however he muted its thread; one he typed in T3 Code doesn't", async () => {
    const loader = thread("loader", "Fix the loader", { latestRunId: "run-2", modelSelection: { instanceId: "opencode", model: "kimi-k3" } })
    const cache = thread("cache", "Fix the cache", { latestRunId: "run-4", modelSelection: { instanceId: "opencode", model: "kimi-k3" } })
    const ran = (runId: string, userMessageId: string, said: string) => ({
      runs: [{ id: runId, status: "completed", ordinal: 1, startedAt: minutes(4), userMessageId }],
      messages: [
        { id: userMessageId, runId, role: "user", text: "Go on.", createdAt: minutes(4) },
        { id: `a-${runId}`, runId, role: "assistant", text: said, createdAt: minutes(0) },
      ],
      sessions: [`oc-${runId}`],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, finished } = yield* notices({
          view: [loader, cache],
          bounded: { loader: ran("run-2", "yapd:u1:0:m", "The loader is fixed."), cache: ran("run-4", "m-typed", "The cache is fixed.") },
        })
        yield* hear(ended(loader, "run-2"), ended(cache, "run-4"))
        yield* wait(20)
        return finished.toSorted((one, other) => one.key.localeCompare(other.key))
      }),
    )
    expect(result).toEqual([
      { key: "done:Rosie:run-2", message: "The loader is fixed.", answering: true },
      { key: "done:Rosie:run-4", message: "The cache is fixed." },
    ])
  })

  test("a run that fails right after the one before it went well is said, though that one's Stop hook came after it started", async () => {
    // Each ran a message queued behind a turn that went well, which failed at once, the Mina one on the limit the turn before used up.
    // The earlier turn's Stop hook, a moment getting going, came after the next had started; Claude has no Stop for a failure.
    const tezos = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-2", lastErrorClass: "provider_error" })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { status: "failed", latestRunId: "run-2", lastErrorClass: "usage_limit" })
    const queued = (kind: string, message: string, resetAt?: string) => ({
      runs: [
        { id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), completedAt: new Date(now - 3_050).toISOString() },
        { id: "run-2", status: "failed", ordinal: 2, startedAt: new Date(now - 3_000).toISOString(), completedAt: new Date(now - 2_500).toISOString() },
      ],
      messages: [{ id: "a1", runId: "run-1", role: "assistant", text: "The fee table is in.", createdAt: minutes(0) }],
      turnItems: [failure("run-2", kind, message, resetAt)],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({
          view: [tezos, mina],
          bounded: {
            tezos: { ...queued("provider_error", "API Error: 500 Internal server error"), sessions: ["s-tezos"] },
            mina: { ...queued("usage_limit", "Claude usage limit reached.", "2026-10-08T23:00:00.000Z"), sessions: ["s-mina"] },
          },
          stops: new Map([
            ["s-tezos", [{ at: now - 2_700, message: "The fee table is in." }]],
            ["s-mina", [{ at: now - 2_300, message: "The fee table is in." }]],
          ]),
        })
        yield* hear(ended(tezos, "run-2"), ended(mina, "run-2"))
        yield* wait(10)
        return told
      }),
    )
    expect(result).toHaveLength(2)
    expect(result).toContain("Migrate Tezos Integration failed, sir: the model provider had an error.")
    expect(result.some((line) => /^Open Mina SSV2 Bug Tickets hit Claude's limit, sir; it resets at \d/.test(line))).toBe(true)
  })

  test("a run that fails at once after one that went well is said when that one's late Stop has words T3 Code kept otherwise, and left to a Stop that can't be that one's", async () => {
    // As above, but the turn before's Stop hook says what it said last otherwise than T3 Code keeps it, so its words are no run's that can be
    // told, and the failed run said nothing to tell its own by: when it came says it's the turn before's. The loader's turn before had its
    // Stop before it was done, so the one after the failed run started can't be that one's, and is left to as if it told of the failure.
    const failed = (id: string, title: string, kind: string) => thread(id, title, { status: "failed", latestRunId: "run-2", lastErrorClass: kind })
    const tezos = failed("tezos", "Migrate Tezos Integration", "provider_error")
    const mina = failed("mina", "Open Mina SSV2 Bug Tickets", "usage_limit")
    const loader = failed("loader", "Fix the loader", "provider_error")
    const queued = (session: string, kind: string, message: string, resetAt?: string) => ({
      runs: [
        { id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), completedAt: new Date(now - 3_050).toISOString() },
        { id: "run-2", status: "failed", ordinal: 2, startedAt: new Date(now - 3_000).toISOString(), completedAt: new Date(now - 2_500).toISOString() },
      ],
      messages: [{ id: `a-${session}`, runId: "run-1", role: "assistant", text: "The fee table is in.", createdAt: minutes(0) }],
      turnItems: [failure("run-2", kind, message, resetAt)],
      sessions: [session],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({
          view: [tezos, mina, loader],
          bounded: {
            tezos: queued("s-tezos", "provider_error", "API Error: 500 Internal server error"),
            mina: queued("s-mina", "usage_limit", "Claude usage limit reached.", "2026-10-08T23:00:00.000Z"),
            loader: queued("s-loader", "provider_error", "API Error: 500 Internal server error"),
          },
          stops: new Map([
            ["s-tezos", [{ at: now - 2_700, message: "Fee table: done and pushed to the branch." }]],
            ["s-mina", [{ at: now - 2_300, message: "Fee table: done and pushed to the branch." }]],
            [
              "s-loader",
              [
                { at: now - 4_500, message: "Fee table: done and pushed to the branch." },
                { at: now - 2_300, message: "The provider had an error, so I stopped." },
              ],
            ],
          ]),
        })
        yield* hear(ended(tezos, "run-2"), ended(mina, "run-2"), ended(loader, "run-2"))
        yield* wait(10)
        return told
      }),
    )
    expect(result).toHaveLength(2)
    expect(result).toContain("Migrate Tezos Integration failed, sir: the model provider had an error.")
    expect(result.some((line) => /^Open Mina SSV2 Bug Tickets hit Claude's limit, sir; it resets at \d/.test(line))).toBe(true)
  })

  test("a run that said something before it failed, right after one that went well, is said when that one's late Stop has words T3 Code kept otherwise, and left to a Stop with its own", async () => {
    // As above, but each failed run got a few words out first, which a Stop can't be told by when it has none: when the turn before's came
    // still says it's that one's. The loader's run had a Stop hook with its own words, which tell it's that run's, whenever it came.
    const failed = (id: string, title: string, kind: string) => thread(id, title, { status: "failed", latestRunId: "run-2", lastErrorClass: kind })
    const tezos = failed("tezos", "Migrate Tezos Integration", "provider_error")
    const mina = failed("mina", "Open Mina SSV2 Bug Tickets", "usage_limit")
    const loader = failed("loader", "Fix the loader", "provider_error")
    const queued = (session: string, kind: string, message: string, resetAt?: string) => ({
      runs: [
        { id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), completedAt: new Date(now - 3_050).toISOString() },
        { id: "run-2", status: "failed", ordinal: 2, startedAt: new Date(now - 3_000).toISOString(), completedAt: new Date(now - 1_500).toISOString() },
      ],
      messages: [
        { id: `a-${session}`, runId: "run-1", role: "assistant", text: "The fee table is in.", createdAt: minutes(1) },
        { id: `b-${session}`, runId: "run-2", role: "assistant", text: "Let me look at the tickets first.", createdAt: minutes(0) },
      ],
      turnItems: [failure("run-2", kind, message, resetAt)],
      sessions: [session],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({
          view: [tezos, mina, loader],
          bounded: {
            tezos: queued("s-tezos", "provider_error", "API Error: 500 Internal server error"),
            mina: queued("s-mina", "usage_limit", "Claude usage limit reached.", "2026-10-08T23:00:00.000Z"),
            loader: queued("s-loader", "provider_error", "API Error: 500 Internal server error"),
          },
          stops: new Map([
            ["s-tezos", [{ at: now - 2_700, message: "Fee table: done and pushed to the branch." }]],
            ["s-mina", [{ at: now - 2_700, message: "Fee table: done and pushed to the branch." }]],
            ["s-loader", [{ at: now - 2_700, message: "Let me look at the tickets first." }]],
          ]),
        })
        yield* hear(ended(tezos, "run-2"), ended(mina, "run-2"), ended(loader, "run-2"))
        yield* wait(10)
        return told
      }),
    )
    expect(result).toHaveLength(2)
    expect(result).toContain("Migrate Tezos Integration failed, sir: the model provider had an error.")
    expect(result.some((line) => /^Open Mina SSV2 Bug Tickets hit Claude's limit, sir; it resets at \d/.test(line))).toBe(true)
  })

  test("a run that fails at once after another that did, right after one that went well, is said when that one's late Stop came after both started", async () => {
    // Two messages were queued behind a turn that went well, and each failed at once, with no Stop of its own: the one Stop since, a moment
    // getting going and with words T3 Code kept otherwise, is the turn before's, which the failed run between doesn't hide.
    const failed = (id: string, title: string, kind: string) => thread(id, title, { status: "failed", latestRunId: "run-3", lastErrorClass: kind })
    const tezos = failed("tezos", "Migrate Tezos Integration", "provider_error")
    const mina = failed("mina", "Open Mina SSV2 Bug Tickets", "usage_limit")
    const queued = (session: string, kind: string, message: string, resetAt?: string) => ({
      runs: [
        { id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), completedAt: new Date(now - 3_050).toISOString() },
        { id: "run-2", status: "failed", ordinal: 2, startedAt: new Date(now - 3_000).toISOString(), completedAt: new Date(now - 2_950).toISOString() },
        { id: "run-3", status: "failed", ordinal: 3, startedAt: new Date(now - 2_900).toISOString(), completedAt: new Date(now - 2_850).toISOString() },
      ],
      messages: [{ id: `a-${session}`, runId: "run-1", role: "assistant", text: "The fee table is in.", createdAt: minutes(0) }],
      turnItems: [failure("run-2", kind, message, resetAt), failure("run-3", kind, message, resetAt)],
      sessions: [session],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({
          view: [tezos, mina],
          bounded: {
            tezos: queued("s-tezos", "provider_error", "API Error: 500 Internal server error"),
            mina: queued("s-mina", "usage_limit", "Claude usage limit reached.", "2026-10-08T23:00:00.000Z"),
          },
          stops: new Map([
            ["s-tezos", [{ at: now - 2_700, message: "Fee table: done and pushed to the branch." }]],
            ["s-mina", [{ at: now - 2_700, message: "Fee table: done and pushed to the branch." }]],
          ]),
        })
        yield* hear(ended(tezos, "run-3"), ended(mina, "run-3"))
        yield* wait(10)
        return told
      }),
    )
    expect(result).toHaveLength(2)
    expect(result).toContain("Migrate Tezos Integration failed, sir: the model provider had an error.")
    expect(result.some((line) => /^Open Mina SSV2 Bug Tickets hit Claude's limit, sir; it resets at \d/.test(line))).toBe(true)
  })

  test("a run that fails after one interrupted before it said anything, right after one that went well, is said when that one's late Stop came after it started", async () => {
    // A message sent and stopped at once, then sent again, which failed: the one interrupted said nothing and has no Stop of its own, so the
    // one Stop since, a moment getting going and with words T3 Code kept otherwise, is still the turn that went well's, not this one's.
    const tezos = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-3", lastErrorClass: "provider_error" })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({
          view: [tezos],
          bounded: {
            tezos: {
              runs: [
                { id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), completedAt: new Date(now - 3_050).toISOString() },
                { id: "run-2", status: "interrupted", ordinal: 2, startedAt: new Date(now - 3_020).toISOString(), completedAt: new Date(now - 3_010).toISOString() },
                { id: "run-3", status: "failed", ordinal: 3, startedAt: new Date(now - 3_000).toISOString(), completedAt: new Date(now - 1_500).toISOString() },
              ],
              messages: [
                { id: "a1", runId: "run-1", role: "assistant", text: "The fee table is in.", createdAt: minutes(1) },
                { id: "a3", runId: "run-3", role: "assistant", text: "Let me look at the tickets first.", createdAt: minutes(0) },
              ],
              turnItems: [failure("run-3", "provider_error", "API Error: 500 Internal server error")],
              sessions: ["s-tezos"],
            },
          },
          stops: new Map([["s-tezos", [{ at: now - 2_700, message: "Fee table: done and pushed to the branch." }]]]),
        })
        yield* hear(ended(tezos, "run-3"))
        yield* wait(10)
        return told
      }),
    )
    expect(result).toEqual(["Migrate Tezos Integration failed, sir: the model provider had an error."])
  })

  test("a short turn of yapd's right after the one before it is left to its own hook, however late or early that one's came", async () => {
    // yapd's message waited behind a turn that went well, and ran in a few seconds: its own Stop came after the earlier one's, which
    // came late for the Tezos thread, after it had started, and early for the loader, before the earlier run's checkpoint was taken.
    const tezos = thread("tezos", "Migrate Tezos Integration", { latestRunId: "run-2" })
    const loader = thread("loader", "Fix the loader", { latestRunId: "run-2" })
    const queued = (id: string) => ({
      runs: [
        { id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), completedAt: new Date(now - 3_050).toISOString() },
        { id: "run-2", status: "completed", ordinal: 2, startedAt: new Date(now - 3_000).toISOString(), userMessageId: `yapd:${id}` },
      ],
      messages: [
        { id: `b-${id}`, runId: "run-1", role: "assistant", text: "The PR is ready.", createdAt: minutes(1) },
        { id: `a-${id}`, runId: "run-2", role: "assistant", text: "Done, the fee table is in.", createdAt: minutes(0) },
      ],
      sessions: [`s-${id}`],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, finished } = yield* notices({
          view: [tezos, loader],
          bounded: { tezos: queued("tezos"), loader: queued("loader") },
          stops: new Map([
            ["s-tezos", [{ at: now - 2_700, message: "The PR is ready." }, { at: now - 500, message: "Done, the fee table is in." }]],
            ["s-loader", [{ at: now - 4_500, message: "The PR is ready." }, { at: now - 1_000, message: "Done, the fee table is in." }]],
          ]),
        })
        yield* hear(ended(tezos, "run-2"), ended(loader, "run-2"))
        yield* wait(20)
        return finished
      }),
    )
    expect(result).toEqual([])
  })

  test("a short turn of yapd's right after one that had no Stop is left to its own Stop, which has its last words, however soon after the other ended it came", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", { latestRunId: "run-2" })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, finished } = yield* notices({
          view: [tezos],
          bounded: {
            tezos: {
              runs: [
                { id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), completedAt: new Date(now - 3_050).toISOString() },
                { id: "run-2", status: "completed", ordinal: 2, startedAt: new Date(now - 3_000).toISOString(), userMessageId: "yapd:followup" },
              ],
              messages: [
                { id: "a1", runId: "run-1", role: "assistant", text: "The PR is ready.", createdAt: minutes(1) },
                { id: "a2", runId: "run-2", role: "assistant", text: "I did the follow-up.", createdAt: minutes(0) },
              ],
              sessions: ["s-tezos"],
            },
          },
          // The turn before had none, as when its hook was off; this one's came within five seconds of that one's end.
          stops: new Map([["s-tezos", [{ at: now - 500, message: "I did the follow-up." }]]]),
        })
        yield* hear(ended(tezos, "run-2"))
        yield* wait(20)
        return finished
      }),
    )
    expect(result).toEqual([])
  })

  test("a turn no hook told of isn't said once its thread started again while it was being looked into, however long that took", async () => {
    const old = thread("loader", "Fix the loader", { latestRunId: "run-1" })
    const next = thread("loader", "Fix the loader", { latestRunId: "run-2", activeRunId: "run-2", status: "running" })
    const result = await run(
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const made = yield* notices({
          view: [old],
          bounded: {
            loader: {
              runs: [{ id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), userMessageId: "m1" }],
              messages: [{ id: "a1", runId: "run-1", role: "assistant", text: "The loader is fixed.", createdAt: minutes(0) }],
            },
          },
          slow: { reading, resume },
        })
        yield* made.hear(ended(old, "run-1"))
        yield* made.wait(20)
        // It's read as the latest, then the desk is slow to say what it's called, and meanwhile he follows it up in T3 Code.
        yield* Deferred.await(reading)
        yield* made.becomes(next)
        yield* made.hear({ _tag: "Started", thread: next })
        yield* Deferred.succeed(resume, undefined)
        yield* made.flush
        return { finished: made.finished, overtaken: made.overtaken }
      }),
    )
    expect(result).toEqual({ finished: [], overtaken: ["loader"] })
  })

  test("a turn no hook told of isn't said once its thread started again or went, as a hook's update isn't once the next prompt comes", async () => {
    const loader = thread("loader", "Fix the loader", { latestRunId: "run-2", modelSelection: { instanceId: "opencode", model: "kimi-k3" } })
    const bounded = {
      loader: {
        runs: [{ id: "run-2", status: "completed", ordinal: 1, startedAt: minutes(4), userMessageId: "m2" }],
        messages: [{ id: "a2", runId: "run-2", role: "assistant", text: "The loader is fixed.", createdAt: minutes(0) }],
        sessions: ["oc-loader"],
      },
    }
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, becomes, finished, overtaken } = yield* notices({ view: [loader], bounded })
        yield* hear(ended(loader, "run-2"))
        // He follows it up in T3 Code within the grace, so it starts again.
        yield* wait(5)
        const again = { ...loader, activeRunId: "run-3", latestRunId: "run-3" }
        yield* becomes(again)
        yield* hear({ _tag: "Started", thread: again }, { _tag: "Removed", thread: again })
        yield* wait(15)
        return { finished, overtaken }
      }),
    )
    expect(result.finished).toEqual([])
    // And what was waiting to be said of it, if anything was, isn't.
    expect(result.overtaken).toEqual(["loader", "loader"])
  })

  /** The Tezos one's approval to push, with the command it's for, as T3 Code shows them. */
  const pushing = [
    { type: "approval_request", status: "waiting", requestId: "r1", requestKind: "command", prompt: "Bash: git push origin tezos", nativeItemRef: { nativeId: "toolu_1" } },
    { type: "command_execution", status: "running", input: "git push origin tezos", nativeItemRef: { nativeId: "toolu_1" } },
  ]

  /** A question as T3 Code shows it, with nothing to pick from. */
  const asking = (requestId: string, question: string) => [{ type: "user_input_request", status: "waiting", requestId, questions: [{ id: "q", question }] }]

  test("an approval is never announced, as it comes or after a restart, while a question still is", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", { activeRunId: "run-1", pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: minutes(1) } })
    // An MCP server's form is an approval too; the billing one's can't be read; and the loader's adapter shows its approval as a question.
    const deploy = thread("deploy", "Cloud deployment discovery", { activeRunId: "run-2", pendingRuntimeRequest: { id: "r2", kind: "mcp-elicitation", createdAt: minutes(1) } })
    const billing = thread("billing", "Billing export", { activeRunId: "run-5", pendingRuntimeRequest: { id: "r5", kind: "file-change", createdAt: minutes(1) } })
    const loader = thread("loader", "Fix the loader", { activeRunId: "run-3", pendingRuntimeRequest: { id: "r3", kind: "user_input", createdAt: minutes(1) } })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { activeRunId: "run-4", pendingRuntimeRequest: { id: "r4", kind: "user_input", createdAt: minutes(1) } })
    const bounded = {
      tezos: { turnItems: pushing },
      deploy: { turnItems: [{ type: "approval_request", status: "waiting", requestId: "r2", requestKind: "mcp-elicitation", prompt: "Let the deploy server read the cluster" }] },
      loader: { turnItems: [{ type: "approval_request", status: "waiting", requestId: "r3", requestKind: "command", prompt: "Bash: rm -rf dist" }] },
      mina: { turnItems: asking("r4", "Which database?") },
    }
    const view = [tezos, deploy, billing, loader, mina]
    const result = await run(
      Effect.gen(function* () {
        const live = yield* notices({ view, bounded })
        yield* live.hear(...view.map((waiting): T3Live.Change => ({ _tag: "Asked", thread: waiting, request: waiting.pendingRuntimeRequest! })))
        // Past the while a card that can't be read is read again for, like the billing one's, which would be told after.
        yield* live.wait(3)
        // yapd restarts with none of them heard, or is turned on.
        const restarted = yield* notices({ view, bounded })
        yield* restarted.reconcile
        yield* restarted.wait(3)
        return { live: [...live.told, ...live.asked], restarted: [...restarted.told, ...restarted.asked] }
      }),
    )
    const question = "A question on Open Mina SSV2 Bug Tickets, sir: Which database?"
    expect(result).toEqual({ live: [question], restarted: [question] })
  })

  test("a question the thread shows before its card can be read is still asked once the card is there, never only told", async () => {
    // T3 Code writes what a thread waits on and the card that asks it apart: the Tezos one's card comes a moment later, the Mina one's never.
    const tezos = thread("tezos", "Migrate Tezos Integration", { activeRunId: "run-1", pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: minutes(0) } })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { activeRunId: "run-2", pendingRuntimeRequest: { id: "r2", kind: "user_input", createdAt: minutes(0) } })
    const bounded: Record<string, Bounded> = { tezos: {}, mina: {} }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [tezos, mina], bounded })
        yield* made.hear({ _tag: "Asked", thread: tezos, request: tezos.pendingRuntimeRequest! }, { _tag: "Asked", thread: mina, request: mina.pendingRuntimeRequest! })
        yield* made.wait(0.25)
        yield* made.wait(0.25)
        const early = [...made.told, ...made.asked]
        bounded.tezos = { turnItems: asking("r1", "Which fee table?") }
        for (let step = 0; step < 8; step++) yield* made.wait(0.25)
        return { early, told: made.told, asked: made.asked }
      }),
    )
    expect(result).toEqual({
      early: [],
      told: ["Open Mina SSV2 Bug Tickets has a question for you, sir: it's waiting for you in T3 Code."],
      asked: ["A question on Migrate Tezos Integration, sir: Which fee table?"],
    })
  })

  test("a question is asked in its own words with no model call when they can be said, and only a part that can't is rewritten", async () => {
    const question = (header: string, asked: string, options: ReadonlyArray<string>) => ({ id: asked, question: asked, options: options.map((label) => ({ label, description: "" })), ...(header === "" ? {} : { header }) })
    const tezos = thread("tezos", "Migrate Tezos Integration", { activeRunId: "run-1", pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: minutes(0) } })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { activeRunId: "run-2", pendingRuntimeRequest: { id: "r2", kind: "user_input", createdAt: minutes(0) } })
    const tricky = "Should it import `formatDate` from src/utils/date.ts or date-fns?"
    const bounded = {
      tezos: {
        turnItems: [
          {
            type: "user_input_request",
            status: "waiting",
            requestId: "r1",
            questions: [question("Colour", "Which colour should the test use?", ["Red", "Blue (Recommended)"]), question("Dates", tricky, ["The helper", "date-fns"])],
          },
        ],
      },
      mina: { turnItems: [{ type: "user_input_request", status: "waiting", requestId: "r2", questions: [question("", "Should I also file the rounding bug?", [])] }] },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [tezos, mina], bounded })
        yield* made.hear({ _tag: "Asked", thread: tezos, request: tezos.pendingRuntimeRequest! }, { _tag: "Asked", thread: mina, request: mina.pendingRuntimeRequest! })
        const [colour] = made.worded.filter(({ ref }) => ref.id === "tezos")
        return {
          asked: made.asked.toSorted(),
          rewritten: made.rewritten,
          asks: colour?.asks,
          last: colour?.parts?.[1]?.last("Red"),
        }
      }),
    )
    expect(result.asked).toEqual([
      "A question on Open Mina SSV2 Bug Tickets, sir: Should I also file the rounding bug?",
      "Two questions on Migrate Tezos Integration, sir. First: Which colour should the test use? Red or Blue? I'd go with Blue.",
    ])
    expect(result.rewritten).toEqual([tricky])
    expect(result.last).toBe("Red, sir. And last: Which date helper should the fee table use? The helper or date-fns?")
    expect(result.asks).toMatchObject({ _tag: "Question", requestId: "r1", mode: "live", part: 0, collected: {}, inFull: false })
  })

  test("a pending question is announced once after a restart, and not at all if it was already said", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", {
      activeRunId: "run-1",
      pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: minutes(60) },
    })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", {
      activeRunId: "run-2",
      pendingRuntimeRequest: { id: "r2", kind: "user_input", createdAt: minutes(60) },
    })
    // Never said, the loader's approval stays silent all the same.
    const loader = thread("loader", "Fix the loader", { activeRunId: "run-3", pendingRuntimeRequest: { id: "r3", kind: "command", createdAt: minutes(60) } })
    const bounded = {
      tezos: { turnItems: asking("r1", "Which fee table?") },
      mina: { turnItems: asking("r2", "Which database?") },
      loader: { turnItems: pushing.map((item) => ({ ...item, requestId: "r3" })) },
    }
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        // The Mina question was said before the restart, and heard.
        const said = yield* Journal.fromStore(store).claim({ at: now - 3_000_000, kind: "notice", machine: "Rosie", thread: "mina", key: "ask:Rosie:r2", said: "It asks which database." })
        yield* Journal.fromStore(store).markHeard(Option.toArray(Option.flatten(said)), now - 2_990_000)
        const first = yield* notices({ view: [tezos, mina, loader], bounded, store })
        yield* first.reconcile
        yield* first.flush
        // And yapd restarts again.
        const second = yield* notices({ view: [tezos, mina, loader], bounded, store })
        yield* second.reconcile
        yield* second.flush
        return { first: [...first.told, ...first.asked], second: [...second.told, ...second.asked] }
      }),
    )
    expect(result.first).toEqual(["A question on Migrate Tezos Integration, sir: Which fee table?"])
    expect(result.second).toEqual([])
  })

  test("a pending question begun before a restart and never heard to the end is asked again after it, under the entry it was kept under, once", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", {
      activeRunId: "run-1",
      pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: minutes(60) },
    })
    const bounded = { tezos: { turnItems: asking("r1", "Which fee table?") } }
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        // It was coming up to be asked, kept under its key, when yapd restarted.
        yield* Journal.fromStore(store).claim({ at: now - 60_000, kind: "notice", machine: "Rosie", thread: "tezos", key: "ask:Rosie:r1", said: "It asks which fee table." })
        const first = yield* notices({ view: [tezos], bounded, store })
        yield* first.reconcile
        yield* first.flush
        const kept = yield* first.journal.since(0, { kinds: ["notice"] })
        // Heard this time, it isn't asked after another restart.
        const second = yield* notices({ view: [tezos], bounded, store })
        yield* second.reconcile
        yield* second.flush
        return { first: first.asked, kept: kept.map(({ key, heardAt }) => [key, heardAt !== undefined]), second: second.asked }
      }),
    )
    expect(result.first).toEqual(["A question on Migrate Tezos Integration, sir: Which fee table?"])
    expect(result.kept).toEqual([["ask:Rosie:r1", true]])
    expect(result.second).toEqual([])
  })

  test("a request still waiting behind a newer one asked alongside it isn't taken for answered, and one that was is", async () => {
    const pending = (id: string) => ({ id, kind: "command", createdAt: minutes(1) })
    // Each asked two things; T3 Code's summary shows the newer. The Tezos one's first still waits; the Mina one's was answered.
    const tezos = thread("tezos", "Migrate Tezos Integration", { activeRunId: "run-1", pendingRuntimeRequest: pending("r2") })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { activeRunId: "run-2", pendingRuntimeRequest: pending("r4") })
    const bounded = {
      tezos: { runtimeRequests: [{ id: "r1", status: "pending" }, { id: "r2", status: "pending" }] },
      mina: { runtimeRequests: [{ id: "r3", status: "resolved" }, { id: "r4", status: "pending" }] },
    }
    const result = await run(
      Effect.gen(function* () {
        const { hear, settled } = yield* notices({ view: [tezos, mina], bounded })
        yield* hear({ _tag: "Answered", thread: tezos, request: pending("r1") }, { _tag: "Answered", thread: mina, request: pending("r3") })
        return settled
      }),
    )
    expect(result).toEqual(["r3"])
  })

  test("a usage limit is said once per window, however many threads hit it", async () => {
    const limited = (id: string, title: string, runId: string) =>
      thread(id, title, { status: "failed", latestRunId: runId, lastErrorClass: "usage_limit", usageLimitResetAt: "2026-10-08T23:00:00.000Z" })
    const tezos = limited("tezos", "Migrate Tezos Integration", "run-1")
    const mina = limited("mina", "Open Mina SSV2 Bug Tickets", "run-2")
    const limit = (runId: string) => ({
      runs: [{ id: runId, status: "failed", ordinal: 1, startedAt: minutes(3) }],
      turnItems: [failure(runId, "usage_limit", "Claude usage limit reached.", "2026-10-08T23:00:00.000Z")],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({ view: [tezos, mina], bounded: { tezos: limit("run-1"), mina: limit("run-2") } })
        yield* hear(ended(tezos, "run-1"), ended(mina, "run-2"))
        yield* wait(10)
        return told
      }),
    )
    // Whichever is looked at first.
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/^(Migrate Tezos Integration|Open Mina SSV2 Bug Tickets) hit Claude's limit, sir; it resets at \d/)
  })

  test("a usage limit is said once until it resets, though T3 Code only knew when by the time the next thread hit it", async () => {
    // Codex's reset is only known once its usage shows full, which can be after the first thread failed on it.
    const codex = { instanceId: "codex", model: "gpt-6" }
    const limited = (id: string, title: string, runId: string, resetAt?: string) =>
      thread(id, title, { status: "failed", latestRunId: runId, lastErrorClass: "usage_limit", modelSelection: codex, usageLimitResetAt: resetAt ?? null })
    const tezos = limited("tezos", "Migrate Tezos Integration", "run-1")
    const mina = limited("mina", "Open Mina SSV2 Bug Tickets", "run-2", "2026-10-09T03:00:00.000Z")
    const loader = limited("loader", "Fix the loader", "run-3", "2026-10-09T08:00:00.000Z")
    const limit = (runId: string, resetAt?: string) => ({
      runs: [{ id: runId, status: "failed", ordinal: 1, startedAt: minutes(3) }],
      turnItems: [failure(runId, "usage_limit", "You've hit your usage limit.", resetAt)],
    })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({
          view: [tezos, mina, loader],
          bounded: { tezos: limit("run-1"), mina: limit("run-2", "2026-10-09T03:00:00.000Z"), loader: limit("run-3", "2026-10-09T08:00:00.000Z") },
        })
        yield* hear(ended(tezos, "run-1"))
        yield* wait(10)
        yield* hear(ended(mina, "run-2"))
        yield* wait(10)
        const once = [...told]
        // It reset, and the loader hit it again.
        yield* wait(5 * 60 * 60)
        yield* hear(ended(loader, "run-3"))
        yield* wait(10)
        return { once, told }
      }),
    )
    expect(result.once).toEqual(["Migrate Tezos Integration hit Codex's limit, sir."])
    expect(result.told).toHaveLength(2)
    expect(result.told[1]).toMatch(/^Fix the loader hit Codex's limit, sir; it resets at \d/)
  })

  test("a limit whose reset nobody said doesn't hide one hit hours later that resets past when the first could have", async () => {
    // A Claude 429 is classed as the limit, with no reset; three hours later the real limit is hit, in a window begun since.
    const tezos = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-1", lastErrorClass: "usage_limit" })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", { status: "failed", latestRunId: "run-2", lastErrorClass: "usage_limit", usageLimitResetAt: "2026-10-09T04:00:00.000Z" })
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told } = yield* notices({
          view: [tezos, mina],
          bounded: {
            tezos: { runs: [{ id: "run-1", status: "failed", ordinal: 1, startedAt: minutes(3) }], turnItems: [failure("run-1", "usage_limit", "Claude API rate limit reached.")] },
            mina: {
              runs: [{ id: "run-2", status: "failed", ordinal: 1, startedAt: minutes(3) }],
              turnItems: [failure("run-2", "usage_limit", "Claude usage limit reached.", "2026-10-09T04:00:00.000Z")],
            },
          },
        })
        yield* hear(ended(tezos, "run-1"))
        yield* wait(10)
        yield* wait(3 * 60 * 60)
        yield* hear(ended(mina, "run-2"))
        yield* wait(10)
        return told
      }),
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toBe("Migrate Tezos Integration hit Claude's limit, sir.")
    expect(result[1]).toMatch(/^Open Mina SSV2 Bug Tickets hit Claude's limit, sir; it resets at \d/)
  })

  test("what a rig thread asks, and a run of one that fails, are heard from rig's T3 Code, read from rig's, named as rig's and kept under rig's keys", async () => {
    const fees = thread("fees", "Fee table checks", { activeRunId: "run-1", pendingRuntimeRequest: { id: "q9", kind: "user_input", createdAt: minutes(1) } })
    const loader = thread("loader", "Fix the loader", { status: "failed", latestRunId: "run-2", lastErrorClass: "provider_error" })
    const rig = {
      view: [fees, loader],
      bounded: {
        fees: { turnItems: asking("q9", "Which fee table?") },
        loader: {
          runs: [{ id: "run-2", status: "failed", ordinal: 1, startedAt: minutes(5) }],
          turnItems: [failure("run-2", "provider_error", "API Error: 500 Internal server error")],
          sessions: ["s-loader"],
        },
      },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, rig })
        yield* made.rig.reached(true)
        yield* made.rig.hear({ _tag: "Asked", thread: fees, request: fees.pendingRuntimeRequest! }, ended(loader, "run-2"))
        yield* made.wait(10)
        const kept = yield* made.journal.since(0, { kinds: ["notice"] })
        return { asked: made.asked, refs: made.worded.map(({ ref }) => ref), told: made.told, reads: [...new Set(made.reads)], kept: kept.map(({ key, machine }) => [key, machine]) }
      }),
    )
    expect(result.asked).toEqual(["A question on Fee table checks on rig, sir: Which fee table?"])
    expect(result.refs).toEqual([{ machine: "rig", id: "fees" }])
    expect(result.told).toEqual(["Fix the loader on rig failed, sir: the model provider had an error."])
    expect(result.reads.toSorted()).toEqual(["rig fees", "rig loader"])
    expect(result.kept.toSorted()).toEqual([
      ["ask:rig:q9", "rig"],
      ["fail:rig:run-2", "rig"],
    ])
  })

  test("a rig question still waiting after a restart, begun and never heard, is asked again once rig's T3 Code catches up, under the entry it was kept under, and only once", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", { activeRunId: "run-1", pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: minutes(60) } })
    const fees = thread("fees", "Fee table checks", { activeRunId: "run-9", pendingRuntimeRequest: { id: "q9", kind: "user_input", createdAt: minutes(60) } })
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        // It was coming up to be asked, kept under its key, when yapd restarted.
        yield* Journal.fromStore(store).claim({ at: now - 60_000, kind: "notice", machine: "rig", thread: "fees", key: "ask:rig:q9", said: "It asks which fee table." })
        const made = yield* notices({
          view: [tezos],
          bounded: { tezos: { turnItems: asking("r1", "Which network?") } },
          store,
          rig: { view: [fees], bounded: { fees: { turnItems: asking("q9", "Which fee table?") } } },
        })
        // Each machine looks once its own T3 Code has caught up: this one's at once, rig's only once it can be reached.
        yield* Effect.forkScoped(Notices.lookBack(made, Effect.succeed(Option.some(true)), "Rosie"))
        yield* Effect.forkScoped(Notices.lookBack(made, made.rig.live.view, "rig"))
        yield* made.wait(1)
        const down = [...made.asked]
        yield* made.rig.reached(true)
        yield* made.wait(1)
        const back = made.worded.map(({ ref, kept }) => ({ ref, kept: kept !== undefined }))
        // Rig drops out and comes back, and yapd is turned on: heard by now, it isn't asked again.
        yield* made.rig.reached(false)
        yield* made.wait(1)
        yield* made.rig.reached(true)
        yield* made.wait(1)
        yield* made.reconcile
        yield* made.flush
        const kept = yield* made.journal.since(0, { kinds: ["notice"] })
        return { down, asked: made.asked, back, kept: kept.map(({ key, heardAt }) => [key, heardAt !== undefined]).toSorted(), returned: made.returned }
      }),
    )
    // Each time a machine's T3 Code caught up, what was put by while it couldn't be seen is asked.
    expect(result.returned).toEqual(["Rosie", "rig", "rig"])
    // Rig being down held up nothing here.
    expect(result.down).toEqual(["A question on Migrate Tezos Integration, sir: Which network?"])
    expect(result.asked).toEqual(["A question on Migrate Tezos Integration, sir: Which network?", "A question on Fee table checks on rig, sir: Which fee table?"])
    expect(result.back).toEqual([
      { ref: { machine: "Rosie", id: "tezos" }, kept: false },
      { ref: { machine: "rig", id: "fees" }, kept: true },
    ])
    expect(result.kept).toEqual([
      ["ask:Rosie:r1", true],
      ["ask:rig:q9", true],
    ])
  })

  describe("while yapd was offline", () => {
    const alive = now - 60 * 60_000
    const started = now - 60_000
    const done = (id: string, title: string, at: number, overrides: Record<string, unknown> = {}) =>
      thread(id, title, { latestRunId: `run-${id}`, latestRunCompletedAt: new Date(at).toISOString(), ...overrides })
    const view = [
      done("tezos", "Migrate Tezos Integration", now - 30 * 60_000),
      done("mina", "Open Mina SSV2 Bug Tickets", now - 20 * 60_000, { status: "failed", lastErrorClass: "provider_error" }),
      done("noisy", "Watch the linter", now - 25 * 60_000),
      // Before it went down, after it started, still running, or kept since it was last up: none of these.
      done("old", "Old work", now - 90 * 60_000),
      done("live", "Live work", now - 30_000),
      done("busy", "Busy work", now - 40 * 60_000, { activeRunId: "run-2", activityRunStatus: "running" }),
      done("told", "Told work", now - 45 * 60_000),
    ]
    const bounded = {
      mina: {
        runs: [{ id: "run-mina", status: "failed", ordinal: 1, startedAt: minutes(25) }],
        turnItems: [failure("run-mina", "provider_error", "API Error: 500 Internal server error")],
      },
    }
    const held = (detail: unknown) => (detail as { session?: string; held?: string; muted?: boolean } | undefined) ?? {}

    test("runs that finished while yapd was down are held for later, not said, under the key T3 Code's word would say them under, while failures are said", async () => {
      const result = await run(
        Effect.gen(function* () {
          const made = yield* notices({ view, bounded, offline: { alive: Option.some(alive), started }, muted: ["t3:Rosie:noisy"] })
          yield* made.journal.write({ at: now - 10 * 60_000, kind: "update", machine: "Rosie", thread: "told", said: "Told work is done." })
          yield* made.reconcileOn("Rosie")
          yield* made.flush
          // Its T3 Code catching up again says nothing more.
          yield* made.reconcileOn("Rosie")
          yield* made.flush
          const kept = yield* made.journal.since(0, { kinds: ["update"] })
          const again = yield* made.journal.claim({ at: now, kind: "update", key: "done:Rosie:run-tezos" })
          return { told: [...made.told], kept: kept.map(({ thread, said, key, detail }) => [thread, said, key, held(detail)]), again: Option.isSome(again) }
        }),
      )
      expect(result.told).toEqual(["Open Mina SSV2 Bug Tickets failed, sir: the model provider had an error."])
      expect(result.kept).toEqual([
        ["tezos", "Migrate Tezos Integration finished while I was offline, sir.", "done:Rosie:run-tezos", { session: "finished:Rosie:tezos", held: "offline" }],
        ["noisy", "Watch the linter finished while I was offline, sir.", "done:Rosie:run-noisy", { session: "finished:Rosie:noisy", muted: true }],
        ["told", "Told work is done.", undefined, {}],
      ])
      expect(result.again).toBe(false)
    })

    test("the answer to a message he sent, finished while yapd was down, is summed up and said however he muted the thread, while a run he stopped or likely watched is nothing to tell", async () => {
      const ended = (id: string, minutesAgo: number) => now - minutesAgo * 60_000
      const ran = (id: string, status: string, started: number, at: number, userMessageId: string) => ({
        runs: [{ id: `run-${id}`, status, ordinal: 1, startedAt: new Date(started).toISOString(), completedAt: new Date(at).toISOString(), userMessageId }],
        messages: [
          { id: userMessageId, runId: `run-${id}`, role: "user", text: "Use the fee table.", createdAt: new Date(started).toISOString() },
          { id: `a-${id}`, runId: `run-${id}`, role: "assistant", text: "The fee table is in.", createdAt: new Date(at).toISOString() },
        ],
      })
      const threads = [
        done("answer", "Answer the fee question", ended("answer", 35)),
        done("stopped", "Stopped work", ended("stopped", 33)),
        done("glance", "Glanced work", ended("glance", 32)),
        done("typed", "Typed work", ended("typed", 31)),
        done("steered", "Steered work", ended("steered", 34)),
        done("behind", "Work he queued behind", ended("behind", 36)),
      ]
      const reads = {
        answer: ran("answer", "completed", ended("answer", 40), ended("answer", 35), "yapd:u1:0:m"),
        stopped: ran("stopped", "interrupted", ended("stopped", 40), ended("stopped", 33), "yapd:u2:0:m"),
        glance: ran("glance", "completed", ended("glance", 32) - 30_000, ended("glance", 32), "m-typed"),
        typed: ran("typed", "completed", ended("typed", 40), ended("typed", 31), "m-typed-2"),
        steered: ran("steered", "completed", ended("steered", 40), ended("steered", 34), "m-typed-3"),
        behind: ran("behind", "completed", ended("behind", 40), ended("behind", 36), "m-typed-4"),
      }
      const result = await run(
        Effect.gen(function* () {
          const made = yield* notices({
            view: threads,
            bounded: reads,
            offline: { alive: Option.some(alive), started },
            muted: ["t3:Rosie:answer"],
            // He steered a message into one run, and queued one behind another, which is still to start.
            sent: { steered: [{ at: ended("steered", 38), how: "steered" }], behind: [{ at: ended("behind", 38), how: "queued" }] },
          })
          yield* made.reconcileOn("Rosie")
          yield* made.flush
          const kept = yield* made.journal.since(0, { kinds: ["update"] })
          return { finished: [...made.finished], told: [...made.told], kept: kept.map(({ thread, key, detail }) => [thread, key, held(detail)]) }
        }),
      )
      expect(result.finished).toEqual([
        { key: "done:Rosie:run-steered", message: "The fee table is in.", answering: true },
        { key: "done:Rosie:run-answer", message: "The fee table is in.", answering: true },
      ])
      expect(result.told).toEqual([])
      expect(result.kept).toEqual([
        ["behind", "done:Rosie:run-behind", { session: "finished:Rosie:behind", held: "offline" }],
        ["typed", "done:Rosie:run-typed", { session: "finished:Rosie:typed", held: "offline" }],
      ])
    })

    test("a run whose hook update was kept under its session since yapd was last up, its thread not told in time, isn't held again", async () => {
      const result = await run(
        Effect.gen(function* () {
          const made = yield* notices({
            view: [done("tezos", "Migrate Tezos Integration", now - 30 * 60_000), done("mina", "Open Mina SSV2 Bug Tickets", now - 20 * 60_000)],
            bounded: {
              tezos: { runs: [{ id: "run-tezos", status: "completed", ordinal: 1, startedAt: minutes(45), completedAt: minutes(30) }], sessions: ["native-tezos"] },
              mina: { runs: [{ id: "run-mina", status: "completed", ordinal: 1, startedAt: minutes(45), completedAt: minutes(20) }], sessions: ["native-mina"] },
            },
            offline: { alive: Option.some(alive), started },
          })
          yield* made.journal.write({ at: now - 30 * 60_000, kind: "update", thread: "claude:native-tezos", said: "Tezos is migrated." })
          // Before yapd was last up, it's no word on this run.
          yield* made.journal.write({ at: alive - 60_000, kind: "update", thread: "claude:native-mina", said: "Mina's tickets are half done." })
          yield* made.reconcileOn("Rosie")
          yield* made.flush
          return (yield* made.journal.since(0, { kinds: ["update"] })).map(({ thread, key }) => [thread, key])
        }),
      )
      expect(result).toEqual([
        ["claude:native-mina", undefined],
        ["claude:native-tezos", undefined],
        ["mina", "done:Rosie:run-mina"],
      ])
    })

    test("nothing is looked for without a heartbeat, as the first time, or while yapd is off", async () => {
      const result = await run(
        Effect.gen(function* () {
          const first = yield* notices({ view, bounded, offline: { alive: Option.none(), started } })
          yield* first.reconcileOn("Rosie")
          const off = yield* notices({ view, bounded, offline: { alive: Option.some(alive), started }, on: false })
          yield* off.reconcileOn("Rosie")
          yield* off.flush
          return {
            first: [...first.told, ...(yield* first.journal.since(0, { kinds: ["update"] }))],
            off: [...off.told, ...(yield* off.journal.since(0, { kinds: ["update"] }))],
          }
        }),
      )
      expect(result).toEqual({ first: [], off: [] })
    })
  })
})
