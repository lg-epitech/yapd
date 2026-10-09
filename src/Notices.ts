import { Cause, Clock, Effect, FiberSet, Option, Schema, Stream } from "effect"
import type * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import { Condenser, english } from "./Condenser.ts"
import * as Hands from "./Hands.ts"
import type { Notice } from "./Inbox.ts"
import type { Entry, Journal } from "./Journal.ts"
import { addressed, type Lines, Persona } from "./Persona.ts"
import * as Questions from "./Questions.ts"
import type * as T3Actions from "./T3Actions.ts"
import type * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"

// What yapd brings up about T3 Code's threads of its own accord: what one waits
// on the user for, a run that failed, a usage limit it hit, and a turn that
// finished with no hook to tell of it. Each is kept in the journal under a key
// as it's said, so it's said once, ever, whatever restarts or reconnects come
// in between. A finished turn is left to its hook whenever one came, even one
// that wasn't said, since only hooks know a turn the user was watching: a
// Stop is the run's whose last words it has, or, when its words are no run's
// that can be told, and the run failed or said nothing, whose when it came
// says, and one that can't be told either way is left to as if it were, since
// a turn said twice is worse than one not said. A question is asked, for the
// user to answer by voice; a secret is only told, since it's only ever given
// in T3 Code; and an approval is never brought up at all, since his agents
// run with full access and he doesn't want one at every turn: it's still
// there when he asks who needs him, and answered when he brings it up.

/** What a change to a thread may come to, before anything is read of it. */
export type News =
  /** It waits on the user, for an approval, an answer or a secret, as `kind` says: "user_input" for an answer or a secret, anything else for an approval. */
  | { readonly _tag: "Asked"; readonly thread: T3Live.Thread; readonly requestId: string; readonly kind: string }
  /** A run of it ended, however: what it comes to is only known once it's read, a while later. */
  | { readonly _tag: "Ran"; readonly thread: T3Live.Thread; readonly runId: string }
  /** What it waited on him for was dealt with, there or anywhere, or the thread went: it's no longer asked. */
  | { readonly _tag: "Settled"; readonly thread: T3Live.Thread; readonly requestId: string }

/**
 * What's worth looking into about a change. Never anything about a
 * subagent's thread, which the user never addresses on its own.
 */
