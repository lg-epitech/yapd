import { Clock, Effect, Option, Schedule, Stream, SubscriptionRef } from "effect"
import type * as Icons from "./Icons.ts"
import type { Journal, Kept } from "./Journal.ts"
import * as Mutes from "./Mutes.ts"
import type * as Server from "./Server.ts"
import type * as Threads from "./Threads.ts"

// The threads with the latest updates, as a menu lists them: each thread's
// newest update or notice from the last week, newest first, whether yapd said
// it or kept it quiet, with what the thread is called, its project and that
// project's icon, and whether it's muted or waits on him. It's built from the
// journal, so a restart keeps it, and built again whenever any of it changes.
// What's said aloud of a thread lives elsewhere: this is only what's shown.

/** How far back a thread's latest counts. */
const week = 7 * 24 * 60 * 60_000

/** How many threads are listed. */
const shown = 8

/** How many of the latest are read, so threads that merge into others still leave enough. */
const read = 16

/** What a journal entry's detail says of the session it came from, when it's tied to a thread. */
const sessionOf = (kept: Kept) => {
  const session = (kept.detail as { readonly session?: unknown } | undefined)?.session
  return typeof session === "string" ? session : undefined
}

/**
 * Whether a journal entry is a session's own, not tied to a thread: an update
 * kept under its hook's session, like one from a terminal, or one whose link
 * to its thread timed out. Everything else is about a thread T3 Code runs.
 */
const sessionRow = (kept: Kept) => kept.kind === "update" && sessionOf(kept) === undefined

/** What a session is called on a menu: by its agent, and its machine when it isn't this one. */
const sessionTitle = (session: string, machine: string, here: string) =>
  `${session.startsWith("codex:") ? "Codex" : "Claude"} session${machine === here ? "" : ` on ${machine}`}`

export interface Latest {
  /** The threads with the latest updates, then each time that changes. */
  readonly rows: Stream.Stream<ReadonlyArray<Server.Recent>>
  /** The threads as listed now. */
  readonly current: Effect.Effect<ReadonlyArray<Server.Recent>>
  /**
   * The other keys a thread listed now may be muted under, beside its own:
   * the session of its latest update, muted before that session was found
   * to be the thread's. Unmuting the thread takes those off too.
   */
  readonly under: (key: string) => Effect.Effect<ReadonlyArray<string>>
}

/** How long until the list is built again while a machine's threads can't be seen yet, as just after a start or while its T3 Code reconnects. */
const blindly = "5 seconds"

/**
 * The threads with the latest updates on every machine yapd follows, `here`
 * being this one, built again a moment after anything in it changes: what's
 * kept in the journal, what's muted, an icon, a thread's title or whether it
 * waits, and once a minute, for mutes that end on their own.
 */
