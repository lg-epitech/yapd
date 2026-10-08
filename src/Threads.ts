import type { Database } from "bun:sqlite"
import { Clock, Context, Data, Effect, Either, Option, Stream } from "effect"
import { realpath } from "node:fs/promises"
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
  /** Where it works: its worktree, or its project's folder. */
  readonly directory: Option.Option<string>
  readonly thread: T3Live.Thread
  readonly state: State
  /** When it got to that state, in ms. */
  readonly since: number
  /** What the user said to start it, when yapd started it. */
  readonly started: Option.Option<{ readonly dictated: string; readonly description: string | null }>
  /** The latest thing yapd said about it. */
  readonly last: Option.Option<{ readonly at: number; readonly said: string }>
  /** One of the many below the likeliest, which the model sees by name only, to pick by how it sounds. */
  readonly brief: boolean
}

/** The threads that matter right now, most first, and the machines whose threads can't be seen. */
export interface Desk {
  readonly threads: ReadonlyArray<Listed>
  /** Machines whose threads can't be seen now, with why, in words that can be said. */
  readonly away: ReadonlyArray<{ readonly machine: string; readonly reason: string }>
}

/** A thread couldn't be read or searched, with why, in words that can be said. */
export class ThreadsError extends Data.TaggedError("ThreadsError")<{ readonly reason: string; readonly cause?: unknown }> {}

