import { Clock, Context, Duration, Effect, Either, Option, Schema } from "effect"
import * as Brain from "./Brain.ts"
import * as Ledger from "./Ledger.ts"
import { addressed, type Lines, unaddressed } from "./Persona.ts"
import * as T3Actions from "./T3Actions.ts"
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
      /** Wanted at once, it went into T3 Code's queue instead, since the turn under way is waiting: on him, or finishing off. */
      readonly waiting?: Waiting
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

/** What came of a step that was written down: gone, turned down, never sent or unknown. */
type Went = Exclude<Outcome, { readonly _tag: "Twin" | "Read" }>

/** What the turn under way waits on: something it asked him, or its last bits of work. */
export type Waiting = "asked" | "finishing"

/** What a restart's look found never said what came of it. */
export interface Reconciled {
  /** Messages that didn't get there, each to be offered once to go again. */
  readonly undelivered: ReadonlyArray<Ledger.Row>
  /**
   * Steps it couldn't confirm, like a stop, new work, or a message too long
   * ago to send again or that it couldn't look for, each with why, to be said
   * once, and never done again.
   */
  readonly unconfirmed: ReadonlyArray<Ledger.Row>
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
     * again, which isn't asked about a second time. `wanted` is whether what
     * comes after a step of it that went, like telling a turn it stopped, may
     * still be done: never once yapd was turned off since it was said (I8).
     */
    readonly run: (step: Step, act: Act, options?: { readonly twice?: boolean; readonly wanted?: Effect.Effect<boolean> }) => Effect.Effect<Outcome>
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
     * lately, to offer, and whatever else it couldn't confirm, to say so.
     */
    readonly reconcile: Effect.Effect<Reconciled>
    /** A message a restart found didn't get there, while it's still to be offered: nothing came of it since, and it's recent enough to. */
    readonly still: (commandId: string) => Effect.Effect<Option.Option<Ledger.Row>>
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
/** Why a message that may not have got there isn't offered to go again. */
export const tooLong = "It's too long ago to send it again now."
/** What a stop is noted with once it's been let carry on, so it's never let carry on twice. */
const carried = "Carried on since."
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
/** What a stopped thread is told when it's let carry on. */
export const carryOn = "Please carry on where you left off."
/** What a thread that read a message already is told when it's taken back. */
export const ignore = (text: string) => `Please ignore my last message ("${text.trim()}") and carry on as you were.`

/** The commands kept in the ledger, read back to send again. */
const Body = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Send"), text: Schema.String, messageId: Schema.String, how: Schema.Literal("now", "after", "restart") }),
  Schema.Struct({ _tag: Schema.Literal("Stop") }),
  Schema.Struct({ _tag: Schema.Literal("Resume") }),
  Schema.Struct({ _tag: Schema.Literal("Cancel"), runId: Schema.String, messageId: Schema.optionalWith(Schema.String, { exact: true }) }),
)
const command = Schema.decodeUnknownOption(Body)

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

/** Why what comes after a step that went isn't done, once yapd was turned off since he said it (I8). */
export const switchedOff = "yapd was turned off before I could."

/** Why a turn stopped to be told something in its place wasn't told, when nothing noted why. */
const untold = "I didn't get to tell it."

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

