import { Clock, Context, Duration, Effect, Either, Option, Schedule, Schema } from "effect"
import * as Brain from "./Brain.ts"
import * as Launcher from "./Launcher.ts"
import * as Ledger from "./Ledger.ts"
import { addressed, type Lines, unaddressed } from "./Persona.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3CodeLauncher from "./T3CodeLauncher.ts"
import type * as T3CodeServer from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import type * as Threads from "./Threads.ts"

// What yapd does to the user's threads, by its own hand. Each step it commits
// to is written in the ledger first, then sent once, under ids that make T3
// Code do it once however often it's sent. What came of it is told as T3
// Code tells it: done, steered into the turn under way or queued behind it,
// turned down, never sent, or unknown, which is looked for once in the thread.
// Nothing is ever sent again without the user's yes, and then only once and
// under the same ids. A restart only looks. A message to a busy thread goes
// into T3 Code's own queue or the turn under way, never a queue of yapd's;
// one in place of the turn under way goes once yapd has stopped it, as a step
// of its own, never by T3 Code's own restart, which it turns down in too many
// ordinary states, like a turn getting going, waiting on him, or busy only in
// the background.

/** Something to do to a thread. */
export type Act =
  | { readonly _tag: "Message"; readonly to: Threads.Ref; readonly text: string; readonly how: T3Actions.When }
  | { readonly _tag: "Stop"; readonly to: Threads.Ref }
  /** Takes back what was just done: a stop, by letting the thread carry on, or a message, by withdrawing it. */
  | { readonly _tag: "Undo"; readonly to: Option.Option<Threads.Ref>; readonly carry: boolean }
  /** Allows, or turns down, what the thread waits on him for: only `requestId`, the request he heard. Never for always. */
  | { readonly _tag: "Decide"; readonly to: Threads.Ref; readonly requestId: string; readonly decision: Decision }
  /**
   * Answers the thread's question, only `requestId`, the one he heard, by its
   * questions' ids, with the option he picked, said back, when he picked one;
   * `as` "message" when what he said was a message for the thread, which went
   * as the answer, since the thread was waiting on it.
   */
  | {
      readonly _tag: "Reply"
      readonly to: Threads.Ref
      readonly requestId: string
      readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>>
      readonly said: Option.Option<string>
      readonly as?: "answer" | "message"
    }

/** What an approval is answered with by voice: allowed, for the rest of the thread's work when he says so, or turned down. */
export type Decision = "accept" | "acceptForSession" | "decline"

/**
 * For a message in place of the turn under way, done as a stop, as a step of
 * its own, then the message at once, as the next: whether the stop went, so
 * this is what came of the message, or that it was never told; or didn't, so
 * the message never went; or found the turn "ended" just before, with nothing
 * to stop, so this is what came of the message, gone in as it would anyway.
 */
interface Stopping {
  readonly stopped?: boolean | "ended"
}

/** What came of it. */
export type Outcome =
  | ({
      readonly _tag: "Done"
      readonly how: Ledger.How
      readonly to: Threads.Ref
      /**
       * Wanted at once, it went into T3 Code's queue instead, since the turn
       * under way is waiting: on him, or finishing off. Or it waits in a queue
       * on hold: one a stop held before it went, which T3 Code holds whatever
       * goes in behind, or, sent once more, one a stop has put on hold since.
       */
      readonly waiting?: Waiting
      /** Sent once more, T3 Code had it from the first time, and the turn it started or went into has ended since: so nothing's at work on it now. */
      readonly ended?: Ended
    } & Stopping)
  /** T3 Code, or yapd looking first, said no: it's never sent again under these ids. */
  | ({ readonly _tag: "Refused"; readonly reason: string } & Stopping)
  /** It never left yapd. With `again`, it may go once more on his yes, under the same ids. */
  | ({ readonly _tag: "NotSent"; readonly reason: string; readonly again: Option.Option<string> } & Stopping)
  /** It left yapd, and wasn't found in the thread when looked for. With `again`, it may go once more on his yes, under the same ids. */
  | ({ readonly _tag: "Unknown"; readonly reason: string; readonly again: Option.Option<string> } & Stopping)
  /** The same words went to the same thread lately: asked about first, never dropped. */
  | { readonly _tag: "Twin"; readonly row: Ledger.Row }
  /** The message to withdraw was read already, so it can only be told to ignore it. */
  | { readonly _tag: "Read"; readonly row: Ledger.Row }
  /** What it answers no longer waits on him, as when it was dealt with in T3 Code meanwhile: nothing's done, and nothing's said. */
  | { readonly _tag: "Moot" }

/** What came of a step that was written down: gone, turned down, never sent or unknown. */
type Went = Exclude<Outcome, { readonly _tag: "Twin" | "Read" | "Moot" }>

/** What a message in the queue waits on: the turn under way, for something it asked him, or its last bits of work; or the queue, on hold. */
export type Waiting = "asked" | "finishing" | "held"

/**
 * How the turn a message started or went into has ended: done with, cut
 * short, by a stop or something going wrong, rolled back in T3 Code since, or
 * just ended, when which run that turn was, and so how it ended, can't be told.
 */
export type Ended = "finished" | "cut" | "rolled" | "ended"

/** What a restart's look found never said what came of it. */
export interface Reconciled {
  /** Messages that didn't get there, each to be offered once to go again. */
  readonly undelivered: ReadonlyArray<Ledger.Row>
  /**
   * Steps it couldn't confirm, like a stop, new work, or a message too long
   * ago to send again or that it couldn't look for, new work that didn't
   * start, as "failed", and a stop or a queue let go of that went when what
   * was to follow never did, each with why, to be said once, and never done
   * again.
   */
  readonly unconfirmed: ReadonlyArray<Ledger.Row>
  /**
   * New work T3 Code was still getting ready, waited for on its own, as long
   * after it was asked for as a launch would be, so nothing above waits
   * behind it: then what of it didn't start or still can't be confirmed, as
   * in `unconfirmed`, to be said once.
   */
  readonly readying: Effect.Effect<ReadonlyArray<Ledger.Row>>
}

/** Which step of which request something is. */
export interface Step {
  readonly utterance: string
  readonly step: number
}

/** What yapd does to threads, each step once. */
export class Hands extends Context.Tag("yapd/Hands")<
  Hands,
  {
    /**
     * Does it, once. `twice` when he said yes to sending the same words
     * again, which isn't asked about a second time. `wanted` is whether each
     * step of it may still be begun, like telling a turn it stopped: never
     * once yapd was turned off since it was said, however long a look at the
     * thread before it took (I8).
     */
    readonly run: (
      step: Step,
      act: Act,
      options?: {
        readonly twice?: boolean
        readonly wanted?: Effect.Effect<boolean>
        /**
         * For a message that answers what a thread said at this time, in ms:
         * held back once the thread was given something else since, other
         * than by yapd, like a message he typed in T3 Code or a turn that
         * started after it.
         */
        readonly since?: number
      },
    ) => Effect.Effect<Outcome>
    /**
     * His yes to sending it again: the same step once more, under the same
     * ids, and never after that (I2). At another time than it first went,
     * `how`, only if it never left yapd: one that may have got there can only
     * go as it first went, so it's left, and he's told why. One for now to a
     * turn that's waiting by then goes behind it, as T3 Code takes it.
     */
    readonly again: (commandId: string, options?: { readonly how?: T3Actions.When }) => Effect.Effect<Outcome>
    /**
     * He didn't take up sending it again: it's never offered again on its own,
     * but it stays as it was, so the same words said again find it, and are
     * offered again under its ids rather than sent under new ones.
     */
    readonly leave: (commandId: string, reason: string) => Effect.Effect<void>
    /**
     * At startup: looks at what never said what came of it, and never sends
     * anything (I6). Gives back the messages found not to have got there
     * lately, to offer, and whatever else it couldn't confirm, to say so,
     * with new work T3 Code is still getting ready to wait for on its own.
     */
    readonly reconcile: Effect.Effect<Reconciled>
    /**
     * As `reconcile`, for only what was done on the machines `on` picks, by
     * what the user calls them: each machine's is looked at once its own T3
     * Code has caught up, so rig being down neither holds up this machine's
     * nor has what went to rig taken for lost.
     */
    readonly reconcileOn: (on: (machine: string) => boolean) => Effect.Effect<Reconciled>
    /** A message a restart found didn't get there, while it's still to be offered: nothing came of it since, and it's recent enough to. */
    readonly still: (commandId: string) => Effect.Effect<Option.Option<Ledger.Row>>
    /**
     * Whether a message he'd send a thread would be held back as it could give
     * a secret away: it waits on one, or on a question he'd type one into and
     * this looks like one. Asked before his words are kept or logged anywhere,
     * so that, held back, they never are.
     */
    readonly keeps: (to: Threads.Ref, text: string) => Effect.Effect<boolean>
  }
>() {}

/** The same words to the same thread within this long, with no new turn since, are asked about before they go again. */
const twins = 10 * 60_000
/** How long after a message "scratch that" takes it back. */
const scratch = "2 minutes"
/** How long after a stop "carry on" lets it carry on. */
const resumable = "10 minutes"
/** How long ago a message a restart found didn't get there can be offered to go again. Older than that, it's only said. */
const recent = 15 * 60_000
/** Why a step a restart looked for can't be confirmed, when the thread doesn't show it. */
export const unconfirmable = "I couldn't tell whether it went through before I restarted."
/** Why new work a restart looked for can't be confirmed, when T3 Code is still getting it ready as long after it was asked for as a launch waits. */
export const gettingReady = "T3 Code is still getting it ready."
/** How new work is getting on while T3 Code is still getting it ready: its thread made, with the work not in it yet, or its workspace being prepared. */
const readies: ReadonlyArray<ReturnType<typeof T3CodeLauncher.progress>> = ["empty", "preparing"]
/** Why a message that may not have got there isn't offered to go again. */
export const tooLong = "It's too long ago to send it again now."
/** Why a message a restart didn't find where it went isn't offered to go again: yapd's database couldn't be written to keep track of it. */
export const unnoted = "I couldn't note it down, so I can't offer to send it again."
/** What a stop is noted with once it's been let carry on, so it's never let carry on twice. */
const carried = "Carried on since."
/** Why what was to follow a step that went, like telling a turn yapd stopped what to do instead, never did: yapd restarted between the two. */
export const unfollowed = "I restarted before I could do what came next."
/** How long ago a step that went can have been for a restart to say what was to follow it never did. */
const followed = 24 * 60 * 60_000
/** Why "carry on" does nothing to a thread let carry on already. */
const carriedOn = "It's already carried on since I stopped it."
/** Why "carry on" does nothing to a thread going again by his hand. */
const backAtWork = "It's already back at work."
/** Why the same words aren't sent again once they've been sent once more already and still can't be confirmed. */
const thirdTime = "I couldn't confirm either of the last two got there, so I won't risk sending it a third time."
/** When a message goes in, as it's said. */
const timing: Readonly<Record<T3Actions.When, string>> = { now: "at once", after: "once the turn under way is done", restart: "in place of the turn under way" }
/** How the reason a message that may have got there can't go again at another time starts. */
const mayHave = "It may have got there already"
/** Why a message that may have got there can't go again at another time than it first went. */
const unchanged = (how: T3Actions.When) => `${mayHave}, so it can only go again as it first went, ${timing[how]}.`
/** Why a message sent once more won't be read: it was taken out of the queue it waited in since it first went. */
const takenOut = "It was taken out of the queue since, so it won't run."
/** Why a message sent once more may not be read: T3 Code had it from the first time, and it's gone from the thread. */
const notThere = "It isn't in the thread now, so it may have been taken out of the queue."
/** How the reason a message sent once more may not be read starts, when T3 Code has it but the thread couldn't be read to look for it. */
const unchecked = "I couldn't check it's still in the thread"
/** What a stopped thread is told when it's let carry on. */
export const carryOn = "Please carry on where you left off."
/** What a thread that read a message already is told when it's taken back. */
export const ignore = (text: string) => `Please ignore my last message ("${text.trim()}") and carry on as you were.`
/** Why a message answering what a thread said wasn't sent: it was given something else since. */
export const given = "It's been given something else since, so I held that back."
/** Why an approval or an answer wasn't sent: T3 Code says it was dealt with just before. */
const answeredElsewhere = "It was answered in T3 Code just before."
/** Why a secret isn't given by voice. */
const secretive = "It's waiting on a secret, which I never give by voice: it needs T3 Code."
/** Why a message isn't sent to a thread waiting on a secret, which it could be in other words. */
const withheld = "It's waiting on a secret, so nothing goes to it by voice until that's given in T3 Code."
/** Why a message isn't sent to a thread waiting on a question that couldn't be read, which could be for a secret. */
const unread = "It's waiting on you for something I couldn't read, so I held that back in case it's a secret."
/**
 * Why what he said isn't sent as an answer in his own words, or to a thread
 * waiting on a question he'd type an answer to: it looks like a secret, like
 * a code or a key, whatever the question said it was for.
 */