/** The threads yapd keeps in mind, on every machine it can see. */
export class Threads extends Context.Tag("yapd/Threads")<
  Threads,
  {
    /** Ranked shortlist from memory only: no listing, no SSH. `found` are threads a search just turned up. */
    readonly desk: (
      focus: Option.Option<Ref>,
      pending: ReadonlyArray<Ref>,
      most: number,
      found?: ReadonlyArray<Ref>,
      more?: number,
      /** What he said, for threads whose titles have his words. */
      heard?: string,
    ) => Effect.Effect<Desk>
    readonly find: (ref: Ref) => Effect.Effect<Option.Option<T3Live.Thread>>
    readonly changes: Stream.Stream<{ readonly machine: string; readonly change: T3Live.Change }>
    readonly actions: (machine: string) => Option.Option<T3Actions.Actions>
    /** Where a thread got to, read from it now. */
    readonly detail: (ref: Ref, pending?: string) => Effect.Effect<T3Actions.Detail, ThreadsError>
    /** Threads whose messages mention the words. */
    readonly search: (words: string) => Effect.Effect<ReadonlyArray<{ readonly ref: Ref; readonly snippet: string }>, ThreadsError>
    /** What each provider has used of its limits, as of at most a few minutes ago unless T3 Code stopped answering. */
    readonly usage: Effect.Effect<Option.Option<Usage>>
    /** Asks T3 Code for usage again, when what's known is getting old. */
    readonly refreshUsage: Effect.Effect<void>
    /** Notes work yapd started, so it's known by what it's about. What's noted is only ever filled in. */
    readonly keep: (ref: Ref, started: { readonly prompt: string; readonly dictated: string; readonly description: string }) => Effect.Effect<void>
    /**
     * The thread a hook on `machine` came from, found by the agent's own id
     * for its session among the threads working in its directory, and only
     * while that machine's T3 Code is followed (I11). None otherwise, which
     * keeps its update on the way hooks have always gone. Never fails.
     */
    readonly link: (machine: string, session: string, cwd: string) => Effect.Effect<Option.Option<Ref>>
    /** The agent's own ids for a thread's conversations, which its hooks report as their session. */
    readonly sessions: (ref: Ref) => Effect.Effect<ReadonlyArray<string>, ThreadsError>
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
  // Only a name that can be said in one breath: an older yapd kept a whole account of the work there.
  const sayable = (text: string) => text !== "" && plain.test(text) && english(text) && speakable(text) && text.split(/\s+/).length <= 8
  const own = description?.trim() ?? ""
  if (sayable(own)) return own
  const trimmed = title.trim()
  if (sayable(trimmed)) return trimmed
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
 * a search for their words found, what waits on the user, what's running,
 * what failed, and on down to the newest.
 */
export const shortlist = (input: {
  readonly machine: string
  readonly view: T3Live.View
  readonly focus: Option.Option<Ref>
  readonly pending: ReadonlyArray<Ref>
  /** Threads whose messages have the words the user said. */
  readonly found?: ReadonlyArray<Ref>
  /** What he said, for threads whose titles have his words. */
  readonly heard?: string
  readonly most: number
  /** How many more, below those, the model sees by name only: the recent ones nothing puts higher. */
  readonly more?: number
  readonly started: ReadonlyMap<string, Started>
  /** The latest line yapd said about each thread, by id. */
  readonly said: ReadonlyMap<string, { readonly at: number; readonly said: string }>
  readonly now: number
}): ReadonlyArray<Listed> => {
  const { machine, view, focus, pending, most, started, said, now } = input
  const within = (at: number | undefined, span: number) => at !== undefined && now - at < span
  const titled = new Set(entitled(input.heard ?? "", view))
  const group = (thread: T3Live.Thread, doing: State) => {
    const candidate = pending.findIndex((ref) => ref.machine === machine && ref.id === thread.id)
    if (candidate >= 0) return candidate / 100
    if (Option.isSome(focus) && focus.value.machine === machine && focus.value.id === thread.id) return 1
    if ((input.found ?? []).some((ref) => ref.machine === machine && ref.id === thread.id) || titled.has(thread.id)) return 1.5
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
  const ranked = [...view.threads.values()]
    .filter((thread) => !subagent(thread) && thread.archivedAt === null)
    .map((thread) => {
      const doing = state(thread)
      return { thread, doing, group: group(thread, doing), updated: time(thread.updatedAt) ?? 0 }
    })
    .toSorted((one, other) => one.group - other.group || other.updated - one.updated)
  // A misheard name can only be matched to a name the model sees, so the rest of the month's go too, by name.
  const named = ranked
    .slice(most)
    .filter(({ updated }) => within(updated, days(30)))
    .slice(0, input.more ?? 0)
  return [...ranked.slice(0, most), ...named]
    .map(({ thread, doing }, index): Listed => {
      const project = view.projects.get(thread.projectId)
      const own = started.get(thread.id)
      return {
        handle: `t${index + 1}`,
        ref: { machine, id: thread.id },
        here: true,
        called: called(thread.title, own?.description, project?.title ?? "", time(thread.createdAt) ?? now, now),
        project: spoken(project?.title ?? ""),
        directory: Option.fromNullable(thread.worktreePath ?? project?.workspaceRoot),
        thread,
        state: doing,
        since: since(thread, doing),
        started: Option.map(Option.fromNullable(own), ({ dictated, description }) => ({ dictated, description })),
        last: Option.fromNullable(said.get(thread.id)),
        brief: index >= most,
      }
    })
}

/**
 * A word as it's compared with a title's: lowercase, without accents or
 * marks, doubled letters single and a plural's s gone, since that's how
 * speech recognition tends to differ from what was typed: "MiNAS SV2" for
 * "Mina SSV2".
 */
const stem = (word: string) => {
  const plain = word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1")
  return plain.length > 4 && plain.endsWith("s") ? plain.slice(0, -1) : plain
}

/** Words too short or too common to say which thread a title is. */
const filler: ReadonlySet<string> = new Set(["the", "and", "for", "you", "can", "tell", "status", "on", "with", "from", "into", "add", "new"])

const stems = (text: string) =>
  new Set(
    text
      .split(/[^\p{L}\p{N}]+/u)
      .map(stem)
      .filter((word) => word.length >= 3 && !ignored.has(word)),
  )

/** Threads put among the likeliest by their titles at most. */
const entitledAt = 5

/**
 * Threads whose titles have two or more of his words, however speech mangled
 * their spelling, the most first: T3 Code's search only looks through what
 * the threads said, and only for a phrase as written. Short of that, a
 * thread's name is the model's to recognise by its sound.
 */
export const entitled = (heard: string, view: T3Live.View): ReadonlyArray<string> => {
  const said = stems(heard)
  if (said.size < 2) return []
  return [...view.threads.values()]
    .filter((thread) => !subagent(thread) && thread.archivedAt === null)
    .map((thread) => ({ id: thread.id, shared: [...stems(thread.title)].filter((word) => said.has(word)).length, at: time(thread.updatedAt) ?? 0 }))
    .filter(({ shared }) => shared >= 2)
    .toSorted((one, other) => other.shared - one.shared || other.at - one.at)
    .slice(0, entitledAt)
    .map(({ id }) => id)
}

/** Words searched for at most, and threads a search adds to the desk at most: a third of it. */
const searches = 4
const added = 10
/** Words too common to tell threads apart. */
const common: ReadonlySet<string> = new Set([
  "what", "what's", "whats", "status", "with", "that", "this", "have", "please", "could", "would", "about", "going", "doing",
  "tell", "there", "they", "them", "from", "into", "your", "thread", "work", "check", "look", "like", "just", "some", "when",
  "where", "which", "will", "been", "were", "then", "than", "also", "it's", "thing", "things", "today", "right", "know",
  "need", "needs", "want", "start", "make", "does", "done", "still", "much", "many", "more",
])

/** Those words and the filler as they're compared with a title's: by then "status" is "statu" and "still" is "stil". */
const ignored: ReadonlySet<string> = new Set([...filler, ...common].map(stem))

/** The words in what he said that tell threads apart: none too short or too common. */
export const distinctive = (text: string) =>
  [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 3 && !common.has(word)))].slice(0, searches)