export const verdict = (change: T3Live.Change): Option.Option<News> => {
  if (change.thread.lineage?.relationshipToParent === "subagent") return Option.none()
  switch (change._tag) {
    case "Asked":
      return Option.some({ _tag: "Asked", thread: change.thread, requestId: change.request.id, kind: change.request.kind })
    case "Finished": {
      // The run that was going, or the latest one, which came and went unseen.
      const runId = change.before.activeRunId ?? change.thread.latestRunId
      return runId === null ? Option.none() : Option.some({ _tag: "Ran", thread: change.thread, runId })
    }
    case "Answered":
      return Option.some({ _tag: "Settled", thread: change.thread, requestId: change.request.id })
    case "Removed":
      return Option.map(Option.fromNullable(change.thread.pendingRuntimeRequest), ({ id }): News => ({ _tag: "Settled", thread: change.thread, requestId: id }))
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
/** How long after a run ended its Stop hook may still come, getting going and naming its project first. */
const late = 5000
/** How much of two last words, case and punctuation aside, one ending the other needs to be the same words, as T3 Code may keep only the end of them. */
const ending = 24
/** How long a limit whose reset nobody said is taken to hold: the shortest window a provider has. */
const lasting = 5 * 60 * 60_000
/** How far back a limit said before is looked for: the longest a provider's holds. */
const longest = 7 * 24 * 60 * 60_000

/** When a limit said before resets, as it's kept with it, when that was known. */
const Limit = Schema.Struct({ resets: Schema.String })
const decodeLimit = Schema.decodeUnknownOption(Limit)

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
  const said = words.length <= most ? plain : `${words.slice(0, most).join(" ").replace(/[,;:]$/, "")}…`
  // It follows a colon: a name keeps its capital, a sentence's first word doesn't.
  return said.replace(/^(The|A|An|It|Its|This|That|There|No|Nothing|Something|Your)\b/, (word) => word.toLowerCase())
}

/** A Stop hook as it came: when, and what the agent said last, which tells whose turn it ended. */
export interface Stop {
  readonly at: number
  readonly message: string
}

/** Words as they're compared: case, punctuation and spacing aside. */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/** Whether a Stop's last words are what a run said last: the same, or one ending the other, with enough of it to tell. */
export const alike = (stop: string, said: string) => {
  const [one, other] = [plain(stop), plain(said)]
  if (one === "" || other === "") return false
  return one === other || (Math.min(one.length, other.length) >= ending && (one.endsWith(other) || other.endsWith(one)))
}

/** Whether last words are enough to tell their run by even once the thread started again: not a short "Done." the next run could end on too. */
export const telling = (message: string) => plain(message).length >= ending

/**
 * Whose a Stop is, by what it said last: the run's "own", "another" run's
 * read with it, like the one before's come late, or "unknown", when its words
 * are no run's that can be told, as when T3 Code keeps them otherwise.
 */
export const whose = (stop: Stop, run: Pick<T3Actions.Ran, "final" | "others">) =>
  alike(stop.message, run.final) ? ("own" as const) : run.others.some((other) => alike(stop.message, other)) ? ("another" as const) : ("unknown" as const)

/**
 * Whether a run had a Stop hook of its own, out of the thread's Stops, oldest
 * first: one since it started with its last words, or with words that are no
 * run's that can be told, which the hook is left to all the same, since a
 * turn said twice is worse than one not said. Never one with another run's
 * words, like the one before's come late, which matters for a run that fails
 * at once, since Claude has no Stop for that; nor one with no words, which
 * tells of nothing. A run that failed, which Claude has no Stop for, or that
 * said nothing to tell its own by, goes by when a Stop whose words can't be
 * told came: the last run before that went well had one coming as it ended,
 * which takes a moment to get going, and when none had come by the time this
 * one started, the first since, while it could still be that one's, is taken
 * for it. Any other is still left to as if it were this one's.
 */
export const hooked = (stops: ReadonlyArray<Stop>, run: Pick<T3Actions.Ran, "status" | "final" | "others" | "previous">, startedAt: number) => {
  const since = startedAt - leeway
  const theirs =
    run.status !== "failed" && run.final !== ""
      ? Option.none<Stop>()
      : Option.flatMap(run.previous, (previous) =>
          Option.filter(Option.fromNullable(stops.find((stop) => stop.at >= previous.startedAt - leeway)), (first) => first.at >= since && first.at <= previous.endedAt + late),
        )
  return stops.some((stop) => {
    if (stop.message.trim() === "" || stop.at < since) return false
    const owner = whose(stop, run)
    return owner === "own" || (owner === "unknown" && !Option.exists(theirs, (taken) => taken === stop))
  })
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

/** What's said of each, about the thread called `called`, as news: what he can answer by voice is asked instead. */
export const lines = {
  failed: (called: string, why: string, said: Lines) => `${capital(called)} failed${addressed(said)}: ${why}`,
  limited: (called: string, who: string, resets: Option.Option<string>, said: Lines) =>
    `${capital(called)} hit ${who}'s limit${addressed(said)}${Option.match(resets, { onNone: () => "", onSome: (at) => `; it resets ${at}` })}.`,
  secret: (called: string, label: string, said: Lines) =>
    `${capital(called)} needs ${secretName(label)} from you${addressed(said)}, which I never take by voice: it's waiting for you in T3 Code.`,
  waiting: (called: string, what: string, said: Lines) => `${capital(called)} ${what}${addressed(said)}: it's waiting for you in T3 Code.`,
}

/** What a request is said to want when it can't be read, or the model can't say. */
const unworded = (kind: string) => (kind === "user_input" ? "has a question for you" : "wants your go-ahead on something")

/** How long a request the thread shows as what it waits on is read again for while its card isn't there yet, and how often. */
const card = { tries: 8, every: "250 millis" } as const

/** What's said of what a thread waits on, kept in the journal under the key it's said once under, ever. */
const noted = (ref: Threads.Ref, project: string, request: Pick<T3Actions.Request, "_tag" | "id">, at: number, spoken: string) => ({
  at,
  kind: "notice" as const,
  machine: ref.machine,
  thread: ref.id,
  project,
  said: spoken,
  key: key.asked(ref.machine, request.id),
  detail: { request: request._tag },
})

/**
 * What a thread waits on him to allow, worded from what the model made of
 * it, `what`, which follows the thread's name: asked, needing "approve" when
 * it's risky by the model's word or by all of what it would run, or when
 * that couldn't be read in full, and saying so. It's never brought up of
 * yapd's own accord, only read back when he brings it up himself.
 */
export const asking = (
  input: {
    readonly ref: Threads.Ref
    readonly called: string
    readonly project: string
    readonly request: Extract<T3Actions.Request, { readonly _tag: "Approval" }>
    readonly what: string
    readonly risk: "low" | "high"
    readonly at: number
  },
  said: Lines,
): Assistant.Worded => {
  const { ref, called, project, request, risk, at } = input
  // It follows the thread's name, so it starts as the rest of a sentence.
  const what = input.what.replace(/^(Wants|Asks|Needs|Has) /, (word) => word.toLowerCase())
  const sir = addressed(said)
  // By all of what it would run, never what's cut short to be said, which can leave out the risky part, and that first, as a tool's name is.
  const risky = risk === "high" || Brain.dangerous(request.whole === undefined ? request.what : `${request.whole}\n${request.what}`)
  // Not shown in full, what it would run could be anything, so it's taken for risky too.
  const unread = request.whole === undefined
  const dangerous = risky || unread
  const doing = /^wants to /i.test(what) ? what.replace(/^wants to /i, "") : undefined
  const about = doing === undefined ? `give ${called} your go-ahead` : `allow ${called} to ${doing}`
  const asked = risky
    ? `${capital(called)} ${what}, which can't be undone, so say 'approve' if you want it${sir}.`
    : unread
      ? `${capital(called)} ${what}, but I couldn't read all of what it would run, so say 'approve' if you want it${sir}.`
      : `${capital(called)} ${what}. Allow it${sir}?`
  const rewordings = dangerous
    ? [`Shall I still ${about}${sir}? Only 'approve' will do.`, `Do you still want me to ${about}${sir}? Say 'approve' if you do.`]
    : [`Shall I still ${about}${sir}?`, `Do you still want me to ${about}${sir}?`]
  return {
    _tag: "Ask",
    asking: {
      ref,
      asks: { _tag: "Approval", requestId: request.id, dangerous, decisions: request.decisions.map(({ decision }) => decision), inFull: false },
      asked,
      about,
      rewordings,
      entry: noted(ref, project, request, at, asked),
    },
  }
}

/**
 * A thread's question, worded to be asked a part at a time, each part's
 * question in the words `spoken` has for it, the agent's own or the model's,
 * when they can be said. Only told when it can't be asked: too many parts or
 * options to take in, or nothing of it that can be said.
 */
export const questioning = (
  input: {
    readonly ref: Threads.Ref
    readonly called: string
    readonly project: string
    readonly request: Extract<T3Actions.Request, { readonly _tag: "Question" }>
    readonly spoken: ReadonlyArray<Option.Option<string>>
    readonly at: number
  },
  said: Lines,
): Assistant.Worded => {
  const { ref, called, project, request, at } = input
  const parts = request.questions.map((question, index) => Questions.said(question, input.spoken[index] ?? Option.none()))
  const worded = Questions.worded({ called, parts, lines: said })
  const first = worded._tag === "Ask" ? worded.parts[0] : undefined
  if (worded._tag === "Tell" || first === undefined) {
    // When nothing of it can be said, only that it's there.
    const spoken = Option.getOrElse(worded._tag === "Tell" ? worded.spoken : Option.none(), () => lines.waiting(called, unworded("user_input"), said))
    return { _tag: "Tell", spoken, entry: noted(ref, project, request, at, spoken) }
  }
  return {
    _tag: "Ask",
    asking: {
      ref,
      asks: { _tag: "Question", requestId: request.id, questions: request.questions, mode: request.mode, part: 0, collected: {}, inFull: false },
      asked: first.first,
      about: `the question on ${called}`,
      // Asked again as it is when it goes unanswered, in full each time.
      rewordings: first.still,
      parts: worded.parts,
      entry: noted(ref, project, request, at, first.first),
    },
  }
}

/**
 * Reads what a thread waits on him for and words it, to be asked, or only
 * told, like a secret, which is never answered by voice, or one that can't
 * be read, or an approval the model couldn't word, which isn't asked blind.
 * A question is read in the agent's own words, and only a part that can't
 * be said as it is goes to the model. The thread can show it waits on
 * something before its card can be read, as T3 Code writes them apart, so
 * that's read again a few times first. None while the thread doesn't wait
 * on it, even behind something it asked since, or isn't on the desk.
 */
export const composer = (threads: Threads.Threads["Type"]) =>
  Effect.gen(function* () {
    const condenser = yield* Condenser
    const persona = yield* Persona
    return (ref: Threads.Ref, requestId: string, at?: number) =>
      Effect.gen(function* () {
        const thread = yield* threads.find(ref)
        const shown = Option.fromNullable((yield* threads.desk(Option.none(), [ref], 1)).threads.find((listed) => Threads.same(listed.ref, ref)))
        if (Option.isNone(thread) || Option.isNone(shown) || !(yield* threads.waiting(ref, requestId))) return Option.none<Assistant.Worded>()
        const { called, project } = shown.value
        // What kind it is, when it's the one the thread shows, for when it can't be read.
        const kind = thread.value.pendingRuntimeRequest?.id === requestId ? thread.value.pendingRuntimeRequest.kind : ""
        const said = yield* persona.lines
        const when = at ?? (yield* Clock.currentTimeMillis)
        /** Its card, read again a moment later while the thread still waits on it and it isn't there yet. */
        const read = (tries: number): Effect.Effect<Option.Option<T3Actions.Request>, Threads.ThreadsError> =>
          Effect.gen(function* () {
            const { request } = yield* threads.detail(ref, requestId)
            if (Option.isSome(request) || tries === 0 || !(yield* threads.waiting(ref, requestId))) return request
            yield* Effect.sleep(card.every)
            return yield* read(tries - 1)
          })
        const request = yield* read(card.tries).pipe(
          Effect.catchAll((error) => Effect.as(Effect.logWarning(`Could not read what it waits on: ${error.reason}`), Option.none<T3Actions.Request>())),
        )
        const told = (spoken: string, detail: string): Assistant.Worded => ({
          _tag: "Tell",
          spoken,
          entry: { at: when, kind: "notice", machine: ref.machine, thread: ref.id, project, said: spoken, key: key.asked(ref.machine, requestId), detail: { request: detail } },
        })
        if (Option.isNone(request)) return Option.some(told(lines.waiting(called, unworded(kind), said), kind))
        const found = request.value
        if (found._tag === "Secret") return Option.some(told(lines.secret(called, found.label, said), found._tag))
        if (found._tag === "Question") {
          // Asked as the agent put it whenever that can be said; the rest, two at a time, by the model, or failing that by its header.
          // One with more parts than are asked is only told so, in no part's words.
          const wording = found.questions.length > Questions.most ? [] : found.questions
          const spoken = yield* Effect.forEach(
            wording,
            (part) =>
              Option.match(Questions.sayQuestion(part.question), {
                onSome: (question) => Effect.succeed(Option.some(question)),
                onNone: () =>
                  condenser.question(part, called).pipe(
                    Effect.map(({ spoken }) => Questions.sayQuestion(spoken)),
                    Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not word a question", error), Option.none<string>())),
                  ),
              }),
            { concurrency: 2 },
          )
          return Option.some(questioning({ ref, called, project, request: found, spoken, at: when }, said))
        }
        return Option.some(
          yield* condenser.ask(found, called).pipe(
            Effect.map(({ spoken, risk }) =>
              spoken === "" ? told(lines.waiting(called, unworded(kind), said), found._tag) : asking({ ref, called, project, request: found, what: spoken, risk, at: when }, said),
            ),
            Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not word what it waits on", error), told(lines.waiting(called, unworded(kind), said), found._tag))),
          ),
        )
      })
  })

/**
 * A turn that finished with no hook to tell of it, to be said like a hook's
 * update, once under `key`, unless yapd was turned off since `turns`: what
 * tells a Stop of its own from another's, which takes its place whenever one
 * comes, and whether it's still the thread's `current` run, which its
 * starting again or going ends.
 */
export interface Finished {
  readonly about: Threads.Ref
  readonly project: string
  readonly cwd: string
  readonly turn: { readonly prompt: Option.Option<string>; readonly message: string }
  readonly at: number
  readonly key: string
  readonly turns: number
  readonly run: Pick<T3Actions.Ran, "status" | "final" | "others" | "natives" | "previous"> & { readonly startedAt: number }
  readonly current: Effect.Effect<boolean>
}

/**
 * Says what T3 Code's threads need the user for, whenever yapd is on, and
 * what failed and what finished with no hook to tell of it, unless yapd was
 * turned off since, as `tell` queues it. `stopped` is the Stop hooks
 * sessions had, oldest first, but those a turn said in their hook's place
 * took as its run's, `finished` says a finished turn as a hook's update, and
 * `mention` makes "it" the thread a notice is about as it starts being said.
 */
export const make = (options: {
  readonly threads: Threads.Threads["Type"]
  readonly journal: Journal["Type"]
  readonly tell: (notice: Notice, since?: number) => Effect.Effect<void>
  readonly power: Effect.Effect<{ readonly on: boolean; readonly turns: number }>
  readonly stopped: (sessions: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Stop>>
  readonly finished: (input: Finished) => Effect.Effect<void>
  /** A thread started again, or went: what it said last that no hook told of, if that's still to be said, isn't. */
  readonly overtaken: (ref: Threads.Ref) => Effect.Effect<void>
  readonly mention: (ref: Threads.Ref, said: string) => Effect.Effect<void>
  /** Asks what a thread waits on him for, as the one question open. */
  readonly ask: (asking: Assistant.Asking) => Effect.Effect<void>
  /** What a thread waited on him for was dealt with, so it isn't asked. */
  readonly settled: (requestId: string) => Effect.Effect<void>
  /** Turns shorter than this are taken as watched, as hooks' are. */
  readonly shortest: number
}) =>
  Effect.gen(function* () {
    const { threads, journal } = options
    const persona = yield* Persona
    const compose = yield* composer(threads)
    const running = yield* FiberSet.make()
    /** Requests being worded now, so one heard of twice at once, from the stream and on starting, isn't worded twice. */
    const wording = new Set<string>()
    /** How many times each thread started again or went, so a turn of it looked into since knows it's no longer its latest. */
    const generations = new Map<string, number>()
    const generation = (ref: Threads.Ref) => generations.get(`${ref.machine}:${ref.id}`) ?? 0

    /** What goes wrong looking into a change is only logged: nothing else waits on it. */
    const trouble = <A, E>(looking: Effect.Effect<A, E>) =>
      Effect.catchAllCause(looking, (cause) => (Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not look into what happened to a thread", cause)))

    /** The thread on the desk, under the name it's said by, while it's still there. */
    const listed = (ref: Threads.Ref) =>
      Effect.map(threads.desk(Option.none(), [ref], 1), (desk) => Option.fromNullable(desk.threads.find((listed) => Threads.same(listed.ref, ref))))

    /**
     * Queues a notice about a thread, kept under its key in the journal as
     * it's about to be said, unless it was ever said before or `still` says
     * it no longer holds; noted as heard once it's said to the end. `kept` is
     * the entry it was kept under already and never heard, as when yapd
     * restarted while saying it, which it's said under again.
     */
    const notify = (
      ref: Threads.Ref,
      spoken: string,
      entry: Entry & { readonly key: string },
      still: Effect.Effect<boolean>,
      at: number,
      turns: number,
      id = `t3:${ref.machine}:${ref.id}`,
      kept?: number,
    ) => {
      let claimed: Option.Option<Option.Option<number>> | undefined = kept === undefined ? undefined : Option.some(Option.some(kept))
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

    /**
     * Says what a thread waits on him for: once, ever, until he's heard it,
     * under `kept`, the entry it was kept under already when he never did.
     */
    const asked = (ref: Threads.Ref, requestId: string, at: number, kept?: number) =>
      Effect.suspend(() => {
        if (wording.has(requestId)) return Effect.void
        wording.add(requestId)
        return ask(ref, requestId, at, kept).pipe(Effect.ensuring(Effect.sync(() => wording.delete(requestId))))
      })

    const ask = (ref: Threads.Ref, requestId: string, at: number, kept?: number) =>
      Effect.gen(function* () {
        const worded = yield* compose(ref, requestId, at)
        if (Option.isNone(worded)) return
        // What waits on him is there to say whenever yapd is on, even turned off and on while it was worded: off, it's said once it's on.
        const { on, turns } = yield* options.power
        if (!on) return
        if (worded.value._tag === "Ask") {
          // Never an approval, even one the thread shows as a question: it's there when he asks who needs him.
          if (worded.value.asking.asks._tag === "Approval") return yield* Effect.logInfo("Not announcing an approval shown as a question")
          // Asked as the one question open, for him to answer by voice.
          return yield* options.ask(kept === undefined ? worded.value.asking : { ...worded.value.asking, kept })
        }
        yield* notify(ref, worded.value.spoken, worded.value.entry, threads.waiting(ref, requestId), at, turns, undefined, kept)
      })

    /**
     * What a thread waited on him for that it no longer shows: dealt with,
     * unless a newer one only hides it, as T3 Code's summary of a thread
     * shows only the newest it waits on, when it still waits behind that.
     */
    const answered = (ref: Threads.Ref, requestId: string) =>
      Effect.gen(function* () {
        if (yield* threads.waiting(ref, requestId)) return yield* Effect.logInfo(`Still waiting on ${requestId}, behind what it asked since`)
        yield* options.settled(requestId)
      })

    /**
     * Once a run is over and its hook has had time to come, says it failed,
     * or hit a limit, or, when no hook told of a turn that went well, what it
     * said, as a hook's update would be, while it's still the thread's
     * `current` run. Nothing for a run he stopped.
     */
    const ran = (ref: Threads.Ref, runId: string, turns: number, at: number, current: Effect.Effect<boolean>) =>
      Effect.gen(function* () {
        yield* Effect.sleep(failing)
        const actions = threads.actions(ref.machine)
        if (Option.isNone(actions)) return
        const run = yield* actions.value.ran(ref.id, runId)
        if (Option.isNone(run)) return
        const { status, natives } = run.value
        const startedAt = Option.getOrElse(run.value.startedAt, () => at)
        if (!["failed", "completed", "waiting"].includes(status)) return
        if (status !== "failed") yield* Effect.sleep(finishing)
        // A Stop hook of its own, said or skipped: what it said, or why it wasn't, stands.
        if (hooked(yield* options.stopped(natives), run.value, startedAt)) return yield* Effect.logInfo("Left to its hook")
        const thread = yield* threads.find(ref)
        const shown = yield* listed(ref)
        if (Option.isNone(thread) || Option.isNone(shown)) return
        const { called, project } = shown.value
        if (status === "failed") return yield* failed(ref, run.value, thread.value, called, project, turns, at)
        // Started again since, what it said then is no longer its latest, as a hook's update isn't once the next prompt comes, even when
        // that was while what's read of it here was on its way.
        const latest = thread.value.latestRunId === null || thread.value.latestRunId === runId
        if (!latest || !(yield* current)) return yield* Effect.logInfo("Not saying a turn no hook told of, since it started again")
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
          run: { status, final: run.value.final, others: run.value.others, natives, previous: run.value.previous, startedAt },
          current,
        })
      }).pipe(Effect.catchAll((error) => Effect.logWarning("Could not read how a run went", error)))

    /**
     * Whether a limit of this provider other than the one under `limit`,
     * which resets at `resets` when that's known, was said and still holds:
     * until it resets, or, when nobody said when, for as long as the shortest
     * does, and only as this one's window, which can't reset later than that.
     * T3 Code may only know when it resets by the time another thread hits
     * it, which keys it apart; one that resets later is a window begun since.
     */
    const holding = (who: string, limit: string, resets: Option.Option<number>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const said = yield* journal.since(now - longest, { kinds: ["notice"], most: 1000 })
        return said.some(
          (entry) =>
            entry.key !== undefined &&
            entry.key !== limit &&
            entry.key.startsWith(key.limited(who, "")) &&
            Option.match(
              Option.filter(Option.map(decodeLimit(entry.detail), ({ resets }) => Date.parse(resets)), (reset) => !Number.isNaN(reset)),
              {
                onNone: () => now - entry.at < lasting && !Option.exists(resets, (reset) => reset - entry.at > lasting),
                onSome: (reset) => now < reset,
              },
            ),
        )
      })

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
          // Said for another thread, it isn't again till it resets, whether or not it was known when then.
          const reset = Option.filter(Option.map(resets, Date.parse), (reset) => !Number.isNaN(reset))
          const unsaid = Effect.zipWith(still, holding(who, limit, reset), (still, held) => still && !held)
          const entry = { ...base, said: spoken, key: limit, detail: { failure: kind, ...Option.match(resets, { onNone: () => ({}), onSome: (resets) => ({ resets }) }) } }
          return yield* notify(ref, spoken, entry, unsaid, at, turns, limit)
        }
        const spoken = lines.failed(called, reason(run.failure, thread), said)
        yield* notify(ref, spoken, { ...base, said: spoken, key: key.failed(ref.machine, run.id) }, still, at, turns)
      })

    /** Looks into what a change to a thread comes to, in the background, unless yapd is off. */
    const hear = (machine: string, change: T3Live.Change) =>
      Effect.gen(function* () {
        // Started again, or gone, a turn of it no hook told of that's still to be said isn't, as a hook's update isn't once the next
        // prompt comes, nor one still being looked into.
        if (change._tag === "Started" || change._tag === "Removed") {
          const ref = { machine, id: change.thread.id }
          generations.set(`${machine}:${ref.id}`, generation(ref) + 1)
          yield* options.overtaken(ref)
        }
        const news = verdict(change)
        if (Option.isNone(news)) return
        if (news.value._tag === "Settled") {
          const ref = { machine, id: news.value.thread.id }
          // Gone, or waiting on nothing now, it waits on nothing at all; otherwise it's read, in the background.
          if (change._tag === "Removed" || news.value.thread.pendingRuntimeRequest === null) return yield* options.settled(news.value.requestId)
          return yield* FiberSet.run(running, answered(ref, news.value.requestId).pipe(trouble))
        }
        // An approval is never brought up, however it comes.
        if (news.value._tag === "Asked" && news.value.kind !== "user_input") return yield* Effect.logInfo(`Not announcing an approval: ${news.value.kind}`)
        // Off, nothing is said later of what happened meanwhile; what still waits on him is said once it's on.
        const { on, turns } = yield* options.power
        if (!on) return
        const at = yield* Clock.currentTimeMillis
        const ref = { machine, id: news.value.thread.id }
        // The thread's run as it is now, which it no longer is once it starts again or goes.
        const since = generation(ref)
        const current = Effect.sync(() => generation(ref) === since)
        const looking = news.value._tag === "Asked" ? asked(ref, news.value.requestId, at) : ran(ref, news.value.runId, turns, at, current)
        yield* FiberSet.run(running, looking.pipe(trouble, Effect.annotateLogs({ thread: news.value.thread.title })))
      })

    return {
      /** Follows what happens to the threads, for as long as yapd runs. */
      follow: Stream.runForEach(threads.changes, ({ machine, change }) => hear(machine, change)),
      /**
       * The questions waiting on him that he hasn't heard: run once T3 Code has
       * caught up after a start, and each time yapd is turned on. One begun
       * and never heard to the end, as when yapd was turned off or restarted
       * while saying it, is said again, under the entry it was kept under.
       * Nothing while it's off.
       */
      reconcile: Effect.gen(function* () {
        const { on } = yield* options.power
        if (!on) return
        const now = yield* Clock.currentTimeMillis
        const said = new Map((yield* journal.since(now - pending, { kinds: ["notice"], most: 1000 })).flatMap((kept) => (kept.key === undefined ? [] : [[kept.key, kept] as const])))
        const desk = yield* threads.desk(Option.none(), [], 1000)
        for (const { ref, thread } of desk.threads) {
          const request = thread.pendingRuntimeRequest
          const created = request === null ? Number.NaN : Date.parse(request.createdAt)
          // Nor an approval, after a restart or once yapd is on.
          if (request === null || request.kind !== "user_input" || Number.isNaN(created) || now - created > pending) continue
          const before = said.get(key.asked(ref.machine, request.id))
          if (before?.heardAt !== undefined) continue
          yield* FiberSet.run(running, asked(ref, request.id, now, before?.id).pipe(trouble, Effect.annotateLogs({ thread: thread.title })))
        }
      }),
    }
  })