const revealed = "That sounds like a secret, and I never give one by voice, so it needs T3 Code."
/** Whether what he said wasn't sent since it could give a secret away, so his words aren't kept anywhere either. */
export const guarded = (outcome: Outcome) => "reason" in outcome && [secretive, withheld, unread, revealed].includes(outcome.reason)
/** Why an approval or an answer isn't sent when what the thread waits on isn't what it answers. */
const mismatched = "It isn't waiting on that kind of answer, so it needs T3 Code."
/** Why an answer isn't sent when T3 Code takes it as a message, which needs every part it needs. */
const incomplete = "It needs an answer to every part, so it needs T3 Code."
/** Why another answer to the same request isn't sent while an earlier, different one may have got there. */
const answeredBefore = "Your earlier answer may already have got there, so this one needs T3 Code."
/** Why another answer to the same request isn't sent once an earlier, different one went. */
const answeredAlready = "I sent it your earlier answer already, so this one needs T3 Code."
/** How far back an earlier answer to the same request is looked for. */
const answering = 24 * 60 * 60_000
/** Why an answer that never left yapd was put aside: he answered differently since, which goes in its place. */
const replaced = "He answered it differently since."
/** Why a step never went: what it was to send couldn't be read back. */
const unreadable = "I couldn't read back what to send."
/** Why the same answer isn't sent again once an earlier one was given up on without knowing whether it got there. */
const unconfirmedAnswer = "I couldn't confirm your earlier answer got there, so I won't risk sending it again: it needs T3 Code."

/**
 * Whether an answer that was given up on may still have got there: sent
 * once more already and still not found, or left unconfirmed by a restart.
 * Only one that never left yapd, put aside for a different one or never
 * readable to send, was given up on safely.
 */
const unsettled = (row: Pick<Ledger.Row, "state" | "reason">) => row.state === "abandoned" && ![replaced, unreadable].includes(row.reason ?? "")

/**
 * The commands kept in the ledger, read back to send again. A stop to tell a
 * turn something in its place, and letting go of a queue to ask it to carry
 * on, keep what it's to be told next, which T3 Code isn't sent, so a restart
 * between the two can say it never was.
 */
const Body = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Send"), text: Schema.String, messageId: Schema.String, how: Schema.Literal("now", "after", "restart") }),
  Schema.Struct({ _tag: Schema.Literal("Stop"), then: Schema.optionalWith(Schema.String, { exact: true }) }),
  Schema.Struct({ _tag: Schema.Literal("Resume"), then: Schema.optionalWith(Schema.String, { exact: true }) }),
  Schema.Struct({ _tag: Schema.Literal("Cancel"), runId: Schema.String, messageId: Schema.optionalWith(Schema.String, { exact: true }) }),
  Schema.Struct({ _tag: Schema.Literal("Decide"), requestId: Schema.String, decision: Schema.Literal("accept", "acceptForSession", "decline") }),
  Schema.Struct({
    _tag: Schema.Literal("Answer"),
    requestId: Schema.String,
    answers: Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Array(Schema.String)) }),
  }),
)
const command = Schema.decodeUnknownOption(Body)

/** Answers to a request's questions in an order that doesn't depend on how they were put together. */
const ordered = (answers: Readonly<Record<string, string | ReadonlyArray<string>>>) =>
  JSON.stringify(Object.keys(answers).toSorted().map((key) => [key, answers[key]]))

/** Whether what's in the ledger answers a request as this does: the same decision, or the same answers. */
const alike = (body: unknown, act: Extract<Act, { readonly _tag: "Decide" | "Reply" }>) =>
  Option.exists(command(body), (sent) =>
    act._tag === "Decide"
      ? sent._tag === "Decide" && sent.decision === act.decision
      : sent._tag === "Answer" && ordered(sent.answers) === ordered(act.answers),
  )

/** New work in the ledger as it was asked for. */
const request = Schema.decodeUnknownOption(Launcher.Request)

/** A message in the ledger as it went, or was to: its words, and when it was to go in. */
export const went = (row: Pick<Ledger.Row, "body">) =>
  Option.flatMap(command(row.body), (sent) => (sent._tag === "Send" ? Option.some({ text: sent.text, how: sent.how }) : Option.none()))

/** A word that's an id, quoted or not: letters and digits run together with _ or :, or long and mostly digits. */
const id = String.raw`['"‘“]?(?=[\w:.-]*\d)(?:[\w.-]*[_:][\w:.-]*|(?=(?:[a-z-]*\d){4})[\w-]{8,})['"’”]?`

/** What T3 Code says in its own terms, and what's said instead. */
const reasons: ReadonlyArray<readonly [RegExp, string]> = [
  // It takes a message into a turn only while the turn is at it, not getting going or waiting, nor busy only in the background, with no turn of the agent's going.
  [/\bcannot be steered\b/i, "It isn't at a point where it can take that yet."],
  [/\bno running provider turn\b/i, "It isn't at a point where it can take that yet."],
  // It stops only a run with something going in it: one that ended just before the stop got there has nothing to stop.
  [/\bis not interruptible\b/i, "It isn't doing anything right now."],
  // An approval or a question answered in T3 Code's app just before; or one that ended with its run, or as T3 Code restarted.
  [/\bis resolved\b/i, answeredElsewhere],
  [/\bis (expired|cancelled)\b/i, "It isn't waiting on that any more."],
  // It acts on a thread only while it's neither archived nor deleted.
  [/\bthread\b.*\bis not active\b/i, "It's been archived or deleted."],
  // It lets go of a queue only once a turn that ran into a usage limit is carried on, from T3 Code's app.
  [/\blimited thread\b/i, "It's hit a usage limit."],
]