/** Searching the threads' messages for some words, as T3 Code does. */
export type Search<E> = (words: string) => Effect.Effect<ReadonlyArray<{ readonly ref: Ref; readonly snippet: string }>, E>

/**
 * Threads whose messages have the words that tell threads apart, one search
 * each, since T3 Code matches a phrase only as it's written, each with what
 * was found. Those with most of the words come first, then each word's best
 * hits in turn, as T3 Code ranked them, the rarer word's first: a common word
 * he said can't crowd out the one that names the thread. It fails only when
 * no search could be made at all.
 */
export const matching = <E>(text: string, search: Search<E>) =>
  Effect.gen(function* () {
    const words = distinctive(text)
    const sought = words.length > 0 ? words : text.trim() === "" ? [] : [text.trim()]
    const all = yield* Effect.forEach(sought, (word) => Effect.either(search(word)), { concurrency: "unbounded" })
    const failed = all.find(Either.isLeft)
    if (failed !== undefined && all.every(Either.isLeft)) return yield* failed
    // Each word's threads in T3 Code's order, once each however many of their messages have it.
    const lists = all.flatMap((searched) =>
      Either.isRight(searched)
        ? [searched.right.filter(({ ref }, index, matches) => matches.findIndex((other) => same(other.ref, ref)) === index)]
        : [],
    )
    const hits = new Map<string, { readonly ref: Ref; readonly snippet: string; count: number; place: number; among: number }>()
    for (const matches of lists) {
      for (const [place, { ref, snippet }] of matches.entries()) {
        const key = `${ref.machine}\n${ref.id}`
        const hit = hits.get(key)
        if (hit === undefined) {
          hits.set(key, { ref, snippet, count: 1, place, among: matches.length })
          continue
        }
        hit.count++
        if (place < hit.place || (place === hit.place && matches.length < hit.among)) {
          hit.place = place
          hit.among = matches.length
        }
      }
    }
    return [...hits.values()].toSorted((one, other) => other.count - one.count || one.place - other.place || one.among - other.among)
  })

/** The threads a search for what he said puts on the desk, those with most of his words first. */
export const searched = <E>(text: string, search: Search<E>) =>
  Effect.map(matching(text, search), (hits) => hits.slice(0, added).map(({ ref }) => ref))

/** How long usage is good for before it's asked again. */
const stale = 5 * 60_000

/** Usage read longer ago than this is only ever said as of when it was read, never as what's used now. */
export const dated = 15 * 60_000

/** What each provider had used of its limits, and when T3 Code said so. */
export interface Usage {
  readonly at: number
  readonly providers: T3Actions.Usage
}

