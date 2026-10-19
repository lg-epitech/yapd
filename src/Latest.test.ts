import { describe, expect, test } from "bun:test"
import { Clock, Effect, Option, PubSub, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import * as Icons from "./Icons.ts"
import type * as Inbox from "./Inbox.ts"
import * as Journal from "./Journal.ts"
import * as Latest from "./Latest.ts"
import * as Missed from "./Missed.ts"
import * as Mutes from "./Mutes.ts"
import type * as Server from "./Server.ts"
import * as Store from "./Store.ts"
import * as T3Live from "./T3Live.ts"
import type * as Threads from "./Threads.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** Lets the fibers catch up, since the clock only moves when told to. */
const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

const day = 24 * 60 * 60_000

const thread = (id: string, title: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId: "p-int",
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  })

const integration: Threads.Placed = { id: "p-int", title: "integration", workspaceRoot: "/code/integration", projectIcon: { kind: "emoji", emoji: "🦀" }, scratch: false }

/**
 * The latest threads over a journal and mutes kept in memory, with T3 Code
 * showing `shown` threads on each machine, all in the integration project,
 * and a session in its folder found to be in it too.
 */
const listing = (
  shown: Readonly<Record<string, ReadonlyArray<T3Live.Thread>>>,
  /** Whether what he hasn't heard is counted, as a catch-up gathers it. */
  counting = false,
) =>
  Effect.gen(function* () {
    const store = yield* Store.make(":memory:")
    const journal = Journal.fromStore(store, (host) => host.split(".")[0] ?? host, yield* PubSub.unbounded<Journal.Kept>(), yield* PubSub.unbounded<void>())
    const mutes = yield* Mutes.make(store)
    const icons = yield* Icons.make({ actions: () => Option.none() })
    const views: Record<string, ReadonlyArray<T3Live.Thread> | undefined> = { ...shown }
    const threads: Pick<Threads.Threads["Type"], "find" | "project" | "changes" | "unseen"> = {
      // A machine's threads are seen once T3 Code there has caught up.
      unseen: (machine) => Effect.sync(() => (views[machine] === undefined ? Option.some(`I can't see ${machine}'s threads yet.`) : Option.none())),
      find: (ref) => Effect.sync(() => Option.fromNullable(views[ref.machine]?.find(({ id }) => id === ref.id))),
      project: (_, where) =>
        Effect.succeed(
          where.thread !== undefined ? (Object.values(views).flatMap((all) => all ?? []).some(({ id }) => id === where.thread) ? Option.some(integration) : Option.none()) : where.directory?.startsWith("/code/integration") === true ? Option.some(integration) : Option.none(),
        ),
      changes: Stream.never,
    }
    const missed = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.map(Missed.gather(journal, { now, spoke: now - day, coming: [], desk: { threads: [], away: [] } }), ({ groups }) => groups),
    )
    const latest = yield* Latest.make({ here: "Rosie", journal, mutes, icons, threads, ...(counting ? { missed } : {}) })
    // Following what changes from here on.
    yield* flush
    return { latest, journal, mutes, threads }
  })

/** What each row shows, in short. */
const brief = (rows: ReadonlyArray<Server.Recent>) => rows.map(({ key, title, text, muted }) => `${key} · ${title} · ${text}${muted ? " · muted" : ""}`)