/** Hands that reach threads through `threads` and write each step in `ledger` first. */
export const make = (options: {
  /** Where each thread is, and what reaches its machine. */
  readonly threads: Pick<Threads.Threads["Type"], "find" | "actions">
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
      if (Option.isNone(thread)) return Either.left("I can't find it among your threads right now.")
      if (thread.value.archivedAt !== null) return Either.left("It's been archived.")
      if (thread.value.lineage?.relationshipToParent === "subagent") return Either.left("It's part of another thread, and takes nothing on its own.")
      return Either.right({ actions: actions.value, thread: thread.value })
    })

  /** Whether a step that may not have got there did, looked for once in the thread. */
  const landed = (row: Ledger.Row, actions: T3Actions.Actions): Effect.Effect<boolean, T3CodeServer.Trouble> => {
    const sent = command(row.body)
    if (row.messageId !== null && row.kind === "message") return actions.has(row.thread, row.messageId)
    if (row.kind === "stop") return Effect.map(actions.running(row.thread), (running) => !running)
    if (Option.isSome(sent) && sent.value._tag === "Cancel") {
      // Withdrawn, T3 Code drops the run, and its message, from the thread, or shows it cancelled. One that started meanwhile is being read,
      // as is one he steered into the turn under way, which cancels the run it waited in too, but keeps the message.
      const { runId, messageId } = sent.value
      if (messageId === undefined) return Effect.map(actions.detail(row.thread), ({ runs }) => !runs.some(({ id, status }) => id === runId && status !== "cancelled"))
      return Effect.map(
        actions.message(row.thread, messageId),
        Option.match({
          onNone: () => true,
          onSome: ({ intent, run }) => !Option.exists(intent, steeredIn) && Option.exists(run, ({ status }) => status === "cancelled"),
        }),
      )
    }
    return Effect.succeed(false)
  }

  /** How a message went in, as the thread says: into the turn under way, behind it, or at once. */
  const entered = (row: Ledger.Row, actions: T3Actions.Actions, wasBusy: boolean, how: T3Actions.When) =>
    Effect.gen(function* () {
      const fallback: Ledger.How = how === "after" ? "queued" : "now"
      if (row.kind !== "message" || row.messageId === null || !(wasBusy || how === "after")) return fallback
      const intent = yield* actions.inputIntent(row.thread, row.messageId).pipe(Effect.orElseSucceed(() => Option.none<T3Actions.Intent>()))
      return Option.match(intent, {
        onNone: () => fallback,
        onSome: (intent): Ledger.How =>
          steeredIn(intent) ? "steered" : intent === "queued_turn" ? "queued" : "now",
      })
    })

  /**
   * Sending it once more never left yapd, so it wasn't sent again: the step
   * is put back as it was, never offered again on its own, so the same words
   * said again find it, and his yes can still send it under its ids.
   */
  const unsent = (row: Ledger.Row, reason: string) =>
    Effect.zipRight(
      ledger.settle(row.commandId, row.state === "failed" ? "failed" : "unknown", { reason, from: ["abandoned"] }),
      ledger.leave(row.commandId, "Sending it again never left yapd."),
    )

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
   * left yapd, which isn't sending it. `at` is when a message goes in this
   * time, when T3 Code can't take it as it first went, still under its ids.
   */
  const dispatch = (row: Ledger.Row, actions: T3Actions.Actions, wasBusy: boolean, last = false, at?: T3Actions.When): Effect.Effect<Went> =>
    Effect.gen(function* () {
      const what = doing[row.kind]
      const read = command(row.body)
      if (Option.isNone(read)) {
        yield* ledger.settle(row.commandId, "abandoned", { reason: "I couldn't read back what to send." })
        return yield* failing({ _tag: "NotSent", reason: "I couldn't read back what to send.", again: Option.none() }, what)
      }
      const sent = read.value._tag === "Send" && at !== undefined ? { ...read.value, how: at } : read.value
      const how = sent._tag === "Send" ? sent.how : "now"
      const again = row.kind === "message" && !last ? Option.some(row.commandId) : Option.none<string>()
      const result = yield* Effect.either(actions.run(row.thread, sent, row.commandId))
      if (Either.isRight(result)) {
        const entry = yield* entered(row, actions, wasBusy, how)
        yield* ledger.settle(row.commandId, "sent", { how: entry })
        yield* Effect.logInfo(`Dispatched ${row.commandId} → sent (${entry})`)
        return { _tag: "Done", how: entry, to: refOf(row) } satisfies Outcome
      }
      const error = result.left
      const reason = plainly(T3Actions.reason(error))
      if (error._tag === "Refusal") {
        yield* ledger.settle(row.commandId, "refused", { reason })
        return yield* failing({ _tag: "Refused", reason } satisfies Outcome, `${what}, T3 Code turned it down`)
      }
      if (error.sent !== true) {
        yield* last ? unsent(row, reason) : ledger.settle(row.commandId, "failed", { reason })
        return yield* failing({ _tag: "NotSent", reason, again } satisfies Outcome, `${what}, it never went`)
      }
      // It went, and may have been done: looked for once, never sent again on its own.
      const found = yield* Effect.either(landed(row, actions))
      if (Either.isRight(found) && found.right) {
        const entry = yield* entered(row, actions, wasBusy, how)
        yield* ledger.settle(row.commandId, "sent", { how: entry })
        yield* Effect.logInfo(`Dispatched ${row.commandId} → sent (${entry}), found after: ${reason}`)
        return { _tag: "Done", how: entry, to: refOf(row) } satisfies Outcome
      }
      yield* ledger.settle(row.commandId, last ? "abandoned" : "unknown", { reason })
      return yield* failing({ _tag: "Unknown", reason, again } satisfies Outcome, `${what}, and couldn't tell whether it went`)
    })

  /**
   * Writes the step in the ledger and sends it, unless it's there already,
   * when what came of it stands. Once written, it's seen through: stopped
   * between the two, it would be left as if it may have gone when it didn't,
   * and stopped while it's sent, as if it never went when it may have.
   */
  const once = (
    step: Step,
    kind: Ledger.Kind,
    to: Threads.Ref,
    body: (ids: { readonly commandId: string; readonly messageId: string | null }) => T3Actions.Command,
    reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread },
    digest?: string,
  ) =>
    Effect.uninterruptible(
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
        return yield* dispatch(prepared.right, reached.actions, busy(reached.thread))
      }),
    )

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

  const message = (step: Step, act: Extract<Act, { readonly _tag: "Message" }>, twice: boolean, wanted: Effect.Effect<boolean>) =>
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
      const sent = yield* once(step, "message", to, ({ messageId }) => ({ _tag: "Send", text, messageId: messageId ?? "", how }), reached.right, digest)
      return sent._tag === "Done" && waiting !== undefined ? { ...sent, waiting } : sent
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
   * ended just before the stop got there, it's just told at once.
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
      const send = (at: Step) => once(at, "message", to, ({ messageId }) => ({ _tag: "Send", text, messageId: messageId ?? "", how: "now" }), reached, digest)
      /** Not told after all, with why, noted with a stop that went, so the same step worked out again says the same. */
      const notTold = (reason: string, stopped: true | "ended") =>
        Effect.gen(function* () {
          if (stopped === true) yield* ledger.settle(Ledger.ids(step.utterance, step.step, false).commandId, "sent", { reason, from: ["sent"] })
          return yield* failing({ _tag: "NotSent", reason, again: Option.none(), stopped } satisfies Outcome, "tell it what to do instead")
        })
      if (!busy(reached.thread)) return yield* send(step)
      yield* Effect.logInfo(`Stopping its turn, which is ${reached.thread.activityRunStatus ?? "busy"}, to tell it something in its place`)
      const stopped = yield* once(step, "stop", to, () => ({ _tag: "Stop" }), reached)
      const next = { ...step, step: step.step + 1 }
      if (stopped._tag === "Refused" && idle(stopped.reason)) {
        if (!(yield* wanted)) return yield* notTold(switchedOff, "ended")
        yield* Effect.logInfo("Its turn ended just before it was stopped, so telling it at once")
        return { ...(yield* send(next)), stopped: "ended" } satisfies Outcome
      }
      if (stopped._tag !== "Done") return { ...stopped, stopped: false } satisfies Outcome
      const after = yield* watch(to, reached.thread, busy, stopping, wanted)
      if (!(yield* wanted)) return yield* notTold(switchedOff, true)
      if (busy(after)) return yield* notTold(windingDown, true)
      return { ...(yield* send(next)), stopped: true } satisfies Outcome
    })

  const stop = (step: Step, to: Threads.Ref) =>
    Effect.gen(function* () {
      const reached = yield* reach(to)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing.stop)
      return yield* once(step, "stop", to, () => ({ _tag: "Stop" }), reached.right)
    })

  /**
   * Lets a thread yapd stopped carry on: lets go of its queue, then asks it to
   * pick up where it was, while that's still `wanted`; or, told something in
   * place of what it was stopped from that waits in that queue, only lets go.
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
      const resumed = yield* once(step, "undo", ref, () => ({ _tag: "Resume" }), reached.right)
      if (instead) {
        if (resumed._tag === "Done") yield* ledger.settle(stopped.value.commandId, "abandoned", { reason: carried, from: ["sent"] })
        return resumed
      }
      // Nothing held is nothing to let go of, which doesn't stop it carrying on.
      if (resumed._tag !== "Done" && resumed._tag !== "Refused") return resumed
      if (!(yield* wanted)) return yield* failing({ _tag: "NotSent", reason: switchedOff, again: Option.none() } satisfies Outcome, "ask it to carry on")
      const told = yield* once(
        { ...step, step: step.step + 1 },
        "message",
        ref,
        ({ messageId }) => ({ _tag: "Send", text: carryOn, messageId: messageId ?? "", how: "now" }),
        reached.right,
        Ledger.digest(carryOn),
      )
      // Let carry on, the stop is taken back, and isn't taken back twice.
      if (told._tag === "Done") yield* ledger.settle(stopped.value.commandId, "abandoned", { reason: carried, from: ["sent"] })
      return told
    })

  /**
   * Withdraws the message just sent while it's still in the queue; once it's
   * been read, it can only be told to ignore it. It's only ever the last thing
   * done, never anything before it.
   */
  const withdraw = (step: Step, to: Option.Option<Threads.Ref>) =>
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
        const cancelled = yield* once(step, "undo", ref, () => ({ _tag: "Cancel", runId, messageId }), reached.right)
        // Withdrawn, it's nothing to take back again, nor what "I sent that a minute ago" means.
        if (cancelled._tag === "Done") yield* ledger.settle(row.commandId, "abandoned", { reason: Ledger.withdrawn })
        return cancelled
      }
      yield* Effect.logInfo(`${row.commandId} was read already, so it can only be told to ignore it`)
      return { _tag: "Read", row } satisfies Outcome
    })

  return {
    run: (step, act, options = {}) => {
      const wanted = options.wanted ?? Effect.succeed(true)
      switch (act._tag) {
        case "Message":
          return message(step, act, options.twice === true, wanted)
        case "Stop":
          return stop(step, act.to)
        case "Undo":
          return act.carry ? carry(step, act.to, wanted) : withdraw(step, act.to)
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
            yield* unsent(row, reached.left)
            return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing[row.kind])
          }
          // T3 Code takes nothing into a turn that's waiting, so a message for now goes in its queue behind it, as one sent fresh does: under
          // the same ids, so one it has from the first time is done once all the same, and goes in as it did then.
          const waiting = Option.exists(went(row), ({ how }) => how !== "after") ? waits(reached.right.thread) : undefined
          yield* Effect.logInfo(`Sending ${row.commandId} once more, as you said${waiting === undefined ? "" : ", behind the turn under way, which is waiting"}`)
          const sent = yield* dispatch(row, reached.right.actions, busy(reached.right.thread), true, waiting === undefined ? undefined : "after")
          return sent._tag === "Done" && waiting !== undefined && sent.how === "queued" ? { ...sent, waiting } : sent
        }),
      ),
    leave: (commandId, reason) =>
      Effect.zipRight(ledger.leave(commandId, reason), Effect.logInfo(`Not offering ${commandId} again: ${reason}`)),
    still: (commandId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return Option.filter(yield* ledger.get(commandId), (row) => Ledger.offerable(row) && now - row.at <= recent)
      }),
    reconcile: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const open = yield* ledger.open(0)
      const undelivered: Array<Ledger.Row> = []
      const unconfirmed: Array<Ledger.Row> = []
      // What this run did is settled, or offered again, as it happens.
      for (const row of open.filter(({ at }) => at < started)) {
        // Only from where it was, in case something came of it since it was read.
        const from = [row.state]
        /**
         * Not confirmed, it's said once, with why, and never done again. A
         * message stays as it may be, never offered again on its own, so the
         * same words said again find it, and are offered under its own ids.
         */
        const unverified = (reason: string) =>
          Effect.gen(function* () {
            if (row.kind === "message") {
              yield* ledger.settle(row.commandId, "unknown", { reason, from })
              yield* ledger.leave(row.commandId, reason)
            } else yield* ledger.settle(row.commandId, "abandoned", { reason, from })
            yield* Effect.logWarning(`Couldn't confirm ${row.commandId} went through before restarting: ${reason}`)
            unconfirmed.push({ ...row, reason })
          })
        const actions = threads.actions(row.machine)
        if (Option.isNone(actions)) {
          yield* unverified(`I can't reach the threads on ${row.machine} right now.`)
          continue
        }
        if (row.kind === "start") {
          const thread = yield* threads.find(refOf(row))
          if (Option.isSome(thread)) yield* ledger.settle(row.commandId, "sent", { from })
          else yield* unverified(unconfirmable)
          continue
        }
        const found = yield* Effect.either(landed(row, actions.value))
        if (Either.isLeft(found)) {
          yield* unverified(`I couldn't look for it just now: ${after(plainly(found.left.reason))}`)
          continue
        }
        if (found.right) {
          yield* ledger.settle(row.commandId, "sent", { ...(row.how === null ? {} : { how: row.how }), from })
          yield* Effect.logInfo(`Found ${row.commandId} after restarting: it got there`)
        } else if (row.kind !== "message") yield* unverified(unconfirmable)
        // Too long ago to send again, it's only said.
        else if (now - row.at > recent) yield* unverified(tooLong)
        else {
          yield* ledger.settle(row.commandId, "unknown", { reason: "I couldn't find it in the thread after restarting.", from })
          yield* Effect.logWarning(`${row.commandId} isn't in the thread after restarting, so I'll offer to send it again`)
          undelivered.push(row)
        }
      }
      return { undelivered, unconfirmed } satisfies Reconciled
    }),
  }
}

