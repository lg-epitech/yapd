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
}

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
  readonly threads: Pick<Threads.Threads["Type"], "find" | "project" | "changes">
}) =>
  Effect.gen(function* () {
    const { here, journal, mutes, icons, threads } = options

    const compute = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const latest = yield* journal.latest(now - week, read)
      const muted = new Map((yield* mutes.list).map((mute) => [mute.key, mute]))
      // A session's own row, once a thread shown has its update under it, as when its link timed out once, is that thread's.
      const tied = new Set(
        latest.flatMap((kept) => {
          const session = sessionOf(kept)
          return session === undefined ? [] : [`${kept.machine ?? here}\n${session}`]
        }),
      )
      const rows = latest.filter((kept) => !(sessionRow(kept) && tied.has(`${kept.machine ?? here}\n${kept.thread}`))).slice(0, shown)
      return yield* Effect.forEach(rows, (kept) =>
        Effect.gen(function* () {
          const machine = kept.machine ?? here
          const id = kept.thread ?? ""
          const session = sessionRow(kept)
          const key = session ? Mutes.key.session(machine, id) : Mutes.key.thread({ machine, id })
          // Muted by its session, before that session was found to be the thread's.
          const own = session ? undefined : sessionOf(kept)
          const by = own === undefined || own.startsWith("finished:") ? [] : [Mutes.key.session(machine, own)]
          const mute = [key, ...by].map((key) => muted.get(key)).find((mute) => mute !== undefined)
          const thread = session ? Option.none() : yield* threads.find({ machine, id })
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
            text: kept.said ?? "",
            at: new Date(kept.at).toISOString(),
            muted: mute !== undefined,
            ...(mute?.ends === undefined ? {} : { until: new Date(mute.ends).toISOString() }),
            waiting: Option.exists(thread, ({ pendingRuntimeRequest }) => pendingRuntimeRequest !== null),
          } satisfies Server.Recent
        }),
      )
    }).pipe(Effect.catchAllCause((cause) => Effect.as(Effect.logWarning("Could not list the latest threads", cause), [] as ReadonlyArray<Server.Recent>)))

    const ref = yield* SubscriptionRef.make(yield* compute)
    /** Built again, and kept only when it changed, so nothing that follows the state hears of what didn't. */
    const refresh = Effect.flatMap(compute, (rows) =>
      SubscriptionRef.update(ref, (before) => (JSON.stringify(before) === JSON.stringify(rows) ? before : rows)),
    )
    const shows = new Set(["Renamed", "Asked", "Answered", "Removed"])
    yield* Stream.mergeAll(
      [
        Stream.map(journal.kept, () => undefined),
        mutes.changes,
        icons.changes,
        Stream.filter(threads.changes, ({ change }) => shows.has(change._tag)).pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("1 minute")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Stream.debounce("250 millis"), Stream.runForEach(() => refresh), Effect.forkScoped)
    return {
      rows: Stream.changesWith(ref.changes, (one, other) => one === other),
      current: SubscriptionRef.get(ref),
    } satisfies Latest
  })
