import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, Queue, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import type * as Assistant from "./Assistant.ts"
import { Condenser } from "./Condenser.ts"
import type { Notice } from "./Inbox.ts"
import * as Journal from "./Journal.ts"
import * as Notices from "./Notices.ts"
import * as Persona from "./Persona.ts"
import * as Reminders from "./Reminders.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as Server from "./T3CodeServer.ts"
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
    /** Whether yapd is on, and how many times it was turned on or off, which the test can change. */
    readonly power?: { on: boolean; turns: number }
    /** What's queued is dropped unsaid as yapd is turned off, rather than said. */
    readonly dropping?: boolean
    /** What's queued waits under its id, as the inbox keeps it, a newer one taking the place of one waiting under the same, till `speak`. */
    readonly queueing?: boolean
    /** The work yapd started, as the ledger has it. */
    readonly started?: ReadonlyArray<{ readonly at: number; readonly thread: string; readonly messageId: string | null }>
    /** Whether he can be reminded of things, kept in the same database, offers asked as they come due kept in `offers`. */
    readonly reminding?: boolean
    /** What T3 Code says each provider has used of its limits, as it says it, when it's asked. */
    readonly usage?: () => ReadonlyArray<Record<string, unknown>>
    /** Focus or quiet, while one is on. */
    readonly holding?: () => Option.Option<"focus" | "quiet">
    /** Whether reading a thread fails now, as when T3 Code fails a moment. */
    readonly troubled?: (thread: string) => boolean
    /** Waits while yapd archives a thread. */
    readonly archiving?: (ref: Threads.Ref) => Effect.Effect<void>
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
    const reaching = (machine: string, bounded: Readonly<Record<string, Bounded>>, usage = given.usage): Effect.Effect<Server.Transport, Server.Trouble> =>
      Effect.succeed({
        api: (<A, I>(path: string, schema: Schema.Schema<A, I>) => {
          const id = decodeURIComponent(path.split("/").at(-2) ?? "")
          reads.push(`${machine} ${id}`)
          if (given.troubled?.(id) === true) return Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long." }))
          const read = bounded[id] ?? {}
          const providerThreads = (read.sessions ?? []).map((nativeId) => ({ nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" } }))
          return Schema.decodeUnknown(schema)({
            projection: { runs: read.runs ?? [], messages: read.messages ?? [], turnItems: read.turnItems ?? [], providerThreads, runtimeRequests: read.runtimeRequests ?? [] },
          }).pipe(Effect.orDie)
        }) as Server.Transport["api"],
        // With no scratch project to tell of, and its providers' usage when the test gives it.
        call: (<A, I>(method: string, _: unknown, schema: Schema.Schema<A, I>) =>
          method === "server.getConfig"
            ? Schema.decodeUnknown(schema)(usage === undefined ? {} : { providers: usage() }).pipe(Effect.orDie)
            : Effect.die("not expected")) as Server.Transport["call"],
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
    /** The entries what was told was kept under, as it was being said. */
    const beingSaid: Array<string> = []
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
    const power = given.power ?? { on: true, turns: 1 }
    const reminders = given.reminding === true ? Reminders.make(store, kept) : undefined
    /** The offers handed over to be asked, by what they'd send. */
    const offers: Array<string> = []
    /** What waits to be said, by its id. */
    const waiting = new Map<string, Notice>()
    const tell = (notice: Notice) =>
      Effect.gen(function* () {
        if (given.dropping === true) {
          power.on = false
          power.turns++
          return yield* notice.gone ?? Effect.void
        }
        if (given.queueing === true) return void waiting.set(notice.id, notice)
        yield* say(notice)
      })
    const say = (notice: Notice) =>
      Effect.gen(function* () {
        if (yield* notice.stale) return
        yield* notice.saying ?? Effect.void
        told.push(notice.spoken)
        // What it's kept under as it's said, which isn't missed meanwhile, and is unheard till it's said to the end.
        const rows = yield* notice.telling ?? Effect.succeed([])
        beingSaid.push(...(yield* journal.rows(rows)).map(({ said, heardAt }) => `${said}${heardAt === undefined ? "" : " (heard)"}`))
        yield* notice.heard ?? Effect.void
      })
    const made = yield* Notices.make({
      threads,
      journal,
      tell,
      power: Effect.sync(() => ({ ...power })),
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
      ...(given.started === undefined ? {} : { started: (_, since) => Effect.succeed((given.started ?? []).filter(({ at }) => at >= since)) }),
      shortest: 60_000,
      ...(reminders === undefined ? {} : { reminders, offered: (reminder) => Effect.sync(() => void offers.push(reminder.propose ?? "")) }),
      ...(given.holding === undefined ? {} : { holding: Effect.sync(given.holding) }),
      ...(given.archiving === undefined ? {} : { archiving: given.archiving }),
    }).pipe(Effect.provide(Layer.merge(persona, condenser(rewritten))))
    yield* Effect.forkScoped(made.follow)
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    return {
      ...made,
      store,
      journal,
      reminders,
      offers,
      power,
      told,
      beingSaid,
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
      /** What waits is taken up to be said, then cut off by a dictation before its end and put back to be said again, as the daemon keeps it. */
      cut: Effect.gen(function* () {
        for (const notice of [...waiting.values()]) {
          if (yield* notice.stale) waiting.delete(notice.id)
          else yield* notice.saying ?? Effect.void
        }
      }),
      /** What waits is said in turn, and what comes of it, till nothing does. */
      speak: Effect.gen(function* () {
        while (waiting.size > 0) {
          const next = [...waiting.values()]
          waiting.clear()
          for (const notice of next) yield* say(notice)
          yield* flush
        }
      }),
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
        return { early, told: first.told, again: second.told, beingSaid: first.beingSaid }
      }),
    )
    expect(result.early).toEqual([])
    expect(result.told).toEqual(["Migrate Tezos Integration failed, sir: the model provider had an error."])
    expect(result.beingSaid).toEqual(result.told)
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
})

describe("Notices while yapd is off", () => {
  const failed = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-1", lastErrorClass: "provider_error" })
  const failing = {
    tezos: {
      runs: [{ id: "run-1", status: "failed", ordinal: 1, startedAt: minutes(5) }],
      turnItems: [failure("run-1", "provider_error", "API Error: 500 Internal server error")],
      sessions: ["s-tezos"],
    },
  }

  test("a run that fails while yapd is off is kept unheard under its key, and never said, then or once it's on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const power = { on: false, turns: 2 }
        const { hear, wait, told, journal } = yield* notices({ view: [failed], bounded: failing, power })
        yield* hear(ended(failed, "run-1"))
        yield* wait(10)
        const off = (yield* journal.since(0, { kinds: ["notice"] })).map(({ key, said, heardAt }) => [key, said, heardAt])
        // On again, and told of the same run, as after T3 Code reconnects.
        power.on = true
        power.turns = 3
        yield* hear(ended(failed, "run-1"))
        yield* wait(10)
        return { told: [...told], off }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.off).toEqual([["fail:Rosie:run-1", "Migrate Tezos Integration failed, sir: the model provider had an error.", undefined]])
  })

  test("a limit hit while yapd is off holds its window, so another thread hitting it once it's on isn't said either", async () => {
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
        const power = { on: false, turns: 2 }
        const { hear, wait, told, journal } = yield* notices({ view: [tezos, mina], bounded: { tezos: limit("run-1"), mina: limit("run-2") }, power })
        yield* hear(ended(tezos, "run-1"))
        yield* wait(10)
        power.on = true
        power.turns = 3
        yield* hear(ended(mina, "run-2"))
        yield* wait(10)
        return { told: [...told], kept: (yield* journal.since(0, { kinds: ["notice"] })).map(({ key, heardAt }) => [key, heardAt]) }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.kept).toEqual([["limit:Claude:2026-10-08T23:00", undefined]])
  })

  test("a failure queued to be said and dropped as yapd is turned off is kept unheard", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { hear, wait, told, journal } = yield* notices({ view: [failed], bounded: failing, dropping: true })
        yield* hear(ended(failed, "run-1"))
        yield* wait(10)
        return { told: [...told], kept: (yield* journal.since(0, { kinds: ["notice"] })).map(({ key, heardAt }) => [key, heardAt]) }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.kept).toEqual([["fail:Rosie:run-1", undefined]])
  })

  test("a turn no hook told of while yapd is off is still looked into and handed on, for the daemon to keep unheard", async () => {
    const loader = thread("loader", "Fix the loader", { latestRunId: "run-2", modelSelection: { instanceId: "opencode", model: "kimi-k3" } })
    const bounded = {
      loader: {
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
        const { hear, wait, finished, told } = yield* notices({ view: [loader], bounded, power: { on: false, turns: 2 } })
        yield* hear(ended(loader, "run-2"))
        yield* wait(20)
        return { finished, told }
      }),
    )
    expect(result.finished).toEqual([{ key: "done:Rosie:run-2", message: "The loader is fixed." }])
    expect(result.told).toEqual([])
  })

  test("the first turn of work yapd started that ended while yapd restarted is looked into once T3 Code has caught up, though yapd is off", async () => {
    /** A thread yapd started minutes ago, whose latest run, begun with `userMessageId`, ended two minutes ago with `said`. */
    const started = (id: string, userMessageId: string, said: string, overrides: Record<string, unknown> = {}) => ({
      thread: thread(id, id, { latestRunId: `run-${id}`, latestRunCompletedAt: minutes(2), modelSelection: { instanceId: "opencode", model: "kimi-k3" }, ...overrides }),
      bounded: {
        runs: [{ id: `run-${id}`, status: "completed", ordinal: 1, startedAt: minutes(8), userMessageId }],
        messages: [
          { id: userMessageId, runId: `run-${id}`, role: "user", text: "Find out.", createdAt: minutes(8) },
          { id: `a-${id}`, runId: `run-${id}`, role: "assistant", text: said, createdAt: minutes(2) },
        ],
      },
      start: { at: now - 10 * 60_000, thread: id, messageId: `yapd:${id}:0:m` },
    })
    const threads = [
      started("glucose", "yapd:glucose:0:m", "Apple hasn't shipped one."),
      // He typed the next turn himself, after its first.
      started("sensors", "m-typed", "Dexcom has one."),
      // Still at it.
      started("busy", "yapd:busy:0:m", "Halfway there.", { activeRunId: "run-busy" }),
      // Told of already.
      started("told", "yapd:told:0:m", "The fee table is right."),
    ]
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({
          view: threads.map(({ thread }) => thread),
          bounded: Object.fromEntries(threads.map(({ thread, bounded }) => [thread.id, bounded])),
          started: threads.map(({ start }) => start),
          power: { on: false, turns: 2 },
        })
        yield* made.journal.write({ at: now - 60_000, kind: "update", machine: "Rosie", thread: "told", project: "integration", said: "The fee table is right." })
        yield* made.reconcileOn("Rosie")
        yield* made.wait(20)
        return made.finished
      }),
    )
    expect(result).toEqual([{ key: "done:Rosie:run-glucose", message: "Apple hasn't shipped one.", answering: true }])
  })

  test("the first turn of work yapd started that ended while yapd restarted is looked into again, under its run's key, until what it tells is kept", async () => {
    const glucose = thread("glucose", "glucose", { latestRunId: "run-glucose", latestRunCompletedAt: minutes(2) })
    const bounded = {
      glucose: {
        runs: [{ id: "run-glucose", status: "completed", ordinal: 1, startedAt: minutes(8), userMessageId: "yapd:glucose:0:m" }],
        messages: [
          { id: "yapd:glucose:0:m", runId: "run-glucose", role: "user", text: "Find out.", createdAt: minutes(8) },
          { id: "a-glucose", runId: "run-glucose", role: "assistant", text: "Apple hasn't shipped one.", createdAt: minutes(2) },
        ],
      },
    }
    const result = await run(
      Effect.gen(function* () {
        let troubled = false
        const made = yield* notices({
          view: [glucose],
          bounded,
          started: [{ at: now - 10 * 60_000, thread: "glucose", messageId: "yapd:glucose:0:m" }],
          troubled: () => troubled,
        })
        const told = () => made.finished.map(({ key }) => key)
        // Found to be its first turn, then T3 Code fails a moment as what it said is read.
        yield* made.reconcileOn("Rosie")
        troubled = true
        yield* made.wait(13)
        troubled = false
        for (let i = 0; i < 6; i++) yield* made.wait(5)
        const read = told()
        // Handed on, but nothing of it was kept, as when it couldn't be got ready: it's looked into again, under the same key.
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        const again = told()
        // Once it's kept, it's done with, even when T3 Code catches up again.
        yield* made.journal.write({ at: now, kind: "update", machine: "Rosie", thread: "glucose", project: "", said: "Apple hasn't shipped one." })
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        yield* made.reconcileOn("Rosie")
        for (let i = 0; i < 6; i++) yield* made.wait(5)
        return { read, again, kept: told() }
      }),
    )
    expect(result).toEqual({
      read: ["done:Rosie:run-glucose"],
      again: ["done:Rosie:run-glucose", "done:Rosie:run-glucose"],
      kept: ["done:Rosie:run-glucose", "done:Rosie:run-glucose"],
    })
  })

  test("the first turn of work yapd started still under way as T3 Code catches up is looked into once it's over, should what's heard of it then come to nothing", async () => {
    const going = thread("glucose", "glucose", { activeRunId: "run-glucose", latestRunId: "run-glucose" })
    const over = thread("glucose", "glucose", { latestRunId: "run-glucose", latestRunCompletedAt: minutes(0) })
    const asked = { id: "yapd:glucose:0:m", runId: "run-glucose", role: "user", text: "Find out.", createdAt: minutes(8) }
    const latest = { id: "run-glucose", status: "running", ordinal: 1, startedAt: minutes(8), userMessageId: asked.id }
    const bounded = { glucose: { runs: [latest], messages: [asked] } }
    const result = await run(
      Effect.gen(function* () {
        let troubled = false
        const made = yield* notices({ view: [going], bounded, started: [{ at: now - 10 * 60_000, thread: "glucose", messageId: asked.id }], troubled: () => troubled })
        yield* made.reconcileOn("Rosie")
        yield* made.wait(5)
        // It ends, and T3 Code fails a moment as what it said is read.
        bounded.glucose = {
          runs: [{ ...latest, status: "completed" }],
          messages: [asked, { id: "a-glucose", runId: "run-glucose", role: "assistant", text: "Apple hasn't shipped one.", createdAt: minutes(0) }],
        }
        troubled = true
        yield* made.becomes(over)
        yield* made.hear(ended(over, "run-glucose"))
        yield* made.wait(13)
        troubled = false
        const heard = made.finished.map(({ key }) => key)
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        return { heard, looked: made.finished.map(({ key }) => key) }
      }),
    )
    expect(result).toEqual({ heard: [], looked: ["done:Rosie:run-glucose"] })
  })

  test("the first turn of work yapd started once T3 Code had caught up is looked into again, under its run's key, until what it tells is kept, when it can't be read as it ends", async () => {
    const over = thread("glucose", "glucose", { latestRunId: "run-glucose", latestRunCompletedAt: minutes(0) })
    const asked = { id: "yapd:glucose:0:m", runId: "run-glucose", role: "user", text: "Find out.", createdAt: minutes(3) }
    const bounded: Record<string, Bounded> = {}
    const starts: Array<{ readonly at: number; readonly thread: string; readonly messageId: string | null }> = []
    const result = await run(
      Effect.gen(function* () {
        let troubled = false
        const made = yield* notices({ view: [], bounded, started: starts, troubled: () => troubled })
        const told = () => made.finished.map(({ key }) => key)
        // T3 Code catches up before any of it.
        yield* made.reconcileOn("Rosie")
        yield* made.wait(5)
        // He starts it, its first turn ends, and T3 Code fails a moment as what it said is read.
        starts.push({ at: now - 3 * 60_000, thread: "glucose", messageId: asked.id })
        bounded.glucose = {
          runs: [{ id: "run-glucose", status: "completed", ordinal: 1, startedAt: minutes(3), userMessageId: asked.id }],
          messages: [asked, { id: "a-glucose", runId: "run-glucose", role: "assistant", text: "Apple hasn't shipped one.", createdAt: minutes(0) }],
        }
        troubled = true
        yield* made.becomes(over)
        yield* made.hear(ended(over, "run-glucose"))
        yield* made.wait(13)
        troubled = false
        const heard = told()
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        const looked = told()
        // Once it's kept, it's done with.
        yield* made.journal.write({ at: now, kind: "update", machine: "Rosie", thread: "glucose", project: "", said: "Apple hasn't shipped one." })
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        return { heard, looked, kept: told() }
      }),
    )
    expect(result).toEqual({ heard: [], looked: ["done:Rosie:run-glucose"], kept: ["done:Rosie:run-glucose"] })
  })

  test("the first turn of work yapd started that ended while T3 Code's word couldn't be heard, which then only tells of a new thread, is looked into", async () => {
    const over = thread("glucose", "glucose", { latestRunId: "run-glucose", latestRunCompletedAt: minutes(1) })
    const asked = { id: "yapd:glucose:0:m", runId: "run-glucose", role: "user", text: "Find out.", createdAt: minutes(3) }
    const bounded: Record<string, Bounded> = {}
    const starts: Array<{ readonly at: number; readonly thread: string; readonly messageId: string | null }> = []
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded, started: starts })
        yield* made.reconcileOn("Rosie")
        yield* made.wait(5)
        starts.push({ at: now - 3 * 60_000, thread: "glucose", messageId: asked.id })
        bounded.glucose = {
          runs: [{ id: "run-glucose", status: "completed", ordinal: 1, startedAt: minutes(3), userMessageId: asked.id }],
          messages: [asked, { id: "a-glucose", runId: "run-glucose", role: "assistant", text: "Apple hasn't shipped one.", createdAt: minutes(1) }],
        }
        yield* made.becomes(over)
        yield* made.hear({ _tag: "Created", thread: over })
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        return made.finished.map(({ key }) => key)
      }),
    )
    expect(result).toEqual(["done:Rosie:run-glucose"])
  })

  test("the first turn of work yapd started is kept looking into once at a time, though what let go of it before ends after it's taken up again", async () => {
    const glucose = thread("glucose", "glucose", { activeRunId: "run-glucose", latestRunId: "run-glucose" })
    const salt = thread("salt", "salt", { activeRunId: "run-salt", latestRunId: "run-salt" })
    const bounded = {
      glucose: { runs: [{ id: "run-glucose", status: "running", ordinal: 1, startedAt: minutes(8), userMessageId: "yapd:glucose:0:m" }] },
      salt: { runs: [{ id: "run-salt", status: "running", ordinal: 1, startedAt: minutes(8), userMessageId: "yapd:salt:0:m" }] },
    }
    const started = [
      { at: now - 10 * 60_000, thread: "glucose", messageId: "yapd:glucose:0:m" },
      { at: now - 10 * 60_000, thread: "salt", messageId: "yapd:salt:0:m" },
    ]
    const result = await run(
      Effect.gen(function* () {
        // T3 Code catches up before the glucose thread can be seen, so it's let go of at once, and the salt one is kept looking into.
        const made = yield* notices({ view: [salt], bounded, started })
        yield* made.reconcileOn("Rosie")
        yield* made.wait(5)
        // The glucose thread is heard of as new, and taken up again a minute later.
        yield* made.becomes(glucose)
        yield* made.hear({ _tag: "Created", thread: glucose })
        yield* made.wait(60)
        // The salt thread is archived, so what was looking into both ends.
        yield* made.becomes({ ...salt, archivedAt: minutes(0) })
        yield* made.wait(60)
        // The glucose thread is heard of as new again, while it's still being looked into.
        yield* made.hear({ _tag: "Created", thread: glucose })
        const from = made.reads.length
        for (let i = 0; i < 5; i++) yield* made.wait(60)
        return made.reads.slice(from).filter((read) => read === "Rosie glucose").length
      }),
    )
    expect(result).toBe(5)
  })

  test("the first turn of work yapd started on rig, heard from a hook that couldn't be tied to its thread, isn't said again after a restart, nor when T3 Code tells of it again", async () => {
    // He started it ten hours ago, and its answer was said from rig's Stop, kept under the hook's session rather than the thread.
    const asr = thread("asr", "OpenAI ASR releases", { latestRunId: "run-asr", latestRunCompletedAt: minutes(599) })
    const asked = { id: "yapd:asr:0:m", runId: "run-asr", role: "user", text: "Look up when OpenAI last released an ASR model.", createdAt: minutes(600) }
    const rig = {
      view: [asr],
      bounded: {
        asr: {
          runs: [{ id: "run-asr", status: "completed", ordinal: 1, startedAt: minutes(600), completedAt: minutes(599), userMessageId: asked.id }],
          messages: [asked, { id: "a-asr", runId: "run-asr", role: "assistant", text: "OpenAI's last speech model came out in March.", createdAt: minutes(599) }],
          sessions: ["5dba8e2d-b807520"],
        },
      },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, rig, started: [{ at: now - 601 * 60_000, thread: "asr", messageId: asked.id }] })
        yield* made.journal.write({
          at: now - 599 * 60_000,
          kind: "update",
          machine: "rig",
          thread: "claude:5dba8e2d-b807520",
          project: "asr",
          said: "OpenAI's last speech model came out in March.",
          heardAt: now - 599 * 60_000,
          detail: { priority: "done", prompt: asked.text },
        })
        // Rig's T3 Code catches up after the restart.
        yield* made.rig.reached(true)
        yield* made.reconcileOn("rig")
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        const recovered = [...made.finished]
        // Its word that the turn ended comes again, as after a reconnect, with its Stop long forgotten.
        yield* made.rig.hear(ended(asr, "run-asr"))
        for (let i = 0; i < 18; i++) yield* made.wait(5)
        return { recovered, heard: made.finished, told: made.told }
      }),
    )
    expect(result).toEqual({ recovered: [], heard: [], told: [] })
  })

  test("the first turn of work yapd started in a thread he archived since is never looked into", async () => {
    const archived = thread("glucose", "glucose", { latestRunId: "run-glucose", latestRunCompletedAt: minutes(2), archivedAt: minutes(1) })
    const bounded = {
      glucose: {
        runs: [{ id: "run-glucose", status: "completed", ordinal: 1, startedAt: minutes(8), userMessageId: "yapd:glucose:0:m" }],
        messages: [{ id: "a-glucose", runId: "run-glucose", role: "assistant", text: "Apple hasn't shipped one.", createdAt: minutes(2) }],
      },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [archived], bounded, started: [{ at: now - 10 * 60_000, thread: "glucose", messageId: "yapd:glucose:0:m" }] })
        yield* made.reconcileOn("Rosie")
        for (let i = 0; i < 36; i++) yield* made.wait(5)
        return { finished: made.finished, reads: made.reads.length }
      }),
    )
    expect(result).toEqual({ finished: [], reads: 0 })
  })

  test("a question asked while yapd is off isn't worded then, and is asked once it's on", async () => {
    const asking = [{ type: "user_input_request", status: "waiting", requestId: "r1", questions: [{ id: "q", question: "Which fee table?" }] }]
    const request = { id: "r1", kind: "user_input", createdAt: minutes(1) }
    const tezos = thread("tezos", "Migrate Tezos Integration", { activeRunId: "run-1", pendingRuntimeRequest: request })
    const result = await run(
      Effect.gen(function* () {
        const power = { on: false, turns: 2 }
        const made = yield* notices({ view: [tezos], bounded: { tezos: { turnItems: asking } }, power })
        yield* made.hear({ _tag: "Asked", thread: tezos, request } as unknown as T3Live.Change)
        yield* made.wait(1)
        const off = [...made.asked]
        power.on = true
        power.turns = 3
        yield* made.reconcile
        yield* made.flush
        return { off, on: [...made.asked] }
      }),
    )
    expect(result.off).toEqual([])
    expect(result.on).toEqual(["A question on Migrate Tezos Integration, sir: Which fee table?"])
  })
})

