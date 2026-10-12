import { describe, expect, test } from "bun:test"
import { Clock, Effect, Option, PubSub, Queue, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Icons from "./Icons.ts"
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

const integration: T3Live.Project = { id: "p-int", title: "integration", workspaceRoot: "/code/integration", projectIcon: { kind: "emoji", emoji: "🦀" } }

/**
 * The latest threads over a journal and mutes kept in `path`, with T3 Code
 * showing `shown` threads on each machine, all in the integration project,
 * and a session in its folder found to be in it too.
 */
const listing = (
  shown: Readonly<Record<string, ReadonlyArray<T3Live.Thread>>>,
  path = ":memory:",
  /** What he heard, and each time that changes. */
  hearing: Pick<Parameters<typeof Latest.make>[0], "heard" | "hearing" | "desk"> = {},
  /** Whether what he hasn't heard is counted, as a catch-up gathers it. */
  counting = false,
) =>
  Effect.gen(function* () {
    const store = yield* Store.make(path)
    const journal = Journal.fromStore(store, (host) => host.split(".")[0] ?? host, yield* PubSub.unbounded<Journal.Kept>(), yield* PubSub.unbounded<void>())
    const mutes = yield* Mutes.make(store)
    const icons = yield* Icons.make({ actions: () => Option.none() })
    const changes = yield* Queue.unbounded<{ readonly machine: string; readonly change: T3Live.Change }>()
    const views: Record<string, ReadonlyArray<T3Live.Thread> | undefined> = { ...shown }
    let looked = 0
    const threads: Pick<Threads.Threads["Type"], "find" | "project" | "changes" | "unseen"> = {
      // A machine's threads are seen once T3 Code there has caught up.
      unseen: (machine) => Effect.sync(() => (views[machine] === undefined ? Option.some(`I can't see ${machine}'s threads yet.`) : Option.none())),
      find: (ref) => Effect.sync(() => Option.fromNullable(views[ref.machine]?.find(({ id }) => id === ref.id))),
      project: (_, where) =>
        Effect.sync(() => void looked++).pipe(Effect.as(
          
          where.thread !== undefined ? (Object.values(views).flatMap((all) => all ?? []).some(({ id }) => id === where.thread) ? Option.some(integration) : Option.none()) : where.directory?.startsWith("/code/integration") === true ? Option.some(integration) : Option.none(),
        )),
      changes: Stream.fromQueue(changes),
    }
    const missed = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.map(Missed.gather(journal, { now, spoke: now - day, coming: [], desk: { threads: [], away: [] } }), ({ groups }) => groups),
    )
    const latest = yield* Latest.make({ here: "Rosie", journal, mutes, icons, threads, ...hearing, ...(counting ? { missed } : {}) })
    // Following what changes from here on.
    yield* flush
    return {
      latest,
      journal,
      mutes,
      /** How many times a row's project was looked for, which each time the list is built does. */
      looked: () => looked,
      threads,
      /** T3 Code on a machine catches up, telling of no change as it does. */
      caughtUp: (machine: string, all: ReadonlyArray<T3Live.Thread>) => Effect.sync(() => void (views[machine] = all)),
      /** A machine's threads can't be seen any more, as when it's away, which T3 Code there can't tell of. */
      away: (machine: string) => Effect.sync(() => void (views[machine] = undefined)),
      /** T3 Code shows a thread as it is now, and tells of what changed. */
      becomes: (machine: string, after: T3Live.Thread, change: T3Live.Change["_tag"]) =>
        Effect.gen(function* () {
          views[machine] = [...(views[machine] ?? []).filter(({ id }) => id !== after.id), after]
          yield* Queue.offer(changes, { machine, change: { _tag: change, thread: after, before: after } as T3Live.Change })
        }),
    }
  })

/** What each row shows, in short. */
const brief = (rows: ReadonlyArray<Server.Recent>) => rows.map(({ key, title, text, muted }) => `${key} · ${title} · ${text}${muted ? " · muted" : ""}`)

