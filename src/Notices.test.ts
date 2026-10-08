import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Queue, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
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

const persona = Layer.succeed(Persona.Persona, { lines: Effect.succeed({ ...Persona.plain, address: "sir" }) })

const condenser = Layer.succeed(Condenser, {
  condense: () => Effect.die("not expected"),
  ask: (request) => Effect.succeed({ spoken: request._tag === "Approval" ? "wants to push the branch" : "asks which database to use", risk: "low" as const }),
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
    readonly stops?: ReadonlyMap<string, number>
    readonly store?: Store.Store["Type"]
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
    const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
      api: (<A, I>(path: string, schema: Schema.Schema<A, I>) => {
        const read = given.bounded[decodeURIComponent(path.split("/").at(-2) ?? "")] ?? {}
        const providerThreads = (read.sessions ?? []).map((nativeId) => ({ nativeThreadRef: { driver: "claudeAgent", nativeId, strength: "strong" } }))
        return Schema.decodeUnknown(schema)({
          projection: { runs: read.runs ?? [], messages: read.messages ?? [], turnItems: read.turnItems ?? [], providerThreads },
        }).pipe(Effect.orDie)
      }) as Server.Transport["api"],
      call: (() => Effect.die("not expected")) as Server.Transport["call"],
    })
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: { view: Effect.succeed(Option.some(view)), changes: Stream.fromQueue(changes) },
      actions: Option.some(T3Actions.make(reach)),
      others: [],
      journal,
      store,
    })
    const told: Array<string> = []
    /** What was asked as the one question open, as the assistant asks it: once, ever, kept under its key. */
    const asked: Array<string> = []
    const settled: Array<string> = []
    const finished: Array<{ readonly key: string; readonly message: string }> = []
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
      power: Effect.succeed({ on: true, turns: 1 }),
      stopped: (sessions) =>
        Effect.sync(() => {
          const at = sessions.flatMap((session) => Option.toArray(Option.fromNullable(given.stops?.get(session))))
          return at.length === 0 ? Option.none() : Option.some(Math.max(...at))
        }),
      finished: (input) => Effect.sync(() => void finished.push({ key: input.key, message: input.turn.message })),
      mention: () => Effect.void,
      ask: (asking) => Effect.map(journal.claim(asking.entry), (kept) => void (Option.isSome(kept) && asked.push(asking.asked))),
      settled: (requestId) => Effect.sync(() => void settled.push(requestId)),
      shortest: 60_000,
    }).pipe(Effect.provide(Layer.merge(persona, condenser)))
    yield* Effect.forkScoped(made.follow)
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    return {
      ...made,
      store,
      journal,
      told,
      asked,
      settled,
      finished,
      /** T3 Code tells of these. */
      hear: (...happened: ReadonlyArray<T3Live.Change>) => Queue.offerAll(changes, happened).pipe(Effect.zipRight(flush)),
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
    // Claude's hook for the Tezos turn came, and was skipped as quick; nothing has hooks for the loader's agent.
    const tezos = thread("tezos", "Migrate Tezos Integration", { latestRunId: "run-1" })
    const loader = thread("loader", "Fix the loader", { latestRunId: "run-2", modelSelection: { instanceId: "opencode", model: "kimi-k3" } })
    const bounded = {
      tezos: {
        runs: [{ id: "run-1", status: "completed", ordinal: 1, startedAt: minutes(0.5), userMessageId: "m1" }],
        messages: [{ id: "a1", runId: "run-1", role: "assistant", text: "Done, the fee table is in.", createdAt: minutes(0) }],
        sessions: ["s-tezos"],
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
        const { hear, wait, finished } = yield* notices({ view: [tezos, loader], bounded, stops: new Map([["s-tezos", now - 2_000]]) })
        yield* hear(ended(tezos, "run-1"), ended(loader, "run-2"))
        yield* wait(19)
        const early = [...finished]
        yield* wait(1)
        return { early, finished }
      }),
    )
    expect(result.early).toEqual([])
    expect(result.finished).toEqual([{ key: "done:Rosie:run-2", message: "The loader is fixed." }])
  })

  test("a pending request is announced once after a restart, and not at all if it was already said", async () => {
    const tezos = thread("tezos", "Migrate Tezos Integration", {
      activeRunId: "run-1",
      pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: minutes(60) },
    })
    const mina = thread("mina", "Open Mina SSV2 Bug Tickets", {
      activeRunId: "run-2",
      pendingRuntimeRequest: { id: "r2", kind: "user_input", createdAt: minutes(60) },
    })
    const bounded = {
      tezos: { turnItems: [{ type: "approval_request", status: "waiting", requestId: "r1", requestKind: "command", prompt: "Bash: git push origin tezos" }] },
      mina: { turnItems: [{ type: "user_input_request", status: "waiting", requestId: "r2", questions: [{ id: "q", question: "Which database?" }] }] },
    }
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        // The Mina question was said before the restart.
        yield* Journal.fromStore(store).claim({ at: now - 3_000_000, kind: "notice", machine: "Rosie", thread: "mina", key: "ask:Rosie:r2", said: "It asks which database." })
        const first = yield* notices({ view: [tezos, mina], bounded, store })
        yield* first.reconcile
        yield* first.flush
        // And yapd restarts again.
        const second = yield* notices({ view: [tezos, mina], bounded, store })
        yield* second.reconcile
        yield* second.flush
        return { first: [...first.told, ...first.asked], second: [...second.told, ...second.asked] }
      }),
    )
    expect(result.first).toEqual(["Migrate Tezos Integration wants to push the branch. Allow it, sir?"])
    expect(result.second).toEqual([])
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
})