/** Threads read at most to link one hook: those that ran in its directory lately, since its own just did. */
const linkable = 8

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
    let usage: Usage | undefined

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

    const sessions = (ref: Ref) =>
      Effect.flatMap(reach(ref), (actions) =>
        actions.sessions(ref.id).pipe(Effect.mapError((error) => new ThreadsError({ reason: T3Actions.reason(error), cause: error }))),
      )

    /** Which thread each agent conversation read so far is behind, by the agent's own id for it, for as long as yapd runs. */
    const owners = new Map<string, string>()
    /** When each thread read for its conversations was last updated then: it only has new ones once it has run again. */
    const read = new Map<string, string>()
    /** Directories as they really are, links followed, as each was first looked at. */
    const real = new Map<string, string>()
    const canonical = (path: string) =>
      Effect.suspend(() => {
        const known = real.get(path)
        if (known !== undefined) return Effect.succeed(known)
        return Effect.promise(() => realpath(path).catch(() => path)).pipe(Effect.tap((resolved) => Effect.sync(() => real.set(path, resolved))))
      })

    const link = (from: string, session: string, cwd: string) =>
      Effect.gen(function* () {
        const unlinked = (why: string) => Effect.as(Effect.logInfo(`Not linked: ${why}`), Option.none<Ref>())
        const linked = (thread: T3Live.Thread) => Effect.as(Effect.logInfo(`Linked to "${thread.title}"`), Option.some<Ref>({ machine, id: thread.id }))
        if (from !== machine) return yield* unlinked(`${from}'s T3 Code isn't followed`)
        const view = yield* live.view
        if (Option.isNone(view)) return yield* unlinked("T3 Code isn't followed right now")
        const { threads, projects } = view.value
        const owner = threads.get(owners.get(session) ?? "")
        if (owner !== undefined && !subagent(owner)) return yield* linked(owner)
        // A subagent's own conversation is its provider's to talk to, so its hooks keep to their old way.
        const here = yield* canonical(cwd)
        const candidates = (yield* Effect.forEach(
          [...threads.values()].filter((thread) => !subagent(thread)),
          (thread) => {
            const directory = thread.worktreePath ?? projects.get(thread.projectId)?.workspaceRoot
            return directory === undefined ? Effect.succeed([]) : Effect.map(canonical(directory), (real) => (real === here ? [thread] : []))
          },
        ))
          .flat()
          .toSorted((one, other) => (time(other.updatedAt) ?? 0) - (time(one.updatedAt) ?? 0))
          .slice(0, linkable)
        for (const thread of candidates.filter(({ id, updatedAt }) => read.get(id) !== updatedAt)) {
          const found = yield* Effect.either(sessions({ machine, id: thread.id }))
          if (Either.isLeft(found)) {
            yield* Effect.logWarning(`Could not read which sessions "${thread.title}" has: ${found.left.reason}`)
            continue
          }
          read.set(thread.id, thread.updatedAt)
          for (const native of found.right) owners.set(native, thread.id)
          if (found.right.includes(session)) return yield* linked(thread)
        }
        return yield* unlinked(candidates.length === 0 ? "no thread in T3 Code works in this directory" : "no thread in this directory has this session")
      }).pipe(
        Effect.catchAllCause((cause) => Effect.as(Effect.logWarning("Could not link a hook to its thread", cause), Option.none<Ref>())),
        Effect.annotateLogs({ session }),
      )

    /** When usage was last asked for, so a T3 Code that doesn't answer isn't asked on every request. */
    let tried = Number.NEGATIVE_INFINITY
    const refresh = Option.match(options.actions, {
      onNone: () => Effect.void,
      onSome: (actions) =>
        Effect.gen(function* () {
          tried = yield* Clock.currentTimeMillis
          const fresh = yield* actions.usage
          usage = { at: yield* Clock.currentTimeMillis, providers: fresh }
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
      desk: (focus, pending, most, found = [], more = 0, heard = "") =>
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
          const threads = shortlist({ machine, view: view.value, focus, pending, found, heard, most, more, started, said: latest(entries, machine), now })
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
      // What's known at once, asked again meanwhile when it's old. With nothing known, or nothing recent enough to say as
      // what's used now, it's waited for, even when it's being asked for already: what's dated is only for a T3 Code that
      // can't answer.
      usage: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (usage === undefined || now - usage.at > dated) yield* refreshing
        else if (yield* old) yield* Effect.forkIn(refreshing, scope)
        return Option.fromNullable(usage)
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
      link,
      sessions,
    } satisfies Threads["Type"]
  })
