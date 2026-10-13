import { Cause, Clock, type Duration, Effect, FiberSet, Option, Schedule, Schema, Stream } from "effect"
import type * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import { Condenser, english } from "./Condenser.ts"
import * as Hands from "./Hands.ts"
import type { Notice } from "./Inbox.ts"
import type { Entry, Journal } from "./Journal.ts"
import * as Payload from "./Payload.ts"
import { addressed, type Lines, Persona } from "./Persona.ts"
import * as Questions from "./Questions.ts"
import type * as T3Actions from "./T3Actions.ts"
import * as T3Live from "./T3Live.ts"
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
/** How far back work yapd started is looked for, for a first turn that ended while yapd couldn't hear it. */
const lately = 24 * 60 * 60_000
/** How often such a first turn that may still be to keep is looked into again, until what it tells is kept. */
const again = "1 minute"
/** How a first turn of that kind that couldn't be read is read again at once, as when T3 Code fails a moment: its run's key keeps it said once. */
const rereading = { times: 3, schedule: Schedule.exponential("2 seconds") }

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
  /**
   * Why it told of nothing, when it didn't: "quick", not said as a turn he
   * was likely watching, which a turn of work yapd sent never is; "dropped",
   * nothing of it said or kept, as a slight turn its hook couldn't tell by
   * id was the first of work yapd started, its thread not found in time or
   * what tells that not read, or one that couldn't be got ready. T3 Code's
   * word says a turn of work yapd sent in its place.
   */
  skipped?: "quick" | "dropped"
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
 * for it. Any other is still left to as if it were this one's. Never one
 * that told of nothing, skipped as quick or dropped, for a run a message of
 * yapd's started: that never told him what he asked for.
 */
export const hooked = (stops: ReadonlyArray<Stop>, run: Pick<T3Actions.Ran, "status" | "final" | "others" | "previous" | "userMessageId">, startedAt: number) =>
  hooking(stops, run, startedAt).length > 0

/** The Stops a run is left to, as `hooked` tells them, oldest first. */
export const hooking = (stops: ReadonlyArray<Stop>, run: Pick<T3Actions.Ran, "status" | "final" | "others" | "previous" | "userMessageId">, startedAt: number) => {
  const since = startedAt - leeway
  const theirs =
    run.status !== "failed" && run.final !== ""
      ? Option.none<Stop>()
      : Option.flatMap(run.previous, (previous) =>
          Option.filter(Option.fromNullable(stops.find((stop) => stop.at >= previous.startedAt - leeway)), (first) => first.at >= since && first.at <= previous.endedAt + late),
        )
  const asked = sent(run)
  return stops.filter((stop) => {
    if (stop.message.trim() === "" || stop.at < since || (asked && stop.skipped !== undefined)) return false
    const owner = whose(stop, run)
    return owner === "own" || (owner === "unknown" && !Option.exists(theirs, (taken) => taken === stop))
  })
}

/** Whether a message yapd sent started a run: what he asked for, by voice or by starting the work. */
export const sent = (run: Pick<T3Actions.Ran, "userMessageId">) => Option.exists(run.userMessageId, (id) => id.startsWith("yapd:"))

/** Whether a run was short enough that he was likely still looking at it, unless yapd sent what started it. */
export const quick = (run: Pick<T3Actions.Ran, "startedAt" | "userMessageId">, ended: number, shortest: number) =>
  Option.exists(run.startedAt, (started) => ended - started < shortest) && !sent(run)

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

