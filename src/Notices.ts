import { Cause, Clock, Effect, FiberSet, Option, Stream } from "effect"
import * as Brain from "./Brain.ts"
import { Condenser, english } from "./Condenser.ts"
import * as Hands from "./Hands.ts"
import type { Notice } from "./Inbox.ts"
import type { Entry, Journal } from "./Journal.ts"
import { addressed, type Lines, Persona } from "./Persona.ts"
import type * as T3Actions from "./T3Actions.ts"
import type * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"

// What yapd brings up about T3 Code's threads of its own accord: what one waits
// on the user for, a run that failed, a usage limit it hit, and a turn that
// finished with no hook to tell of it. Each is kept in the journal under a key
// as it's said, so it's said once, ever, whatever restarts or reconnects come
// in between. A finished turn is left to its hook whenever one came, even one
// that wasn't said, since only hooks know a turn the user was watching.

/** What a change to a thread may come to, before anything is read of it. */
export type News =
  /** It waits on the user, for an approval, an answer or a secret. */
  | { readonly _tag: "Asked"; readonly thread: T3Live.Thread; readonly requestId: string }
  /** A run of it ended, however: what it comes to is only known once it's read, a while later. */
  | { readonly _tag: "Ran"; readonly thread: T3Live.Thread; readonly runId: string }

/**
 * What's worth looking into about a change. Never anything about a
 * subagent's thread, which the user never addresses on its own.
 */
export const verdict = (change: T3Live.Change): Option.Option<News> => {
  if (change.thread.lineage?.relationshipToParent === "subagent") return Option.none()
  switch (change._tag) {
    case "Asked":
      return Option.some({ _tag: "Asked", thread: change.thread, requestId: change.request.id })
    case "Finished": {
      // The run that was going, or the latest one, which came and went unseen.
      const runId = change.before.activeRunId ?? change.thread.latestRunId
      return runId === null ? Option.none() : Option.some({ _tag: "Ran", thread: change.thread, runId })
    }
    default:
      return Option.none()
  }
}

/** The keys what's said once, ever, is kept under in the journal. */
export const key = {
  asked: (machine: string, requestId: string) => `ask:${machine}:${requestId}`,
  failed: (machine: string, runId: string) => `fail:${machine}:${runId}`,
  /** One provider's limit, until `window` it resets at, however many threads hit it. */
  limited: (provider: string, window: string) => `limit:${provider}:${window}`,
  done: (machine: string, runId: string) => `done:${machine}:${runId}`,
}

/** How long a failed run is left for a hook that tells of it, which then has said it. */
const failing = "10 seconds"
/** How much longer a run that went well is left for its hook, which only hooks know to skip, as a turn he was watching. */
const finishing = "10 seconds"
/** How far back a request still waiting is announced once yapd starts, or is turned on. */
const pending = 12 * 60 * 60_000
/** How long before a run started its hook may have come and still be its. */
const leeway = 1000

/** A provider as it's said, from T3 Code's name for it, like "claudeAgent". */
export const provider = (instance: string) => {
  const known: ReadonlyArray<readonly [string, string]> = [
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
    ["cursor", "Cursor"],
    ["gemini", "Gemini"],
  ]
  const found = known.find(([prefix]) => instance.toLowerCase().startsWith(prefix))
  if (found !== undefined) return found[1]
  const words = instance.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  return words === "" ? "your provider" : words
}

/** The window a limit is said once in: the minute it resets, or, when nobody says, the hour it was hit. */
export const window = (resets: Option.Option<string>, at: number) =>
  Option.match(
    Option.filter(Option.map(resets, Date.parse), (reset) => !Number.isNaN(reset)),
    {
      onNone: () => new Date(at).toISOString().slice(0, 13),
      onSome: (reset) => new Date(reset).toISOString().slice(0, 16),
    },
  )

