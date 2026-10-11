import { Clock, Effect, Option, Schedule, Stream, SubscriptionRef } from "effect"
import type * as Assistant from "./Assistant.ts"
import type * as Conversation from "./Conversation.ts"
import type * as Daemon from "./Daemon.ts"
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
  /**
   * A session's row listed now, as the update it shows, so that once it's
   * said again "it" is that session, never a thread: none for a thread's row.
   */
  readonly session: (key: string) => Effect.Effect<Option.Option<Conversation.Update>>
}

/**
 * A session's latest update as the journal kept it, for "it" to mean the
 * session once it's said again: named by its agent, project and machine, as
 * when he first heard it, and muted by its row's key, never one made again
 * from the hostname its hook reported. Nothing of it waits on him any more,
 * since its hook was let go of long ago.
 */
const updateOf = (kept: Kept, here: string): Conversation.Update => {
  const session = kept.thread ?? ""
  const agent = session.startsWith("codex:") ? "codex" : "claude"
  const machine = kept.machine ?? here
  // The hostname its hook reported, which names the machine as the journal did, or the machine itself.
  const host = (kept.detail as { readonly host?: unknown } | undefined)?.host
  const prompt = (kept.detail as { readonly prompt?: unknown } | undefined)?.prompt
  const said = kept.said ?? ""
  const message = kept.text ?? said
  return {
    session,
    project: kept.project ?? "",
    turn: { prompt: typeof prompt === "string" ? Option.some(prompt) : Option.none(), message },
    needsYou: false,
    spoken: said,
    audio: "",
    thread: {
      agent,
      session: session.slice(agent.length + 1),
      cwd: kept.directory ?? "",
      message,
      origin: typeof host === "string" ? { host } : machine === here ? {} : { host: machine },
    },
    at: kept.at,
  }
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

    /** Nothing listed yet, the keys nothing is muted under, and no session's update. */
    const none = {
      rows: [] as ReadonlyArray<Server.Recent>,
      under: new Map<string, ReadonlyArray<string>>(),
      updates: new Map<string, Conversation.Update>(),
      blind: false,
    }

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
      const updates = new Map<string, Conversation.Update>()
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
          if (session) updates.set(key, updateOf(last, here))
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
      return { rows: listed, under, updates, blind }
    }).pipe(Effect.catchAllCause((cause) => Effect.as(Effect.logWarning("Could not list the latest threads", cause), none)))

    const first = yield* compute
    const ref = yield* SubscriptionRef.make(first.rows)
    let { under, updates, blind } = first
    /** Built again, and kept only when it changed, so nothing that follows the state hears of what didn't. */
    const refresh = Effect.flatMap(compute, (built) =>
      Effect.zipRight(
        Effect.sync(() => {
          under = built.under
          updates = built.updates
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
      session: (key) => Effect.sync(() => Option.fromNullable(updates.get(key))),
    } satisfies Latest
  })

/**
 * What of the daemon the menu needs: what he heard, to say it again for a
 * row, and saying what was kept of the rest.
 */
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
  /** What makes "it" the row said again: its thread, as an answer about it does, or its session, by the row's key, never a thread. */
  readonly assistant: Pick<Assistant.Assistant["Type"], "mention" | "mentionSession">
}) => {
  const { latest, threads, mutes, controls, daemon, assistant } = options
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
     * Says a thread's latest update again, by its key: as it was said, when
     * it's one he heard, so a reply to it still gets there, otherwise what was
     * kept of it. Either way, from when it starts playing, "it" is the row:
     * its thread, or for a session's row, that session, by the row's key, so
     * nothing he says next goes to a thread he heard of before.
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
        // Said for this row, which "it" then means, rather than the update as it was first heard, which may be tied to no thread.
        if (Option.isSome(heard)) return yield* daemon.replay(heard.value, key)
        if (row.text.trim() === "") return "unknown" as const
        const { on, turns } = yield* daemon.power
        if (!on) return "off" as const
        // What "it" is once it's said: the thread, or the session, never what he heard of before. A session's row gone from the
        // list since it was looked up, as when it was built again, is gone.
        const saying =
          row.thread === null
            ? Option.map(yield* latest.session(key), (update) => assistant.mentionSession(update, row.text, key))
            : Option.some(assistant.mention({ machine: row.machine, id: row.thread }, row.text))
        if (Option.isNone(saying)) return "unknown" as const
        const now = yield* Clock.currentTimeMillis
        yield* daemon.tell(
          {
            id: `again:${key}:${now}`,
            kind: "answer",
            priority: "needs-you",
            spoken: row.text,
            at: now,
            stale: Effect.succeed(false),
            saying: saying.value,
          },
          turns,
        )
        return "queued" as const
      }),
  }
}
