import type { Database } from "bun:sqlite"
import { Clock, Context, Data, Effect, Option, Stream } from "effect"
import { english, speakable } from "./Condenser.ts"
import type { Journal, Kept } from "./Journal.ts"
import type * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3Live from "./T3Live.ts"

// The threads on the user's machines as yapd keeps them in mind: what each is
// doing, what it's called when said aloud, and which matter most right now.
// Everything here comes from what T3 Code already sent and what yapd wrote
// down itself, so working out what the user means never waits on a listing.

/** A thread on one machine, by the name the user gives the machine. */
export interface Ref {
  readonly machine: string
  readonly id: string
}

/** Whether two refs are the same thread. */
export const same = (one: Ref, other: Ref) => one.machine === other.machine && one.id === other.id

/** What a thread is doing, in the terms the user cares about. */
export type State = "running" | "finishing" | "queued" | "approval" | "question" | "failed" | "limited" | "idle"

/** A thread on the desk, under the handle the model knows it by. */
export interface Listed {
  /** Like "t4", which only means this thread within one desk. */
  readonly handle: string
  readonly ref: Ref
  readonly here: boolean
  /** What it's called aloud. */
  readonly called: string
  /** Its project's name, as it's said. */
  readonly project: string
  readonly thread: T3Live.Thread
  readonly state: State
  /** When it got to that state, in ms. */
  readonly since: number
  /** What the user said to start it, when yapd started it. */
  readonly started: Option.Option<{ readonly dictated: string; readonly description: string | null }>
  /** The latest thing yapd said about it. */
  readonly last: Option.Option<{ readonly at: number; readonly said: string }>
}

/** The threads that matter right now, most first, and the machines whose threads can't be seen. */
export interface Desk {
  readonly threads: ReadonlyArray<Listed>
  /** Machines whose threads can't be seen now, with why, in words that can be said. */
  readonly away: ReadonlyArray<{ readonly machine: string; readonly reason: string }>
}

export class ThreadsError extends Data.TaggedError("ThreadsError")<{ readonly reason: string; readonly cause?: unknown }> {}

export class Threads extends Context.Tag("yapd/Threads")<
  Threads,
  {
    /** Ranked shortlist from memory only: no listing, no SSH. */
    readonly desk: (focus: Option.Option<Ref>, pending: ReadonlyArray<Ref>, most: number) => Effect.Effect<Desk>
    readonly find: (ref: Ref) => Effect.Effect<Option.Option<T3Live.Thread>>
    readonly changes: Stream.Stream<{ readonly machine: string; readonly change: T3Live.Change }>
    readonly actions: (machine: string) => Option.Option<T3Actions.Actions>
    /** Where a thread got to, read from it now. */
    readonly detail: (ref: Ref, pending?: string) => Effect.Effect<T3Actions.Detail, ThreadsError>
    /** Threads whose messages mention the words. */
    readonly search: (words: string) => Effect.Effect<ReadonlyArray<{ readonly ref: Ref; readonly snippet: string }>, ThreadsError>
    /** What each provider has used of its limits, as of at most a few minutes ago. */
    readonly usage: Effect.Effect<Option.Option<T3Actions.Usage>>
    /** Asks T3 Code for usage again, when what's known is getting old. */
    readonly refreshUsage: Effect.Effect<void>
    /** Notes work yapd started, so it's known by what it's about. What's noted is only ever filled in. */
    readonly keep: (ref: Ref, started: { readonly prompt: string; readonly dictated: string; readonly description: string }) => Effect.Effect<void>
  }
>() {}

const time = (iso: string | null | undefined) => {
  const at = iso === null || iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(at) ? undefined : at
}

/** What a thread is doing. What it waits on the user for comes first, since that's what they'd want to know. */
export const state = (thread: T3Live.Thread): State => {
  if (thread.pendingRuntimeRequest !== null) return thread.pendingRuntimeRequest.kind === "user_input" ? "question" : "approval"
  if (T3Live.busy(thread)) return "running"
  if (thread.activityRunStatus === "waiting") return "finishing"
  if (thread.status === "queued") return "queued"
  if (thread.status === "failed") return thread.lastErrorClass === "usage_limit" ? "limited" : "failed"
  return "idle"
}

