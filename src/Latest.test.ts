import { describe, expect, test } from "bun:test"
import { Effect, Option, PubSub, Queue, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Icons from "./Icons.ts"
import * as Journal from "./Journal.ts"
import * as Latest from "./Latest.ts"
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
const listing = (shown: Readonly<Record<string, ReadonlyArray<T3Live.Thread>>>, path = ":memory:") =>
  Effect.gen(function* () {
    const store = yield* Store.make(path)
    const journal = Journal.fromStore(store, (host) => host.split(".")[0] ?? host, yield* PubSub.unbounded<Journal.Kept>())
    const mutes = yield* Mutes.make(store)
    const icons = yield* Icons.make({ actions: () => Option.none() })
    const changes = yield* Queue.unbounded<{ readonly machine: string; readonly change: T3Live.Change }>()
    const views = { ...shown }
    const threads: Pick<Threads.Threads["Type"], "find" | "project" | "changes"> = {
      find: (ref) => Effect.sync(() => Option.fromNullable(views[ref.machine]?.find(({ id }) => id === ref.id))),
      project: (_, where) =>
        Effect.succeed(
          where.thread !== undefined ? (Object.values(views).flat().some(({ id }) => id === where.thread) ? Option.some(integration) : Option.none()) : where.directory?.startsWith("/code/integration") === true ? Option.some(integration) : Option.none(),
        ),
      changes: Stream.fromQueue(changes),
    }
    const latest = yield* Latest.make({ here: "Rosie", journal, mutes, icons, threads })
    // Following what changes from here on.
    yield* flush
    return {
      latest,
      journal,
      mutes,
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
})
