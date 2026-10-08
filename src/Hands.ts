import { Clock, Context, Effect, Either, Option, Schema } from "effect"
import * as Ledger from "./Ledger.ts"
import { addressed, type Lines } from "./Persona.ts"
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
// into T3 Code's own queue or the turn under way, never a queue of yapd's.

/** Something to do to a thread. */
export type Act =
  | { readonly _tag: "Message"; readonly to: Threads.Ref; readonly text: string; readonly how: T3Actions.When }
  | { readonly _tag: "Stop"; readonly to: Threads.Ref }
  /** Takes back what was just done: a stop, by letting the thread carry on, or a message, by withdrawing it. */
  | { readonly _tag: "Undo"; readonly to: Option.Option<Threads.Ref>; readonly carry: boolean }

/** What came of it. */
export type Outcome =
  | { readonly _tag: "Done"; readonly how: Ledger.How; readonly to: Threads.Ref }
  /** T3 Code, or yapd looking first, said no: it's never sent again under these ids. */
  | { readonly _tag: "Refused"; readonly reason: string }
  /** It never left yapd. With `again`, it may go once more on his yes, under the same ids. */
  | { readonly _tag: "NotSent"; readonly reason: string; readonly again: Option.Option<string> }
  /** It left yapd, and wasn't found in the thread when looked for. With `again`, it may go once more on his yes, under the same ids. */
  | { readonly _tag: "Unknown"; readonly reason: string; readonly again: Option.Option<string> }
  /** The same words went to the same thread lately: asked about first, never dropped. */
  | { readonly _tag: "Twin"; readonly row: Ledger.Row }
  /** The message to withdraw was read already, so it can only be told to ignore it. */
  | { readonly _tag: "Read"; readonly row: Ledger.Row }

/** Which step of which request something is. */
export interface Step {
  readonly utterance: string
  readonly step: number
}

/** What yapd does to threads, each step once. */
export class Hands extends Context.Tag("yapd/Hands")<
  Hands,
  {
    /** Does it, once. `twice` when he said yes to sending the same words again, which isn't asked about a second time. */
    readonly run: (step: Step, act: Act, options?: { readonly twice?: boolean }) => Effect.Effect<Outcome>
    /** His yes to sending it again: the same step once more, under the same ids, and never after that (I2). */
    readonly again: (commandId: string) => Effect.Effect<Outcome>
    /**
     * He didn't take up sending it again: it's never offered again on its own,
     * but it stays as it was, so the same words said again find it, and are
     * offered again under its ids rather than sent under new ones.
     */
    readonly leave: (commandId: string, reason: string) => Effect.Effect<void>
    /** At startup: looks at what never said what came of it lately, and never sends anything (I6). Gives back the messages found not to have got there. */
    readonly reconcile: Effect.Effect<ReadonlyArray<Ledger.Row>>
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
/** How far back a restart looks at what never said what came of it. Older than that, it's left be. */
const recent = 15 * 60_000
/** What a stopped thread is told when it's let carry on. */
export const carryOn = "Please carry on where you left off."
/** What a thread that read a message already is told when it's taken back. */
export const ignore = (text: string) => `Please ignore my last message ("${text.trim()}") and carry on as you were.`

/** The commands kept in the ledger, read back to send again. */
const Body = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Send"), text: Schema.String, messageId: Schema.String, how: Schema.Literal("now", "after", "restart") }),
  Schema.Struct({ _tag: Schema.Literal("Stop") }),
  Schema.Struct({ _tag: Schema.Literal("Resume") }),
  Schema.Struct({ _tag: Schema.Literal("Cancel"), runId: Schema.String }),
)
const command = Schema.decodeUnknownOption(Body)