/** A reason T3 Code gave, fit to say: no ids, nothing unreadable, the work never put down to an agent or a session, and a full stop. */
export const plainly = (reason: string) => {
  const known = reasons.find(([pattern]) => pattern.test(reason))
  if (known !== undefined) return known[1]
  const stripped = reason
    // Which one it is, like "the active run", in place of its id, or "that run" when nothing says.
    .replace(
      /\b(?:(active|queued|target|current|pending|running)\s+)?(run|thread|command|message|request)\s+(?:['"‘“][^'"’”\s]+['"’”]|(?=[\w:.-]*[\d_:-])[\w:.-]+)/gi,
      (_, which: string | undefined, what: string) => (which === undefined ? `that ${what.toLowerCase()}` : `the ${which.toLowerCase()} ${what.toLowerCase()}`),
    )
    .replace(/\byapd:\S+/g, "it")
    .replace(new RegExp(String.raw`(?<![\w'"])${id}(?![\w'"])`, "gi"), "")
    .replace(/['"‘“]\S*\d\S*['"’”]/g, "")
  const said = Brain.speakable(stripped, { threads: [], away: [] })
    // What an id came after, like "not found:", ends there.
    .replace(/\s*:\s*(?=[.!?]*$)/, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
  const sentence = `${said.charAt(0).toUpperCase()}${said.slice(1)}`
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/** Whether a message went into the turn under way: steered in, or taken out of the queue into it, by his hand in T3 Code's app. */
const steeredIn = (intent: T3Actions.Intent) => intent === "steer" || intent === "promoted_queued_to_steer"

/**
 * How a message T3 Code has went in, as the thread shows it: into the turn
 * under way, waiting in the queue, or a turn of its own, as one that waited in
 * the queue is once it's started.
 */
const shown = ({ intent, run }: T3Actions.Found): Ledger.How =>
  Option.exists(intent, steeredIn)
    ? "steered"
    : Option.match(run, { onNone: () => Option.exists(intent, (intent) => intent === "queued_turn"), onSome: ({ status }) => status === "queued" })
      ? "queued"
      : "now"

/**
 * Whether a message that went into the queue, as `how` has it, waits there on
 * hold, which starts nothing till it's let carry on: T3 Code holds what goes
 * in behind a run a stop held, however idle the thread is by then.
 */
const onHold = ({ run }: T3Actions.Found, how: Ledger.How) => how === "queued" && Option.exists(run, ({ held }) => held)

/** How a run has ended, by its status, when it has. */
const ends: Readonly<Partial<Record<string, Ended>>> = { completed: "finished", interrupted: "cut", failed: "cut", cancelled: "cut", rolled_back: "rolled" }

/**
 * How the turn a message went into at `at` has ended, if it has. One that
 * started a turn of its own ended as its run did. One steered into the turn
 * under way started none, and the run it waited in, if it was taken out of
 * the queue, says nothing of it, since T3 Code cancels that run as it takes
 * it out: the turn it went into is the run T3 Code names on it, which has
 * ended as that run did, once it isn't still going. Only without that run
 * in the read is the thread's latest run looked to, which may be another,
 * like the one it waited in, or one begun since: that turn has ended once
 * the thread's latest run completed after it went in, as `answered` has it,
 * and ended as that latest run did only when that run was already going
 * when it went in, since a later one may have run since.
 */
const over = ({ intent, run, into }: T3Actions.Found, thread: T3Live.Thread, at: number): Ended | undefined => {
  const ended = (status: string) => (T3Actions.going.includes(status) ? undefined : (ends[status] ?? "ended"))
  if (!Option.exists(intent, steeredIn)) {
    if (Option.isSome(run)) return ends[run.value.status]
    // With nothing to say how it went in, as when T3 Code rolled its turn back and hid that turn's item, the run the message names is its turn.
    return Option.isSome(into) ? ended(into.value.status) : undefined
  }
  if (Option.isSome(into)) return ended(into.value.status)
  const when = (iso: string | null) => (iso === null ? Number.NaN : Date.parse(iso))
  if (!(when(thread.latestRunCompletedAt) > at)) return undefined
  return when(thread.latestRunStartedAt) <= at ? (ends[thread.status] ?? "ended") : "ended"
}

/** Runs that haven't said anything back yet: waiting in the queue, or getting going or at it. */
const unanswered: ReadonlyArray<string> = ["queued", "preparing", "starting", "running"]

/**
 * Whether a thread has answered a message that went in at `at`. One that started
 * a run of its own, or waits in the queue to, is answered once that run has
 * ended its turn or asks something, never by another run ending, as the one
 * it waited behind or the one stopped for it does. One steered into the turn
 * under way is answered by a turn that ended since, or something it asks.
 */
const answered = (thread: T3Live.Thread, at: number, own: Option.Option<{ readonly status: string }>) => {
  const since = (iso: string | null | undefined) => iso !== null && iso !== undefined && Date.parse(iso) > at
  const asked = since(thread.pendingRuntimeRequest?.createdAt)
  return Option.match(own, {
    onNone: () => since(thread.latestRunCompletedAt) || asked,
    onSome: ({ status }) => !unanswered.includes(status) || (status !== "queued" && asked),
  })
}

/** Whether it's in the middle of something a message would go into, or wait behind. */
const busy = (thread: T3Live.Thread) => T3Live.busy(thread) || thread.activityRunStatus === "waiting"

/** What its turn under way is waiting on, if it is: a turn waiting takes nothing in, so what's sent waits behind it. */
const waits = (thread: T3Live.Thread): Waiting | undefined =>
  thread.activityRunStatus !== "waiting" ? undefined : thread.pendingRuntimeRequest === null ? "finishing" : "asked"

/** How long, once a turn's been stopped to be told something in its place, the live view has to show it stopped before it's told. */
const stopping = "15 seconds"

/** Why a turn stopped to be told something in its place wasn't told: the live view never showed it stopped, so it could still have taken it in, or held it in the queue. */
const windingDown = "It was still winding down fifteen seconds later."

/** Why a step isn't done, once yapd was turned off since he said it (I8). */
export const switchedOff = "yapd was turned off before I could."

/** Whether a step wasn't done, as yapd was turned off after he said it. */
const unwanted = (outcome: Outcome) => outcome._tag === "NotSent" && outcome.reason === switchedOff

/** Why a turn stopped to be told something in its place wasn't told, when nothing noted why. */
const untold = "I didn't get to tell it."

/** Why a turn that ended just before it was stopped to be told something in its place wasn't told: another started in its place. */
const overtaken = "Something else started on it just as I went to stop it."

/** Why a turn that ended just before it was stopped to be told something in its place wasn't told: what's going on it couldn't be looked at again. */
const unlooked = "It may have started on something else just as I went to stop it, and I couldn't check."

/** Whether a stop was turned down since there was nothing to stop. */
const idle = (reason: string) => /isn't doing anything/.test(reason)

/** How often the live view is looked at meanwhile. */
const glancing = "250 millis"

/** What a step does, in a few words, for the log. */
const doing: Readonly<Record<Ledger.Kind, string>> = {
  message: "send a message",
  stop: "stop a run",
  undo: "take something back",
  decide: "answer an approval",
  reply: "answer a question",
  start: "start new work",
  tidy: "tidy a thread",
  relay: "pass a message on",
}

const refOf = (row: Ledger.Row): Threads.Ref => ({ machine: row.machine, id: row.thread })

/** What a step that's in the ledger already came to, since it's never sent a second time on its own. */
const settled = (row: Ledger.Row): Went => {
  const again = row.kind === "message" ? Option.some(row.commandId) : Option.none<string>()
  switch (row.state) {
    case "sent":
      return { _tag: "Done", how: row.how ?? "now", to: refOf(row) }
    case "refused":
      return { _tag: "Refused", reason: row.reason ?? "T3 Code turned it down." }
    case "failed":
      return { _tag: "NotSent", reason: row.reason ?? "It didn't go.", again }
    case "abandoned":
      return { _tag: "NotSent", reason: row.reason ?? "I left it.", again: Option.none() }
    case "prepared":
    case "unknown":
      return { _tag: "Unknown", reason: row.reason ?? "I couldn't tell whether it got there.", again }
  }
}

/**
 * Whose steps a restart looks at once `machine`'s T3 Code has caught up: its
 * own, and, for this machine, `here`, those on machines yapd no longer
 * follows too, which nothing else would look at. Never another followed
 * machine's, which wait for it.
 */
export const whose = (machine: string, here: string, followed: ReadonlyArray<string>) => (on: string) =>
  machine === here ? on === here || !followed.includes(on) : on === machine

/** How long a restart waits for this machine's T3 Code, almost always up, to catch up, before leaving its steps to the next restart. */
const catchingUp = "15 minutes"

/**
 * A restart's look at `machine`'s steps, as `whose` says, once its T3 Code
 * has caught up, which `view` tells. Another machine's waits as long as yapd
 * runs: one asleep or out of reach for a while is ordinary, and what went to
 * it would otherwise go unlooked at till the next restart, too old by then to
 * offer again. Waiting holds up nothing, as each machine's looks on its own.
 * Whether it has is asked `every` so often.
 */
export const lookBack = (
  hands: Pick<Hands["Type"], "reconcileOn">,
  view: Effect.Effect<Option.Option<unknown>>,
  machine: string,
  here: string,
  followed: ReadonlyArray<string>,
  every: Duration.DurationInput = "1 second",
) =>
  Effect.gen(function* () {
    const caughtUp = Effect.repeat(view, { schedule: Schedule.spaced(every), until: Option.isSome })
    yield* machine === here ? Effect.timeoutFail(caughtUp, { duration: catchingUp, onTimeout: () => "T3 Code didn't catch up in time" }) : caughtUp
    return yield* hands.reconcileOn(whose(machine, here, followed))
  })

/** Hands that reach threads through `threads` and write each step in `ledger` first. */
export const make = (options: {
  /** Where each thread is, what reaches its machine, and why it can't when it can't. */
  readonly threads: Pick<Threads.Threads["Type"], "find" | "actions" | "unseen">
  readonly ledger: Ledger.Ledger["Type"]
  /** When yapd started, in ms: what it did since is its own to settle, which a restart's look leaves alone. */
  readonly started?: number
}): Hands["Type"] => {
  const { threads, ledger, started = Number.POSITIVE_INFINITY } = options

  /** Says why it didn't go, in the log too, as every failure is. */
  const failing = <O extends Extract<Outcome, { readonly reason: string }>>(outcome: O, what: string) =>
    Effect.as(Effect.logWarning(`Could not ${what}: ${outcome.reason}`), outcome)

  /** What reaches the thread's machine, and the thread as it is now, unless it's gone or can't take it. */
  const reach = (to: Threads.Ref) =>
    Effect.gen(function* () {
      const actions = threads.actions(to.machine)
      if (Option.isNone(actions)) return Either.left(`I can't reach the threads on ${to.machine} right now.`)
      const thread = yield* threads.find(to)
      // Its machine's threads can't be seen, like rig's while it can't be reached: that's why, and nothing goes anywhere else in its place.
      if (Option.isNone(thread)) return Either.left(Option.getOrElse(yield* threads.unseen(to.machine), () => "I can't find it among your threads right now."))
      if (thread.value.archivedAt !== null) return Either.left("It's been archived.")
      if (thread.value.lineage?.relationshipToParent === "subagent") return Either.left("It's part of another thread, and takes nothing on its own.")
      return Either.right({ actions: actions.value, thread: thread.value })
    })

  /** Whether a step that may not have got there did, looked for once in the thread. */
  const landed = (row: Ledger.Row, actions: T3Actions.Actions): Effect.Effect<boolean, T3CodeServer.Trouble> => {
    const sent = command(row.body)
    if (row.messageId !== null && row.kind === "message") return actions.has(row.thread, row.messageId)
    // An answer got there once the thread no longer waits on what it answered, even behind something newer it asked.
    if (Option.isSome(sent) && (sent.value._tag === "Decide" || sent.value._tag === "Answer")) {
      const { requestId } = sent.value
      return Effect.flatMap(threads.find(refOf(row)), (thread) => {
        const pending = Option.getOrNull(Option.flatMap(thread, ({ pendingRuntimeRequest }) => Option.fromNullable(pendingRuntimeRequest)))
        if (pending === null) return Effect.succeed(true)
        if (pending.id === requestId) return Effect.succeed(false)
        return Effect.map(actions.detail(row.thread, requestId), ({ pending }) => !pending.includes(requestId))
      })
    }
    if (row.kind === "stop") return Effect.map(actions.running(row.thread), (running) => !running)
    if (Option.isSome(sent) && sent.value._tag === "Cancel") {
      // Withdrawn, T3 Code drops the run, and its message, from the thread, or shows it cancelled. One that started meanwhile is being read,
      // as is one he steered into the turn under way, which cancels the run it waited in too, but keeps the message. Looked for as `traced`
      // finds it: once enough turns since have pushed all else of it out of the thread's last turns, the cancelled run they still show
      // can't tell the two apart, and only the whole thread can, which failing to read fails the look.
      const { runId, messageId } = sent.value
      if (messageId === undefined) return Effect.map(actions.detail(row.thread), ({ runs }) => !runs.some(({ id, status }) => id === runId && status !== "cancelled"))
      return Effect.map(
        actions.traced(row.thread, messageId),
        Option.match({
          onNone: () => true,
          onSome: ({ intent, run }) => !Option.exists(intent, steeredIn) && Option.exists(run, ({ status }) => status === "cancelled"),
        }),
      )
    }
    return Effect.succeed(false)
  }

  /**
   * How a message went in, as the thread says: into the turn under way,
   * behind it, or at once, as `shown` has it, and, behind it, whether it
   * waits in a queue on hold. When the thread doesn't say, as it was sent.
   */
  const entered = (row: Ledger.Row, actions: T3Actions.Actions, wasBusy: boolean, how: T3Actions.When) =>
    Effect.gen(function* () {
      const fallback = { how: how === "after" ? ("queued" as const) : ("now" as const), held: false }
      if (row.kind !== "message" || row.messageId === null || !(wasBusy || how === "after")) return fallback
      const found = yield* actions.message(row.thread, row.messageId).pipe(Effect.orElseSucceed(() => Option.none<T3Actions.Found>()))
      return Option.match(
        Option.filter(found, ({ intent }) => Option.isSome(intent)),
        {
          onNone: () => fallback,
          onSome: (found): { readonly how: Ledger.How; readonly held: boolean } => {
            const how = shown(found)
            return { how, held: onHold(found, how) }
          },
        },
      )
    })

  /** A message that went in as `entry` says, noted so, and said to wait in a queue on hold when it does. `why` is how it came to be found, for the log. */
  const entering = (row: Ledger.Row, entry: { readonly how: Ledger.How; readonly held: boolean }, why = "") =>
    Effect.gen(function* () {
      yield* ledger.settle(row.commandId, "sent", { how: entry.how })
      yield* Effect.logInfo(`Dispatched ${row.commandId} → sent (${entry.how}${entry.held ? ", held" : ""})${why === "" ? "" : `, ${why}`}`)
      return { _tag: "Done", how: entry.how, to: refOf(row), ...(entry.held ? { waiting: "held" as const } : {}) } satisfies Outcome
    })

  /**
   * What came of a message sent once more after it may have got there the
   * first time, found in the thread, whether T3 Code answered for it or its
   * answer was lost again: what's there may be from the first time, so it's
   * made of the same way either way. There to be read, it went in as the
   * thread shows it, which may be long before, never as the thread is now:
   * still in a queue a stop has put on hold since, it waits there however
   * idle the thread is. The turn it started or went into ended since, it's
   * said to have gone in, and how that turn ended, when that can be told,
   * never as being worked on now, since nothing is. Shown cancelled, with
   * nothing to say he moved it into the turn under way, which cancels the
   * run it waited in too, it was withdrawn, so the same words said again are
   * new: it's found as `traced` finds it, in the whole thread once enough
   * turns since have pushed all else of it out of the thread's last turns.
   * `why` is how it came to be looked for, for the log.
   */
  const placed = (row: Ledger.Row, found: T3Actions.Found, thread: T3Live.Thread, why: string): Effect.Effect<Went> =>
    Effect.gen(function* () {
      // Steered in, even from the queue by his hand in T3 Code's app, which cancels the run it waited in, it's in the turn under way.
      if (Option.exists(found.intent, steeredIn) || !Option.exists(found.run, ({ status }) => status === "cancelled")) {
        const how = shown(found)
        const held = onHold(found, how)
        // Since it went in, by T3 Code's clock as the thread's turns are: not shown, it went in after it was written down.
        const ended = over(found, thread, Option.getOrElse(found.at, () => row.at))
        yield* ledger.settle(row.commandId, "sent", { how })
        yield* Effect.logInfo(`Dispatched ${row.commandId} → sent (${how}${held ? ", held" : ""}${ended === undefined ? "" : `, its turn ${ended}`}), ${why}`)
        return { _tag: "Done", how, to: refOf(row), ...(held ? { waiting: "held" as const } : {}), ...(ended === undefined ? {} : { ended }) } satisfies Outcome
      }
      yield* ledger.settle(row.commandId, "abandoned", { reason: Ledger.withdrawn })
      return yield* failing({ _tag: "Refused", reason: takenOut } satisfies Outcome, `${doing.message} again`)
    })

  /**
   * What came of a message sent once more after it may have got there the
   * first time, once T3 Code answers for it: it answers for ids it has
   * already from what it kept, without doing it again, so it's looked for in
   * the thread, and found, it's as `placed` has it. Otherwise T3 Code has it,
   * as its answer says, so it went, but not found, or with the thread
   * unread, as when its last turns can't tell and the whole of it is too
   * slow to read, whether it's still to be read can't be told, since one
   * that went in is also dropped from the thread's read once enough happens
   * after it: the same words said again are asked about. None for what isn't
   * a message.
   */
  const kept = (row: Ledger.Row, { actions, thread }: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread }) =>
    Effect.gen(function* () {
      if (row.kind !== "message" || row.messageId === null) return Option.none<Went>()
      const look = yield* Effect.either(actions.traced(row.thread, row.messageId))
      const found = Either.getOrElse(look, () => Option.none<T3Actions.Found>())
      if (Option.isSome(found)) return Option.some(yield* placed(row, found.value, thread, "as T3 Code had it already"))
      const reason = Either.isLeft(look) ? `${unchecked}: ${after(plainly(look.left.reason))}` : notThere
      yield* ledger.settle(row.commandId, "sent", { reason })
      return Option.some<Went>(
        yield* failing({ _tag: "Unknown", reason, again: Option.none() } satisfies Outcome, `${doing.message} again, and couldn't tell whether it's still to be read`),
      )
    })

  /**
   * Sending it once more never left yapd, so it wasn't sent again: the step
   * is put back as it was, never offered again on its own, so the same words
   * said again find it, and his yes can still send it under its ids. Both at
   * once: put back first, it would be there to offer, for the same reason as
   * the first time, to anything reading it in between, like a restart's late
   * look at it.
   */
  const unsent = (row: Ledger.Row) =>
    ledger.settle(row.commandId, row.state === "failed" ? "failed" : "unknown", { reason: Ledger.leftBe("Sending it again never left yapd."), from: ["abandoned"] })

  /**
   * The time he wants a message sent once more to go in at, when it isn't the
   * time it first went: put down, for one that never left yapd, since T3 Code
   * never saw its ids; otherwise it's left, never offered again on its own,
   * and why is what comes of it, since T3 Code may hold it as it first went.
   */
  const retime = (commandId: string, wanted: T3Actions.When | undefined) =>
    Effect.gen(function* () {
      const row = yield* ledger.get(commandId)
      const first = Option.flatMap(row, (row) => Option.flatMap(command(row.body), (sent) => (sent._tag === "Send" ? Option.some(sent) : Option.none())))
      // In place of the turn under way, a message goes at once, once yapd has stopped the turn, which is how it's sent, so that's the same time.
      const how = wanted === "restart" ? "now" : wanted
      if (how === undefined || Option.isNone(row) || Option.isNone(first) || (first.value.how === "restart" ? "now" : first.value.how) === how) return Option.none<Outcome>()
      if (yield* ledger.amend(commandId, { ...first.value, how })) {
        yield* Effect.logInfo(`Sending ${commandId} ${how} rather than ${first.value.how}, since it never left`)
        return Option.none<Outcome>()
      }
      // Sent, turned down or given up on, what came of it stands.
      if (row.value.state !== "prepared" && row.value.state !== "unknown") return Option.none<Outcome>()
      yield* ledger.leave(commandId, "He wanted it at another time than it first went.")
      return Option.some<Outcome>(yield* failing({ _tag: "Refused", reason: unchanged(first.value.how) } satisfies Outcome, `${doing.message} ${how}`))
    })

  /**
   * Sends a step written in the ledger and notes what came of it. When it
   * may have got there, it's looked for once. `last` is for the one time
   * it's sent again, after which it's never offered again, unless it never
   * left yapd, which isn't sending it; a message that may have got there the
   * first time is looked for then even once T3 Code says it's done, since it
   * says so from what it kept, and found, whether T3 Code said so or its
   * answer was lost again, it's made of as `placed` has it, since what's
   * there may be from the first time. `at` is when a message goes in this
   * time, when T3 Code can't take it as it first went, still under its ids.
   */
  const dispatch = (
    row: Ledger.Row,
    reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread },
    last = false,
    at?: T3Actions.When,
  ): Effect.Effect<Went> =>
    Effect.gen(function* () {
      const { actions } = reached
      const wasBusy = busy(reached.thread)
      const what = doing[row.kind]
      const read = command(row.body)
      if (Option.isNone(read)) {
        yield* ledger.settle(row.commandId, "abandoned", { reason: unreadable })
        return yield* failing({ _tag: "NotSent", reason: unreadable, again: Option.none() }, what)
      }
      const sent = read.value._tag === "Send" && at !== undefined ? { ...read.value, how: at } : read.value
      const how = sent._tag === "Send" ? sent.how : "now"
      const again = row.kind === "message" && !last ? Option.some(row.commandId) : Option.none<string>()
      // What never left yapd the first time, T3 Code never had the ids of, so what's found of it is what it did with it now.
      const earlier = last && row.state !== "failed"
      const result = yield* Effect.either(actions.run(row.thread, sent, row.commandId))
      if (Either.isRight(result)) {
        const gone = earlier ? yield* kept(row, reached) : Option.none<Went>()
        if (Option.isSome(gone)) return gone.value
        return yield* entering(row, yield* entered(row, actions, wasBusy, how))
      }
      const error = result.left
      const reason = plainly(T3Actions.reason(error))
      if (error._tag === "Refusal") {
        yield* ledger.settle(row.commandId, "refused", { reason })
        return yield* failing({ _tag: "Refused", reason } satisfies Outcome, `${what}, T3 Code turned it down`)
      }
      if (error.sent !== true) {
        yield* last ? unsent(row) : ledger.settle(row.commandId, "failed", { reason })
        return yield* failing({ _tag: "NotSent", reason, again } satisfies Outcome, `${what}, it never went`)
      }
      // It went, and may have been done: looked for once, never sent again on its own.
      if (earlier && row.kind === "message" && row.messageId !== null) {
        // Sent once more, what's found may be there from the first time, so it's made of as it is when T3 Code answers for it.
        const look = yield* Effect.either(actions.traced(row.thread, row.messageId))
        if (Either.isRight(look) && Option.isSome(look.right)) return yield* placed(row, look.right.value, reached.thread, `found after: ${reason}`)
      } else {
        const found = yield* Effect.either(landed(row, actions))
        if (Either.isRight(found) && found.right) return yield* entering(row, yield* entered(row, actions, wasBusy, how), `found after: ${reason}`)
      }
      yield* ledger.settle(row.commandId, last ? "abandoned" : "unknown", { reason })
      return yield* failing({ _tag: "Unknown", reason, again } satisfies Outcome, `${what}, and couldn't tell whether it went`)
    })

  /**
   * Writes the step in the ledger and sends it, unless it's there already,
   * when what came of it stands, or what it's for is no longer `wanted`,
   * once yapd was turned off since he said it, however long what came first
   * took, like a look at the thread: then nothing is written or sent (I8).
   * Once written, it's seen through: stopped between the two, it would be
   * left as if it may have gone when it didn't, and stopped while it's sent,
   * as if it never went when it may have.
   */
  const once = (
    step: Step,
    kind: Ledger.Kind,
    to: Threads.Ref,
    body: (ids: { readonly commandId: string; readonly messageId: string | null }) => typeof Body.Type,
    reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread },
    wanted: Effect.Effect<boolean>,
    digest?: string,
  ) =>
    Effect.gen(function* () {
      if (!(yield* wanted)) {
        const there = yield* ledger.get(Ledger.ids(step.utterance, step.step, false).commandId)
        if (Option.isSome(there)) return settled(there.value)
        return yield* failing({ _tag: "NotSent", reason: switchedOff, again: Option.none() } satisfies Outcome, doing[kind])
      }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const prepared = yield* ledger
            .prepare({ ...step, kind, machine: to.machine, thread: to.id, body, message: kind === "message", ...(digest === undefined ? {} : { digest }) })
            .pipe(Effect.either)
          if (Either.isLeft(prepared)) {
            return yield* failing(
              { _tag: "NotSent", reason: "I couldn't write it down first, so I didn't send it.", again: Option.none() } satisfies Outcome,
              doing[kind],
            )
          }
          if (!prepared.right.fresh) return settled(prepared.right)
          return yield* dispatch(prepared.right, reached)
        }),
      )
    })

  /**
   * What's made of the same words going to a thread they went to lately,
   * when it isn't to go straight through. It's looked for once in the thread.
   * One that went is asked about, unless the thread has answered it since, or
   * it can't be told whether it has. One that may not have got there, found,
   * is one that went; withdrawn before it was read, whether shown cancelled
   * or, as T3 Code drops a message taken out of its queue, sent into the
   * queue and gone from the thread, what's said now is new; otherwise it's
   * offered again under its own ids, never sent under new ones, and once it's
   * been sent again already, it isn't risked a third time.
   */
  const twinned = (twin: Ledger.Row, reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread }) =>
    Effect.gen(function* () {
      const look = twin.messageId === null ? Either.right(Option.none<T3Actions.Found>()) : yield* Effect.either(reached.actions.message(twin.thread, twin.messageId))
      const found = Either.getOrElse(look, () => Option.none<T3Actions.Found>())
      // Steered in, even from the queue by his hand in T3 Code's app, which cancels the run it waited in, it's in the turn under way.
      const steered = Option.exists(found, ({ intent }) => Option.exists(intent, steeredIn))
      const own = steered ? Option.none<{ readonly status: string }>() : Option.flatMap(found, ({ run }) => run)
      // Only one that went into the queue can be taken out of it: any other gone from the thread is only further back than its read reaches.
      const gone = twin.state === "sent" && twin.how === "queued" && twin.messageId !== null && Either.isRight(look) && Option.isNone(found)
      if (gone || Option.exists(own, ({ status }) => status === "cancelled")) {
        yield* Effect.logInfo(`${twin.commandId} was withdrawn from the thread, so the same words go as new`)
        return Option.none<Outcome>()
      }
      let row = twin
      if (row.state !== "sent" && Option.isSome(found)) {
        yield* ledger.settle(row.commandId, "sent", { from: [row.state] })
        yield* Effect.logInfo(`Found ${row.commandId} in the thread after all`)
        row = { ...row, state: "sent" }
      }
      // Since it went in, by T3 Code's clock as the thread's turns are: sent once more, or late, that's after it was written down.
      const since = Option.getOrElse(Option.flatMap(found, ({ at }) => at), () => row.at)
      if (row.state === "sent" && Either.isRight(look) && answered(reached.thread, since, own)) return Option.none<Outcome>()
      if (row.state === "abandoned") return Option.some<Outcome>(yield* failing({ _tag: "Refused", reason: thirdTime } satisfies Outcome, doing.message))
      yield* Effect.logInfo(`The same words went to it at ${new Date(row.at).toISOString()} as ${row.commandId}, so asking first`)
      return Option.some<Outcome>({ _tag: "Twin", row })
    })

  /**
   * Whether a thread was given something else since `since`, other than by
   * yapd: a message typed after it, later than yapd's own last one, or a
   * turn that started after it, like one he queued while it ran, with
   * nothing sent by yapd since.
   */
  const moved = (to: Threads.Ref, thread: T3Live.Thread, since: number) =>
    Effect.gen(function* () {
      const after = (iso: string | null, than: number) => iso !== null && Date.parse(iso) > than
      const ours = (yield* ledger.steps(since, { kinds: ["message"], machine: to.machine, thread: to.id })).at(-1)?.at
      if (after(thread.latestUserMessageAt, since + 1000) && (ours === undefined || after(thread.latestUserMessageAt, ours + 2000))) return true
      return ours === undefined && after(thread.latestRunStartedAt, since + 1000)
    })

  /**
   * Why nothing may be sent to a thread as it is, if that's so: it waits on a
   * secret, which T3 Code says, or a question that asks him to type one in,
   * which only its turn items say, and which unread could be one; or on a
   * question with nothing to pick from, however it's worded, and `text`
   * looks like a secret, which it could be asking for in other words.
   */
  const keeping = (to: Threads.Ref, reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread }, text: string) =>
    Effect.gen(function* () {
      const pending = reached.thread.pendingRuntimeRequest
      if (pending === null) return undefined
      if (T3Actions.secret(pending.id)) return withheld
      if (pending.kind !== "user_input") return undefined
      const read = yield* Effect.either(reached.actions.detail(to.id, pending.id))
      if (Either.isLeft(read)) return unread
      const request = read.right.request
      if (Option.exists(request, ({ _tag }) => _tag === "Secret")) return withheld
      const open = Option.exists(request, (request) => request._tag === "Question" && request.questions.some(({ options }) => options.length === 0))
      return open && T3Actions.revealing(text) ? revealed : undefined
    })

  const message = (step: Step, act: Extract<Act, { readonly _tag: "Message" }>, twice: boolean, wanted: Effect.Effect<boolean>, since?: number) =>
    Effect.gen(function* () {
      const { to, text } = act
      const { commandId } = Ledger.ids(step.utterance, step.step, true)
      // Worked out again, it's the step it was, whatever came of it: in place of the turn under way, what came of the stop and the message after it.
      const before = yield* ledger.get(commandId)
      if (Option.isSome(before) && before.value.kind === "stop") {
        const stop = before.value
        const told = yield* ledger.get(Ledger.ids(step.utterance, step.step + 1, true).commandId)
        return Option.match(told, {
          onNone: (): Outcome =>
            stop.state === "sent" ? { _tag: "NotSent", reason: stop.reason ?? untold, again: Option.none(), stopped: true } : { ...settled(stop), stopped: false },
          onSome: (told): Outcome => ({ ...settled(told), stopped: stop.state === "sent" ? true : "ended" }),
        })
      }
      if (Option.isSome(before)) return settled(before.value)
      const reached = yield* reach(to)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing.message)
      // Waiting on a secret, it's sent nothing by voice, since what he says could be the secret in other words; nor what looks like one, to a question he'd type into.
      const kept = yield* keeping(to, reached.right, text)
      if (kept !== undefined) return yield* failing({ _tag: "Refused", reason: kept } satisfies Outcome, doing.message)
      // An answer to what it said then, which it's moved on from: held back, never written down, so the same words later are new.
      if (since !== undefined && (yield* moved(to, reached.right.thread, since))) return yield* failing({ _tag: "Refused", reason: given } satisfies Outcome, doing.message)
      const digest = Ledger.digest(text)
      if (!twice) {
        const now = yield* Clock.currentTimeMillis
        const twin = yield* ledger.twin(to.machine, to.id, digest, now - twins)
        const made = Option.isSome(twin) ? yield* twinned(twin.value, reached.right) : Option.none<Outcome>()
        if (Option.isSome(made)) return made.value
      }
      if (act.how === "restart") return yield* restart(step, act, reached.right, digest, wanted)
      // T3 Code takes a message into a turn only while it's at it, and turns one down for a turn that's waiting, so it goes in the queue behind it.
      const waiting = act.how === "now" ? waits(reached.right.thread) : undefined
      const how = waiting === undefined ? act.how : "after"
      const sent = yield* once(step, "message", to, ({ messageId }) => ({ _tag: "Send", text, messageId: messageId ?? "", how }), reached.right, wanted, digest)
      // Waiting in a queue on hold, it waits on that first, whatever the turn does.
      return sent._tag === "Done" && waiting !== undefined && sent.waiting === undefined ? { ...sent, waiting } : sent
    })

  /**
   * The thread as the live view has it once it's no longer as `still` says,
   * or as it last had it `within` from now, or once what it's for is no
   * longer `wanted`, looked at every so often meanwhile. It ends by its own
   * clock rather than by being cut short, since it's waited on once a step is
   * written, where nothing can cut it short.
   */
  const watch = (
    to: Threads.Ref,
    thread: T3Live.Thread,
    still: (thread: T3Live.Thread) => boolean,
    within: Duration.DurationInput,
    wanted: Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(within)
      let now = Option.getOrElse(yield* threads.find(to), () => thread)
      while (still(now) && (yield* Clock.currentTimeMillis) < until && (yield* wanted)) {
        yield* Effect.sleep(glancing)
        now = Option.getOrElse(yield* threads.find(to), () => now)
      }
      return now
    })

  /**
   * Stops the turn under way to start over with the message, as his words
   * ask: the stop, holding its queue, as a step of its own, then the message
   * at once, as the next, once the live view shows it stopped, so it starts a
   * turn of its own rather than go into the turn being stopped or wait in the
   * queue the stop held. Still busy by then, or no longer `wanted`, it
   * isn't told, and why is noted. With nothing under way, or a turn that
   * ended just before the stop got there with nothing else started since,
   * it's just told at once.
   */
  const restart = (
    step: Step,
    act: Extract<Act, { readonly _tag: "Message" }>,
    reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread },
    digest: string,
    wanted: Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const { to, text } = act
      /** The message, as a step of its own, at once. To a thread busy just before, how it went in is looked up rather than taken for granted. */
      const send = (at: Step) => once(at, "message", to, ({ messageId }) => ({ _tag: "Send", text, messageId: messageId ?? "", how: "now" }), reached, wanted, digest)
      /** Why it wasn't told, noted with the stop that went, so the same step worked out again, or a restart, says the same. */
      const noting = (reason: string) => ledger.settle(Ledger.ids(step.utterance, step.step, false).commandId, "sent", { reason, from: ["sent"] })
      if (!busy(reached.thread)) return yield* send(step)
      yield* Effect.logInfo(`Stopping its turn, which is ${reached.thread.activityRunStatus ?? "busy"}, to tell it something in its place`)
      const stopped = yield* once(step, "stop", to, () => ({ _tag: "Stop", then: text }), reached, wanted)
      const next = { ...step, step: step.step + 1 }
      if (stopped._tag === "Refused" && idle(stopped.reason)) {
        // Turned down as ended, the turn may have ended for another to start in its place, like a message queued behind it, which is never
        // told what was meant for the one stopped: what's going is looked at again first, and with anything going, or no telling, it isn't told.
        const looked = yield* Effect.either(reached.actions.running(to.id))
        if (Either.isLeft(looked) || looked.right) {
          const reason = Either.isLeft(looked) ? unlooked : overtaken
          yield* ledger.settle(Ledger.ids(step.utterance, step.step, false).commandId, "refused", { reason, from: ["refused"] })
          return yield* failing({ _tag: "Refused", reason, stopped: false } satisfies Outcome, "tell it what to do instead")
        }
        yield* Effect.logInfo("Its turn ended just before it was stopped, so telling it at once")
        return { ...(yield* send(next)), stopped: "ended" } satisfies Outcome
      }
      if (stopped._tag !== "Done") return { ...stopped, stopped: false } satisfies Outcome
      const after = yield* watch(to, reached.thread, busy, stopping, wanted)
      // Still busy once the wait is up, it isn't told; ended early by yapd being turned off, it isn't either, which sending it sees to (I8).
      if (busy(after) && (yield* wanted)) {
        yield* noting(windingDown)
        return yield* failing({ _tag: "NotSent", reason: windingDown, again: Option.none(), stopped: true } satisfies Outcome, "tell it what to do instead")
      }
      const told = yield* send(next)
      if (unwanted(told)) yield* noting(switchedOff)
      return { ...told, stopped: true } satisfies Outcome
    })

  const stop = (step: Step, to: Threads.Ref, wanted: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      const reached = yield* reach(to)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing.stop)
      return yield* once(step, "stop", to, () => ({ _tag: "Stop" }), reached.right, wanted)
    })

  /**
   * Lets a thread yapd stopped carry on: lets go of its queue, then, once
   * that's done, asks it to pick up where it was, while that's still
   * `wanted`; or, told something in place of what it was stopped from that
   * waits in that queue, only lets go.
   */
  const carry = (step: Step, to: Option.Option<Threads.Ref>, wanted: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      const stopped = yield* ledger.latest(resumable, {
        kinds: ["stop"],
        states: ["sent", "abandoned"],
        ...Option.match(to, { onNone: () => ({}), onSome: ({ machine, id }) => ({ machine, thread: id }) }),
      })
      if (Option.isSome(stopped) && stopped.value.reason === carried) {
        return yield* failing({ _tag: "Refused", reason: carriedOn } satisfies Outcome, "let it carry on")
      }
      if (Option.isNone(stopped) || stopped.value.state !== "sent") {
        return yield* failing({ _tag: "Refused", reason: "I haven't stopped anything lately." } satisfies Outcome, "let it carry on")
      }
      const ref = refOf(stopped.value)
      const reached = yield* reach(ref)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, "let it carry on")
      // Going again already, by his hand or a carry on before, it's told nothing twice.
      if (busy(reached.right.thread)) return yield* failing({ _tag: "Refused", reason: backAtWork } satisfies Outcome, "let it carry on")
      // Told to carry on since the stop already, it's never told again under new ids: there, it's carrying on; maybe not, it's offered again under its own.
      const before = yield* ledger.twin(ref.machine, ref.id, Ledger.digest(carryOn), stopped.value.at)
      if (Option.isSome(before)) {
        const told = before.value
        const there =
          told.state === "sent" ||
          (told.messageId !== null && Either.getOrElse(yield* Effect.either(reached.right.actions.has(told.thread, told.messageId)), () => false))
        if (there) {
          if (told.state !== "sent") yield* ledger.settle(told.commandId, "sent", { from: [told.state] })
          yield* ledger.settle(stopped.value.commandId, "abandoned", { reason: carried, from: ["sent"] })
          return yield* failing({ _tag: "Refused", reason: carriedOn } satisfies Outcome, "let it carry on")
        }
        if (told.state === "abandoned") return yield* failing({ _tag: "Refused", reason: thirdTime } satisfies Outcome, "let it carry on")
        yield* Effect.logInfo(`It was told to carry on as ${told.commandId}, which isn't confirmed, so asking first`)
        return { _tag: "Twin", row: told } satisfies Outcome
      }
      // Told something in its place that waits in the queue the stop held, carrying on is letting that go, never asking it to pick up what it was told to drop.
      const then = yield* ledger.get(Ledger.ids(stopped.value.utterance, stopped.value.step + 1, true).commandId)
      const instead = Option.exists(then, (row) => row.kind === "message" && row.machine === ref.machine && row.thread === ref.id && row.state === "sent" && row.how === "queued")
      const resumed = yield* once(step, "undo", ref, () => (instead ? { _tag: "Resume" } : { _tag: "Resume", then: carryOn }), reached.right, wanted)
      if (instead) {
        if (resumed._tag === "Done") yield* ledger.settle(stopped.value.commandId, "abandoned", { reason: carried, from: ["sent"] })
        return resumed
      }
      // T3 Code lets go of a queue with nothing in it all the same, so one it turns down, like for a thread archived since it was looked at,
      // isn't asked to pick up where it was: a message would go in regardless, and start work on what he's no longer there for.
      if (resumed._tag !== "Done") return resumed
      const told = yield* once(
        { ...step, step: step.step + 1 },
        "message",
        ref,
        ({ messageId }) => ({ _tag: "Send", text: carryOn, messageId: messageId ?? "", how: "now" }),
        reached.right,
        wanted,
        Ledger.digest(carryOn),
      )
      // Let carry on, the stop is taken back, and isn't taken back twice.
      if (told._tag === "Done") yield* ledger.settle(stopped.value.commandId, "abandoned", { reason: carried, from: ["sent"] })
      // Not asked to carry on since yapd was turned off, that's noted with the queue let go of, so a restart doesn't say it again.
      if (unwanted(told)) yield* ledger.settle(Ledger.ids(step.utterance, step.step, false).commandId, "sent", { reason: switchedOff, from: ["sent"] })
      return told
    })

  /**
   * Allows, turns down or answers what a thread waits on him for, only while
   * it's still the very request he heard: dealt with in T3 Code meanwhile,
   * nothing is done or said. Only an approval is allowed and only a question
   * answered, since T3 Code takes either for both and the agent would never
   * get it, and a secret never is. Once per request: an earlier step for it
   * that went stands, and one that may not have goes once more under its
   * own ids, on this yes of his, never under new ones (I2); once that's been
   * given up on still unconfirmed, or a restart couldn't confirm it, it's
   * never sent again, and he's told so. That's only for the same answer: a
   * different one goes under its own ids only once the earlier never left
   * yapd, and is otherwise left to T3 Code, so what's sent is always what he
   * said last, and what's said is what was sent.
   */
  const respond = (step: Step, act: Extract<Act, { readonly _tag: "Decide" | "Reply" }>, wanted: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      const kind = act._tag === "Decide" ? "decide" : "reply"
      const before = yield* ledger.get(Ledger.ids(step.utterance, step.step, false).commandId)
      if (Option.isSome(before)) return settled(before.value)
      const reached = yield* reach(act.to)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing[kind])
      const { actions, thread } = reached.right
      const moot = Effect.as(Effect.logInfo(`Not answering ${act.requestId}, since it no longer waits on it`), { _tag: "Moot" } satisfies Outcome)
      // Waiting on nothing, it was dealt with; waiting on something else, it may still wait on this one too, asked alongside it, which only a read can say.
      if (thread.pendingRuntimeRequest === null) return yield* moot
      const read = yield* Effect.either(actions.detail(act.to.id, act.requestId))
      if (Either.isLeft(read)) {
        return yield* failing({ _tag: "NotSent", reason: plainly(T3Actions.reason(read.left)), again: Option.none() } satisfies Outcome, doing[kind])
      }
      if (thread.pendingRuntimeRequest.id !== act.requestId && !read.right.pending.includes(act.requestId)) return yield* moot
      const request = read.right.request
      if (Option.exists(request, ({ _tag }) => _tag === "Secret")) return yield* failing({ _tag: "Refused", reason: secretive } satisfies Outcome, doing[kind])
      const question = Option.getOrUndefined(Option.filter(request, (request) => request._tag === "Question"))
      const questions = question?._tag === "Question" ? question.questions : []
      // An answer in his own words that looks like a secret isn't given by voice, whatever the question said it was for, even beside an
      // option he picked for another part: only what's one of its part's options, as it takes it, is never his own words.
      const offered = (id: string, value: string) => questions.some((asked) => asked.id === id && asked.options.some((option) => T3Actions.choice(option) === value))
      if (act._tag === "Reply" && Object.entries(act.answers).some(([id, value]) => [value].flat().some((given) => !offered(id, given) && T3Actions.revealing(given)))) {
        return yield* failing({ _tag: "Refused", reason: revealed } satisfies Outcome, doing[kind])
      }
      const fits = Option.exists(request, (request) =>
        act._tag === "Decide" ? request._tag === "Approval" && request.decisions.some(({ decision }) => decision === act.decision) : request._tag === "Question",
      )
      // T3 Code takes an answer under a key the question doesn't have without a word, and the agent never gets it.
      const unasked = act._tag === "Reply" && Object.keys(act.answers).some((id) => !questions.some((asked) => asked.id === id))
      if (!fits || unasked) return yield* failing({ _tag: "Refused", reason: mismatched } satisfies Outcome, doing[kind])
      // Taken as a message to the thread, each part is one string, and every part it needs has one.
      const message = question?._tag === "Question" && question.mode === "message"
      if (act._tag === "Reply" && message && questions.some(({ id, required }) => required && [act.answers[id] ?? []].flat().join("").trim() === "")) {
        return yield* failing({ _tag: "Refused", reason: incomplete } satisfies Outcome, doing[kind])
      }
      const answer = act._tag === "Reply" && message ? { ...act, answers: Object.fromEntries(Object.entries(act.answers).map(([id, value]) => [id, [value].flat().join(", ")])) } : act
      const now = yield* Clock.currentTimeMillis
      const latest = (yield* ledger.steps(now - answering, { kinds: [kind], machine: act.to.machine, thread: act.to.id })).findLast((row) =>
        Option.exists(command(row.body), (body) => (body._tag === "Decide" || body._tag === "Answer") && body.requestId === act.requestId),
      )
      // A different answer from one that never left yapd takes its place; from one that went, or may have, even given up on since, it would
      // contradict what T3 Code may have.
      if (latest !== undefined && !alike(latest.body, answer)) {
        if (latest.state === "failed") {
          yield* ledger.settle(latest.commandId, "abandoned", { reason: replaced, from: ["failed"] })
        } else if (latest.state !== "refused" && (latest.state !== "abandoned" || unsettled(latest))) {
          return yield* failing({ _tag: "Refused", reason: latest.state === "sent" ? answeredAlready : answeredBefore } satisfies Outcome, doing[kind])
        }
      }
      const earlier = latest !== undefined && alike(latest.body, answer) ? latest : undefined
      if (earlier?.state === "sent") return settled(earlier)
      /** The same answer, given up on without knowing whether it got there: it's never sent again, under its own ids or new ones. */
      const unconfirmed = failing({ _tag: "Unknown", reason: unconfirmedAnswer, again: Option.none() } satisfies Outcome, doing[kind])
      if (earlier !== undefined && unsettled(earlier)) return yield* unconfirmed
      /** The answer as a step of its own, under this request's ids. */
      const fresh = once(
        step,
        kind,
        act.to,
        () =>
          answer._tag === "Decide"
            ? { _tag: "Decide", requestId: answer.requestId, decision: answer.decision }
            : { _tag: "Answer", requestId: answer.requestId, answers: answer.answers },
        reached.right,
        wanted,
      )
      /**
       * The same answer once more, under the ids it first went under, on this
       * yes of his, while that's still `wanted`: looked at as it's taken to
       * send, so once yapd was turned off since he said it, however long the
       * look at the thread took, nothing is sent and it stays as it was (I8).
       */
      const resend = (earlier: Ledger.Row) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!(yield* wanted)) return yield* failing({ _tag: "NotSent", reason: switchedOff, again: Option.none() } satisfies Outcome, doing[kind])
            const taken = yield* ledger.resending(earlier.commandId)
            // Taken just before, as by another yes, or come to something since: what it came to stands, and it never goes under new ids.
            if (Option.isNone(taken)) {
              const now = yield* ledger.get(earlier.commandId)
              if (Option.isSome(now) && ["sent", "refused", "failed"].includes(now.value.state)) return settled(now.value)
              return yield* unconfirmed
            }
            yield* Effect.logInfo(`Answering ${act.requestId} once more under ${taken.value.commandId}, as you said`)
            return yield* dispatch(taken.value, reached.right, true)
          }),
        )
      const outcome: Went = earlier === undefined || earlier.state === "refused" || earlier.state === "abandoned" ? yield* fresh : yield* resend(earlier)
      return outcome._tag === "Refused" && outcome.reason === answeredElsewhere ? ({ _tag: "Moot" } satisfies Outcome) : outcome
    })

  /**
   * Withdraws the message just sent while it's still in the queue; once it's
   * been read, it can only be told to ignore it. It's only ever the last thing
   * done, never anything before it.
   */
  const withdraw = (step: Step, to: Option.Option<Threads.Ref>, wanted: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      const last = yield* ledger.latest(scratch, Option.match(to, { onNone: () => ({}), onSome: ({ machine, id }) => ({ machine, thread: id }) }))
      const refused = (reason: string) => failing({ _tag: "Refused", reason } satisfies Outcome, "take it back")
      if (Option.isNone(last)) return yield* refused("I haven't done anything in the last couple of minutes.")
      const row = last.value
      if (row.kind === "stop") return yield* refused("It was a stop, which carrying on takes back.")
      if (row.kind === "start") return yield* refused("Starting work can't be taken back yet.")
      const messageId = row.messageId
      if (row.kind !== "message" || messageId === null) return yield* refused("There's nothing more to take back.")
      if (row.state !== "sent" && row.state !== "unknown") return yield* refused("It never went, so there's nothing to take back.")
      const ref = refOf(row)
      const reached = yield* reach(ref)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, "take a message back")
      const found = yield* Effect.either(reached.right.actions.message(row.thread, messageId))
      if (Either.isLeft(found)) {
        return yield* failing({ _tag: "NotSent", reason: plainly(found.left.reason), again: Option.none() } satisfies Outcome, "take a message back")
      }
      if (Option.isNone(found.right)) {
        // Not there yet, it may still get there: never offered to go again, and the same words said again are still asked about.
        if (row.state === "unknown") {
          yield* ledger.leave(row.commandId, "He took it back before it was found in the thread.")
          return yield* failing(
            { _tag: "Refused", reason: "It wasn't in the thread yet when I looked, so it may still get there." } satisfies Outcome,
            "take a message back",
          )
        }
        return yield* failing({ _tag: "Refused", reason: "I can't find it in the thread." } satisfies Outcome, "take a message back")
      }
      const run = found.right.value.run
      if (Option.isSome(run) && run.value.status === "queued") {
        const runId = run.value.id
        const cancelled = yield* once(step, "undo", ref, () => ({ _tag: "Cancel", runId, messageId }), reached.right, wanted)
        // Withdrawn, it's nothing to take back again, nor what "I sent that a minute ago" means.
        if (cancelled._tag === "Done") yield* ledger.settle(row.commandId, "abandoned", { reason: Ledger.withdrawn })
        return cancelled
      }
      yield* Effect.logInfo(`${row.commandId} was read already, so it can only be told to ignore it`)
      return { _tag: "Read", row } satisfies Outcome
    })

  /**
   * Not confirmed after a restart, it's said once, with why, and never done
   * again. A message stays as it may be, never offered again on its own, so
   * the same words said again find it, and are offered under its own ids.
   * Only while it's as it was read: what came of it since, like his yes or no
   * to sending it again, stands, and was said then, so nothing is given back.
   * A message is noted as never to be offered in the same write: noted
   * first, it would be there to offer, for this reason, to anything reading
   * it in between. What's said is the reason as it is. One yapd's database
   * couldn't write is said all the same, since nothing else will say it,
   * and stays as it was, for the next restart to look at again.
   */
  const unverified = (row: Ledger.Row, reason: string) =>
    Effect.gen(function* () {
      const noted = row.kind === "message" ? { state: "unknown" as const, reason: Ledger.leftBe(reason) } : { state: "abandoned" as const, reason }
      if ((yield* ledger.settle(row.commandId, noted.state, { reason: noted.reason, as: row })) === "stale") return Option.none<Ledger.Row>()
      yield* Effect.logWarning(`Couldn't confirm ${row.commandId} went through before restarting: ${reason}`)
      return Option.some<Ledger.Row>({ ...row, reason })
    })

  /**
   * What came of new work asked for before a restart, by the checks a launch
   * waits on, and waited for while T3 Code is still getting it ready, as long
   * after it was asked for as a launch would be, since a thread made for it
   * doesn't say it started: unless it began, it's given back with why, to say.
   * One T3 Code still hasn't put the work in by then is taken as not found,
   * since it may yet put it in.
   */
  const launched = (row: Ledger.Row) =>
    Effect.gen(function* () {
      const from = [row.state]
      const thread = yield* T3CodeLauncher.readied(threads.find(refOf(row)), row.at)
      const ended = Option.flatMap(thread, (thread) => T3CodeLauncher.unstarted(thread, Option.exists(request(row.body), ({ worktree }) => worktree === true)))
      if (Option.exists(thread, (thread) => T3CodeLauncher.progress(thread) === "begun")) {
        yield* ledger.settle(row.commandId, "sent", { from })
        yield* Effect.logInfo(`Found ${row.commandId} started after restarting`)
        return Option.none<Ledger.Row>()
      }
      if (Option.isNone(ended)) return yield* unverified(row, Option.isSome(thread) ? gettingReady : unconfirmable)
      yield* ledger.settle(row.commandId, "failed", { reason: ended.value, from })
      yield* Effect.logWarning(`${row.commandId} didn't start before restarting: ${ended.value}`)
      return Option.some<Ledger.Row>({ ...row, state: "failed", reason: ended.value })
    })

  /** What a restart finds never said what came of it, on the machines `on` picks, as `reconcile` and `reconcileOn` say. */
  const reconciling = (on: (machine: string) => boolean) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const open = yield* ledger.open(0)
      const undelivered: Array<Ledger.Row> = []
      const unconfirmed: Array<Ledger.Row> = []
      const readying: Array<Ledger.Row> = []
      // What this run did is settled, or offered again, as it happens.
      for (const row of open.filter(({ at, machine }) => at < started && on(machine))) {
        // Only from where it was, in case something came of it since it was read.
        const from = [row.state]
        const actions = threads.actions(row.machine)
        if (Option.isNone(actions)) {
          unconfirmed.push(...Option.toArray(yield* unverified(row, `I can't reach the threads on ${row.machine} right now.`)))
          continue
        }
        // New work T3 Code is still getting ready is waited for on its own, so nothing else waits behind it, and what isn't is told now.
        if (row.kind === "start") {
          if (Option.exists(yield* threads.find(refOf(row)), (thread) => readies.includes(T3CodeLauncher.progress(thread)))) readying.push(row)
          else unconfirmed.push(...Option.toArray(yield* launched(row)))
          continue
        }
        const found = yield* Effect.either(landed(row, actions.value))
        if (Either.isLeft(found)) {
          unconfirmed.push(...Option.toArray(yield* unverified(row, `I couldn't look for it just now: ${after(plainly(found.left.reason))}`)))
          continue
        }
        if (found.right) {
          yield* ledger.settle(row.commandId, "sent", { ...(row.how === null ? {} : { how: row.how }), from })
          yield* Effect.logInfo(`Found ${row.commandId} after restarting: it got there`)
        } else if (row.kind !== "message") unconfirmed.push(...Option.toArray(yield* unverified(row, unconfirmable)))
        // Too long ago to send again, it's only said.
        else if (now - row.at > recent) unconfirmed.push(...Option.toArray(yield* unverified(row, tooLong)))
        // Only while it's as it was read, since his no to sending it again, or a yes that never left yapd, only change its reason: that
        // stands, so it's never offered again.
        else {
          const noted = yield* ledger.settle(row.commandId, "unknown", { reason: "I couldn't find it in the thread after restarting.", as: row })
          if (noted === "noted") {
            yield* Effect.logWarning(`${row.commandId} isn't in the thread after restarting, so I'll offer to send it again`)
            undelivered.push(row)
          }
          // Not written, a yes to sending it again couldn't be kept track of either, so it's only said, with why.
          if (noted === "unwritten") {
            yield* Effect.logWarning(`${row.commandId} isn't in the thread after restarting, and I couldn't note it down to offer it`)
            unconfirmed.push({ ...row, reason: unnoted })
          }
        }
      }
      // A turn stopped to be told something in its place, or let go of its queue to be asked to carry on, that yapd restarted before
      // telling: it's never told now, only said, once.
      for (const row of yield* ledger.steps(now - followed, { kinds: ["stop", "undo"], states: ["sent"] })) {
        const next = Option.flatMap(command(row.body), (body) => (body._tag === "Stop" || body._tag === "Resume" ? Option.fromNullable(body.then) : Option.none()))
        if (row.at >= started || !on(row.machine) || row.reason !== null || Option.isNone(next)) continue
        if (Option.isSome(yield* ledger.get(Ledger.ids(row.utterance, row.step + 1, true).commandId))) continue
        yield* ledger.settle(row.commandId, "sent", { reason: unfollowed, from: ["sent"] })
        yield* Effect.logWarning(`${row.commandId} went, but I restarted before I could do what came next: ${next.value}`)
        unconfirmed.push({ ...row, reason: unfollowed })
      }
      return {
        undelivered,
        unconfirmed,
        readying: Effect.map(Effect.forEach(readying, launched, { concurrency: "unbounded" }), (rows) => rows.flatMap(Option.toArray)),
      } satisfies Reconciled
    })

  return {
    run: (step, act, options = {}) => {
      const wanted = options.wanted ?? Effect.succeed(true)
      switch (act._tag) {
        case "Message":
          return message(step, act, options.twice === true, wanted, options.since)
        case "Decide":
        case "Reply":
          return respond(step, act, wanted)
        case "Stop":
          return stop(step, act.to, wanted)
        case "Undo":
          return act.carry ? carry(step, act.to, wanted) : withdraw(step, act.to, wanted)
      }
    },
    // Taken to send again, it's seen through, as a step is once written.
    again: (commandId, options = {}) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const retimed = yield* retime(commandId, options.how)
          if (Option.isSome(retimed)) return retimed.value
          const taken = yield* ledger.resending(commandId)
          if (Option.isNone(taken)) {
            // Sent again already, or it's come to something since: that stands.
            const row = yield* ledger.get(commandId)
            return Option.match(row, {
              onNone: (): Outcome => ({ _tag: "Refused", reason: "I've no record of that any more." }),
              onSome: (row): Outcome => (row.state === "abandoned" ? { _tag: "NotSent", reason: "I've sent that once more already.", again: Option.none() } : settled(row)),
            })
          }
          const row = taken.value
          const reached = yield* reach(refOf(row))
          if (Either.isLeft(reached)) {
            yield* unsent(row)
            return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing[row.kind])
          }
          // T3 Code takes nothing into a turn that's waiting, so a message for now goes in its queue behind it, as one sent fresh does: under
          // the same ids, so one it has from the first time is done once all the same, and goes in as it did then.
          const waiting = Option.exists(went(row), ({ how }) => how !== "after") ? waits(reached.right.thread) : undefined
          yield* Effect.logInfo(`Sending ${row.commandId} once more, as you said${waiting === undefined ? "" : ", behind the turn under way, which is waiting"}`)
          const sent = yield* dispatch(row, reached.right, true, waiting === undefined ? undefined : "after")
          // Waiting in a queue on hold, it waits on that first, whatever the turn does.
          return sent._tag === "Done" && waiting !== undefined && sent.how === "queued" && sent.waiting === undefined ? { ...sent, waiting } : sent
        }),
      ),
    leave: (commandId, reason) =>
      Effect.zipRight(ledger.leave(commandId, reason), Effect.logInfo(`Not offering ${commandId} again: ${reason}`)),
    still: (commandId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return Option.filter(yield* ledger.get(commandId), (row) => Ledger.offerable(row) && now - row.at <= recent)
      }),
    keeps: (to, text) =>
      Effect.gen(function* () {
        const reached = yield* reach(to)
        return Either.isRight(reached) && (yield* keeping(to, reached.right, text)) !== undefined
      }),
    reconcile: reconciling(() => true),
    reconcileOn: reconciling,
  }
}