/** What reads like a sentence once said: no code, paths or markup. */
const sayable = /^[\p{L}\p{N} ,.'’&:;!?()%+-]+$/u

/** How many words of T3 Code's own reason are said at most. */
const most = 25

/**
 * Why a run failed, as it's said: what kind of failure it was, or else T3
 * Code's own words, made fit to say and kept short, when they can be.
 */
export const reason = (failure: Option.Option<{ readonly class: string; readonly message: string }>, thread: T3Live.Thread) => {
  const kind = Option.match(failure, { onNone: () => thread.lastErrorClass ?? "", onSome: (failure) => failure.class })
  const known = Brain.failures[kind]
  if (known !== undefined) return `${known}.`
  const message = Option.match(failure, { onNone: () => thread.lastError ?? "", onSome: (failure) => failure.message })
  const plain = message.trim() === "" ? "" : (Hands.plainly(message).split(/(?<=[.!?])\s/)[0] ?? "")
  if (plain === "" || !sayable.test(plain) || !english(plain)) return "it ran into an error."
  const words = plain.split(/\s+/)
  return words.length <= most ? plain : `${words.slice(0, most).join(" ").replace(/[,;:]$/, "")}…`
}

/** Whether a run was short enough that he was likely still looking at it, unless yapd sent what started it. */
export const quick = (run: Pick<T3Actions.Ran, "startedAt" | "userMessageId">, ended: number, shortest: number) =>
  Option.exists(run.startedAt, (started) => ended - started < shortest) && !Option.exists(run.userMessageId, (id) => id.startsWith("yapd:"))

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** What a secret is called, when it can be said as it is. */
const secretName = (label: string) => {
  const trimmed = label.trim()
  return trimmed !== "" && /^[\p{L}\p{N} '’&-]+$/u.test(trimmed) && english(trimmed) && trimmed.split(/\s+/).length <= 6 ? `the ${trimmed}` : "a secret"
}

/** What's said of each, about the thread called `called`. Only ever news: what he'd answer is asked in T3 Code. */
export const lines = {
  failed: (called: string, why: string, said: Lines) => `${capital(called)} failed${addressed(said)}: ${why}`,
  limited: (called: string, who: string, resets: Option.Option<string>, said: Lines) =>
    `${capital(called)} hit ${who}'s limit${addressed(said)}${Option.match(resets, { onNone: () => "", onSome: (at) => `; it resets ${at}` })}.`,
  secret: (called: string, label: string, said: Lines) =>
    `${capital(called)} needs ${secretName(label)} from you${addressed(said)}, which I never take by voice: it's waiting for you in T3 Code.`,
  waiting: (called: string, what: string, said: Lines) => `${capital(called)} ${what}${addressed(said)}: it's waiting for you in T3 Code.`,
}

/** What a request is said to want when the model can't say. */
const unworded = (kind: string) => (kind === "user_input" ? "has a question for you" : "wants your go-ahead on something")

/**
 * Says what T3 Code's threads need the user for, what failed and what
 * finished with no hook to tell of it, as `tell` queues it, unless yapd was
 * turned off since it was heard of. `stopped` is when a session's last Stop
 * hook came, `finished` says a finished turn as a hook's update, and
 * `mention` makes "it" the thread a notice is about as it starts being said.
 */
export const make = (options: {
  readonly threads: Threads.Threads["Type"]
  readonly journal: Journal["Type"]
  readonly tell: (notice: Notice, since?: number) => Effect.Effect<void>
  readonly power: Effect.Effect<{ readonly on: boolean; readonly turns: number }>
  readonly stopped: (sessions: ReadonlyArray<string>) => Effect.Effect<Option.Option<number>>
  readonly finished: (input: {
    readonly about: Threads.Ref
    readonly project: string
    readonly cwd: string
    readonly turn: { readonly prompt: Option.Option<string>; readonly message: string }
    readonly at: number
    readonly key: string
    readonly turns: number
  }) => Effect.Effect<void>
  readonly mention: (ref: Threads.Ref, said: string) => Effect.Effect<void>
  /** Turns shorter than this are taken as watched, as hooks' are. */
  readonly shortest: number
}) =>
  Effect.gen(function* () {
    const { threads, journal } = options
    const condenser = yield* Condenser
    const persona = yield* Persona
    const running = yield* FiberSet.make()
    /** Requests being worded now, so one heard of twice at once, from the stream and on starting, isn't worded twice. */
    const wording = new Set<string>()

    /** What goes wrong looking into a change is only logged: nothing else waits on it. */
    const trouble = <A, E>(looking: Effect.Effect<A, E>) =>
      Effect.catchAllCause(looking, (cause) => (Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not look into what happened to a thread", cause)))

    /** The thread on the desk, under the name it's said by, while it's still there. */
    const listed = (ref: Threads.Ref) =>
      Effect.map(threads.desk(Option.none(), [ref], 1), (desk) => Option.fromNullable(desk.threads.find((listed) => Threads.same(listed.ref, ref))))

    /**
     * Queues a notice about a thread, kept under its key in the journal as
     * it's about to be said, unless it was ever said before or `still` says
     * it no longer holds; noted as heard once it's said to the end.
     */
    const notify = (
      ref: Threads.Ref,
      spoken: string,
      entry: Entry & { readonly key: string },
      still: Effect.Effect<boolean>,
      at: number,
      turns: number,
      id = `t3:${ref.machine}:${ref.id}`,
    ) => {
      let claimed: Option.Option<Option.Option<number>> | undefined
      return options.tell(
        {
          id,
          kind: "notice",
          priority: "needs-you",
          spoken,
          at,
          // Claimed once, the first time it comes up still worth saying: put back after a dictation, it's still this one's to say.
          stale: Effect.gen(function* () {
            if (!(yield* still)) return true
            if (claimed === undefined) claimed = yield* journal.claim(entry)
            return Option.isNone(claimed)
          }),
          saying: options.mention(ref, spoken),
          heard: Effect.suspend(() => {
            const row = claimed === undefined ? Option.none() : Option.flatten(claimed)
            return Option.match(row, {
              onNone: () => Effect.void,
              onSome: (row) => Effect.flatMap(Clock.currentTimeMillis, (now) => journal.markHeard([row], now)),
            })
          }),
        },
        turns,
      )
    }

    /** Says what a thread waits on him for: once, ever, as news, since it's answered in T3 Code. */
    const asked = (ref: Threads.Ref, requestId: string, turns: number, at: number) =>
      Effect.suspend(() => {
        if (wording.has(requestId)) return Effect.void
        wording.add(requestId)
        return ask(ref, requestId, turns, at).pipe(Effect.ensuring(Effect.sync(() => wording.delete(requestId))))
      })

    const ask = (ref: Threads.Ref, requestId: string, turns: number, at: number) =>
      Effect.gen(function* () {
        const thread = yield* threads.find(ref)
        const shown = yield* listed(ref)
        if (Option.isNone(thread) || Option.isNone(shown) || thread.value.pendingRuntimeRequest?.id !== requestId) return
        const { called, project } = shown.value
        const said = yield* persona.lines
        const request = yield* threads.detail(ref, requestId).pipe(
          Effect.map(({ request }) => request),
          Effect.catchAll((error) => Effect.as(Effect.logWarning(`Could not read what it waits on: ${error.reason}`), Option.none<T3Actions.Request>())),
        )
        const spoken = yield* Option.match(request, {
          onNone: () => Effect.succeed(lines.waiting(called, unworded(thread.value.pendingRuntimeRequest?.kind ?? ""), said)),
          onSome: (request) =>
            request._tag === "Secret"
              ? Effect.succeed(lines.secret(called, request.label, said))
              : condenser.ask(request, called).pipe(
                  Effect.map(({ spoken }) => lines.waiting(called, spoken === "" ? unworded(thread.value.pendingRuntimeRequest?.kind ?? "") : spoken, said)),
                  Effect.catchAll((error) =>
                    Effect.as(Effect.logWarning("Could not word what it waits on", error), lines.waiting(called, unworded(thread.value.pendingRuntimeRequest?.kind ?? ""), said)),
                  ),
                ),
        })
        const still = Effect.map(threads.find(ref), Option.exists((thread) => thread.pendingRuntimeRequest?.id === requestId))
        const entry = {
          at,
          kind: "notice" as const,
          machine: ref.machine,
          thread: ref.id,
          project,
          said: spoken,
          key: key.asked(ref.machine, requestId),
          detail: { request: Option.match(request, { onNone: () => thread.value.pendingRuntimeRequest?.kind, onSome: ({ _tag }) => _tag }) },
        }
        yield* notify(ref, spoken, entry, still, at, turns)
      })

    /**
     * Once a run is over and its hook has had time to come, says it failed,
     * or hit a limit, or, when no hook told of a turn that went well, what it
     * said, as a hook's update would be. Nothing for a run he stopped.
     */
    const ran = (ref: Threads.Ref, runId: string, turns: number, at: number) =>
      Effect.gen(function* () {
        yield* Effect.sleep(failing)
        const actions = threads.actions(ref.machine)
        if (Option.isNone(actions)) return
        const run = yield* actions.value.ran(ref.id, runId)
        if (Option.isNone(run)) return
        const { status, natives, startedAt } = run.value
        if (!["failed", "completed", "waiting"].includes(status)) return
        if (status !== "failed") yield* Effect.sleep(finishing)
        // A Stop hook of its own since it started, said or skipped: what it said, or why it wasn't, stands.
        const since = Option.getOrElse(startedAt, () => at) - leeway
        if (Option.exists(yield* options.stopped(natives), (stopped) => stopped >= since)) {
          return yield* Effect.logInfo("Left to its hook")
        }
        const thread = yield* threads.find(ref)
        const shown = yield* listed(ref)
        if (Option.isNone(thread) || Option.isNone(shown)) return
        const { called, project } = shown.value
        if (status === "failed") return yield* failed(ref, run.value, thread.value, called, project, turns, at)
        if (quick(run.value, at, options.shortest)) return yield* Effect.logInfo("Skipped quick turn, with no hook")
        if (run.value.said === "") return
        yield* options.finished({
          about: ref,
          project,
          cwd: Option.getOrElse(shown.value.directory, () => ""),
          turn: { prompt: run.value.prompt, message: run.value.said },
          at,
          key: key.done(ref.machine, runId),
          turns,
        })
      }).pipe(Effect.catchAll((error) => Effect.logWarning("Could not read how a run went", error)))

    /** Says a run failed, with why, or that it hit its provider's limit, once for every thread that does until it resets. */
    const failed = (ref: Threads.Ref, run: T3Actions.Ran, thread: T3Live.Thread, called: string, project: string, turns: number, at: number) =>
      Effect.gen(function* () {
        const said = yield* persona.lines
        const kind = Option.match(run.failure, { onNone: () => thread.lastErrorClass, onSome: (failure) => failure.class })
        // Only while it's still the thread's latest: started again since, he's dealt with it.
        const still = Effect.map(threads.find(ref), Option.exists((thread) => thread.latestRunId === run.id))
        const base = { at, kind: "notice" as const, machine: ref.machine, thread: ref.id, project, detail: { failure: kind } }
        if (kind === "usage_limit") {
          const resets = Option.orElse(
            Option.flatMap(run.failure, (failure) => Option.fromNullable(failure.resetAt)),
            () => Option.fromNullable(thread.usageLimitResetAt),
          )
          const who = provider(thread.modelSelection.instanceId)
          const limit = key.limited(who, window(resets, at))
          const spoken = lines.limited(called, who, Option.flatMap(resets, (resets) => Option.fromNullable(Brain.clock(resets, at))), said)
          return yield* notify(ref, spoken, { ...base, said: spoken, key: limit }, still, at, turns, limit)
        }
        const spoken = lines.failed(called, reason(run.failure, thread), said)
        yield* notify(ref, spoken, { ...base, said: spoken, key: key.failed(ref.machine, run.id) }, still, at, turns)
      })

    /** Looks into what a change to a thread comes to, in the background, unless yapd is off. */
    const hear = (machine: string, change: T3Live.Change) =>
      Effect.gen(function* () {
        const news = verdict(change)
        if (Option.isNone(news)) return
        // Off, nothing is said later of what happened meanwhile; what still waits on him is said once it's on.
        const { on, turns } = yield* options.power
        if (!on) return
        const at = yield* Clock.currentTimeMillis
        const ref = { machine, id: news.value.thread.id }
        const looking = news.value._tag === "Asked" ? asked(ref, news.value.requestId, turns, at) : ran(ref, news.value.runId, turns, at)
        yield* FiberSet.run(running, looking.pipe(trouble, Effect.annotateLogs({ thread: news.value.thread.title })))
      })

    return {
      /** Follows what happens to the threads, for as long as yapd runs. */
      follow: Stream.runForEach(threads.changes, ({ machine, change }) => hear(machine, change)),
      /**
       * What's waiting on him, which nothing said yet: run once T3 Code has
       * caught up after a start, and each time yapd is turned on. Nothing while
       * it's off.
       */
      reconcile: Effect.gen(function* () {
        const { on, turns } = yield* options.power
        if (!on) return
        const now = yield* Clock.currentTimeMillis
        const said = new Set((yield* journal.since(now - pending, { kinds: ["notice"], most: 1000 })).flatMap(({ key }) => (key === undefined ? [] : [key])))
        const desk = yield* threads.desk(Option.none(), [], 1000)
        for (const { ref, thread } of desk.threads) {
          const request = thread.pendingRuntimeRequest
          const created = request === null ? Number.NaN : Date.parse(request.createdAt)
          if (request === null || Number.isNaN(created) || now - created > pending || said.has(key.asked(ref.machine, request.id))) continue
          yield* FiberSet.run(running, asked(ref, request.id, turns, now).pipe(trouble, Effect.annotateLogs({ thread: thread.title })))
        }
      }),
    }
  })