describe("Latest", () => {
  test("counts the threads that wait on him, on every machine, as they come and go", async () => {
    const result = await run(
      Effect.gen(function* () {
        const states = new Map<string, Threads.State>([
          ["Rosie/t-tezos", "question"],
          ["rig/t-mina", "approval"],
          ["Rosie/t-std", "running"],
          ["rig/t-idle", "failed"],
        ])
        const desk = Effect.sync(() => ({ threads: [...states.values()].map((state) => ({ state })), away: [] }) as unknown as Threads.Desk)
        const { latest, becomes } = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration")], rig: [] }, ":memory:", { desk })
        const counts: Array<number> = []
        yield* Effect.forkScoped(Stream.runForEach(latest.waiting, (count) => Effect.sync(() => void counts.push(count))))
        yield* flush
        // Answered in T3 Code, it no longer waits on him.
        states.set("Rosie/t-tezos", "running")
        yield* becomes("Rosie", thread("t-tezos", "Migrate the Tezos integration"), "Answered")
        yield* TestClock.adjust("250 millis")
        yield* flush
        return counts
      }),
    )
    expect(result).toEqual([2, 1])
  })


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
    expect(result[2]).toMatchObject({ until: new Date(10 * day + 60 * 60_000).toISOString() })
    expect(result[0]).toEqual({
      key: "t3:Rosie:t-0",
      machine: "Rosie",
      thread: "t-0",
      title: "Thread 0",
      project: { name: "integration", id: "p-int", icon: { kind: "emoji", emoji: "🦀", text: "IN", color: "indigo" } },
      text: "Thread 0 asks something.",
      at: new Date(10 * day).toISOString(),
      muted: false,
      waiting: false,
      replayable: true,
    })
  })

  test("titles a thread T3 Code has, one it no longer has, a session here and one on rig, and says which wait on him", async () => {
    const result = await run(
      Effect.gen(function* () {
        const waiting = thread("t-tezos", "Migrate the Tezos integration", { pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: "2026-10-08T00:00:00.000Z" } })
        const { latest, journal, mutes } = yield* listing({ Rosie: [waiting] })
        yield* mutes.mute({ key: "t3:Rosie:t-gone", called: "the old loader work" })
        yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Which network first?", detail: { session: "claude:s-tezos" } })
        yield* journal.write({ at: 2, kind: "update", machine: "Rosie", thread: "t-gone", said: "yapd. The loader is fixed.", project: "yapd", detail: { session: "claude:s-gone" } })
        yield* journal.write({ at: 3, kind: "update", host: "Rosie.local", thread: "claude:s-term", directory: "/code/integration/src", project: "integration", said: "integration. The fee table is in." })
        yield* journal.write({ at: 4, kind: "update", host: "rig.local", thread: "codex:s-rig", directory: "/home/laurent/std", project: "std", said: "std. The cache is fixed." })
        yield* TestClock.adjust("250 millis")
        yield* flush
        return yield* latest.current
      }),
    )
    expect(result.map(({ key, thread, title, project, waiting }) => ({ key, thread, title, project: project?.name, id: project?.id, waiting }))).toEqual([
      { key: "session:rig:codex:s-rig", thread: null, title: "Codex session on rig", project: "std", id: undefined, waiting: false },
      { key: "session:Rosie:claude:s-term", thread: null, title: "Claude session", project: "integration", id: "p-int", waiting: false },
      { key: "t3:Rosie:t-gone", thread: "t-gone", title: "the old loader work", project: "yapd", id: undefined, waiting: false },
      { key: "t3:Rosie:t-tezos", thread: "t-tezos", title: "Migrate the Tezos integration", project: "integration", id: "p-int", waiting: true },
    ])
    expect(result[2]?.muted).toBe(true)
  })

  test("can be heard again: a thread yapd can reach, here or on rig while it's seen, or a row whose update he heard is still there to hear again, never otherwise", async () => {
    const result = await run(
      Effect.gen(function* () {
        const heard = [{ id: "heard-s", key: "session:Rosie:claude:s-heard", at: 2 }]
        const hearing = yield* Queue.unbounded<void>()
        const { latest, journal, away, threads } = yield* listing(
          {
            Rosie: [thread("t-tezos", "Migrate the Tezos integration"), thread("t-old", "Old loader work", { archivedAt: "2026-10-08T00:00:00.000Z" })],
            rig: [thread("t-rig", "Fix the rig cache")],
          },
          ":memory:",
          {
            heard: (key, at) => Effect.sync(() => Option.fromNullable(heard.find((one) => one.key === key && one.at >= at)?.id)),
            hearing: Stream.fromQueue(hearing),
          },
        )
        yield* journal.write({ at: 1, kind: "update", host: "Rosie", thread: "claude:s-term", directory: "/code/integration", said: "integration. Done." })
        yield* journal.write({ at: 2, kind: "update", host: "Rosie", thread: "claude:s-heard", directory: "/code/integration", said: "integration. Heard." })
        yield* journal.write({ at: 3, kind: "update", machine: "Rosie", thread: "t-old", said: "yapd. Old.", detail: { session: "claude:s-old" } })
        yield* journal.write({ at: 4, kind: "update", machine: "Rosie", thread: "t-gone", said: "yapd. Gone.", detail: { session: "claude:s-gone" } })
        yield* journal.write({ at: 5, kind: "update", machine: "rig", thread: "t-rig", said: "std. Cached.", detail: { session: "claude:s-rig" } })
        yield* journal.write({ at: 6, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Halfway.", detail: { session: "claude:s-tezos" } })
        const flags = Effect.map(latest.current, (rows) => Object.fromEntries(rows.map(({ key, replayable }) => [key, replayable])))
        yield* TestClock.adjust("250 millis")
        yield* flush
        const first = yield* flags
        // What he heard moves on, so the session's update is no longer there to hear again.
        heard.length = 0
        yield* Queue.offer(hearing, undefined)
        yield* TestClock.adjust("250 millis")
        yield* flush
        const forgotten = yield* flags
        // rig goes away, which T3 Code there can't tell of, so it's seen at the next look, a minute on.
        yield* away("rig")
        yield* TestClock.adjust("1 minute")
        yield* flush
        return { first, forgotten, away: yield* flags, found: Option.isSome(yield* threads.find({ machine: "rig", id: "t-rig" })) }
      }),
    )
    expect(result.first).toEqual({
      "t3:Rosie:t-tezos": true,
      "t3:rig:t-rig": true,
      "t3:Rosie:t-gone": false,
      "t3:Rosie:t-old": false,
      "session:Rosie:claude:s-heard": true,
      "session:Rosie:claude:s-term": false,
    })
    expect(result.forgotten).toEqual({ ...result.first, "session:Rosie:claude:s-heard": false })
    expect(result.away).toEqual({ ...result.forgotten, "t3:rig:t-rig": false })
    expect(result.found).toBe(false)
  })

  test("a session's own row is the thread's once the thread shows an update of it, as when its link timed out once, and a session's mute shows on its thread", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { latest, journal, mutes } = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration")] })
        // Not tied in time the first time, then tied.
        yield* journal.write({ at: 1, kind: "update", host: "Rosie", thread: "claude:s-tezos", said: "integration. Started." })
        yield* journal.write({ at: 2, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Done.", detail: { session: "claude:s-tezos" } })
        // Muted by the session, before it was known to be the thread's.
        yield* mutes.mute({ key: "session:Rosie:claude:s-tezos" })
        yield* TestClock.adjust("250 millis")
        yield* flush
        return yield* latest.current
      }),
    )
    expect(brief(result)).toEqual(["t3:Rosie:t-tezos · Migrate the Tezos integration · integration. Done. · muted"])
  })

  test("a session's row stays the thread's, and the thread muted by it, once a question the thread asked is its newest", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { latest, journal, mutes } = yield* listing({ rig: [thread("t-tezos", "Migrate the Tezos integration")] })
        // rig's T3 Code took too long the first time, then it was tied.
        yield* journal.write({ at: 1, kind: "update", host: "rig.local", thread: "claude:s-tezos", directory: "/code/integration", said: "integration. Started." })
        yield* mutes.mute({ key: "session:rig:claude:s-tezos" })
        yield* journal.write({ at: 2, kind: "update", machine: "rig", thread: "t-tezos", said: "integration. Halfway.", detail: { session: "claude:s-tezos" } })
        yield* journal.write({ at: 3, kind: "notice", machine: "rig", thread: "t-tezos", said: "The Tezos migration asks which network first." })
        yield* TestClock.adjust("250 millis")
        yield* flush
        return { rows: brief(yield* latest.current), under: yield* latest.under("t3:rig:t-tezos") }
      }),
    )
    expect(result.rows).toEqual(["t3:rig:t-tezos · Migrate the Tezos integration · The Tezos migration asks which network first. · muted"])
    expect(result.under).toEqual(["session:rig:claude:s-tezos"])
  })

  test("a thread's row shows a newer update kept under its session, as when its link timed out, and hides its other sessions' rows", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { latest, journal } = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration")] })
        yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Started, in the session before.", detail: { session: "claude:s-old" } })
        // The session before, resumed, its link timing out.
        yield* journal.write({ at: 2, kind: "update", host: "Rosie", thread: "claude:s-old", said: "Older, under the session before." })
        yield* journal.write({ at: 3, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Older, linked.", detail: { session: "claude:s1" } })
        // T3 Code was restarting, so the newest is kept under its session.
        yield* journal.write({ at: 4, kind: "update", host: "Rosie", thread: "claude:s1", said: "Newer, under the session." })
        yield* journal.write({ at: 0, kind: "update", machine: "Rosie", thread: "t-mina", said: "Mina, first.", detail: { session: "claude:s-mina" } })
        yield* TestClock.adjust("250 millis")
        yield* flush
        return { rows: (yield* latest.current).map(({ key, text, at }) => `${key} · ${text} · ${at}`), under: yield* latest.under("t3:Rosie:t-tezos") }
      }),
    )
    expect(result.rows).toEqual([`t3:Rosie:t-tezos · Newer, under the session. · ${new Date(4).toISOString()}`, `t3:Rosie:t-mina · Mina, first. · ${new Date(0).toISOString()}`])
    expect(result.under).toEqual(["session:Rosie:claude:s1"])
  })

  test("a session's row from a machine yapd doesn't follow never has it built again every few seconds", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { latest, journal, looked } = yield* listing({ Rosie: [] })
        yield* journal.write({ at: 1, kind: "update", host: "other-mac.local", thread: "claude:s-away", said: "Done over there." })
        yield* TestClock.adjust("250 millis")
        yield* flush
        const built = looked()
        for (let index = 0; index < 6; index++) {
          yield* TestClock.adjust("5 seconds")
          yield* flush
        }
        return { rows: brief(yield* latest.current), again: looked() - built }
      }),
    )
    expect(result.rows).toEqual(["session:other-mac:claude:s-away · Claude session on other-mac · Done over there."])
    expect(result.again).toBe(0)
  })

  test("is built again a few seconds after a machine's threads come in, which T3 Code tells of no change for", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { latest, journal, caughtUp } = yield* listing({})
        yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Done.", detail: { session: "claude:s" } })
        yield* TestClock.adjust("250 millis")
        yield* flush
        const before = brief(yield* latest.current)
        yield* caughtUp("Rosie", [thread("t-tezos", "Migrate the Tezos integration")])
        yield* TestClock.adjust("5 seconds")
        yield* flush
        yield* TestClock.adjust("250 millis")
        yield* flush
        return { before, after: (yield* latest.current).map(({ title, project }) => `${title} · ${project?.id}`) }
      }),
    )
    expect(result.before).toEqual(["t3:Rosie:t-tezos · A thread · integration. Done."])
    expect(result.after).toEqual(["Migrate the Tezos integration · p-int"])
  })

  test("is built again a moment after something is kept or claimed, a mute changes or a thread is renamed, and from the journal after a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "yapd-latest-"))
    try {
      const path = join(root, "yapd.sqlite")
      const result = await run(
        Effect.gen(function* () {
          const { latest, journal, mutes, becomes } = yield* listing({ Rosie: [thread("t-tezos", "Migrate Tezos")] }, path)
          const seen: Array<ReadonlyArray<string>> = []
          yield* Effect.forkScoped(Stream.runForEach(latest.rows, (rows) => Effect.sync(() => void seen.push(brief(rows)))))
          yield* flush
          const settle = Effect.zipRight(TestClock.adjust("250 millis"), flush)
          yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Started.", detail: { session: "claude:s" } })
          yield* settle
          yield* journal.claim({ at: 2, kind: "notice", key: "ask:Rosie:r1", machine: "Rosie", thread: "t-tezos", said: "It asks something." })
          yield* settle
          yield* mutes.mute({ key: "t3:Rosie:t-tezos" })
          yield* settle
          yield* becomes("Rosie", thread("t-tezos", "Migrate the Tezos integration"), "Renamed")
          yield* settle
          // What changes nothing shown, like an answer kept, isn't told of again.
          yield* journal.write({ at: 3, kind: "answer", said: "Two running." })
          yield* settle
          return seen
        }),
      )
      expect(result).toEqual([
        [],
        ["t3:Rosie:t-tezos · Migrate Tezos · integration. Started."],
        ["t3:Rosie:t-tezos · Migrate Tezos · It asks something."],
        ["t3:Rosie:t-tezos · Migrate Tezos · It asks something. · muted"],
        ["t3:Rosie:t-tezos · Migrate the Tezos integration · It asks something. · muted"],
      ])
      const again = await run(Effect.flatMap(listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration")] }, path), ({ latest }) => latest.current))
      expect(brief(again)).toEqual(["t3:Rosie:t-tezos · Migrate the Tezos integration · It asks something. · muted"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  describe("menu", () => {
    /** The menu over the latest threads, with a daemon that heard `heard` updates under their keys, each at its time, and is `on`. */
    const menuOf = (
      heard: ReadonlyArray<{ readonly id: string; readonly key: string; readonly at: number }>,
      on = true,
      shown: Readonly<Record<string, ReadonlyArray<T3Live.Thread>>> = { Rosie: [thread("t-tezos", "Migrate the Tezos integration")] },
    ) =>
      Effect.gen(function* () {
        // The newest he heard under the key, kept at `at` or since.
        const latestHeard = (key: string, at: number) => Effect.succeed(Option.fromNullable(heard.filter((one) => one.key === key && one.at >= at).at(-1)?.id))
        const listed = yield* listing(shown, ":memory:", { heard: latestHeard })
        const told: Array<string> = []
        const replayed: Array<string> = []
        const mentioned: Array<string> = []
        const controls = Mutes.controls({ mutes: listed.mutes, silence: () => Effect.void, journal: listed.journal })
        const menu = Latest.menu({
          latest: listed.latest,
          threads: listed.threads,
          mutes: listed.mutes,
          controls,
          daemon: {
            latestHeard,
            // Said again for the row, by its key, which only "mute it" over it uses.
            replay: (id, menu) => Effect.sync(() => void replayed.push(`${id} for ${menu}`)).pipe(Effect.as("queued" as const)),
            power: Effect.succeed({ on, turns: 1 }),
            // Said at once, which makes "it" the thread it's about.
            tell: (notice) =>
              Effect.sync(() => void told.push(notice.spoken)).pipe(Effect.zipRight(notice.saying ?? Effect.void), Effect.zipRight(notice.heard ?? Effect.void), Effect.as(true)),
          } as Parameters<typeof Latest.menu>[0]["daemon"],
          mention: (ref, said) => Effect.sync(() => void mentioned.push(`${ref.machine}/${ref.id}: ${said}`)),
          journal: listed.journal,
        })
        const settle = Effect.zipRight(TestClock.adjust("250 millis"), flush)
        return { ...listed, menu, told, replayed, mentioned, settle }
      })

    test("a row kept while off, heard again from the menu, is said in full, its more too, never only its headline, before it counts as heard", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, menu, told, settle } = yield* menuOf([])
          yield* journal.write({
            at: 1,
            kind: "update",
            machine: "Rosie",
            thread: "t-tezos",
            said: "Tezos asks which network to deploy to first.",
            detail: { session: "claude:s", held: "off", priority: "needs-you", more: "Mainnet costs more but has the real fees; Ghostnet is free." },
          })
          yield* settle
          const replayed = yield* menu.replayThread("t3:Rosie:t-tezos")
          return { replayed, told: [...told], after: (yield* journal.held(0)).length }
        }),
      )
      expect(result).toEqual({
        replayed: "queued",
        told: ["Tezos asks which network to deploy to first. Mainnet costs more but has the real fees; Ghostnet is free."],
        after: 0,
      })
    })

    test("a row held for later, heard again from the menu, counts as heard once it's said, so the digest doesn't tell of it again", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, menu, told, settle } = yield* menuOf([])
          yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration's review pass 7 is running.", detail: { session: "claude:s", held: "progress" } })
          yield* settle
          const before = (yield* journal.held(0)).length
          const replayed = yield* menu.replayThread("t3:Rosie:t-tezos")
          return { before, replayed, told: [...told], after: (yield* journal.held(0)).length }
        }),
      )
      expect(result).toEqual({ before: 1, replayed: "queued", told: ["integration's review pass 7 is running."], after: 0 })
    })

    test("hears a thread again from the update it shows, not one he heard before what was kept quiet of it or a question it asked since", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, menu, told, replayed, mentioned, settle } = yield* menuOf([{ id: "heard-a", key: "t3:Rosie:t-tezos", at: 1 }])
          yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Started.", detail: { session: "claude:s" } })
          yield* journal.write({ at: 2, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Halfway.", detail: { session: "claude:s", muted: true } })
          yield* settle
          const quiet = yield* menu.replayThread("t3:Rosie:t-tezos")
          yield* journal.write({ at: 3, kind: "notice", machine: "Rosie", thread: "t-tezos", said: "The Tezos migration asks which network first." })
          yield* settle
          const notice = yield* menu.replayThread("t3:Rosie:t-tezos")
          return { quiet, notice, told: [...told], replayed: [...replayed], mentioned: [...mentioned], unknown: yield* menu.replayThread("t3:Rosie:t-nope") }
        }),
      )
      expect([result.quiet, result.notice, result.unknown]).toEqual(["queued", "queued", "unknown"])
      expect(result.told).toEqual(["integration. Halfway.", "The Tezos migration asks which network first."])
      expect(result.mentioned).toEqual(["Rosie/t-tezos: integration. Halfway.", "Rosie/t-tezos: The Tezos migration asks which network first."])
      expect(result.replayed).toEqual([])
    })

    test("hears again as it was said the update he heard that the row shows, under its thread or the session it's shown from", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, menu, told, replayed, mentioned, settle } = yield* menuOf([
            { id: "heard-a", key: "t3:Rosie:t-tezos", at: 1 },
            { id: "heard-b", key: "session:Rosie:claude:s", at: 2 },
            { id: "heard-c", key: "session:Rosie:claude:s-term", at: 3 },
          ])
          yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Started.", detail: { session: "claude:s" } })
          yield* settle
          const linked = yield* menu.replayThread("t3:Rosie:t-tezos")
          // Its link timed out, so it's kept under its session.
          yield* journal.write({ at: 2, kind: "update", host: "Rosie", thread: "claude:s", said: "integration. Done." })
          yield* settle
          const session = yield* menu.replayThread("t3:Rosie:t-tezos")
          // A terminal session's row whose update he heard is heard again as it was too, though yapd can't reach it.
          yield* journal.write({ at: 3, kind: "update", host: "Rosie", thread: "claude:s-term", directory: "/code/integration", said: "integration. Done here." })
          yield* settle
          const terminal = yield* menu.replayThread("session:Rosie:claude:s-term")
          return { linked, session, terminal, told: [...told], replayed: [...replayed], mentioned: [...mentioned] }
        }),
      )
      expect([result.linked, result.session, result.terminal]).toEqual(["queued", "queued", "queued"])
      // As "Hear Again" says an update: nothing makes "it" anything else.
      expect(result.replayed).toEqual(["heard-a for t3:Rosie:t-tezos", "heard-b for t3:Rosie:t-tezos", "heard-c for session:Rosie:claude:s-term"])
      expect(result.told).toEqual([])
      expect(result.mentioned).toEqual([])
    })

    test("hears again neither a session's row nor a thread yapd can't reach, archived, deleted or on rig while it's away, and says nothing of them", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, menu, told, replayed, mentioned, settle, away } = yield* menuOf([], true, {
            Rosie: [thread("t-tezos", "Migrate the Tezos integration"), thread("t-old", "Old loader work", { archivedAt: "2026-10-08T00:00:00.000Z" })],
            rig: [thread("t-rig", "Fix the rig cache")],
          })
          yield* journal.write({ at: 1, kind: "update", host: "Rosie", thread: "claude:s-term", directory: "/code/integration", said: "integration. Done." })
          yield* journal.write({ at: 2, kind: "update", host: "rig.local", thread: "codex:s-rig", directory: "/code/std", said: "std. Done on rig." })
          yield* journal.write({ at: 3, kind: "update", machine: "Rosie", thread: "t-old", said: "yapd. Old.", detail: { session: "claude:s-old" } })
          yield* journal.write({ at: 4, kind: "update", machine: "Rosie", thread: "t-gone", said: "yapd. Gone.", detail: { session: "claude:s-gone" } })
          yield* journal.write({ at: 5, kind: "update", machine: "rig", thread: "t-rig", said: "std. Cached.", detail: { session: "claude:s-rig" } })
          yield* settle
          const outcomes = [
            yield* menu.replayThread("session:Rosie:claude:s-term"),
            yield* menu.replayThread("session:rig:codex:s-rig"),
            yield* menu.replayThread("t3:Rosie:t-old"),
            yield* menu.replayThread("t3:Rosie:t-gone"),
            yield* menu.replayThread("t3:rig:t-rig"),
          ]
          // rig goes away: its thread is checked as it's asked for, whatever the list last said.
          yield* away("rig")
          outcomes.push(yield* menu.replayThread("t3:rig:t-rig"))
          return { outcomes, told: [...told], replayed: [...replayed], mentioned: [...mentioned] }
        }),
      )
      expect(result.outcomes).toEqual(["unreachable", "unreachable", "unreachable", "unreachable", "queued", "unreachable"])
      expect(result.told).toEqual(["std. Cached."])
      expect(result.mentioned).toEqual(["rig/t-rig: std. Cached."])
      expect(result.replayed).toEqual([])
    })

    test("says nothing again while yapd is off", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, menu, told, settle } = yield* menuOf([], false)
          yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Halfway.", detail: { session: "claude:s", muted: true } })
          yield* settle
          return { result: yield* menu.replayThread("t3:Rosie:t-tezos"), told: [...told] }
        }),
      )
      expect(result).toEqual({ result: "off", told: [] })
    })

    test("mutes a thread it lists or T3 Code has, by its title and project, but no key yapd never made or thread it doesn't know", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { journal, latest, menu, mutes, settle } = yield* menuOf([])
          yield* journal.write({ at: 1, kind: "update", host: "Rosie", thread: "claude:s-term", directory: "/code/integration", project: "integration", said: "integration. Done." })
          // A machine he named with a space in it, as YAPD_NAME="My Mac" does.
          yield* journal.write({ at: 2, kind: "update", host: "My Mac", thread: "claude:s-mine", directory: "/code/integration", project: "integration", said: "integration. Done." })
          yield* settle
          const mine = (yield* latest.current).find(({ machine }) => machine === "My Mac")?.key ?? ""
          const outcomes = [
            yield* menu.mute("session:Rosie:claude:s-term"),
            yield* menu.mute(decodeURIComponent(encodeURIComponent(mine))),
            yield* menu.mute("t3:Rosie:t-tezos", 10 * 60_000),
            yield* menu.mute("t3:Rosie:t-nope"),
            yield* menu.mute("whatever"),
          ]
          return { outcomes, mutes: (yield* mutes.list).map(({ key, called, project, ends }) => ({ key, called, project, ends })) }
        }),
      )
      expect(result.outcomes).toEqual(["muted", "muted", "muted", "unknown", "invalid"])
      expect(result.mutes).toEqual([
        { key: "session:My%20Mac:claude:s-mine", called: "Claude session on My Mac", project: "integration", ends: undefined },
        { key: "session:Rosie:claude:s-term", called: "Claude session", project: "integration", ends: undefined },
        { key: "t3:Rosie:t-tezos", called: "Migrate the Tezos integration", project: undefined, ends: 10 * 60_000 },
      ])
    })
  })

  test("counts what he hasn't heard of each thread, what came in while yapd was off and what was kept quiet too, and in all only what wasn't kept quiet, and drops once he's heard it", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.adjust(`${day} millis`)
        const { latest, journal } = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration"), thread("t-docs", "Sweep the docs")] }, ":memory:", {}, true)
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

  test("counts what came in while yapd was off over a weekend, though it was turned off and on for a moment since", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.adjust(`${10 * day} millis`)
        const { latest, journal } = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration")] }, ":memory:", {}, true)
        const now = yield* Clock.currentTimeMillis
        const hour = 60 * 60_000
        yield* journal.write({ at: now - 64 * hour, kind: "action", detail: { on: false } })
        yield* journal.write({ at: now - 50 * hour, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Which network first?", detail: { session: "claude:s", priority: "needs-you", held: "off" } })
        yield* journal.write({ at: now - 40 * hour, kind: "notice", machine: "Rosie", thread: "t-tezos", key: "fail:Rosie:r1", said: "It failed.", detail: { failure: "provider_error" } })
        yield* journal.write({ at: now - 4 * hour, kind: "action", detail: { on: true } })
        yield* journal.write({ at: now - 2 * hour, kind: "action", detail: { on: false } })
        yield* journal.write({ at: now - 1 * hour, kind: "action", detail: { on: true } })
        const totals: Array<number> = []
        yield* Effect.forkScoped(Stream.runForEach(latest.unheard, (count) => Effect.sync(() => void totals.push(count))))
        yield* TestClock.adjust("250 millis")
        yield* flush
        return { counts: (yield* latest.current).map(({ key, unheard }) => [key, unheard]), total: totals.at(-1) }
      }),
    )
    expect(result).toEqual({ counts: [["t3:Rosie:t-tezos", 2]], total: 2 })
  })

  test("a row kept while yapd was off, of a thread it can reach, is heard again from the menu and heard once it's said; a terminal session's isn't", async () => {
    const result = await run(
      Effect.gen(function* () {
        const listed = yield* listing({ Rosie: [thread("t-tezos", "Migrate the Tezos integration")] })
        const told: Array<string> = []
        const menu = Latest.menu({
          latest: listed.latest,
          threads: listed.threads,
          mutes: listed.mutes,
          controls: Mutes.controls({ mutes: listed.mutes, silence: () => Effect.void, journal: listed.journal }),
          daemon: {
            latestHeard: () => Effect.succeedNone,
            replay: () => Effect.succeed("queued" as const),
            power: Effect.succeed({ on: true, turns: 1 }),
            tell: (notice) => Effect.sync(() => void told.push(notice.spoken)).pipe(Effect.zipRight(notice.heard ?? Effect.void), Effect.as(true)),
          } as Parameters<typeof Latest.menu>[0]["daemon"],
          mention: () => Effect.void,
          journal: listed.journal,
        })
        yield* listed.journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Distribox migrated.", detail: { session: "claude:s", held: "off" } })
        yield* listed.journal.write({ at: 2, kind: "update", machine: "Rosie", thread: "claude:term", directory: "/tmp", said: "The terminal one is done.", detail: { held: "off" } })
        yield* TestClock.adjust("250 millis")
        yield* flush
        const rows = (yield* listed.latest.current).map(({ key, replayable }) => [key, replayable])
        const again = yield* menu.replayThread("t3:Rosie:t-tezos")
        const session = yield* menu.replayThread("session:Rosie:claude:term")
        return { rows, thread: again, session, told, unheard: (yield* listed.journal.unheard(0, 10)).map(({ said }) => said) }
      }),
    )
    expect(result.rows).toEqual([
      ["session:Rosie:claude:term", false],
      ["t3:Rosie:t-tezos", true],
    ])
    expect(result).toMatchObject({ thread: "queued", session: "unreachable", told: ["Distribox migrated."], unheard: ["The terminal one is done."] })
  })
})