describe("Notices of reminders", () => {
  /** Set an hour before now, for a time `due`, to say "call the bank". */
  const bank = (due: number): Reminders.Asked => ({ at: now - 60 * 60_000, heard: "Remind me to call the bank.", text: "call the bank", due })

  test("a reminder due while yapd was down is said once after the restart", async () => {
    const result = await run(
      Effect.gen(function* () {
        const before = yield* notices({ view: [], bounded: {}, reminding: true })
        yield* before.reminders!.add(bank(now - 10 * 60_000))
        // yapd restarts after it was due: what was handed over before, and what's due, are looked at, then looked at again.
        const after = yield* notices({ view: [], bounded: {}, reminding: true, store: before.store })
        yield* after.retell
        yield* after.due
        yield* after.wait(15)
        yield* after.due
        const once = [...after.told]
        // And again, after another restart.
        const again = yield* notices({ view: [], bounded: {}, reminding: true, store: before.store })
        yield* again.retell
        yield* again.due
        return { once, again: again.told, pending: (yield* again.reminders!.pending).length }
      }),
    )
    expect(result.once).toHaveLength(1)
    // It names the time it was due, so it reads right however late.
    expect(result.once[0]).toMatch(/^You asked me to remind you at .*, sir: call the bank\.$/)
    expect(result.again).toEqual([])
    expect(result.pending).toBe(0)
  })

  test("a reminder due while yapd is off is kept unheard and never said on its own", async () => {
    const result = await run(
      Effect.gen(function* () {
        const off = yield* notices({ view: [], bounded: {}, reminding: true, power: { on: false, turns: 1 } })
        yield* off.reminders!.add(bank(now - 60_000))
        yield* off.due
        // Turned on, it isn't said then either, nor after a restart.
        off.power.on = true
        off.power.turns = 2
        yield* off.wait(15)
        yield* off.due
        const restarted = yield* notices({ view: [], bounded: {}, reminding: true, store: off.store })
        yield* restarted.retell
        yield* restarted.due
        // It's what he missed while yapd was off.
        const missed = yield* off.journal.missed(now - 24 * 60 * 60_000, now - 24 * 60 * 60_000)
        return { told: [...off.told, ...restarted.told], missed: missed.map(({ said, heardAt, detail }) => ({ said, heardAt, held: (detail as { held?: string }).held })) }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.missed).toHaveLength(1)
    expect(result.missed[0]).toMatchObject({ heardAt: undefined, held: "off" })
    expect(result.missed[0]!.said).toMatch(/: call the bank\.$/)
  })

  test("a reminder is said even after older ones were pruned", async () => {
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, reminding: true })
        const first = yield* made.reminders!.add(bank(now - 60_000))
        yield* made.due
        // What's said is pruned, and the next one set takes no id it had.
        yield* made.reminders!.prune(now + 1)
        const next = yield* made.reminders!.add({ ...bank(now + 60_000), text: "pick up the parcel" })
        yield* made.wait(75)
        yield* made.due
        return { told: made.told, ids: [first.id, next.id] }
      }),
    )
    expect(result.ids[1]).not.toBe(result.ids[0])
    expect(result.told).toHaveLength(2)
    expect(result.told[1]).toMatch(/: pick up the parcel\.$/)
  })

  /** Set on the Tezos importer, an hour ago, to call the bank in a minute. */
  const onTezos = { ...bank(now + 60_000), machine: "Rosie", thread: "tezos", called: "the Tezos importer" }

  test("one dropped as its thread went, then brought back as he takes back archiving it, is still said once it comes due", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration")
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [tezos], bounded: {}, reminding: true })
        const set = yield* made.reminders!.add(onTezos)
        yield* made.hear({ _tag: "Removed", thread: tezos })
        const dropped = [...made.told]
        yield* made.reminders!.restore(set.id)
        yield* made.wait(75)
        yield* made.due
        return { dropped, told: made.told.slice(dropped.length), pending: (yield* made.reminders!.pending).length }
      }),
    )
    expect(result.dropped).toEqual(["The Tezos importer was archived or deleted, sir, so I dropped your reminder."])
    expect(result.told).toEqual([expect.stringMatching(/: call the bank\.$/)])
    expect(result.pending).toBe(0)
  })

  test("what he set on a thread yapd is archiving is left to that to drop and say, however soon T3 Code says it's gone", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration")
    const result = await run(
      Effect.gen(function* () {
        const archived = yield* Deferred.make<void>()
        const made = yield* notices({ view: [tezos], bounded: {}, reminding: true, archiving: (ref) => (ref.id === "tezos" ? Deferred.await(archived) : Effect.void) })
        const set = yield* made.reminders!.add(onTezos)
        // Gone before T3 Code answers the archive, which then drops it, and says so in its own line.
        yield* made.hear({ _tag: "Removed", thread: tezos })
        const meanwhile = (yield* made.reminders!.pending).length
        yield* made.reminders!.cancel(set.id)
        yield* Deferred.succeed(archived, undefined)
        yield* made.flush
        return { meanwhile, told: made.told }
      }),
    )
    expect(result).toEqual({ meanwhile: 1, told: [] })
  })

  /** Set a minute before now, to hear when the Tezos one finishes, and to call Bob then when `text` says so. */
  const tezosDone = (text = "", at = now - 60_000): Reminders.Asked => ({ at, heard: "Tell me when the Tezos one finishes.", text, event: "finished", machine: "Rosie", thread: "tezos", called: "the Tezos importer" })

  /** Whether each reminder's entry was heard. */
  const remindersHeard = (journal: Journal.Journal["Type"]) =>
    Effect.map(journal.since(0, { kinds: ["notice"] }), (kept) => kept.filter(({ key }) => key?.startsWith("remind:") === true).map(({ heardAt }) => heardAt !== undefined))

  test("asked once its turn had ended, a thread's finishing is told of when it next finishes, never as the turn before's", async () => {
    const first = thread("tezos", "Migrate Tezos Integration", { latestRunId: "run-1" })
    const said = [{ id: "a1", runId: "run-1", role: "assistant", text: "Done, the fee table is in.", createdAt: minutes(0) }]
    const bounded: Record<string, Bounded> = { tezos: { runs: [{ id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(5), userMessageId: "m1" }], messages: said } }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [first], bounded, reminding: true })
        yield* made.hear(ended(first, "run-1"))
        // Its turn told of, he sends it more work and asks to hear when that's done.
        yield* made.wait(30)
        yield* made.reminders!.add(tezosDone("", now + 30_000))
        yield* made.wait(60)
        const early = { told: [...made.told], pending: (yield* made.reminders!.pending).length }
        const next = thread("tezos", "Migrate Tezos Integration", { latestRunId: "run-2" })
        bounded.tezos = {
          runs: [...(bounded.tezos?.runs ?? []), { id: "run-2", status: "completed", ordinal: 2, startedAt: new Date(now + 31_000).toISOString(), userMessageId: "m2" }],
          messages: [...said, { id: "a2", runId: "run-2", role: "assistant", text: "The full suite passes.", createdAt: new Date(now + 90_000).toISOString() }],
        }
        yield* made.becomes(next)
        yield* made.hear(ended(next, "run-2"))
        yield* made.wait(60)
        return { early, told: made.told, pending: (yield* made.reminders!.pending).length }
      }),
    )
    expect(result.early).toEqual({ told: [], pending: 1 })
    expect(result.told).toEqual([expect.stringMatching(/ has finished, sir, as you asked\.$/)])
    expect(result.pending).toBe(0)
  })

  test("a thread he asked to hear finish that fails is told as one: the failure, then what he asked to be reminded of, heard together", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-1", lastErrorClass: "provider_error" })
    const bounded = {
      tezos: { runs: [{ id: "run-1", status: "failed", ordinal: 1, startedAt: minutes(5) }], turnItems: [failure("run-1", "provider_error", "API Error: 500 Internal server error")] },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [tezos], bounded, reminding: true })
        yield* made.reminders!.add(tezosDone("call Bob"))
        yield* made.hear(ended(tezos, "run-1"))
        yield* made.wait(10)
        return { told: made.told, heard: yield* remindersHeard(made.journal) }
      }),
    )
    expect(result.told).toEqual(["Migrate Tezos Integration failed, sir: the model provider had an error. You asked me to remind you then: call Bob."])
    expect(result.heard).toEqual([true])
  })

  test("a thread he asked to hear finish that hits a limit said for another thread already is told on its own, with why it stopped", async () => {
    const limited = (id: string, title: string, runId: string) =>
      thread(id, title, { status: "failed", latestRunId: runId, lastErrorClass: "usage_limit", usageLimitResetAt: "2026-10-08T23:00:00.000Z" })
    const std = limited("std", "Fix the std build", "run-1")
    const tezos = limited("tezos", "Migrate Tezos Integration", "run-2")
    const limit = (runId: string) => ({
      runs: [{ id: runId, status: "failed", ordinal: 1, startedAt: minutes(3) }],
      turnItems: [failure(runId, "usage_limit", "Claude usage limit reached.", "2026-10-08T23:00:00.000Z")],
    })
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [std, tezos], bounded: { std: limit("run-1"), tezos: limit("run-2") }, reminding: true })
        yield* made.reminders!.add(tezosDone("call Bob"))
        yield* made.hear(ended(std, "run-1"))
        yield* made.wait(10)
        // The same window, minutes later.
        yield* made.hear(ended(tezos, "run-2"))
        yield* made.wait(10)
        return { told: made.told, heard: yield* remindersHeard(made.journal) }
      }),
    )
    expect(result.told).toEqual([
      expect.stringMatching(/^Fix the std build hit Claude's limit, sir; it resets at \d/),
      "Migrate Tezos Integration stopped, sir, before finishing: it hit Claude's limit. You asked me to remind you then: call Bob.",
    ])
    expect(result.heard).toEqual([true])
  })

  test("what he set on a thread that hit a limit is told, though another thread's limit comes in while that waits to be said", async () => {
    const limited = (id: string, title: string, runId: string) =>
      thread(id, title, { status: "failed", latestRunId: runId, lastErrorClass: "usage_limit", usageLimitResetAt: "2026-10-08T23:00:00.000Z" })
    const tezos = limited("tezos", "Migrate Tezos Integration", "run-1")
    const std = limited("std", "Fix the std build", "run-2")
    const limit = (runId: string) => ({
      runs: [{ id: runId, status: "failed", ordinal: 1, startedAt: minutes(3) }],
      turnItems: [failure(runId, "usage_limit", "Claude usage limit reached.", "2026-10-08T23:00:00.000Z")],
    })
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [tezos, std], bounded: { tezos: limit("run-1"), std: limit("run-2") }, reminding: true, queueing: true })
        yield* made.reminders!.add(tezosDone("call Bob"))
        // Both hit the limit seconds apart, while something else is being said.
        yield* made.hear(ended(tezos, "run-1"))
        yield* made.wait(10)
        yield* made.hear(ended(std, "run-2"))
        yield* made.wait(10)
        yield* made.speak
        return { told: made.told, heard: yield* remindersHeard(made.journal) }
      }),
    )
    expect(result.told).toEqual([expect.stringMatching(/^Migrate Tezos Integration hit Claude's limit, sir; it resets at \d.*\. You asked me to remind you then: call Bob\.$/)])
    expect(result.heard).toEqual([true])
  })

  test("a reminder riding on a failure waiting to be said has gone off, so what's said of the failure never tells of one he cancelled", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-1", lastErrorClass: "provider_error" })
    const bounded = {
      tezos: { runs: [{ id: "run-1", status: "failed", ordinal: 1, startedAt: minutes(5) }], turnItems: [failure("run-1", "provider_error", "API Error: 500 Internal server error")] },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [tezos], bounded, reminding: true, queueing: true })
        const bob = yield* made.reminders!.add(tezosDone("call Bob"))
        yield* made.hear(ended(tezos, "run-1"))
        yield* made.wait(10)
        // He cancels it while the failure waits behind something else being said.
        const cancelled = yield* made.reminders!.cancel(bob.id)
        yield* made.speak
        return { cancelled: Option.isSome(cancelled), told: made.told, heard: yield* remindersHeard(made.journal) }
      }),
    )
    expect(result.cancelled).toBe(false)
    expect(result.told).toEqual(["Migrate Tezos Integration failed, sir: the model provider had an error. You asked me to remind you then: call Bob."])
    expect(result.heard).toEqual([true])
  })

  test("what he set on a thread finishing that ended while yapd couldn't hear it goes by how its run ended: a failure says why, and one he stopped keeps it for its next", async () => {
    const over = new Date(now - 30_000).toISOString()
    const tezos = thread("tezos", "Migrate Tezos Integration", { status: "interrupted", latestRunId: "run-1", latestRunCompletedAt: over })
    const std = thread("std", "Fix the std build", { status: "failed", latestRunId: "run-2", latestRunCompletedAt: over, lastErrorClass: "provider_error" })
    const bounded = {
      tezos: { runs: [{ id: "run-1", status: "interrupted", ordinal: 1, startedAt: minutes(5) }] },
      std: { runs: [{ id: "run-2", status: "failed", ordinal: 1, startedAt: minutes(5) }], turnItems: [failure("run-2", "provider_error", "API Error: 500 Internal server error")] },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [tezos, std], bounded, reminding: true })
        yield* made.reminders!.add(tezosDone("call Bob"))
        yield* made.reminders!.add({ ...tezosDone(), thread: "std", called: "the std fix" })
        // yapd restarts, or T3 Code comes back, once both are over.
        yield* made.reconcileOn("Rosie")
        yield* made.flush
        return { told: made.told, pending: (yield* made.reminders!.pending).map(({ thread }) => thread) }
      }),
    )
    expect(result.told).toEqual(["Fix the std build stopped, sir, before finishing: the model provider had an error."])
    expect(result.pending).toEqual(["tezos"])
  })

  test("how a Stop's turn ended, for what he set on its finishing, is read only from its own run: a failure says why, and nothing else can tell", () => {
    const std = thread("std", "Fix the std build", { status: "failed", latestRunId: "run-2", lastErrorClass: "provider_error" })
    const failed: T3Actions.Ran = {
      id: "run-2",
      status: "failed",
      startedAt: Option.some(now - 60_000),
      userMessageId: Option.none(),
      prompt: Option.none(),
      said: "The provider failed, so I stopped.",
      final: "The provider failed, so I stopped.",
      others: [],
      failure: Option.some({ class: "provider_error", message: "API Error: 500 Internal server error", resetAt: null }),
      natives: [],
      previous: Option.none(),
    }
    const stop = (message: string): Notices.Stop => ({ at: now, message })
    expect(Notices.ended(stop("The provider failed, so I stopped."), failed, std)).toEqual({ _tag: "Failed", why: "the model provider had an error." })
    // In words that aren't its run's, as when the thread is on another run by now, it can't be told how it went.
    expect(Notices.ended(stop("The build is green again."), failed, std)).toEqual({ _tag: "Unknown" })
    expect(Notices.ended(stop("The provider failed, so I stopped."), { ...failed, status: "running" }, std)).toEqual({ _tag: "Unknown" })
  })
})