// ---------------------------------------------------------------- what's said

const counted = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

/** How long ago, the way it's said: "a minute ago", "three minutes ago". */
export const ago = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes < 2 ? "a minute ago" : `${counted[minutes] ?? String(minutes)} minutes ago`
}

/** A confirmation, naming the thread after it when it isn't the one he's on about: "On it, sir: the Tezos migration.", or "Right away, sir: the Tezos migration." */
export const naming = (line: string, called: Option.Option<string>) =>
  Option.match(called, { onNone: () => line, onSome: (name) => `${line.trim().replace(/[.!]+$/, "")}: ${name}.` })

/**
 * Whether a message told to a turn yapd stopped for it waits in the queue the
 * stop held, which nothing lets go of but his word to carry on.
 */
export const held = (outcome: { readonly how: Ledger.How; readonly stopped?: boolean | "ended" }) => outcome.stopped === true && outcome.how === "queued"

/**
 * What's said once it's done, naming the thread when it isn't the one he's on
 * about, why a message he wanted in at once waits in the queue, when it does,
 * and how the turn a message sent once more started or went into has ended,
 * when it has.
 */
export const done = (
  act: Act,
  how: Ledger.How,
  lines: Lines,
  called: Option.Option<string>,
  as: { readonly waiting?: Waiting; readonly stopped?: boolean | "ended"; readonly ended?: Ended } = {},
) => {
  const { waiting } = as
  // In place of the turn under way, done as a stop and then the message, which T3 Code may still have put in the queue the stop held, where it stays till he says.
  if (held({ how, ...as })) return `Stopped ${Option.getOrElse(called, () => "it")}${addressed(lines)}, but that's held in its queue till you say carry on.`
  // Named in the sentence, since a name after "told it" would sound like what it was told.
  if (as.stopped === true) return `Stopped ${Option.getOrElse(called, () => "it")}${addressed(lines)}, and told it.`
  // Sent once more, T3 Code had it from the first time, and its turn has ended since, so nothing's at work on it to be said to be.
  if (as.ended !== undefined) {
    const went = `That went ${Option.match(called, { onNone: () => "in", onSome: (name) => `to ${name}` })}${addressed(lines)}`
    // Not known to have finished, it isn't said to have been dealt with, nor cut short when it isn't known to have been.
    if (as.ended === "ended") return `${went}.`
    // Its work was undone in T3 Code since, so it's neither dealt with nor still to be.
    if (as.ended === "rolled") return `${went}, but it's been rolled back since.`
    return as.ended === "finished" ? `${went}, and it's been dealt with.` : `${went}, but the turn it ${how === "steered" ? "went into" : "started"} was cut short.`
  }
  if (waiting !== undefined) {
    // On hold, its queue may be behind a turn begun since, so it isn't said to be stopped.
    if (waiting === "held") return `${Option.match(called, { onNone: () => "Its", onSome: (name) => `${capital(name)}'s` })} queue is on hold${addressed(lines)}, so that will go once it's let carry on.`
    const it = Option.match(called, { onNone: () => "It's", onSome: (name) => `${capital(name)} is` })
    return waiting === "asked"
      ? `${it} waiting on you for something${addressed(lines)}, so that will go once it's dealt with.`
      : `${it} finishing something off${addressed(lines)}, so that will go once it's done.`
  }
  // A message that went as the answer to what the thread was waiting on, which he's told, since it's not what he asked for.
  if (act._tag === "Reply" && act.as === "message") return `${naming(lines.onIt, called)} It was waiting on a question, so that's its answer.`
  return naming(
    act._tag === "Stop"
      ? lines.stopped
      : act._tag === "Undo"
        ? act.carry
          ? lines.carrying
          : `Withdrawn${addressed(lines)}.`
        : act._tag === "Decide"
          ? act.decision === "decline"
            ? lines.declined
            : lines.approved
          : act._tag === "Reply"
            ? Option.match(act.said, { onNone: () => lines.onIt, onSome: (said) => `${capital(said)} it is${addressed(lines)}.` })
            : how === "queued"
              ? lines.queued
              : lines.onIt,
    called,
  )
}