export const make = (options: {
  readonly here: string
  readonly journal: Journal["Type"]
  readonly mutes: Mutes.Mutes
  readonly icons: Icons.Icons
  readonly threads: Pick<Threads.Threads["Type"], "find" | "project" | "changes" | "unseen">
}) =>
  Effect.gen(function* () {
    const { here, journal, mutes, icons, threads } = options

    /** Nothing listed yet, and the keys nothing is muted under. */
    const none = { rows: [] as ReadonlyArray<Server.Recent>, under: new Map<string, ReadonlyArray<string>>(), blind: false }

    const compute = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const latest = yield* journal.latest(now - week, read)
      const muted = new Map((yield* mutes.list).map((mute) => [mute.key, mute]))
      const sessions = latest.some(sessionRow)
      // The session of each thread's latest update, even when what came since, like a question it asked, has none, and, beside a
      // session's own row, every session its recent updates came from, as a resumed one, or one whose link timed out before.
      const found = new Map<Kept, { readonly own: string | undefined; readonly all: ReadonlyArray<string> }>()
      yield* Effect.forEach(
        latest,
        (kept) =>
          Effect.gen(function* () {
            if (sessionRow(kept)) return
            const own = sessionOf(kept)
            if ((own !== undefined && !sessions) || kept.thread === undefined) return void found.set(kept, { own, all: own === undefined ? [] : [own] })
            const before = (yield* journal.byThread(kept.machine ?? here, kept.thread, read)).filter(({ kind }) => kind === "update").map(sessionOf)
            const all = [...new Set([own, ...before].filter((session) => session !== undefined))]
            found.set(kept, { own: own ?? before.find((session) => session !== undefined), all })
          }),
        { discard: true },
      )
      // A session's own row, once a thread shown has an update of it, as when its link timed out once, is that thread's: shown
      // under the thread, as whichever of the two is newer.
      const tied = new Map<string, Kept>()
      if (sessions) for (const kept of latest) for (const session of found.get(kept)?.all ?? []) tied.set(`${kept.machine ?? here}\n${session}`, kept)
      const newest = new Map<Kept, Kept>()
      for (const kept of latest) {
        const thread = sessionRow(kept) ? tied.get(`${kept.machine ?? here}\n${kept.thread}`) : undefined
        if (thread !== undefined && kept.at > (newest.get(thread) ?? thread).at) newest.set(thread, kept)
      }
      const rows = latest
        .filter((kept) => !(sessionRow(kept) && tied.has(`${kept.machine ?? here}\n${kept.thread}`)))
        .map((kept) => ({ kept, last: newest.get(kept) ?? kept }))
        .toSorted((one, other) => other.last.at - one.last.at || other.last.id - one.last.id)
        .slice(0, shown)
      const under = new Map<string, ReadonlyArray<string>>()
      let blind = false
      const listed = yield* Effect.forEach(rows, ({ kept, last }) =>
        Effect.gen(function* () {
          const machine = kept.machine ?? here
          const id = kept.thread ?? ""
          const session = sessionRow(kept)
          const key = session ? Mutes.key.session(machine, id) : Mutes.key.thread({ machine, id })
          // Muted by its session, before that session was found to be the thread's: its latest update's, or the newer session row's it shows.
          const own = last === kept ? found.get(kept)?.own : last.thread
          const by = [...new Set([found.get(kept)?.own, own])].flatMap((own) => (own === undefined || own.startsWith("finished:") ? [] : [Mutes.key.session(machine, own)]))
          under.set(key, by)
          const mute = [key, ...by].map((key) => muted.get(key)).find((mute) => mute !== undefined)
          const thread = session ? Option.none() : yield* threads.find({ machine, id })
          // Its machine's threads not in yet, what it's called and its project are looked for again soon. Never for a session's own
          // row, which T3 Code never names, as for one from a machine yapd doesn't follow, which it never sees.
          if (!session && Option.isNone(thread) && Option.isSome(yield* threads.unseen(machine))) blind = true
          const project = yield* threads.project(machine, session ? (kept.directory === undefined ? {} : { directory: kept.directory }) : { thread: id })
          const icon = Option.isSome(project) ? Option.some(yield* icons.icon(machine, project.value)) : Option.none<Icons.Icon>()
          const name = Option.match(project, { onNone: () => kept.project, onSome: ({ title }) => title })
          return {
            key,
            machine,
            thread: session ? null : id,
            title: session ? sessionTitle(id, machine, here) : Option.match(thread, { onNone: () => mute?.called ?? "A thread", onSome: ({ title }) => title }),
            ...(name === undefined
              ? {}
              : {
                  project: {
                    name,
                    ...Option.match(project, { onNone: () => ({}), onSome: ({ id }) => ({ id }) }),
                    ...Option.match(icon, { onNone: () => ({}), onSome: (icon) => ({ icon }) }),
                  },
                }),
            text: last.said ?? "",
            at: new Date(last.at).toISOString(),
            muted: mute !== undefined,
            ...(mute?.ends === undefined ? {} : { until: new Date(mute.ends).toISOString() }),
            waiting: Option.exists(thread, ({ pendingRuntimeRequest }) => pendingRuntimeRequest !== null),
          } satisfies Server.Recent
        }),
      )
      return { rows: listed, under, blind }
    }).pipe(Effect.catchAllCause((cause) => Effect.as(Effect.logWarning("Could not list the latest threads", cause), none)))

    const first = yield* compute
    const ref = yield* SubscriptionRef.make(first.rows)
    let { under, blind } = first
    /** Built again, and kept only when it changed, so nothing that follows the state hears of what didn't. */
    const refresh = Effect.flatMap(compute, (built) =>
      Effect.zipRight(
        Effect.sync(() => {
          under = built.under
          blind = built.blind
        }),
        SubscriptionRef.update(ref, (before) => (JSON.stringify(before) === JSON.stringify(built.rows) ? before : built.rows)),
      ),
    )
    const shows = new Set(["Renamed", "Asked", "Answered", "Removed"])
    yield* Stream.mergeAll(
      [
        Stream.map(journal.kept, () => undefined),
        mutes.changes,
        icons.changes,
        Stream.filter(threads.changes, ({ change }) => shows.has(change._tag)).pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("1 minute")).pipe(Stream.map(() => undefined)),
        // T3 Code tells of no change as it catches up, here or on another machine, so while one's threads can't be seen it's looked at again.
        Stream.fromSchedule(Schedule.spaced(blindly)).pipe(
          Stream.filter(() => blind),
          Stream.map(() => undefined),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Stream.debounce("250 millis"), Stream.runForEach(() => refresh), Effect.forkScoped)
    return {
      rows: Stream.changesWith(ref.changes, (one, other) => one === other),
      current: SubscriptionRef.get(ref),
      under: (key) => Effect.sync(() => under.get(key) ?? []),
    } satisfies Latest
  })
