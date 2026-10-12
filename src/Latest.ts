import { Clock, Effect, Option, Schedule, Stream, SubscriptionRef } from "effect"
import type * as Daemon from "./Daemon.ts"
import type * as Icons from "./Icons.ts"
import type { Journal, Kept } from "./Journal.ts"
import * as Missed from "./Missed.ts"
import * as Mutes from "./Mutes.ts"
import type * as Server from "./Server.ts"
import type * as T3Live from "./T3Live.ts"
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
  /** How many threads wait on him, on every machine whose threads can be seen, then each time that changes. */
  readonly waiting: Stream.Stream<number>
  /** How many updates and notices a catch-up would tell him of now, muted threads aside, then each time that changes. */
  readonly unheard: Stream.Stream<number>
  /** The threads as listed now. */
  readonly current: Effect.Effect<ReadonlyArray<Server.Recent>>
  /**
   * The other keys a thread listed now may be muted under, beside its own:
   * the session of its latest update, muted before that session was found
   * to be the thread's. Unmuting the thread takes those off too.
   */
  readonly under: (key: string) => Effect.Effect<ReadonlyArray<string>>
  /** The journal entry a thread listed now shows, by its key, and all of what it said, its "more" too, to say it again in full. */
  readonly row: (key: string) => Effect.Effect<Option.Option<{ readonly id: number; readonly full: string }>>
}

/**
 * Whether yapd can reach a thread to act on it, so that hearing it again from
 * the menu can make it what "it" means: it's on its machine's desk, which
 * means that machine's threads can be seen now and it isn't archived.
 * Deleted, it isn't found at all.
 */