// ---------------------------------------------------------------- what's said

const counted = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

/** How long ago, the way it's said: "a minute ago", "three minutes ago". */
export const ago = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes < 2 ? "a minute ago" : `${counted[minutes] ?? String(minutes)} minutes ago`
}

/** A confirmation, naming the thread after it when it isn't the one he's on about: "On it, sir: the Tezos migration." */
export const naming = (line: string, called: Option.Option<string>) =>
  Option.match(called, { onNone: () => line, onSome: (name) => `${line.trim().replace(/[.!]+$/, "")}: ${name}.` })

/**
 * Whether a message told to a turn yapd stopped for it waits in the queue the
 * stop held, which nothing lets go of but his word to carry on.
 */
export const held = (outcome: { readonly how: Ledger.How; readonly stopped?: boolean | "ended" }) => outcome.stopped === true && outcome.how === "queued"

/**
 * What's said once it's done, naming the thread when it isn't the one he's on
 * about, and why a message he wanted in at once waits in the queue, when it does.
 */
export const done = (act: Act, how: Ledger.How, lines: Lines, called: Option.Option<string>, as: { readonly waiting?: Waiting; readonly stopped?: boolean | "ended" } = {}) => {
  const { waiting } = as
  // In place of the turn under way, done as a stop and then the message, which T3 Code may still have put in the queue the stop held, where it stays till he says.
  if (held({ how, ...as })) return `Stopped ${Option.getOrElse(called, () => "it")}${addressed(lines)}, but that's held in its queue till you say carry on.`
  if (as.stopped === true) return naming(`Stopped it${addressed(lines)}, and told it.`, called)
  if (waiting !== undefined) {
    const it = Option.match(called, { onNone: () => "It's", onSome: (name) => `${capital(name)} is` })
    return waiting === "asked"
      ? `${it} waiting on you for something${addressed(lines)}, so that will go once it's dealt with.`
      : `${it} finishing something off${addressed(lines)}, so that will go once it's done.`
  }
  return naming(
    act._tag === "Stop"
      ? lines.stopped
      : act._tag === "Undo"
        ? act.carry
          ? lines.carrying
          : `Withdrawn${addressed(lines)}.`
        : how === "queued"
          ? lines.queued
          : lines.onIt,
    called,
  )
}

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
  }
}