describe("Notices of usage", () => {
  test("a usage threshold is said once per window, however often it's read", async () => {
    let used = 82
    let resets = new Date(now + 3 * 24 * 60 * 60_000).toISOString()
    const usage = () => [
      {
        instanceId: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        status: "ready",
        usageLimits: { checkedAt: new Date(now).toISOString(), windows: [{ id: "claude-weekly", kind: "weekly", label: "Weekly", usedPercent: used, resetsAt: resets }] },
      },
    ]
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, usage })
        /** Read again, as every five minutes, once what was read before is old enough to be asked again. */
        const read = (made: { readonly usage: Effect.Effect<void>; readonly wait: (seconds: number) => Effect.Effect<void> }) =>
          Effect.zipRight(made.wait(16 * 60), made.usage)
        yield* made.usage
        // At 80 percent it's kept for the digest, never said.
        const held = (yield* made.journal.held(0)).map(({ said }) => said)
        used = 96
        yield* read(made)
        yield* read(made)
        // When it resets moves a little from one read to the next: still the same window.
        resets = new Date(Date.parse(resets) + 40_000).toISOString()
        yield* read(made)
        // And after a restart.
        const restarted = yield* notices({ view: [], bounded: {}, usage, store: made.store })
        yield* read(restarted)
        const once = [...made.told, ...restarted.told]
        const heldAfter = (yield* made.journal.held(0)).length
        // A new window, once the last one reset, is said again.
        resets = new Date(now + 10 * 24 * 60 * 60_000).toISOString()
        yield* restarted.wait(4 * 24 * 60 * 60)
        yield* read(restarted)
        return { held, once, heldAfter, next: restarted.told }
      }),
    )
    expect(result.held).toEqual([expect.stringMatching(/^Claude's weekly limit is at 82 percent, sir\. It resets .*\.$/)])
    expect(result.once).toEqual([expect.stringMatching(/^Claude's weekly limit is at 96 percent, sir\. It resets .*\.$/)])
    // Said at 95, what was kept at 80 of the same window isn't for the digest any more.
    expect(result.heldAfter).toBe(0)
    expect(result.next).toHaveLength(1)
  })

  test("a monthly window said at 95 percent isn't said again more than a week on, once when it resets moves into the next hour", async () => {
    // Weeks off, 20 seconds before the hour.
    const first = Math.floor((now + 20 * 24 * 60 * 60_000) / 3_600_000) * 3_600_000 + 59 * 60_000 + 40_000
    let resets = new Date(first).toISOString()
    const usage = () => [
      {
        instanceId: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        status: "ready",
        usageLimits: { checkedAt: new Date(now).toISOString(), windows: [{ id: "claude-monthly", kind: "monthly", label: "Monthly", usedPercent: 96, resetsAt: resets }] },
      },
    ]
    const told = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, usage })
        yield* made.usage
        yield* made.wait(8 * 24 * 60 * 60)
        resets = new Date(first + 40_000).toISOString()
        yield* made.usage
        return made.told
      }),
    )
    expect(told).toEqual([expect.stringMatching(/^Claude's monthly limit is at 96 percent, sir\. It resets .*\.$/)])
  })

  test("a 95 percent warning waiting to be said as quiet begins is kept for the morning, never said that night", async () => {
    const usage = () => [
      {
        instanceId: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        status: "ready",
        usageLimits: {
          checkedAt: new Date(now).toISOString(),
          windows: [{ id: "claude-weekly", kind: "weekly", label: "Weekly", usedPercent: 96, resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString() }],
        },
      },
    ]
    let mode = Option.none<"focus" | "quiet">()
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, usage, queueing: true, holding: () => mode })
        yield* made.usage
        // It waits behind something being said, and he says goodnight.
        mode = Option.some("quiet")
        yield* made.speak
        // Read again later that night.
        yield* made.wait(16 * 60)
        yield* made.usage
        yield* made.speak
        return { told: made.told, morning: (yield* made.journal.held(0, 200, { only: ["quiet"] })).map(({ said }) => said) }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.morning).toEqual([expect.stringMatching(/^Claude's weekly limit is at 96 percent, sir\. It resets .*\.$/)])
  })

  test("a 95 percent warning cut off by a dictation, then taken up again once quiet began, is kept for the morning, never said that night", async () => {
    const usage = () => [
      {
        instanceId: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        status: "ready",
        usageLimits: {
          checkedAt: new Date(now).toISOString(),
          windows: [{ id: "claude-weekly", kind: "weekly", label: "Weekly", usedPercent: 96, resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString() }],
        },
      },
    ]
    let mode = Option.none<"focus" | "quiet">()
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, usage, queueing: true, holding: () => mode })
        yield* made.usage
        // A dictation cuts it off as it's being said, and puts it back; he says goodnight before it's taken up again.
        yield* made.cut
        mode = Option.some("quiet")
        yield* made.speak
        // Read again later that night.
        yield* made.wait(16 * 60)
        yield* made.usage
        yield* made.speak
        return { told: made.told, morning: (yield* made.journal.held(0, 200, { only: ["quiet"] })).map(({ said }) => said) }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.morning).toEqual([expect.stringMatching(/^Claude's weekly limit is at 96 percent, sir\. It resets .*\.$/)])
  })

  test("a threshold passed while yapd is off is kept for a catch-up alone, never for the digest or the morning", async () => {
    const usage = () => [
      {
        instanceId: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        status: "ready",
        usageLimits: {
          checkedAt: new Date(now).toISOString(),
          windows: [
            { id: "claude-session", kind: "session", label: "5h", usedPercent: 84, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
            { id: "claude-weekly", kind: "weekly", label: "Weekly", usedPercent: 97, resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString() },
          ],
        },
      },
    ]
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [], bounded: {}, usage, power: { on: false, turns: 2 }, holding: () => Option.some("quiet") })
        yield* made.usage
        return {
          told: made.told,
          // What the digest and the morning's rundown read.
          held: (yield* made.journal.held(0, 200, { except: ["off"] })).length,
          kept: (yield* made.journal.since(0, { kinds: ["notice"] })).map((entry) => (entry.detail as { readonly held?: unknown }).held),
        }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.held).toBe(0)
    expect(result.kept).toEqual(["off", "off"])
  })
})