/** A reason T3 Code gave, fit to say: no ids, and a full stop. */
export const plainly = (reason: string) => {
  const said = reason
    .replace(/\b(run|thread|command|message|request)\s+(?=[\w:.-]*[\d_:-])[\w:.-]+/gi, (_, what: string) => `that ${what.toLowerCase()}`)
    .replace(/\byapd:\S+/g, "it")
    .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
  const sentence = `${said.charAt(0).toUpperCase()}${said.slice(1)}`
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/** Whether a thread has said anything since `at`: a turn that ended, or something it asks. */
const answered = (thread: T3Live.Thread, at: number) =>
  [thread.latestRunCompletedAt, thread.pendingRuntimeRequest?.createdAt].some((iso) => iso !== null && iso !== undefined && Date.parse(iso) > at)

/** Whether it's in the middle of something a message would go into, or wait behind. */
const busy = (thread: T3Live.Thread) => T3Live.busy(thread) || thread.activityRunStatus === "waiting"

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
const settled = (row: Ledger.Row): Outcome => {
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
      // Only cancelled is withdrawn: one that started meanwhile is being read.
      const runId = sent.value.runId
      return Effect.map(actions.detail(row.thread), ({ runs }) => runs.some(({ id, status }) => id === runId && status === "cancelled"))
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
          intent === "steer" || intent === "promoted_queued_to_steer" ? "steered" : intent === "queued_turn" ? "queued" : "now",
      })
    })

  /**
   * Sends a step written in the ledger and notes what came of it. When it
   * may have got there, it's looked for once. `last` is for the one time
   * it's sent again, after which it's never offered again.
   */
  const dispatch = (row: Ledger.Row, actions: T3Actions.Actions, wasBusy: boolean, last = false): Effect.Effect<Outcome> =>
    Effect.gen(function* () {
      const what = doing[row.kind]
      const sent = command(row.body)
      if (Option.isNone(sent)) {
        yield* ledger.settle(row.commandId, "abandoned", { reason: "I couldn't read back what to send." })
        return yield* failing({ _tag: "NotSent", reason: "I couldn't read back what to send.", again: Option.none() }, what)
      }
      const how = sent.value._tag === "Send" ? sent.value.how : "now"
      const again = row.kind === "message" && !last ? Option.some(row.commandId) : Option.none<string>()
      const result = yield* Effect.either(actions.run(row.thread, sent.value, row.commandId))
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
        yield* ledger.settle(row.commandId, last ? "abandoned" : "failed", { reason })
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

  /** Writes the step in the ledger and sends it, unless it's there already, when what came of it stands. */
  const once = (
    step: Step,
    kind: Ledger.Kind,
    to: Threads.Ref,
    body: (ids: { readonly commandId: string; readonly messageId: string | null }) => T3Actions.Command,
    reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread },
    digest?: string,
  ) =>
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
    })

  /**
   * What's made of the same words going to a thread they went to lately,
   * when it isn't to go straight through. One that went is asked about,
   * unless the thread has said something since. One that may not have got
   * there is looked for once: found, it's one that went; withdrawn before it
   * was read, what's said now is new; otherwise it's offered again under its
   * own ids, never sent under new ones, and once it's been sent again
   * already, it isn't risked a third time.
   */
  const twinned = (twin: Ledger.Row, reached: { readonly actions: T3Actions.Actions; readonly thread: T3Live.Thread }) =>
    Effect.gen(function* () {
      let row = twin
      if (row.state !== "sent" && row.messageId !== null) {
        const found = yield* Effect.either(reached.actions.message(row.thread, row.messageId))
        if (Either.isRight(found) && Option.isSome(found.right)) {
          if (Option.exists(found.right.value.run, ({ status }) => status === "cancelled")) return Option.none<Outcome>()
          yield* ledger.settle(row.commandId, "sent", { from: [row.state] })
          yield* Effect.logInfo(`Found ${row.commandId} in the thread after all`)
          row = { ...row, state: "sent" }
        }
      }
      if (row.state === "sent" && answered(reached.thread, row.at)) return Option.none<Outcome>()
      if (row.state === "abandoned") {
        const reason = "I couldn't confirm either of the last two got there, so I won't risk sending it a third time."
        return Option.some<Outcome>(yield* failing({ _tag: "Refused", reason } satisfies Outcome, doing.message))
      }
      yield* Effect.logInfo(`The same words went to it at ${new Date(row.at).toISOString()} as ${row.commandId}, so asking first`)
      return Option.some<Outcome>({ _tag: "Twin", row })
    })

  const message = (step: Step, act: Extract<Act, { readonly _tag: "Message" }>, twice: boolean) =>
    Effect.gen(function* () {
      const { to, text, how } = act
      const { commandId } = Ledger.ids(step.utterance, step.step, true)
      // Worked out again, it's the step it was, whatever came of it.
      const before = yield* ledger.get(commandId)
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
      return yield* once(step, "message", to, ({ messageId }) => ({ _tag: "Send", text, messageId: messageId ?? "", how }), reached.right, digest)
    })

  const stop = (step: Step, to: Threads.Ref) =>
    Effect.gen(function* () {
      const reached = yield* reach(to)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing.stop)
      return yield* once(step, "stop", to, () => ({ _tag: "Stop" }), reached.right)
    })

  /** Lets a thread yapd stopped carry on: lets go of its queue, then asks it to pick up where it was. */
  const carry = (step: Step, to: Option.Option<Threads.Ref>) =>
    Effect.gen(function* () {
      const stopped = yield* ledger.latest(resumable, {
        kinds: ["stop"],
        states: ["sent"],
        ...Option.match(to, { onNone: () => ({}), onSome: ({ machine, id }) => ({ machine, thread: id }) }),
      })
      if (Option.isNone(stopped)) {
        return yield* failing({ _tag: "Refused", reason: "I haven't stopped anything lately." } satisfies Outcome, "let it carry on")
      }
      const ref = refOf(stopped.value)
      const reached = yield* reach(ref)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, "let it carry on")
      // Going again already, by his hand or a carry on before, it's told nothing twice.
      if (busy(reached.right.thread)) return yield* failing({ _tag: "Refused", reason: "It's already back at work." } satisfies Outcome, "let it carry on")
      const resumed = yield* once(step, "undo", ref, () => ({ _tag: "Resume" }), reached.right)
      // Nothing held is nothing to let go of, which doesn't stop it carrying on.
      if (resumed._tag !== "Done" && resumed._tag !== "Refused") return resumed
      return yield* once(
        { ...step, step: step.step + 1 },
        "message",
        ref,
        ({ messageId }) => ({ _tag: "Send", text: carryOn, messageId: messageId ?? "", how: "now" }),
        reached.right,
        Ledger.digest(carryOn),
      )
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
      if (row.kind !== "message" || row.messageId === null) return yield* refused("There's nothing more to take back.")
      if (row.state !== "sent" && row.state !== "unknown") return yield* refused("It never went, so there's nothing to take back.")
      const ref = refOf(row)
      const reached = yield* reach(ref)
      if (Either.isLeft(reached)) return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, "take a message back")
      const found = yield* Effect.either(reached.right.actions.message(row.thread, row.messageId ?? ""))
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
        const cancelled = yield* once(step, "undo", ref, () => ({ _tag: "Cancel", runId }), reached.right)
        // Withdrawn, it's nothing to take back again, nor what "I sent that a minute ago" means.
        if (cancelled._tag === "Done") yield* ledger.settle(row.commandId, "abandoned", { reason: "Withdrawn." })
        return cancelled
      }
      yield* Effect.logInfo(`${row.commandId} was read already, so it can only be told to ignore it`)
      return { _tag: "Read", row } satisfies Outcome
    })

  return {
    run: (step, act, options = {}) => {
      switch (act._tag) {
        case "Message":
          return message(step, act, options.twice === true)
        case "Stop":
          return stop(step, act.to)
        case "Undo":
          return act.carry ? carry(step, act.to) : withdraw(step, act.to)
      }
    },
    again: (commandId) =>
      Effect.gen(function* () {
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
          yield* ledger.settle(row.commandId, "abandoned", { reason: reached.left })
          return yield* failing({ _tag: "Refused", reason: reached.left } satisfies Outcome, doing[row.kind])
        }
        yield* Effect.logInfo(`Sending ${row.commandId} once more, as you said`)
        return yield* dispatch(row, reached.right.actions, busy(reached.right.thread), true)
      }),
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
      // What this run did is settled, or offered again, as it happens.
      for (const row of open.filter(({ at }) => at < started)) {
        // Only from where it was, in case something came of it since it was read.
        const from = [row.state]
        if (now - row.at > recent) {
          yield* ledger.settle(row.commandId, "abandoned", { reason: row.reason ?? "Too long ago to check after a restart.", from })
          continue
        }
        if (row.kind === "start") {
          const thread = yield* threads.find(refOf(row))
          if (Option.isSome(thread)) yield* ledger.settle(row.commandId, "sent", { from })
          else yield* Effect.logInfo(`Couldn't tell whether ${row.commandId} started, so it's left be`)
          continue
        }
        const actions = threads.actions(row.machine)
        if (Option.isNone(actions)) {
          yield* Effect.logInfo(`Couldn't look for ${row.commandId} on ${row.machine}, so it's left be`)
          continue
        }
        const found = yield* Effect.either(landed(row, actions.value))
        if (Either.isLeft(found)) {
          yield* Effect.logWarning(`Couldn't look for ${row.commandId} after restarting: ${found.left.reason}`)
          continue
        }
        if (found.right) {
          yield* ledger.settle(row.commandId, "sent", { ...(row.how === null ? {} : { how: row.how }), from })
          yield* Effect.logInfo(`Found ${row.commandId} after restarting: it got there`)
        } else if (row.kind === "message") {
          yield* ledger.settle(row.commandId, "unknown", { reason: "I couldn't find it in the thread after restarting.", from })
          yield* Effect.logWarning(`${row.commandId} isn't in the thread after restarting, so I'll offer to send it again`)
          undelivered.push(row)
        } else {
          yield* ledger.settle(row.commandId, "abandoned", { reason: "I couldn't tell whether it went through before I restarted.", from })
          yield* Effect.logWarning(`Couldn't tell whether ${row.commandId} went through before restarting, so it's left be`)
        }
      }
      return undelivered
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