/** That the same words went to the same thread lately: "I sent that a minute ago, sir." */
export const sentBefore = (sent: number, now: number, lines: Lines, called: Option.Option<string>) =>
  `I sent that${Option.match(called, { onNone: () => "", onSome: (name) => ` to ${name}` })} ${ago(now - sent)}${addressed(lines)}.`

/** Asked when the same words went to the same thread lately, and it hasn't said anything since. */
export const twice = (sent: number, now: number, lines: Lines, called: Option.Option<string>) => `${sentBefore(sent, now, lines, called)} Again?`

/** That a message he wants back was read already. */
export const readAlready = (lines: Lines, called: Option.Option<string>) =>
  `${Option.match(called, { onNone: () => "It's", onSome: (name) => `${capital(name)} has` })} already read it${addressed(lines)}.`

/** Offered when a message he wants back was read already. */
export const read = (lines: Lines, called: Option.Option<string>) => `${readAlready(lines, called)} Shall I tell it to ignore that?`

/** Said after a restart, for a step other than a message that couldn't be confirmed, which isn't done again, with why when it's more than that. */
export const unsure = (row: Pick<Ledger.Row, "kind" | "body">, lines: Lines, called: Option.Option<string>, why: string = unconfirmable) => {
  const name = Option.getOrUndefined(called)
  const sent = command(row.body)
  const what =
    row.kind === "stop"
      ? `${name ?? "the work"} stopped`
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