describe("Latest", () => {
  test("each thread's newest update or notice from the last week, newest first, muted ones too, eight at most", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.adjust(`${10 * day} millis`)
        const threads = Array.from({ length: 10 }, (_, index) => thread(`t-${index}`, `Thread ${index}`))
        const { latest, journal, mutes } = yield* listing({ Rosie: threads })
        const now = 10 * day
        yield* journal.write({ at: now - 8 * day, kind: "update", machine: "Rosie", thread: "t-old", said: "Too old.", detail: { session: "claude:old" } })
        for (const [index, at] of [0, 1, 2, 3, 4, 5, 6, 7, 8].entries()) {
          yield* journal.write({ at: now - 1000 + at, kind: "update", machine: "Rosie", thread: `t-${index}`, said: `Update ${index}.`, detail: { priority: "done", session: `claude:s-${index}`, ...(index === 7 ? { muted: true } : {}) } })
        }
        // A newer one of the first, as a notice.
        yield* journal.write({ at: now, kind: "notice", machine: "Rosie", thread: "t-0", said: "Thread 0 asks something." })
        yield* mutes.mute({ key: "t3:Rosie:t-7", ends: now + 60 * 60_000 })
        yield* TestClock.adjust("250 millis")
        yield* flush
        return yield* latest.current
      }),
    )
    expect(brief(result)).toEqual([
      "t3:Rosie:t-0 · Thread 0 · Thread 0 asks something.",
      "t3:Rosie:t-8 · Thread 8 · Update 8.",
      "t3:Rosie:t-7 · Thread 7 · Update 7. · muted",
      "t3:Rosie:t-6 · Thread 6 · Update 6.",
      "t3:Rosie:t-5 · Thread 5 · Update 5.",
      "t3:Rosie:t-4 · Thread 4 · Update 4.",
      "t3:Rosie:t-3 · Thread 3 · Update 3.",
      "t3:Rosie:t-2 · Thread 2 · Update 2.",
    ])
  })

  describe("menu", () => {
    /** The menu over the latest threads, with a daemon that heard nothing and is on, and reminders of which those `offers` are offers. */
    const menuOf = (offers: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const listed = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration")] })
        /** Of each told, whether talking over it stops it, whether what he says is a follow-up about its thread, and else whether it ends there. */
        const listening: Array<{ readonly over: boolean; readonly follows: boolean; readonly ends?: boolean }> = []
        /** A follow-up about its thread, which here makes nothing of what he says. */
        const follows: NonNullable<Inbox.Notice["followUp"]> = () => Effect.succeed(Option.none())
        const controls = Mutes.controls({ mutes: listed.mutes, silence: () => Effect.void, journal: listed.journal })
        const menu = Latest.menu({
          latest: listed.latest,
          threads: listed.threads,
          mutes: listed.mutes,
          controls,
          daemon: {
            latestHeard: () => Effect.succeedNone,
            replay: () => Effect.succeed("queued" as const),
            power: Effect.succeed({ on: true, turns: 1 }),
            // Said at once, which makes "it" the thread it's about.
            tell: (notice) =>
              Effect.gen(function* () {
                const { followUp } = notice
                const other = followUp === undefined || followUp === follows ? {} : { ends: Option.isSome(yield* followUp("Tell it to stop.", 1)) }
                listening.push({ over: followUp !== undefined && notice.after !== true, follows: followUp === follows, ...other })
                yield* notice.saying ?? Effect.void
                yield* notice.heard ?? Effect.void
                return true
              }),
          } as Parameters<typeof Latest.menu>[0]["daemon"],
          mention: () => Effect.void,
          journal: listed.journal,
          following: () => follows,
          reminders: {
            get: (id) =>
              Effect.succeed(Option.some({ id, at: 0, heard: "", text: "", machine: "Rosie", thread: "t-tezos", state: "fired" as const, ...(offers.includes(id) ? { propose: "Run the tests again." } : {}) })),
          },
        })
        const settle = Effect.zipRight(TestClock.adjust("250 millis"), flush)
        return { ...listed, menu, listening, settle }
      })

    test("a row said again from the menu stops when he talks over it, and is followed up only as it could be as it was first said; what he says over what its thread waits on him for, like a secret or an offer, only stops it", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, menu, listening, settle } = yield* menuOf([7])
          const rows: ReadonlyArray<Pick<Journal.Entry, "kind" | "key" | "said" | "detail">> = [
            { kind: "update", said: "integration. Halfway.", detail: { session: "claude:s" } },
            { kind: "notice", key: "ask:Rosie:r1", said: "The Tezos migration needs the API key from you, sir, which I never take by voice." },
            { kind: "notice", key: "remind:7", said: "When the Tezos migration finished, you wanted me to offer to tell it to run the tests again, sir." },
          ]
          for (const [at, row] of rows.entries()) {
            yield* journal.write({ ...row, at: at + 1, machine: "Rosie", thread: "t-tezos" })
            yield* settle
            yield* menu.replayThread("t3:Rosie:t-tezos")
          }
          return [...listening]
        }),
      )
      expect(result).toEqual([
        { over: true, follows: true },
        { over: true, follows: false, ends: true },
        { over: true, follows: false, ends: true },
      ])
    })
  })

  test("counts what he hasn't heard of each thread, what came in while yapd was off and what was kept quiet too, and in all only what wasn't kept quiet, and drops once he's heard it", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.adjust(`${day} millis`)
        const { latest, journal } = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration"), thread("t-docs", "Sweep the docs")] }, true)
        const at = (yield* Clock.currentTimeMillis) - 60_000
        const off = Option.getOrThrow(yield* journal.write({ at, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Distribox migrated.", detail: { session: "claude:s", held: "off" } }))
        const failed = Option.getOrThrow(yield* journal.write({ at: at + 1, kind: "notice", machine: "Rosie", thread: "t-tezos", key: "fail:Rosie:r1", said: "It failed.", detail: { failure: "provider_error" } }))
        yield* journal.write({ at: at + 2, kind: "update", machine: "Rosie", thread: "t-docs", said: "Docs swept.", detail: { session: "claude:d", muted: true } })
        const totals: Array<number> = []
        yield* Effect.forkScoped(Stream.runForEach(latest.unheard, (count) => Effect.sync(() => void totals.push(count))))
        yield* TestClock.adjust("250 millis")
        yield* flush
        const counts = (yield* latest.current).map(({ key, unheard }) => [key, unheard])
        // A catch-up he heard to the end clears them at once.
        yield* journal.markHeard([off, failed], at + 30_000)
        yield* TestClock.adjust("250 millis")
        yield* flush
        return { counts, after: (yield* latest.current).map(({ key, unheard }) => [key, unheard]), totals }
      }),
    )
    expect(result.counts).toEqual([
      ["t3:Rosie:t-docs", 1],
      ["t3:Rosie:t-tezos", 2],
    ])
    expect(result.after).toEqual([
      ["t3:Rosie:t-docs", 1],
      ["t3:Rosie:t-tezos", 0],
    ])
    // Nothing before what was kept came in, then the two that weren't kept quiet, then none once heard.
    expect(result.totals).toEqual([0, 2, 0])
  })
})