/** What's said once it's done, naming the thread when it isn't the one he's on about. */
export const done = (act: Act, how: Ledger.How, lines: Lines, called: Option.Option<string>) =>
  naming(
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

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** A reason as it's said after a colon: lowercase, unless it starts with "I" or a name like T3 Code. */
const after = (reason: string) => (/^(I\b|I'|[A-Z][A-Z\d])/.test(reason) ? reason : `${reason.charAt(0).toLowerCase()}${reason.slice(1)}`)

/** What's said when it didn't go, with why, and whether to send it again when it may. */
export const failed = (act: Act, outcome: Extract<Outcome, { readonly reason: string }>, lines: Lines, called: Option.Option<string>) => {
  const sir = addressed(lines)
  const name = Option.getOrUndefined(called)
  const reason = after(outcome.reason)
  const asking = "again" in outcome && Option.isSome(outcome.again) ? ` ${lines.again}` : ""
  switch (act._tag) {
    case "Message":
      return outcome._tag === "Refused"
        ? `${name === undefined ? "That didn't go through" : `That didn't go to ${name}`}${sir}: ${reason}`
        : outcome._tag === "NotSent"
          ? `${name === undefined ? "That didn't get there" : `That didn't get to ${name}`}${sir}: ${reason}${asking}`
          : `I couldn't confirm it got ${name === undefined ? "there" : `to ${name}`}${sir}.${asking}`
    case "Stop":
      // Nothing to stop is all there is to say.
      if (outcome._tag === "Refused" && /isn't doing anything/.test(reason)) return `${name === undefined ? "It" : capital(name)} isn't doing anything right now${sir}.`
      return outcome._tag === "Unknown" ? `I couldn't confirm ${name ?? "it"} stopped${sir}.` : `I couldn't stop ${name ?? "it"}${sir}: ${reason}`
    case "Undo":
      if (act.carry) {
        return outcome._tag === "Unknown" ? `I couldn't confirm ${name ?? "it"} is going again${sir}.` : `I couldn't get ${name ?? "it"} going again${sir}: ${reason}`
      }
      return outcome._tag === "Unknown" ? `I couldn't confirm it was withdrawn${sir}.` : `I couldn't take that back${sir}: ${reason}`
  }
}

/** Asked when the same words went to the same thread lately, and it hasn't said anything since. */
export const twice = (sent: number, now: number, lines: Lines, called: Option.Option<string>) =>
  `I sent that${Option.match(called, { onNone: () => "", onSome: (name) => ` to ${name}` })} ${ago(now - sent)}${addressed(lines)}. Again?`

/** Offered when a message he wants back was read already. */
export const read = (lines: Lines, called: Option.Option<string>) =>
  `${Option.match(called, { onNone: () => "It's", onSome: (name) => `${capital(name)} has` })} already read it${addressed(lines)}. Shall I tell it to ignore that?`

/** Offered after a restart, for a message that wasn't found where it went. */
export const lost = (lines: Lines, called: Option.Option<string>) =>
  `Before I restarted, I couldn't confirm your message${Option.match(called, { onNone: () => "", onSome: (name) => ` to ${name}` })} got there${addressed(lines)}. ${lines.again}`