/** When it got to the state it's in. */
const since = (thread: T3Live.Thread, now: State) => {
  const updated = time(thread.updatedAt) ?? 0
  switch (now) {
    case "approval":
    case "question":
      return time(thread.pendingRuntimeRequest?.createdAt) ?? updated
    case "running":
    case "finishing":
      return time(thread.latestRunStartedAt) ?? updated
    case "queued":
      return updated
    default:
      return time(thread.latestRunCompletedAt) ?? updated
  }
}

const days = (count: number) => count * 24 * 60 * 60_000

/** When something happened, the way it's said in "the yapd work from yesterday". */
export const when = (at: number, now: number) => {
  const day = (ms: number) => new Date(ms).toDateString()
  if (day(at) === day(now)) return "today"
  if (day(at) === day(now - days(1))) return "yesterday"
  if (now - at < days(6)) return new Date(at).toLocaleDateString("en-US", { weekday: "long" })
  const weeks = Math.round((now - at) / days(7))
  if (now - at < days(30)) return weeks <= 1 ? "last week" : `${weeks} weeks ago`
  return "a while back"
}

/** A project's name as it's said: "integration connectors" for integration-connectors, and a generated one as the scratch project. */
export const spoken = (project: string) => (speakable(project) ? project.replace(/[-_]+/g, " ").trim() : "scratch")