/** A thread as what's said of it names it: with its machine, as "who needs me" has it, when it isn't on this one. */
export const named = (listed: Pick<Threads.Listed, "called" | "here" | "ref">) => (listed.here ? listed.called : `${listed.called} on ${listed.ref.machine}`)

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
 * it, `what`, which follows the thread's name: asked, needing "approve"
 * whatever it is, since a plain yes never allows one, and saying why it's
 * worth a thought when it's risky by the model's word or by all of what it
 * would run, or when that couldn't be read in full. It's never brought up
 * of yapd's own accord, only read back when he brings it up himself.
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
  // Said to be what can't be undone by all of what it would run, never what's cut short to be said, which can leave out the risky part, and
  // that first, as a tool's name is. It only words it: any approval needs "approve".
  const risky = risk === "high" || Brain.dangerous(request.whole === undefined ? request.what : `${request.whole}\n${request.what}`)
  // Not shown in full, what it would run could be anything, which is said too.
  const unread = request.whole === undefined
  const doing = /^wants to /i.test(what) ? what.replace(/^wants to /i, "") : undefined
  const about = doing === undefined ? `give ${called} your go-ahead` : `allow ${called} to ${doing}`
  const asked = risky
    ? `${capital(called)} ${what}, which can't be undone, so say 'approve' if you want it${sir}.`
    : unread
      ? `${capital(called)} ${what}, but I couldn't read all of what it would run, so say 'approve' if you want it${sir}.`
      : `${capital(called)} ${what}. Say 'approve' if you want it${sir}.`
  const rewordings = [`Shall I still ${about}${sir}? Only 'approve' will do.`, `Do you still want me to ${about}${sir}? Say 'approve' if you do.`]
  return {
    _tag: "Ask",
    asking: {
      ref,
      asks: { _tag: "Approval", requestId: request.id, decisions: request.decisions.map(({ decision }) => decision), inFull: false },
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
        const { project } = shown.value
        const called = named(shown.value)
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
  readonly run: Pick<T3Actions.Ran, "status" | "final" | "others" | "natives" | "previous" | "userMessageId"> & { readonly startedAt: number }
  readonly current: Effect.Effect<boolean>
  /** Whether a message yapd sent the thread started it, so it answers what he asked: said however he muted the thread. */
  readonly answering?: boolean
}

/**
 * Says what T3 Code's threads need the user for, whenever yapd is on, and
 * what failed and what finished with no hook to tell of it, unless yapd was
 * turned off since, as `tell` queues it. `stopped` is the Stop hooks
 * sessions had, oldest first, but those a turn said in their hook's place
 * took as its run's, once what comes of each is known, so one that told of
 * nothing is known for it, `finished` says a finished turn as a hook's update, and
 * `mention` makes "it" the thread a notice is about as it starts being said.
 */
export const make = (options: {
  readonly threads: Threads.Threads["Type"]
  readonly journal: Journal["Type"]
  readonly tell: (notice: Notice, since?: number) => Effect.Effect<void>
  readonly power: Effect.Effect<{ readonly on: boolean; readonly turns: number }>
  readonly stopped: (sessions: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Stop>>
  /**
   * A failed run is left to the Stops that told of it, but what they told of
   * may be kept quiet, as his muting the thread does: then `failure` says it
   * after all, since a failure needs him. Without it, it's left to them.
   */
  readonly unheard?: (stops: ReadonlyArray<Stop>, failure: Effect.Effect<void>) => Effect.Effect<void>
  readonly finished: (input: Finished) => Effect.Effect<void>
  /** A thread started again, or went: what it said last that no hook told of, if that's still to be said, isn't. */
  readonly overtaken: (ref: Threads.Ref) => Effect.Effect<void>
  readonly mention: (ref: Threads.Ref, said: string) => Effect.Effect<void>
  /** Asks what a thread waits on him for, as the one question open. */
  readonly ask: (asking: Assistant.Asking) => Effect.Effect<void>
  /** What a thread waited on him for was dealt with, so it isn't asked. */
  readonly settled: (requestId: string) => Effect.Effect<void>
  /** A machine's T3 Code caught up again: what waits on him there that was put by while its threads couldn't be seen is asked. */
  readonly returned: (machine: string) => Effect.Effect<void>
  /**
   * The work yapd started on a machine since then, by its thread, when, and
   * the id of the message it started with. Without it, a first turn that
   * ended while yapd couldn't hear it is never looked for.
   */
  readonly started?: (
    machine: string,
    since: number,
  ) => Effect.Effect<ReadonlyArray<{ readonly at: number; readonly thread: string; readonly messageId: string | null }>>
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

    /**
     * Whether something was kept since `since` of a thread's turns on its
     * machine: an update under T3 Code's id for the thread, or under the
     * session of one of its agent's conversations, `natives`, as their hooks
     * report them, which is where a hook's is kept when it couldn't be tied
     * to the thread, as rig's often can't.
     */
    const keptSince = (ref: Threads.Ref, natives: ReadonlyArray<string>, since: number) =>
      Effect.map(
        Effect.forEach([ref.id, ...natives.flatMap((native) => Payload.Agent.literals.map((agent) => Payload.key(agent, native)))], (thread) =>
          journal.byThread(ref.machine, thread, 1, ["update"]),
        ),
        (found) => found.flat().some(({ at }) => at >= since),
      )

    /**
     * Whether a run is the first turn of work yapd started lately, begun with
     * the message the ledger's `start` row has, and what it told was kept since.
     */
    const firstKept = (ref: Threads.Ref, run: Pick<T3Actions.Ran, "userMessageId" | "natives">) =>
      Effect.gen(function* () {
        const { started } = options
        if (started === undefined || !sent(run)) return false
        const starts = yield* started(ref.machine, (yield* Clock.currentTimeMillis) - lately)
        const start = starts.find(({ thread, messageId }) => thread === ref.id && messageId !== null && Option.contains(run.userMessageId, messageId))
        return start !== undefined && (yield* keptSince(ref, run.natives, start.at))
      })

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
     * restarted while saying it, which it's said under again. While yapd is
     * off, or was turned off or on since `turns`, it's kept under its key
     * unheard and nothing is said: what came in while it was off is told
     * only in a catch-up, and its key keeps it from being said later. So
     * is one dropped unsaid as yapd is turned off.
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
      /** Kept unheard, unless it was kept already or no longer holds. */
      const keep = Effect.suspend(() =>
        claimed !== undefined
          ? Effect.void
          : Effect.flatMap(still, (holds) =>
              holds
                ? Effect.flatMap(journal.claim(entry), (kept) =>
                    Effect.sync(() => {
                      claimed = kept
                    }),
                  )
                : Effect.void,
            ),
      )
      return Effect.flatMap(options.power, (power) => {
        if (!power.on || power.turns !== turns) {
          return Effect.zipRight(keep, Effect.logInfo(`Kept unheard, since yapd is off: ${spoken}`))
        }
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
            // Dropped before it was ever said, as when yapd is turned off, it's kept unheard for catching up.
            gone: Effect.flatMap(options.power, (now) => (now.on && now.turns === turns ? Effect.void : keep)),
            telling: Effect.sync(() => (claimed === undefined ? [] : Option.toArray(Option.flatten(claimed)))),
          },
          turns,
        )
      })
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
     * `current` run. Nothing for a run he stopped. Should something of it
     * still be to keep, or it couldn't be read, the first turn of work yapd
     * started in the thread is kept looking into.
     */
    const ran = (ref: Threads.Ref, runId: string, turns: number, at: number, current: Effect.Effect<boolean>) =>
      looking(ref, runId, turns, at, current).pipe(
        Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not read how a run went", error), true)),
        Effect.flatMap((left) => (left ? opening(ref) : Effect.void)),
      )

    /**
     * What `ran` does, failing when the run can't be read, and telling
     * whether something of it may still be to keep: what it said, handed on
     * to be said, or a run that couldn't be seen. Not one left to its hook,
     * as the first turn of work yapd started whose hook's update was kept is,
     * failed, stopped, started again since, or that said nothing.
     */
    const looking = (ref: Threads.Ref, runId: string, turns: number, at: number, current: Effect.Effect<boolean>) =>
      Effect.gen(function* () {
        yield* Effect.sleep(failing)
        const actions = threads.actions(ref.machine)
        if (Option.isNone(actions)) return true
        const run = yield* actions.value.ran(ref.id, runId)
        if (Option.isNone(run)) return true
        const { status, natives } = run.value
        const startedAt = Option.getOrElse(run.value.startedAt, () => at)
        if (!["failed", "completed", "waiting"].includes(status)) return false
        if (status !== "failed") yield* Effect.sleep(finishing)
        /** That it failed, said of the thread as it's shown now. */
        const failure = Effect.gen(function* () {
          const thread = yield* threads.find(ref)
          const shown = yield* listed(ref)
          if (Option.isNone(thread) || Option.isNone(shown)) return
          yield* failed(ref, run.value, thread.value, named(shown.value), shown.value.project, turns, at)
        })
        // A Stop hook of its own, said or skipped: what it said, or why it wasn't, stands. But what it told of a failure, kept quiet as he
        // muted the thread, he never hears, so the failure is said after all.
        const hooks = hooking(yield* options.stopped(natives), run.value, startedAt)
        if (hooks.length > 0) {
          if (status === "failed" && options.unheard !== undefined) {
            yield* options.unheard(hooks, failure.pipe(Effect.catchAll((error) => Effect.logWarning("Could not read how a run went", error))))
          }
          return yield* Effect.as(Effect.logInfo("Left to its hook"), false)
        }
        if (status === "failed") return yield* Effect.as(failure, false)
        // Left to its hook too, the first turn of work yapd started whose hook's update was kept, though its Stop came before yapd
        // restarted, or so long ago it's forgotten.
        if (yield* firstKept(ref, run.value)) return yield* Effect.as(Effect.logInfo("Left to its hook, whose update was kept"), false)
        const thread = yield* threads.find(ref)
        // Archived, he's done with it: nothing of it is said, or ever to keep.
        if (Option.exists(thread, ({ archivedAt }) => archivedAt !== null)) return false
        const shown = yield* listed(ref)
        if (Option.isNone(thread) || Option.isNone(shown)) return true
        // Outside his projects, it isn't named by a project at all.
        const project = shown.value.scratch ? "" : shown.value.project
        // Started again since, what it said then is no longer its latest, as a hook's update isn't once the next prompt comes, even when
        // that was while what's read of it here was on its way.
        const latest = thread.value.latestRunId === null || thread.value.latestRunId === runId
        if (!latest || !(yield* current)) return yield* Effect.as(Effect.logInfo("Not saying a turn no hook told of, since it started again"), false)
        if (quick(run.value, at, options.shortest)) return yield* Effect.as(Effect.logInfo("Skipped quick turn, with no hook"), false)
        if (run.value.said === "") return false
        yield* options.finished({
          about: ref,
          project,
          cwd: Option.getOrElse(shown.value.directory, () => ""),
          turn: { prompt: run.value.prompt, message: run.value.said },
          at,
          key: key.done(ref.machine, runId),
          turns,
          run: { status, final: run.value.final, others: run.value.others, natives, previous: run.value.previous, userMessageId: run.value.userMessageId, startedAt },
          current,
          answering: sent(run.value),
        })
        return true
      })

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
        // A new thread of work yapd started has its first turn kept looking into from the start, even one that ended while T3 Code's word
        // couldn't be heard, which then tells only that the thread is new.
        if (change._tag === "Created") yield* FiberSet.run(running, opening({ machine, id: change.thread.id }).pipe(trouble))
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
        // Off, what still waits on him is said once it's on, but how a run went is still looked into, to be kept unheard for catching up.
        const { on, turns } = yield* options.power
        if (!on && news.value._tag === "Asked") return
        const at = yield* Clock.currentTimeMillis
        const ref = { machine, id: news.value.thread.id }
        // The thread's run as it is now, which it no longer is once it starts again or goes.
        const since = generation(ref)
        const current = Effect.sync(() => generation(ref) === since)
        const looking = news.value._tag === "Asked" ? asked(ref, news.value.requestId, at) : ran(ref, news.value.runId, turns, at, current)
        yield* FiberSet.run(running, looking.pipe(trouble, Effect.annotateLogs({ thread: news.value.thread.title })))
      })

    /**
     * The questions waiting on him that he hasn't heard, on the machines `on`
     * picks, by what he calls them. One begun and never heard to the end, as
     * when yapd was turned off or restarted while saying it, is said again,
     * under the entry it was kept under. Nothing while it's off.
     */
    const reconciling = (on: (machine: string) => boolean) =>
      Effect.gen(function* () {
        if (!(yield* options.power).on) return
        const now = yield* Clock.currentTimeMillis
        const said = new Map((yield* journal.since(now - pending, { kinds: ["notice"], most: 1000 })).flatMap((kept) => (kept.key === undefined ? [] : [[kept.key, kept] as const])))
        const desk = yield* threads.desk(Option.none(), [], 1000)
        for (const { ref, thread } of desk.threads) {
          if (!on(ref.machine)) continue
          const request = thread.pendingRuntimeRequest
          const created = request === null ? Number.NaN : Date.parse(request.createdAt)
          // Nor an approval, after a restart or once yapd is on.
          if (request === null || request.kind !== "user_input" || Number.isNaN(created) || now - created > pending) continue
          const before = said.get(key.asked(ref.machine, request.id))
          if (before?.heardAt !== undefined) continue
          yield* FiberSet.run(running, asked(ref, request.id, now, before?.id).pipe(trouble, Effect.annotateLogs({ thread: thread.title })))
        }
      })

    /** The machines whose T3 Code caught up since yapd started, with every first turn of work yapd started there that ended unheard dealt with. */
    const caughtUp = new Set<string>()
    /** The machines those turns are being looked into on now, so catching up again meanwhile doesn't look twice. */
    const recovering = new Set<string>()
    /** The threads, by machine, whose first turn of work yapd started is being kept looking into, so it's looked into once at a time. */
    const keptOn = new Set<string>()

    /** Work yapd started on a machine, as the ledger's `start` row has it. */
    type Start = { readonly at: number; readonly thread: string; readonly messageId: string | null }

    /**
     * Whether the first turn of work yapd started that the ledger's `start`
     * row is of may still be to keep, looking into it as a turn no hook told
     * of when it is: once it's over, while nothing of its turns was kept
     * since it started, as `keptSince` tells, and only the turn its message
     * began. Still at it, it may be too: it's heard of as it ends, but that
     * can come to nothing, as when its hook drops it and T3 Code fails a
     * moment as it's read, and its run's key keeps it said once. Not once
     * its thread is gone or archived; but it may be while the machine's
     * threads can't be seen. Failing when it can't be read.
     */
    const unkept = (
      machine: string,
      actions: T3Actions.Actions,
      start: Start,
      turns: number,
      now: number,
    ) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* threads.unseen(machine))) return true
        const ref = { machine, id: start.thread }
        const thread = yield* threads.find(ref)
        if (Option.isNone(thread) || start.messageId === null || thread.value.archivedAt !== null) return false
        const { latestRunId, latestRunCompletedAt } = thread.value
        const busy = T3Live.busy(thread.value)
        const over = latestRunCompletedAt === null ? Number.NaN : Date.parse(latestRunCompletedAt)
        if (latestRunId === null || (!busy && !(over > start.at))) return false
        const run = yield* actions.ran(ref.id, latestRunId)
        if (Option.isNone(run) || !Option.contains(run.value.userMessageId, start.messageId)) return false
        if (yield* keptSince(ref, run.value.natives, start.at)) return false
        // Looked into once it's over, should what's heard of it as it ends come to nothing.
        if (busy) return true
        yield* Effect.logInfo("Looking into the first turn of work I started, which ended while I couldn't hear it").pipe(Effect.annotateLogs({ thread: thread.value.title }))
        const since = generation(ref)
        const current = Effect.sync(() => generation(ref) === since)
        return yield* looking(ref, latestRunId, turns, now, current).pipe(Effect.annotateLogs({ thread: thread.value.title }))
      })

    /**
     * Looks into the first turns of the work yapd started that `starts` are
     * of while each may still be to keep, as `unkept` tells, again every so
     * often, until what each tells is kept in the journal or there's nothing
     * of it to keep: read again at once a few times when it can't be. Not
     * one already being looked into so; and each is said once, under its
     * run's key, however often it's looked into.
     */
    const keeping = (machine: string, actions: T3Actions.Actions, starts: ReadonlyArray<Start>) =>
      Effect.suspend(() => {
        const name = (start: Start) => `${machine}:${start.thread}`
        const mine = starts.filter((start) => !keptOn.has(name(start)))
        /** The threads this still holds, and no other may look into meanwhile. */
        const held = new Set(mine.map(name))
        for (const thread of held) keptOn.add(thread)
        /** Lets go of those it holds that aren't of `left`, each once, so it never lets go of one another has taken since. */
        const release = (left: ReadonlyArray<Start>) => {
          const still = new Set(left.map(name))
          for (const thread of held) {
            if (still.has(thread)) continue
            held.delete(thread)
            keptOn.delete(thread)
          }
        }
        /** Those of `starts` that may still be to keep, letting go of the rest. */
        const look = (starts: ReadonlyArray<Start>) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const { turns } = yield* options.power
            const left = yield* Effect.forEach(
              starts,
              (start) =>
                now - start.at > lately
                  ? Effect.succeed(false)
                  : unkept(machine, actions, start, turns, now).pipe(
                      Effect.retry(rereading),
                      Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not look into the first turn of work I started", error), true)),
                    ),
              { concurrency: "unbounded" },
            )
            const kept = starts.filter((_, index) => left[index] === true)
            release(kept)
            return kept
          })
        return Effect.gen(function* () {
          let left = yield* look(mine)
          while (left.length > 0) {
            yield* Effect.sleep(again)
            left = yield* look(left)
          }
        }).pipe(Effect.ensuring(Effect.sync(() => release([]))))
      })

    /**
     * A thread was heard of as new, or a turn of it as it ended, which may
     * still be to keep or couldn't be read: when the thread is of work yapd
     * started lately, its first turn is kept looking into a while later, as
     * one that ended while yapd restarted is, since what's handed on to be
     * said can come to nothing, and T3 Code can fail a moment as it's read.
     */
    const opening = (ref: Threads.Ref) =>
      Effect.gen(function* () {
        const actions = threads.actions(ref.machine)
        const { started } = options
        if (started === undefined || Option.isNone(actions)) return
        const starts = (yield* started(ref.machine, (yield* Clock.currentTimeMillis) - lately)).filter(({ thread }) => thread === ref.id)
        if (starts.length === 0) return
        yield* Effect.sleep(again)
        yield* keeping(ref.machine, actions.value, starts)
      })

    /**
     * The first turns of work yapd started on a machine lately that ended
     * while yapd couldn't hear they did, as while it restarted: T3 Code's
     * word came before its threads were followed, and its hook found nobody.
     * Each is looked into as a turn no hook told of, whether yapd is on or
     * not, as off keeps what it would say, and kept looking into. Looked for
     * the first time the machine's T3 Code catches up, in the background,
     * and the next time it does should that stop short.
     */
    const opened = (machine: string) =>
      Effect.suspend(() => {
        const actions = threads.actions(machine)
        const { started } = options
        if (started === undefined || Option.isNone(actions) || caughtUp.has(machine) || recovering.has(machine)) return Effect.void
        recovering.add(machine)
        const recovered = Effect.gen(function* () {
          yield* keeping(machine, actions.value, yield* started(machine, (yield* Clock.currentTimeMillis) - lately))
          caughtUp.add(machine)
        }).pipe(Effect.ensuring(Effect.sync(() => recovering.delete(machine))), trouble)
        return Effect.asVoid(FiberSet.run(running, recovered))
      })

    return {
      /** Follows what happens to the threads on every machine yapd follows, for as long as yapd runs. */
      follow: Stream.runForEach(threads.changes, ({ machine, change }) => hear(machine, change)),
      /** What waits on him on every machine whose threads can be seen, each time yapd is turned on. */
      reconcile: reconciling(() => true),
      /**
       * What waits on him on one machine, each time its T3 Code has caught up,
       * as `lookBack` has it, once where it keeps work outside his projects is
       * known, so none of it is said as "No project": what was put by while it
       * couldn't be seen, then what he never heard. And, on or off, the first
       * turns of work yapd started there that ended while it couldn't hear them.
       */
      reconcileOn: (machine: string) =>
        Effect.zipRight(threads.warm(machine), Effect.zipRight(Effect.zipRight(options.returned(machine), opened(machine)), reconciling((on) => on === machine))),
    }
  })

/**
 * What waits on him on `machine`, looked for each time its T3 Code has caught
 * up, which `view` tells, asked `every` so often, for as long as yapd runs:
 * once it starts, and again whenever it's back after going down, like rig out
 * of reach a while or T3 Code restarted there, since what was put by while it
 * couldn't be seen, and what it asked meanwhile, still waits. Each machine
 * looks on its own, so one that's down holds up none of the rest.
 */
export const lookBack = (
  notices: { readonly reconcileOn: (machine: string) => Effect.Effect<void> },
  view: Effect.Effect<Option.Option<unknown>>,
  machine: string,
  every: Duration.DurationInput = "1 second",
) =>
  Effect.gen(function* () {
    let seen = false
    while (true) {
      const now = Option.isSome(yield* view)
      if (now && !seen) yield* notices.reconcileOn(machine)
      seen = now
      yield* Effect.sleep(every)
    }
  })