/**
 * Whether what's said once it's done is the line for going ahead, which he
 * can have lines of his own for, a different one each time: for a message
 * that went in as asked, not one that waits, was told to a turn stopped for
 * it, or whose turn has ended since; and for an answer to a thread's question
 * that isn't said back as the option he picked, like one in his own words or
 * a message that went as its answer.
 */
export const goesAhead = (
  act: Act,
  how: Ledger.How,
  as: { readonly waiting?: Waiting; readonly stopped?: boolean | "ended"; readonly ended?: Ended } = {},
) =>
  act._tag === "Reply"
    ? act.as === "message" || Option.isNone(act.said)
    : act._tag === "Message" && how !== "queued" && as.stopped !== true && as.ended === undefined && as.waiting === undefined

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** A reason as it's said after a colon: lowercase, unless it starts with "I" or a name like T3 Code. */
const after = (reason: string) => (/^(I\b|I'|[A-Z][A-Z\d])/.test(reason) ? reason : `${reason.charAt(0).toLowerCase()}${reason.slice(1)}`)

/** What's said when it didn't go, with why, and whether to send it again when it may. */
export const failed = (act: Act, outcome: Extract<Outcome, { readonly reason: string }>, lines: Lines, called: Option.Option<string>) => {
  const sir = addressed(lines)
  const name = Option.getOrUndefined(called)
  const reason = after(outcome.reason)
  const asking = "again" in outcome && Option.isSome(outcome.again) ? ` ${unaddressed(lines.again, lines)}` : ""
  switch (act._tag) {
    case "Message":
      // Given something else since what it answers, it's held back, which is as he'd want.
      if (outcome.reason === given) return `You've given ${name ?? "it"} something else since${sir}, so I held that back.`
      // In place of the turn under way, done as a stop first: the stop that didn't go, so the message never went, or what came of the message after it, which may never have been sent.
      if (outcome.stopped === false) {
        return outcome._tag === "Unknown" ? `I couldn't confirm ${name ?? "it"} stopped${sir}, so I didn't tell it.` : `I couldn't stop ${name ?? "it"} to tell it that${sir}: ${reason}`
      }
      if (outcome.stopped === true) {
        return outcome._tag === "Refused"
          ? `I stopped ${name ?? "it"}${sir}, but the message didn't go through: ${reason}`
          : outcome._tag === "NotSent"
            ? Option.isNone(outcome.again)
              ? `I stopped ${name ?? "it"}${sir}, but couldn't tell it yet: ${reason}`
              : `I stopped ${name ?? "it"}${sir}, but the message didn't get there: ${reason}${asking}`
            : `I stopped ${name ?? "it"}${sir}, but couldn't confirm the message got there.${asking}`
      }
      // Sent once more, T3 Code had it from the first time, so what's said is what became of it since.
      if (outcome.reason === takenOut || outcome.reason === notThere) return `That got ${name === undefined ? "there" : `to ${name}`} the first time${sir}, but ${reason}`
      // Sent once more, T3 Code has it, from the first time or now, but whether it's still to be read couldn't be looked at, and why is said.
      if (outcome.reason.startsWith(unchecked)) return `That got ${name === undefined ? "there" : `to ${name}`}${sir}, but ${reason}`
      // Not sent again at another time, it's left, which isn't something that went wrong.
      if (outcome._tag === "Refused" && outcome.reason.startsWith(mayHave)) return `I left ${name === undefined ? "it" : `your message to ${name}`}${sir}: ${reason}`
      return outcome._tag === "Refused"
        ? `${name === undefined ? "That didn't go through" : `That didn't go to ${name}`}${sir}: ${reason}`
        : outcome._tag === "NotSent"
          ? `${name === undefined ? "That didn't get there" : `That didn't get to ${name}`}${sir}: ${reason}${asking}`
          : `I couldn't confirm it got ${name === undefined ? "there" : `to ${name}`}${sir}.${asking}`
    case "Stop":
      // Nothing to stop is all there is to say.
      if (outcome._tag === "Refused" && idle(reason)) return `${name === undefined ? "It" : capital(name)} isn't doing anything right now${sir}.`
      return outcome._tag === "Unknown" ? `I couldn't confirm ${name ?? "it"} stopped${sir}.` : `I couldn't stop ${name ?? "it"}${sir}: ${reason}`
    case "Undo":
      if (act.carry) {
        // Going already is what he wanted, not something that went wrong.
        if (outcome.reason === carriedOn) return `I've already let ${name ?? "it"} carry on${sir}.`
        if (outcome.reason === backAtWork) return `${name === undefined ? "It's" : `${capital(name)} is`} already back at work${sir}.`
        return outcome._tag === "Unknown"
          ? `I couldn't confirm ${name ?? "it"} got the word to carry on${sir}.${asking}`
          : `I couldn't get ${name ?? "it"} going again${sir}: ${reason}${asking}`
      }
      return outcome._tag === "Unknown" ? `I couldn't confirm it was withdrawn${sir}.` : `I couldn't take that back${sir}: ${reason}`
    case "Decide":
    case "Reply": {
      const answer = act._tag === "Reply" ? "your answer" : act.decision === "decline" ? "your no" : "your go-ahead"
      // Not known to have got there, and not risked again, it's T3 Code's to show, which he's told plainly.
      if (outcome.reason === unconfirmedAnswer) return `I couldn't confirm ${name ?? "it"} got ${answer} before${sir}, so I won't risk sending it again: it needs T3 Code.`
      return outcome._tag === "Unknown" ? `I couldn't confirm ${name ?? "it"} got ${answer}${sir}.` : `I couldn't get ${answer} to ${name ?? "it"}${sir}: ${reason}`
    }
  }
}

/** That the same words went to the same thread lately: "I sent that a minute ago, sir." */
export const sentBefore = (sent: number, now: number, lines: Lines, called: Option.Option<string>) =>
  `I sent that${Option.match(called, { onNone: () => "", onSome: (name) => ` to ${name}` })} ${ago(now - sent)}${addressed(lines)}.`

/** That the same words may not have got to the same thread when they went lately, said instead of offering to send them again. */
export const unconfirmedBefore = (lines: Lines) => `I couldn't confirm that got there before${addressed(lines)}, so I haven't sent it again.`

/** That the same words never left yapd when they went to the same thread lately, said instead of offering to send them again, which dictating them does. */
export const unsentBefore = (lines: Lines) => `That didn't get there before${addressed(lines)}, so I haven't sent it: say it to me with the shortcut to send it again.`

/** What `twice` asks on its own, after saying the same words went lately. */
export const twiceAsks = "Again?"

/** Asked when the same words went to the same thread lately, and it hasn't said anything since. */
export const twice = (sent: number, now: number, lines: Lines, called: Option.Option<string>) => `${sentBefore(sent, now, lines, called)} ${twiceAsks}`

/** That a message he wants back was read already. */
export const readAlready = (lines: Lines, called: Option.Option<string>) =>
  `${Option.match(called, { onNone: () => "It's", onSome: (name) => `${capital(name)} has` })} already read it${addressed(lines)}.`

/** What `read` offers on its own, after saying the message was read already. */
export const readAsks = "Shall I tell it to ignore that?"

/** Offered when a message he wants back was read already. */
export const read = (lines: Lines, called: Option.Option<string>) => `${readAlready(lines, called)} ${readAsks}`

/**
 * Said after a restart, for a step other than a message that couldn't be
 * confirmed, which isn't done again, with why when it's more than that; for
 * new work found not to have started, with why; or for a stop, or a queue let
 * go of, that went, when what was to follow never did.
 */
export const unsure = (
  row: Pick<Ledger.Row, "kind" | "body"> & { readonly state?: Ledger.State },
  lines: Lines,
  called: Option.Option<string>,
  why: string = unconfirmable,
) => {
  const name = Option.getOrUndefined(called)
  const sent = command(row.body)
  if (row.kind === "start" && row.state === "failed") return `Before I restarted, I asked for new work${addressed(lines)}, but ${after(why)}`
  if (why === unfollowed) {
    return row.kind === "stop"
      ? `Before I restarted, I stopped ${name ?? "the work"}${addressed(lines)}, but didn't get to tell it what to do instead.`
      : `Before I restarted, I let ${name ?? "the work"} go again${addressed(lines)}, but didn't get to ask it to carry on.`
  }
  const what =
    row.kind === "stop"
      ? `${name ?? "the work"} stopped`
      : row.kind === "decide" || row.kind === "reply"
        ? `your answer${name === undefined ? "" : ` to ${name}`} got there`
        : row.kind === "start"
        ? "the new work you asked for started"
        : Option.exists(sent, ({ _tag }) => _tag === "Resume")
          ? `${name ?? "the work"} was going again`
          : Option.exists(sent, ({ _tag }) => _tag === "Cancel")
            ? `your message${name === undefined ? "" : ` to ${name}`} was withdrawn`
            : `what I last did${name === undefined ? "" : ` to ${name}`} went through`
  return `Before I restarted, I couldn't confirm ${what}${addressed(lines)}.${why === unconfirmable ? "" : ` ${why}`}`
}

/** Said after a restart, for a message that wasn't found where it went and can't be offered to go again, with why, like "It's too long ago to send it again now." */
export const unoffered = (lines: Lines, called: Option.Option<string>, why: string) =>
  `Before I restarted, I couldn't confirm your message${Option.match(called, { onNone: () => "", onSome: (name) => ` to ${name}` })} got there${addressed(lines)}, and ${after(why).replace(/[.!?]+$/, "")}.`

/** Said after a restart, for a message that wasn't found where it went, before offering to send it again. */
export const missing = (lines: Lines, called: Option.Option<string>) =>
  `Before I restarted, I couldn't confirm your message${Option.match(called, { onNone: () => "", onSome: (name) => ` to ${name}` })} got there${addressed(lines)}.`

/** Offered after a restart, for a message that wasn't found where it went. */
export const lost = (lines: Lines, called: Option.Option<string>) => `${missing(lines, called)} ${unaddressed(lines.again, lines)}`
