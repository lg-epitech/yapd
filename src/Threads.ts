import type { Database } from "bun:sqlite"
import { Clock, Context, Data, type Duration, Effect, Either, Option, Stream } from "effect"
import { english, speakable } from "./Condenser.ts"
import type { Journal, Kept } from "./Journal.ts"
import type * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3Live from "./T3Live.ts"
import type * as Tunnel from "./Tunnel.ts"

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
    /** Why a machine's threads can't be seen now, as the desk lists it among those away. None while they can. */
    readonly unseen: (machine: string) => Effect.Effect<Option.Option<string>>
    /**
     * Notes what he was just told: once he's heard why another machine can't
     * be reached, it's only said that its threads still can't be seen, until
     * it's been back and gone down again, or can't be reached for another reason.
     */
    readonly heard: (said: string) => Effect.Effect<void>
    readonly changes: Stream.Stream<{ readonly machine: string; readonly change: T3Live.Change }>
    readonly actions: (machine: string) => Option.Option<T3Actions.Actions>
    /** Where a thread got to, read from it now. */
    readonly detail: (ref: Ref, pending?: string) => Effect.Effect<T3Actions.Detail, ThreadsError>
    /**
     * Threads whose messages mention the words, on every machine whose threads
     * can be seen. `within` leaves out a machine that hasn't answered by then,
     * rather than what the others found.
     */
    readonly search: (
      words: string,
      within?: Duration.DurationInput,
    ) => Effect.Effect<ReadonlyArray<{ readonly ref: Ref; readonly snippet: string }>, ThreadsError>
    /** What each provider has used of its limits, as of at most a few minutes ago unless T3 Code stopped answering. */
    readonly usage: Effect.Effect<Option.Option<Usage>>
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
export interface Started {
  readonly dictated: string
  readonly description: string | null
  readonly at: number
}

/** One machine's threads as T3 Code there last sent them, and what yapd noted and said about them. */
export interface Seen {
  /** What the user calls it. */
  readonly machine: string
  /** Whether it's this machine. */
  readonly here: boolean
  readonly view: T3Live.View
  readonly started: ReadonlyMap<string, Started>
  /** The latest line yapd said about each thread, by id. */
  readonly said: ReadonlyMap<string, { readonly at: number; readonly said: string }>
}