/** What only reads well: words, numbers and ordinary punctuation, nothing like a path or a hash. */
const plain = /^[\p{L}\p{N} ,.'’&:!?()#+-]+$/u

/**
 * What a thread is called aloud: what yapd called the work when it started
 * it, else its title when it can be read out as it is and is short enough to
 * say, else which project's work it is and from when.
 */
export const called = (title: string, description: string | null | undefined, project: string, at: number, now: number) => {
  const own = description?.trim() ?? ""
  if (own !== "") return own
  const trimmed = title.trim()
  if (trimmed !== "" && plain.test(trimmed) && english(trimmed) && speakable(trimmed) && trimmed.split(/\s+/).length <= 8) return trimmed
  return `the ${spoken(project)} work from ${when(at, now)}`
}

/** Threads that are part of another, which the user never addresses on their own. */
const subagent = (thread: T3Live.Thread) => thread.lineage?.relationshipToParent === "subagent"

/** What was noted about work yapd started, by thread id. */
interface Started {
  readonly dictated: string
  readonly description: string | null
  readonly at: number
}

/**
 * The desk: every thread in order of how likely the user means it, an
 * ordering that never leaves one out, cut to the `most` first. The question's
 * candidates come first, so "the first" is t1, then what "it" means, then what
 * waits on the user, what's running, what failed, and on down to the newest.
 */
export const shortlist = (input: {
  readonly machine: string
  readonly view: T3Live.View
  readonly focus: Option.Option<Ref>
  readonly pending: ReadonlyArray<Ref>
  readonly most: number
  readonly started: ReadonlyMap<string, Started>
  /** The latest line yapd said about each thread, by id. */
  readonly said: ReadonlyMap<string, { readonly at: number; readonly said: string }>
  readonly now: number
}): ReadonlyArray<Listed> => {
  const { machine, view, focus, pending, most, started, said, now } = input
  const within = (at: number | undefined, span: number) => at !== undefined && now - at < span
  const group = (thread: T3Live.Thread, doing: State) => {
    const candidate = pending.findIndex((ref) => ref.machine === machine && ref.id === thread.id)
    if (candidate >= 0) return candidate / 100
    if (Option.isSome(focus) && focus.value.machine === machine && focus.value.id === thread.id) return 1
    if (doing === "approval" || doing === "question") return 2
    if (doing === "running" || doing === "finishing" || doing === "queued") return 3
    const settled = thread.settledOverride === "settled"
    if ((doing === "failed" || doing === "limited") && !settled && within(time(thread.latestRunCompletedAt), days(1))) return 4
    if (within(said.get(thread.id)?.at, days(1))) return 5
    if (within(started.get(thread.id)?.at, days(7))) return 6
    const snoozed = (time(thread.snoozedUntil) ?? 0) > now
    if (!settled && !snoozed && within(time(thread.updatedAt), days(7))) return 7
    return 8
  }
  return [...view.threads.values()]
    .filter((thread) => !subagent(thread) && thread.archivedAt === null)
    .map((thread) => {
      const doing = state(thread)
      return { thread, doing, group: group(thread, doing), updated: time(thread.updatedAt) ?? 0 }
    })
    .toSorted((one, other) => one.group - other.group || other.updated - one.updated)
    .slice(0, most)
    .map(({ thread, doing }, index): Listed => {
      const project = view.projects.get(thread.projectId)?.title ?? ""
      const own = started.get(thread.id)
      return {
        handle: `t${index + 1}`,
        ref: { machine, id: thread.id },
        here: true,
        called: called(thread.title, own?.description, project, time(thread.createdAt) ?? now, now),
        project: spoken(project),
        thread,
        state: doing,
        since: since(thread, doing),
        started: Option.map(Option.fromNullable(own), ({ dictated, description }) => ({ dictated, description })),
        last: Option.fromNullable(said.get(thread.id)),
      }
    })
}

/** How long usage is good for before it's asked again. */
const stale = 5 * 60_000

/** What the user said they'd been told, as far back as the desk looks for it. */
const latest = (entries: ReadonlyArray<Kept>, machine: string) => {
  const said = new Map<string, { readonly at: number; readonly said: string }>()
  for (const entry of entries) {
    if (entry.thread === undefined || entry.machine !== machine || entry.said === undefined || entry.said.trim() === "") continue
    said.set(entry.thread, { at: entry.at, said: entry.said })
  }
  return said
}

/**
 * The threads on this machine, followed through T3 Code. Other machines are
 * listed as away, with why, until yapd can follow them too.
 */
export const make = (options: {
  /** What the user calls this machine. */
  readonly machine: string
  readonly live: T3Live.T3Live["Type"]
  /** None without a T3 Code token. */
  readonly actions: Option.Option<T3Actions.Actions>
  /** Other machines yapd hears from, whose threads it can't see yet. */
  readonly others: ReadonlyArray<string>
  readonly journal: Journal["Type"]
  readonly store: Store.Store["Type"]
}) =>
  Effect.gen(function* () {
    const { machine, live, journal, store } = options
    const scope = yield* Effect.scope
    let usage: { readonly at: number; readonly usage: T3Actions.Usage } | undefined

    const startedWork = store
      .transaction((database: Database) =>
        database
          .query<{ id: string; dictated: string | null; prompt: string | null; description: string | null; at: string }, [string]>(
            "select id, dictated, prompt, description, at from threads where machine = ? and started = 1",
          )
          .all(machine),
      )
      .pipe(
        Effect.map(
          (rows) =>
            new Map(
              rows.map((row): [string, Started] => [
                row.id,
                { dictated: row.dictated ?? row.prompt ?? "", description: row.description, at: time(row.at) ?? 0 },
              ]),
            ),
        ),
        Effect.catchAll((error) => Effect.logWarning("Could not read what work I started", error).pipe(Effect.as(new Map<string, Started>()))),
      )

    const reach = (ref: Ref) =>
      ref.machine === machine
        ? Option.match(options.actions, {
            onNone: () => Effect.fail(new ThreadsError({ reason: "I need a T3 Code token to read your threads." })),
            onSome: Effect.succeed,
          })
        : Effect.fail(new ThreadsError({ reason: `I can't see ${ref.machine}'s threads yet.` }))

    /** When usage was last asked for, so a T3 Code that doesn't answer isn't asked on every request. */
    let tried = Number.NEGATIVE_INFINITY
    const refresh = Option.match(options.actions, {
      onNone: () => Effect.void,
      onSome: (actions) =>
        Effect.gen(function* () {
          tried = yield* Clock.currentTimeMillis
          const fresh = yield* actions.usage
          usage = { at: yield* Clock.currentTimeMillis, usage: fresh }
        }).pipe(
          Effect.timeout("3 seconds"),
          Effect.catchAll((error) => Effect.logWarning("Could not read your usage from T3 Code", error)),
        ),
    })
    const old = Effect.map(Clock.currentTimeMillis, (now) => now - tried > stale)
    /** One request at a time, which whoever else wants it waits for. */
    const asking = yield* Effect.makeSemaphore(1)
    const refreshing = asking.withPermits(1)(Effect.flatMap(old, (old) => (old ? refresh : Effect.void)))

    return {
      desk: (focus, pending, most) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const away = options.others.map((other) => ({ machine: other, reason: `I can't see ${other}'s threads yet.` }))
          const view = yield* live.view
          if (Option.isNone(view)) {
            const reason = Option.isNone(options.actions)
              ? "I need a T3 Code token to see your threads."
              : "T3 Code isn't running, so I can't see your threads."
            return { threads: [], away: [{ machine, reason }, ...away] }
          }
          const [started, entries] = [yield* startedWork, yield* journal.since(now - days(7), { most: 500 })]
          const threads = shortlist({ machine, view: view.value, focus, pending, most, started, said: latest(entries, machine), now })
          return { threads, away }
        }),
      find: (ref) =>
        ref.machine === machine
          ? Effect.map(live.view, Option.flatMap((view) => Option.fromNullable(view.threads.get(ref.id))))
          : Effect.succeed(Option.none()),
      changes: Stream.map(live.changes, (change) => ({ machine, change })),
      actions: (name) => (name === machine ? options.actions : Option.none()),
      detail: (ref, pending) =>
        Effect.flatMap(reach(ref), (actions) =>
          actions.detail(ref.id, pending).pipe(Effect.mapError((error) => new ThreadsError({ reason: T3Actions.reason(error), cause: error }))),
        ),
      search: (words) =>
        Effect.flatMap(reach({ machine, id: "" }), (actions) =>
          actions.search(words).pipe(
            Effect.map((matches) => matches.map(({ threadId, snippet }) => ({ ref: { machine, id: threadId }, snippet }))),
            Effect.mapError((error) => new ThreadsError({ reason: T3Actions.reason(error), cause: error })),
          ),
        ),
      // What's known at once, asked again meanwhile when it's old: only with nothing known yet is it waited for.
      usage: Effect.gen(function* () {
        if (!(yield* old)) return Option.map(Option.fromNullable(usage), ({ usage }) => usage)
        if (usage === undefined) yield* refreshing
        else yield* Effect.forkIn(refreshing, scope)
        return Option.map(Option.fromNullable(usage), ({ usage }) => usage)
      }),
      refreshUsage: Effect.flatMap(old, (old) => (old ? refreshing : Effect.void)),
      keep: (ref, work) =>
        Effect.gen(function* () {
          const at = new Date(yield* Clock.currentTimeMillis).toISOString()
          yield* store.transaction((database: Database) => {
            database
              .query(
                `insert into threads (machine, id, prompt, dictated, description, started, at) values (?, ?, ?, ?, ?, 1, ?)
                 on conflict (machine, id) do update set
                   prompt = coalesce(threads.prompt, excluded.prompt),
                   dictated = coalesce(threads.dictated, excluded.dictated),
                   description = coalesce(threads.description, excluded.description),
                   started = 1`,
              )
              .run(ref.machine, ref.id, work.prompt, work.dictated, work.description.trim() === "" ? null : work.description.trim(), at)
          })
        }).pipe(Effect.catchAll((error) => Effect.logWarning("Could not note the work I started", error))),
    } satisfies Threads["Type"]
  })