export const reachable = (thread: Option.Option<T3Live.Thread>) => Option.exists(thread, ({ archivedAt }) => archivedAt === null)

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
  /**
   * The newest update he heard under a key, kept at `at` or since, which the
   * menu can say again as it was said: none without a daemon.
   */
  readonly heard?: (key: string, at: number) => Effect.Effect<Option.Option<string>>
  /** Each time what he heard changes, so whether a row can be heard again is worked out again. */
  readonly hearing?: Stream.Stream<unknown>
  /** Every thread yapd can see, on every machine, to count those that wait on him: none without it. */
  readonly desk?: Effect.Effect<Threads.Desk>
  /** What he hasn't heard, as a catch-up would gather it, a thread at a time, to count: nothing without it. */
  readonly missed?: Effect.Effect<ReadonlyArray<Missed.Group>>
}) =>
  Effect.gen(function* () {
    const { here, journal, mutes, icons, threads } = options
    const heard = options.heard ?? (() => Effect.succeedNone)

    /** Nothing listed yet, and the keys nothing is muted under. */
    const none = { rows: [] as ReadonlyArray<Server.Recent>, under: new Map<string, ReadonlyArray<string>>(), entries: new Map<string, { readonly id: number; readonly full: string }>(), waiting: 0, unheard: 0, blind: false }

    const compute = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const latest = yield* journal.latest(now - week, read)
      const muted = new Map((yield* mutes.list).map((mute) => [mute.key, mute]))
      const missed = options.missed === undefined ? [] : yield* options.missed
      const sessions = latest.some(sessionRow) || missed.some(({ rows }) => rows.some(sessionRow))
      // The session of each thread's latest update, even when what came since, like a question it asked, has none, and, beside a
      // session's own row, shown or still unheard, every session its recent updates came from, as a resumed one, or one whose link
      // timed out before.
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
      const entries = new Map<string, { readonly id: number; readonly full: string }>()
      let blind = false
      /** How many of a thread's updates and notices he hasn't heard, muted or not: under its own key, and every session of it, as a catch-up of everything tells of them. */
      const unheardOf = (machine: string, threads: ReadonlyArray<string>) =>
        missed.filter((group) => (group.machine ?? here) === machine && group.thread !== undefined && threads.includes(group.thread)).reduce((sum, { rows }) => sum + rows.length, 0)
      const listed = yield* Effect.forEach(rows, ({ kept, last }) =>
        Effect.gen(function* () {
          const machine = kept.machine ?? here
          const id = kept.thread ?? ""
          const session = sessionRow(kept)
          const key = session ? Mutes.key.session(machine, id) : Mutes.key.thread({ machine, id })
          // Muted by its session, before that session was found to be the thread's: its latest update's, or the newer session row's it shows.
          const own = last === kept ? found.get(kept)?.own : last.thread
          const sessions = [...new Set([found.get(kept)?.own, own])].flatMap((own) => (own === undefined || own.startsWith("finished:") ? [] : [own]))
          const by = sessions.map((own) => Mutes.key.session(machine, own))
          under.set(key, by)
          entries.set(key, { id: last.id, full: Missed.full(last) })
          const mute = [key, ...by].map((key) => muted.get(key)).find((mute) => mute !== undefined)
          const thread = session ? Option.none() : yield* threads.find({ machine, id })
          // Its machine's threads not in yet, what it's called and its project are looked for again soon. Never for a session's own
          // row, which T3 Code never names, as for one from a machine yapd doesn't follow, which it never sees.
          if (!session && Option.isNone(thread) && Option.isSome(yield* threads.unseen(machine))) blind = true
          const project = yield* threads.project(machine, session ? (kept.directory === undefined ? {} : { directory: kept.directory }) : { thread: id })
          const icon = Option.isSome(project) ? Option.some(yield* icons.icon(machine, project.value)) : Option.none<Icons.Icon>()
          const name = Option.match(project, { onNone: () => kept.project, onSome: ({ title }) => title })
          // Heard again as it was said while it's still among what he heard; otherwise only a thread yapd can reach, which "it" then means.
          const still = Option.firstSomeOf(yield* Effect.forEach([key, ...by], (key) => heard(key, last.at)))
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
            replayable: Option.isSome(still) || reachable(thread),
            ...(options.missed === undefined ? {} : { unheard: unheardOf(machine, [id, ...sessions, ...(found.get(kept)?.all ?? [])]) }),
          } satisfies Server.Recent
        }),
      )
      const desk = options.desk === undefined ? undefined : yield* options.desk
      const waiting = desk === undefined ? 0 : desk.threads.filter(({ state }) => state === "approval" || state === "question").length
      // What a catch-up of everything would tell him of: what was kept quiet as he muted its thread aside.
      const unheard = missed.reduce((sum, group) => sum + group.rows.filter((kept) => !Missed.muted(kept)).length, 0)
      return { rows: listed, under, entries, waiting, unheard, blind }
    }).pipe(Effect.catchAllCause((cause) => Effect.as(Effect.logWarning("Could not list the latest threads", cause), none)))

    const first = yield* compute
    const ref = yield* SubscriptionRef.make(first.rows)
    const waiting = yield* SubscriptionRef.make(first.waiting)
    const unheard = yield* SubscriptionRef.make(first.unheard)
    let { under, entries, blind } = first
    /** Built again, and kept only when it changed, so nothing that follows the state hears of what didn't. */
    const refresh = Effect.flatMap(compute, (built) =>
      Effect.zipRight(
        Effect.sync(() => {
          under = built.under
          entries = built.entries
          blind = built.blind
        }),
        SubscriptionRef.update(ref, (before) => (JSON.stringify(before) === JSON.stringify(built.rows) ? before : built.rows)),
      ).pipe(Effect.zipRight(SubscriptionRef.set(waiting, built.waiting)), Effect.zipRight(SubscriptionRef.set(unheard, built.unheard))),
    )
    const shows = new Set(["Renamed", "Asked", "Answered", "Removed"])
    yield* Stream.mergeAll(
      [
        Stream.map(journal.kept, () => undefined),
        // Heard, held or muted, so a catch-up he heard to the end clears the counts at once.
        journal.marked,
        mutes.changes,
        icons.changes,
        Stream.filter(threads.changes, ({ change }) => shows.has(change._tag)).pipe(Stream.map(() => undefined)),
        Stream.map(options.hearing ?? Stream.never, () => undefined),
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
      waiting: Stream.changes(waiting.changes),
      unheard: Stream.changes(unheard.changes),
      current: SubscriptionRef.get(ref),
      under: (key) => Effect.sync(() => under.get(key) ?? []),
      row: (key) => Effect.sync(() => Option.fromNullable(entries.get(key))),
    } satisfies Latest
  })