/**
 * The desk: every thread in order of how likely the user means it, an
 * ordering that never leaves one out, cut to the `most` first. The question's
 * candidates come first, so "the first" is t1, then what "it" means, then what
 * a search for their words found, what waits on the user, what's running,
 * what failed, and on down to the newest. `machine` is this one, and `others`
 * the other machines whose threads can be seen, ranked in among its own, by
 * the same order: what's running on rig matters as much as what's running here.
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
  readonly others?: ReadonlyArray<Seen>
  readonly now: number
}): ReadonlyArray<Listed> => {
  const { focus, pending, most, now } = input
  const machines: ReadonlyArray<Seen> = [
    { machine: input.machine, here: true, view: input.view, started: input.started, said: input.said },
    ...(input.others ?? []),
  ]
  const within = (at: number | undefined, span: number) => at !== undefined && now - at < span
  const titled = new Set(titles(input.heard ?? "", machines).map(({ machine, id }) => `${machine}\n${id}`))
  const group = ({ machine, started, said }: Seen, thread: T3Live.Thread, doing: State) => {
    const candidate = pending.findIndex((ref) => ref.machine === machine && ref.id === thread.id)
    if (candidate >= 0) return candidate / 100
    if (Option.isSome(focus) && focus.value.machine === machine && focus.value.id === thread.id) return 1
    if ((input.found ?? []).some((ref) => ref.machine === machine && ref.id === thread.id) || titled.has(`${machine}\n${thread.id}`)) return 1.5
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
  const ranked = machines
    .flatMap((seen) =>
      [...seen.view.threads.values()]
        .filter((thread) => !subagent(thread) && thread.archivedAt === null)
        .map((thread) => {
          const doing = state(thread)
          return { seen, thread, doing, group: group(seen, thread, doing), updated: time(thread.updatedAt) ?? 0 }
        }),
    )
    .toSorted((one, other) => one.group - other.group || other.updated - one.updated)
  // A misheard name can only be matched to a name the model sees, so the rest of the month's go too, by name.
  const named = ranked
    .slice(most)
    .filter(({ updated }) => within(updated, days(30)))
    .slice(0, input.more ?? 0)
  return [...ranked.slice(0, most), ...named]
    .map(({ seen, thread, doing }, index): Listed => {
      const { machine, here, view, started, said } = seen
      const project = view.projects.get(thread.projectId)?.title ?? ""
      const own = started.get(thread.id)
      return {
        handle: `t${index + 1}`,
        ref: { machine, id: thread.id },
        here,
        called: called(thread.title, own?.description, project, time(thread.createdAt) ?? now, now),
        project: spoken(project),
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
export const entitled = (heard: string, view: T3Live.View): ReadonlyArray<string> =>
  titles(heard, [{ machine: "", view }]).map(({ id }) => id)

/** The threads `entitled` puts up front, on every machine at once, so one machine's can't crowd out a closer match on another. */
const titles = (heard: string, machines: ReadonlyArray<Pick<Seen, "machine" | "view">>): ReadonlyArray<Ref> => {
  const said = stems(heard)
  if (said.size < 2) return []
  return machines
    .flatMap(({ machine, view }) =>
      [...view.threads.values()]
        .filter((thread) => !subagent(thread) && thread.archivedAt === null)
        .map((thread) => ({ machine, id: thread.id, shared: [...stems(thread.title)].filter((word) => said.has(word)).length, at: time(thread.updatedAt) ?? 0 })),
    )
    .filter(({ shared }) => shared >= 2)
    .toSorted((one, other) => other.shared - one.shared || other.at - one.at)
    .slice(0, entitledAt)
    .map(({ machine, id }) => ({ machine, id }))
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

/** What the user said they'd been told, as far back as the desk looks for it. */
const latest = (entries: ReadonlyArray<Kept>, machine: string) => {
  const said = new Map<string, { readonly at: number; readonly said: string }>()
  for (const entry of entries) {
    if (entry.thread === undefined || entry.machine !== machine || entry.said === undefined || entry.said.trim() === "") continue
    said.set(entry.thread, { at: entry.at, said: entry.said })
  }
  return said
}

/** Another machine's threads, followed through T3 Code there, which yapd reaches through an SSH connection it keeps open. */
export interface Other {
  /** What the user calls it. */
  readonly machine: string
  readonly live: T3Live.T3Live["Type"]
  readonly actions: T3Actions.Actions
  /** Whether its T3 Code can be reached now, and when it can't, why, and which time it went down. */
  readonly status: Effect.Effect<Tunnel.Status>
}

/** A machine's T3 Code, as the threads on it are followed and acted on. */
interface Link {
  readonly machine: string
  readonly here: boolean
  readonly live: T3Live.T3Live["Type"]
  /** None without a T3 Code token. */
  readonly actions: Option.Option<T3Actions.Actions>
  /** Why its threads can't be seen, for while they can't. */
  readonly unseen: Effect.Effect<string>
}

/**
 * The threads on this machine and on the others yapd follows, each through T3
 * Code there, ranked together. A machine whose threads can't be seen is listed
 * as away, with why, and never holds up the rest: what's known of each is what
 * it last sent, and acting on a thread goes to its own machine's T3 Code only.
 */
export const make = (options: {
  /** What the user calls this machine. */
  readonly machine: string
  readonly live: T3Live.T3Live["Type"]
  /** None without a T3 Code token. */
  readonly actions: Option.Option<T3Actions.Actions>
  /** Other machines yapd follows, each through its own link. */
  readonly others: ReadonlyArray<Other>
  readonly journal: Journal["Type"]
  readonly store: Store.Store["Type"]
}) =>
  Effect.gen(function* () {
    const { machine, journal, store } = options
    const scope = yield* Effect.scope
    let usage: Usage | undefined

    /** Which time each other machine went down that he was told why of, with why: once each time, rather than every time he asks. */
    const told = new Map<string, string>()
    /** An outage, as it's told: a new one, or the same one for another reason, is news. */
    const telling = ({ outage, reason }: { readonly outage: number; readonly reason: string }) => `${outage}\n${reason}`
    const links: ReadonlyArray<Link> = [
      {
        machine,
        here: true,
        live: options.live,
        actions: options.actions,
        // Named when another machine's threads can be seen, since they're his threads too.
        unseen: Effect.succeed(
          options.others.length === 0
            ? Option.isNone(options.actions)
              ? "I need a T3 Code token to see your threads."
              : "T3 Code isn't running, so I can't see your threads."
            : Option.isNone(options.actions)
              ? `I need a T3 Code token to see ${machine}'s threads.`
              : `T3 Code isn't running on ${machine}, so I can't see its threads.`,
        ),
      },
      ...options.others.map(
        (other): Link => ({
          machine: other.machine,
          here: false,
          live: other.live,
          actions: Option.some(other.actions),
          unseen: Effect.map(other.status, (status) => {
            // Reached, it's still catching up, or T3 Code there won't be followed.
            if (status._tag === "Up") return `I can't follow ${other.machine}'s threads right now.`
            // Starting up isn't an outage, so that's said for as long as it lasts.
            return status.outage > 0 && told.get(other.machine) === telling(status) ? `I still can't see ${other.machine}'s threads.` : status.reason
          }),
        }),
      ),
    ]
    const linked = (name: string) => links.find((link) => link.machine === name)

    /** What was noted about work yapd started, by machine, then by thread. */
    const startedWork = store
      .transaction((database: Database) =>
        database
          .query<{ machine: string; id: string; dictated: string | null; prompt: string | null; description: string | null; at: string }, []>(
            "select machine, id, dictated, prompt, description, at from threads where started = 1",
          )
          .all(),
      )
      .pipe(
        Effect.map((rows) => {
          const started = new Map<string, Map<string, Started>>()
          for (const row of rows) {
            const noted = started.get(row.machine) ?? new Map<string, Started>()
            noted.set(row.id, { dictated: row.dictated ?? row.prompt ?? "", description: row.description, at: time(row.at) ?? 0 })
            started.set(row.machine, noted)
          }
          return started
        }),
        Effect.catchAll((error) =>
          Effect.logWarning("Could not read what work I started", error).pipe(Effect.as(new Map<string, Map<string, Started>>())),
        ),
      )

    const reach = (ref: Ref) =>
      Option.match(Option.fromNullable(linked(ref.machine)), {
        onNone: () => Effect.fail(new ThreadsError({ reason: `I can't see ${ref.machine}'s threads.` })),
        onSome: ({ actions }) =>
          Option.match(actions, {
            onNone: () => Effect.fail(new ThreadsError({ reason: "I need a T3 Code token to read your threads." })),
            onSome: Effect.succeed,
          }),
      })

    /** Searches one machine's threads, as `search` says. */
    const searching = (link: Link, actions: T3Actions.Actions, words: string, within: Duration.DurationInput | undefined) => {
      const asked = actions.search(words).pipe(
        Effect.map((matches) => matches.map(({ threadId, snippet }) => ({ ref: { machine: link.machine, id: threadId }, snippet }))),
        Effect.mapError((error) => new ThreadsError({ reason: T3Actions.reason(error), cause: error })),
      )
      return within === undefined ? asked : Effect.map(Effect.timeoutOption(asked, within), Option.getOrElse(() => []))
    }

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
          const seen: Array<{ readonly link: Link; readonly view: T3Live.View }> = []
          const away: Array<{ readonly machine: string; readonly reason: string }> = []
          for (const link of links) {
            const view = yield* link.live.view
            if (Option.isSome(view)) seen.push({ link, view: view.value })
            else away.push({ machine: link.machine, reason: yield* link.unseen })
          }
          if (seen.length === 0) return { threads: [], away }
          const [started, entries] = [yield* startedWork, yield* journal.since(now - days(7), { most: 500 })]
          const noted = (name: string) => ({ started: started.get(name) ?? new Map<string, Started>(), said: latest(entries, name) })
          const others = seen.filter(({ link }) => !link.here).map(({ link, view }): Seen => ({ machine: link.machine, here: false, view, ...noted(link.machine) }))
          // When this machine's can't be seen, only the others' are ranked.
          const own = seen.find(({ link }) => link.here)?.view ?? T3Live.empty
          const threads = shortlist({ machine, view: own, ...noted(machine), others, focus, pending, found, heard, most, more, now })
          return { threads, away }
        }),
      find: (ref) =>
        Option.match(Option.fromNullable(linked(ref.machine)), {
          onNone: () => Effect.succeed(Option.none()),
          onSome: ({ live }) => Effect.map(live.view, Option.flatMap((view) => Option.fromNullable(view.threads.get(ref.id)))),
        }),
      unseen: (name) =>
        Option.match(Option.fromNullable(linked(name)), {
          onNone: () => Effect.succeed(Option.some(`I can't see ${name}'s threads.`)),
          onSome: (link) => Effect.flatMap(link.live.view, (view) => (Option.isSome(view) ? Effect.succeed(Option.none()) : Effect.map(link.unseen, Option.some))),
        }),
      heard: (said) =>
        Effect.forEach(
          options.others,
          (other) =>
            Effect.map(other.status, (status) => {
              // Said within a sentence, it loses its full stop, and maybe its capital.
              const reason = status._tag === "Down" ? status.reason.replace(/[.!?]+$/, "").toLowerCase() : ""
              if (status._tag === "Down" && status.outage > 0 && reason !== "" && said.toLowerCase().includes(reason)) told.set(other.machine, telling(status))
            }),
          { discard: true },
        ),
      changes: Stream.mergeAll(
        links.map((link) => Stream.map(link.live.changes, (change) => ({ machine: link.machine, change }))),
        { concurrency: "unbounded" },
      ),
      actions: (name) => Option.flatMap(Option.fromNullable(linked(name)), ({ actions }) => actions),
      detail: (ref, pending?) =>
        Effect.flatMap(reach(ref), (actions) =>
          actions.detail(ref.id, pending).pipe(Effect.mapError((error) => new ThreadsError({ reason: T3Actions.reason(error), cause: error }))),
        ),
      search: (words, within?) =>
        Effect.gen(function* () {
          // Another machine's only while its threads can be seen: one that's down would only keep him waiting to be told so.
          const open = yield* Effect.filter(links, (link) => (link.here ? Effect.succeed(true) : Effect.map(link.live.view, Option.isSome)))
          const asked = open.flatMap((link) => Option.toArray(Option.map(link.actions, (actions) => searching(link, actions, words, within))))
          if (asked.length === 0) return yield* reach({ machine, id: "" }).pipe(Effect.as([]))
          const each = yield* Effect.forEach(asked, Effect.either, { concurrency: "unbounded" })
          const lists = each.flatMap((one) => (Either.isRight(one) ? [one.right] : []))
          const failed = each.find(Either.isLeft)
          if (lists.length === 0 && failed !== undefined) return yield* failed.left
          // Each machine's best in turn, as its T3 Code ranked them, so one machine's many can't push another's best down.
          return lists
            .flatMap((matches) => matches.map((match, place) => ({ match, place })))
            .toSorted((one, other) => one.place - other.place)
            .map(({ match }) => match)
        }),
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
    } satisfies Threads["Type"]
  })
