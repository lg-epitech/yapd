import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Queue, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
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

/** The model, which words an approval, and a part of a question whose words can't be said as they are. */
const condenser = Layer.succeed(Condenser, {
  condense: () => Effect.die("not expected"),
  ask: () => Effect.succeed({ spoken: "wants to push the branch", risk: "low" as const }),
  question: () => Effect.succeed({ spoken: "Which date helper should the fee table use?" }),
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
    /** Whether yapd is on, and how many times it was turned on or off, which the test can change. */
    readonly power?: { on: boolean; turns: number }
    /** Whether he can be reminded of things, kept in the same database. */
    readonly reminding?: boolean
    /** What T3 Code says each provider has used of its limits, as it says it, when it's asked. */
    readonly usage?: () => ReadonlyArray<Record<string, unknown>>
  },
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const store = given.store ?? (yield* Store.make(":memory:"))
    const journal = Journal.fromStore(store)
    const changes = yield* Queue.unbounded<T3Live.Change>()
    const view: T3Live.View = {
      projects: new Map([["p", { id: "p", title: "integration", workspaceRoot: "/code/integration" }]]),
      threads: new Map(given.view.map((thread) => [thread.id, thread])),
      sequence: 1,
      synced: true,
    }
    /** T3 Code, reading what `bounded` says. */
    const reaching = (bounded: Readonly<Record<string, Bounded>>, usage = given.usage): Effect.Effect<Server.Transport, Server.Trouble> =>
      Effect.succeed({
        api: (<A, I>(path: string, schema: Schema.Schema<A, I>) => {
          const id = decodeURIComponent(path.split("/").at(-2) ?? "")
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
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: { view: Effect.sync(() => Option.some(view)), changes: Stream.fromQueue(changes) },
      actions: Option.some(T3Actions.make(reaching(given.bounded))),
      others: [],
      journal,
      store,
    })
    const told: Array<string> = []
    /** Everything handed over to be said, and whether what's said after it can be taken up. */
    const handed: Array<readonly [string, boolean]> = []
    /** What was asked as the one question open, as the assistant asks it: kept under its key, or the entry it was kept under before, and heard to the end. */
    const asked: Array<string> = []
    const settled: Array<string> = []
    const finished: Array<{ readonly key: string; readonly message: string; readonly answering?: true }> = []
    const power = given.power ?? { on: true, turns: 1 }
    const reminders = given.reminding === true ? Reminders.make(store, journal) : undefined
    /** Said at once, to the end, unless it's stale by then. */
    const tell = (notice: Notice) =>
      Effect.gen(function* () {
        handed.push([notice.spoken, notice.followUp !== undefined])
        if (yield* notice.stale) return
        yield* notice.saying ?? Effect.void
        told.push(notice.spoken)
        yield* notice.heard ?? Effect.void
      })
    const made = yield* Notices.make({
      threads,
      journal,
      tell,
      power: Effect.sync(() => ({ ...power })),
      stopped: (sessions) => Effect.sync(() => sessions.flatMap((session) => given.stops?.get(session) ?? []).toSorted((a, b) => a.at - b.at)),
      finished: (input) => Effect.sync(() => void finished.push({ key: input.key, message: input.turn.message, ...(input.answering === true ? { answering: true as const } : {}) })),
      overtaken: () => Effect.void,
      mention: () => Effect.void,
      ask: (asking) =>
        Effect.gen(function* () {
          const kept = asking.kept === undefined ? yield* journal.claim(asking.entry) : Option.some(Option.some(asking.kept))
          if (Option.isNone(kept)) return
          asked.push(asking.asked)
          yield* journal.markHeard(Option.toArray(kept.value), now)
        }),
      settled: (requestId) => Effect.sync(() => void settled.push(requestId)),
      returned: () => Effect.void,
      shortest: 60_000,
      ...(reminders === undefined ? {} : { reminders }),
      following: () => () => Effect.succeedNone,
    }).pipe(Effect.provide(Layer.merge(persona, condenser)))
    yield* Effect.forkScoped(made.follow)
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    return {
      ...made,
      store,
      journal,
      reminders,
      told,
      handed,
      asked,
      settled,
      finished,
      /** T3 Code tells of these. */
      hear: (...happened: ReadonlyArray<T3Live.Change>) => Queue.offerAll(changes, happened).pipe(Effect.zipRight(flush)),
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Notices", () => {
  test("a failed run is said once, and not again after a restart", async () => {
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
    expect(result.told).toHaveLength(1)
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
    // Only the question, each time.
    for (const said of [result.live, result.restarted]) expect(said).toEqual([expect.stringContaining("Which database?")])
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
  })

  test("a failure can be answered about its thread; a thread waiting on a secret is told with nothing listened for", async () => {
    const failed = thread("tezos", "Migrate Tezos Integration", { status: "failed", latestRunId: "run-1", lastErrorClass: "provider_error" })
    const stripe = thread("stripe", "Wire up Stripe", { activeRunId: "run-2", pendingRuntimeRequest: { id: "r2", kind: "user_input", createdAt: minutes(0) } })
    const bounded: Record<string, Bounded> = {
      tezos: {
        runs: [{ id: "run-1", status: "failed", ordinal: 1, startedAt: minutes(5) }],
        turnItems: [failure("run-1", "provider_error", "API Error: 500 Internal server error")],
        sessions: ["s-tezos"],
      },
      stripe: { turnItems: [{ type: "secret_request", id: "r2", status: "waiting", label: "Stripe API key" }] },
    }
    const result = await run(
      Effect.gen(function* () {
        const made = yield* notices({ view: [failed, stripe], bounded })
        yield* made.hear(ended(failed, "run-1"), { _tag: "Asked", thread: stripe, request: stripe.pendingRuntimeRequest! })
        yield* made.wait(10)
        return made.handed
      }),
    )
    const listens = (word: RegExp) => result.filter(([spoken]) => word.test(spoken)).map(([, listens]) => listens)
    expect(listens(/failed/)).toEqual([true])
    expect(listens(/Stripe/)).toEqual([false])
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
        const off = (yield* journal.since(0, { kinds: ["notice"] })).map(({ key, heardAt }) => [key, heardAt])
        // On again, and told of the same run, as after T3 Code reconnects.
        power.on = true
        power.turns = 3
        yield* hear(ended(failed, "run-1"))
        yield* wait(10)
        return { told: [...told], off }
      }),
    )
    expect(result.told).toEqual([])
    expect(result.off).toEqual([["fail:Rosie:run-1", undefined]])
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
    expect(result.again).toEqual([])
    expect(result.pending).toBe(0)
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
    expect(Notices.ended(stop("The provider failed, so I stopped."), failed, std)).toMatchObject({ _tag: "Failed" })
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
    expect(result.held).toHaveLength(1)
    expect(result.once).toHaveLength(1)
    // Said at 95, what was kept at 80 of the same window isn't for the digest any more.
    expect(result.heldAfter).toBe(0)
    expect(result.next).toHaveLength(1)
  })
})