/** What of the daemon the menu needs: what he heard, to say it again, and saying what was kept of the rest. */
type Speaker = Pick<Effect.Effect.Success<ReturnType<typeof Daemon.make>>, "latestHeard" | "replay" | "power" | "tell">

/**
 * What the menu does to a thread it lists, by its key: mutes it, which never
 * reaches an agent, or says its latest update again.
 */
export const menu = (options: {
  readonly latest: Latest
  readonly threads: Pick<Threads.Threads["Type"], "find">
  readonly mutes: Pick<Mutes.Mutes, "muted">
  readonly controls: Mutes.Controls
  readonly daemon: Speaker
  /** Makes "it" the thread what's said is about, as an answer about it does. */
  readonly mention: (ref: Threads.Ref, said: string) => Effect.Effect<void>
  /** Where what's said again of a row is noted as heard, so a digest or "what did I miss?" doesn't tell of it again. */
  readonly journal?: Pick<Journal["Type"], "markHeard">
}) => {
  const { latest, threads, mutes, controls, daemon, mention, journal } = options
  return {
    /**
     * Mutes a thread from the menu, by its key: one it lists, one /threads
     * lists, or one muted already, named as it's listed, or by its title.
     */
    mute: (key: string, until?: number) =>
      Effect.gen(function* () {
        const about = Mutes.parse(key)
        if (Option.isNone(about)) return "invalid" as const
        const row = (yield* latest.current).find((row) => row.key === key)
        const found = about.value._tag === "Thread" ? yield* threads.find(about.value.ref) : Option.none()
        if (row === undefined && Option.isNone(found) && Option.isNone(yield* mutes.muted([key]))) return "unknown" as const
        const title = row?.title ?? Option.getOrUndefined(Option.map(found, ({ title }) => title))
        const project = row?.project?.name
        yield* controls.mute({ key, ...(title === undefined ? {} : { called: title }), ...(project === undefined ? {} : { project }) }, until)
        return "muted" as const
      }),
    /**
     * Says a thread's latest update again, by its key, all of it, its "more"
     * too: as an update, when it's one he heard, so a reply to it still gets
     * there, otherwise what was kept of it, as an answer that makes "it" the
     * thread. A session's row, or
     * a thread yapd can't reach now, as when it was archived or its machine
     * can't be seen, isn't said again then: "it" would be something nothing
     * he says can act on.
     */
    replayThread: (key: string) =>
      Effect.gen(function* () {
        const row = (yield* latest.current).find((row) => row.key === key)
        if (row === undefined) return "unknown" as const
        // Only the one the menu shows: not an older one he heard before what was kept quiet of it, or before a question it asked
        // since. Under its own key, or the session's it's shown from, as when its link timed out.
        const at = Date.parse(row.at)
        const heard = yield* Effect.map(
          Effect.forEach([key, ...(yield* latest.under(key))], (key) => daemon.latestHeard(key, at)),
          (all) => Option.firstSomeOf(all),
        )
        // Said for this row, so "mute it" over it mutes the row's key.
        if (Option.isSome(heard)) return yield* daemon.replay(heard.value, key)
        if (row.text.trim() === "") return "unknown" as const
        if (row.thread === null) return "unreachable" as const
        const ref = { machine: row.machine, id: row.thread }
        if (!reachable(yield* threads.find(ref))) return "unreachable" as const
        const { on, turns } = yield* daemon.power
        if (!on) return "off" as const
        const now = yield* Clock.currentTimeMillis
        // Held for later, or unheard, it's heard once it's said to the end, and all of it, its "more" too, never only its headline.
        // What "say that again" says is all of what was played, never only its headline.
        const entry = yield* latest.row(key)
        const spoken = Option.match(entry, { onNone: () => row.text, onSome: ({ full }) => (full === "" ? row.text : full) })
        yield* daemon.tell(
          {
            id: `again:${key}:${now}`,
            kind: "answer",
            priority: "needs-you",
            spoken,
            at: now,
            stale: Effect.succeed(false),
            saying: mention(ref, spoken),
            ...(journal === undefined || Option.isNone(entry)
              ? {}
              : { heard: Effect.flatMap(Clock.currentTimeMillis, (at) => journal.markHeard([entry.value.id], at)) }),
          },
          turns,
        )
        return "queued" as const
      }),
  }
}
