import { Cause, Clock, Context, type Duration, Effect, Either, Fiber, Option } from "effect"
import * as Brain from "./Brain.ts"
import type * as Conversation from "./Conversation.ts"
import type * as Drafts from "./Drafts.ts"
import * as Hands from "./Hands.ts"
import type { Notice } from "./Inbox.ts"
import type { Journal, Kept } from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import { addressed, type Lines, Persona, unaddressed } from "./Persona.ts"
import type { Line } from "./Responder.ts"
import type * as T3Actions from "./T3Actions.ts"
import * as Threads from "./Threads.ts"
import { ago, type Material } from "./Writer.ts"

// Whatever the user says to yapd itself, by the shortcut or typed, goes through
// here: worked out first, which has no effect and can be done again while they
// carry on, then acted on once, one request at a time. yapd keeps at most one
// question open, and whatever they say next closes it before anything else is
// done: it answers it or takes its place, so no request is ever left running
// alongside the one that replaced it, and no question is said twice in the
// same words.

/** Something the user said to yapd, once the words are settled. */
export interface Utterance {
  /** "u" with the time and a few random letters, minted once the words are settled. */
  readonly id: string
  readonly heard: string
  readonly via: "shortcut" | "reply" | "typed"
  readonly at: number
  /** Seconds of it that were speech. */
  readonly voiced: number
  /** How many times yapd had been turned on or off when it was heard, so nothing is done for it after. */
  readonly turns: number
}

/** What a thread asks of the user, which a short answer can settle. */
export type Asks =
  | {
      readonly _tag: "Approval"
      readonly requestId: string
      readonly dangerous: boolean
      readonly decisions: ReadonlyArray<string>
      readonly inFull: boolean
    }
  | { readonly _tag: "Question"; readonly requestId: string; readonly questions: Extract<T3Actions.Request, { readonly _tag: "Question" }>["questions"] }
  /** The agent's own message ended on a question. */
  | { readonly _tag: "Agent" }

/** What "it" means: what the user was just listening to. */
export type Subject =
  | { readonly _tag: "Nothing" }
  | {
      readonly _tag: "Thread"
      readonly ref: Threads.Ref
      readonly said: string
      readonly more: string
      readonly asks: Option.Option<Asks>
      readonly row: number
    }
  /** An update from a session T3 Code doesn't run. */
  | { readonly _tag: "Session"; readonly update: Conversation.Update; readonly said: string }
  | { readonly _tag: "Answer"; readonly said: string; readonly about: Option.Option<Threads.Ref> }

/** The one question yapd has open, and what it's about. */
export interface Open {
  readonly id: string
  readonly version: number
  readonly kind: "which" | "confirm" | "offer" | "project" | "resend"
  /** The request it belongs to. */
  readonly utterance: string
  /** What the user said in that request. */
  readonly heard: string
  /** What was understood, minus what's being asked. */
  readonly decision: Brain.Decision
  readonly candidates: ReadonlyArray<Threads.Ref>
  /** The exact words said. */
  readonly asked: string
  /** What it's about in a few words, for asking it again and letting it go: the request, or the threads it chooses between. */
  readonly about: string
  readonly at: number
  /** For the project of new work: what its prompt is written from. */
  readonly material: Option.Option<Material>
  /** For sending again: the command to dispatch again. */
  readonly resend: Option.Option<string>
}

/** What the user meant, worked out, not yet acted on. */
export interface Thought {
  readonly utterance: Utterance
  readonly subject: Subject
  readonly decision: Brain.Decision
  /** The snapshot its handles refer to. */
  readonly situation: Brain.Situation
  /** The open question's version it was worked out against. */
  readonly version: number
  /** Without the model, by it, or what's said when it couldn't be asked, which changes nothing. */
  readonly source: "fast" | "model" | "failed"
}

/** What came of it. */
export interface Outcome {
  /** What to say, or "" for nothing. */
  readonly say: string
  /** What "it" means next. */
  readonly subject: Subject
  /** What kind of thing was said, which picks how long to listen after. */
  readonly kind: "answer" | "done" | "question" | "none"
}

/** What the user says to yapd itself, worked out and acted on. */
export class Assistant extends Context.Tag("yapd/Assistant")<
  Assistant,
  {
    /** No side effects; it may be called again while the user carries on. */
    readonly think: (utterance: Utterance, subject: Subject, lines: ReadonlyArray<Line>) => Effect.Effect<Thought>
    /** Once, one request at a time; thinks once more if the open question changed meanwhile. Never fails. */
    readonly act: (thought: Thought) => Effect.Effect<Outcome>
    /** A dictation or typed request: worked out and acted on, then what came of it said ahead of anything else. */
    readonly heard: (utterance: Omit<Utterance, "id">) => Effect.Effect<string>
    /** The shortcut was pressed: the open question waits for what's dictated. */
    readonly prepare: Effect.Effect<void>
    /** A dictation came to nothing, like one cancelled or with no words in it: the open question is waited on again. */
    readonly nothing: Effect.Effect<void>
    /** Something was said over an update, which takes the place of whatever yapd asked before that he heard. */
    readonly replied: Effect.Effect<void>
    readonly open: Effect.Effect<Option.Option<Open>>
    /** yapd was turned off: the open question is closed, and what was being written up stops. */
    readonly drop: Effect.Effect<void>
    /** Messages a restart found didn't get there: each is offered to be sent again once, one at a time. */
    readonly undelivered: (rows: ReadonlyArray<Ledger.Row>) => Effect.Effect<void>
  }
>() {}

/** "It" means what's playing, or what was heard within this long. */
const recall = 15 * 60_000
/** How long after a question went unanswered it's asked again. */
const again: Duration.DurationInput = "1 minute"
/** How many times a question is asked before it's let go. */
const asks = 2
/** Questions asked within this long are never asked again in the same words, and one left open longer is let go. */
const fresh = 10 * 60_000
/** What the model is told was heard, said or done lately. */
const lately = { span: 3 * 60 * 60_000, most: 8 }
/** What it's told he missed. */
const unheard = 12
/** Threads on the desk: fewer for a reply, which is about what he just heard. */
/** Threads the model sees in full, for a dictation and for a reply, then how many more by name only; and how many give Whisper their words. */
const desk = { asked: 30, reply: 12, named: 120, vocabulary: 15 }
/** How long the searches for what he said have to add their threads to the desk. */
const cap = "100 millis"

const day = 24 * 60 * 60_000
/** Dictations are dropped after five minutes, so one pressed for longer ago than this has ended, whether or not anything came of it. */
const longest = 6 * 60_000
/** What "scratch that" can take back: what was done this long ago at most. */
const scratchable = "2 minutes"
/** Steps one request can take at most, so a "rest" that never runs out can't go on for ever. */
const steps = 4
/** How long the rest of a request has to be worked out for what comes of it to be said in the same breath as the step before. */
const joining = "1 second"

/**
 * Which step of its request something is, whether it's the same words sent
 * again on his yes, and whether it's done quietly: the step before was said
 * on its own already, so only what didn't go, or a question, is said of it.
 */
interface Stepping {
  readonly step: number
  readonly twice: boolean
  readonly quietly?: boolean
}

const quiet = (subject: Subject): Outcome => ({ say: "", subject, kind: "none" })

/** Something said back that isn't about a thread. */
const reply = (say: string, subject: Subject): Outcome => ({ say, subject: { _tag: "Answer", said: say, about: Option.none() }, kind: say === "" ? "none" : "answer" })

/** The thread a yes or no question is about, which it names, so what's said once it's answered needn't name it again. */
const askedAbout = (open: Pick<Open, "kind" | "candidates">) =>
  Brain.yesNo(open.kind) ? Option.fromNullable(open.candidates[0]) : Option.none<Threads.Ref>()

/** Whether a journal entry is a question yapd asked. */
const question = (kept: Kept) => typeof kept.detail === "object" && kept.detail !== null && "question" in kept.detail

/** What yapd knows as it works something out, and what that comes to without the model, when it's enough. */
interface Glance {
  readonly version: number
  readonly situation: Brain.Situation
  readonly quick: Brain.Decision | undefined
}

/** The assistant, saying what came of each request through `tell`. */
export const make = (options: {
  readonly threads: Threads.Threads["Type"]
  readonly journal: Journal["Type"]
  readonly drafts: Drafts.Drafts
  /** What it does to threads, each step once. */
  readonly hands: Hands.Hands["Type"]
  /** What it did lately, for "scratch that". */
  readonly ledger: Ledger.Ledger["Type"]
  /** Queues something to say, unless yapd was turned off since `since`. */
  readonly tell: (notice: Notice, since?: number) => Effect.Effect<void>
  /** Whether yapd is on, and how many times it was turned on or off. */
  readonly power: Effect.Effect<{ readonly on: boolean; readonly turns: number }>
  /** The update being read, or the last one the user heard, and when. */
  readonly lastHeard: Effect.Effect<Option.Option<{ readonly update: Conversation.Update; readonly at: number; readonly playing: boolean }>>
  /** Something is about to be said, so the speaker can get ready while it's worked out. */
  readonly coming: Effect.Effect<void>
  /**
   * An answer is on its way, so nothing but answers is said until what this
   * gives back is run, once it's queued or won't come, or for a while after
   * he stops dictating at most.
   */
  readonly awaiting: Effect.Effect<Effect.Effect<void>>
  /** Whether these words are waiting to be said, like an update or work that started, which a dictation cut off. */
  readonly queued: (spoken: string) => Effect.Effect<boolean>
}) =>
  Effect.gen(function* () {
    const brain = yield* Brain.Brain
    const persona = yield* Persona
    const scope = yield* Effect.scope
    const { threads, journal, drafts, hands, ledger } = options
    /** One request at a time, from working it out to what's said of it. */
    const turn = yield* Effect.makeSemaphore(1)

    /**
     * The open question, how many times it's been asked, its asking again
     * later, whether something being said now may answer it, while which it's
     * neither said nor asked again, and whether he's heard it yet: until he
     * has, nothing he says can be about it.
     */
    let asking: { open: Open; asks: number; repeat: Fiber.RuntimeFiber<void> | undefined; held: boolean; said: boolean } | undefined
    /** Changes whenever the open question does, so what was worked out against another can tell. */
    let version = 0
    /** What yapd said last of its own accord, which "it" may mean, and when it started saying it. */
    let answered: { readonly subject: Subject; readonly at: number } | undefined
    /** What "it" meant when the shortcut was pressed, before the dictation stopped what was playing. */
    let pressed: Subject | undefined
    /** For each press whose dictation hasn't ended, oldest first: when, and what lets updates be said again once its answer is queued. */
    const presses: Array<{ readonly at: number; readonly arrived: Effect.Effect<void> }> = []
    /** Prompts being written for what was said before it's known whether it's new work, by utterance. */
    const writing = new Map<string, Fiber.RuntimeFiber<Either.Either<Drafts.Written, string>>>()
    /** What's under way in the background for a request, stopped when yapd is turned off. */
    const jobs = new Set<Fiber.RuntimeFiber<unknown, unknown>>()
    /** Work being started, which the journal only has once T3 Code has it ready, so the model knows not to start it again meanwhile. */
    const starting = new Set<Kept>()
    /** Messages a restart found didn't get there, waiting their turn to be offered again. */
    const lost: Array<Ledger.Row> = []

    const mint = (at: number, prefix: string) => `${prefix}${at.toString(36)}${crypto.randomUUID().slice(0, 4)}`

    /** In the background, and stoppable even when begun from what can't be stopped, like an answer being taken in. */
    const background = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.withFiberRuntime<A | void, E>((fiber) => {
        jobs.add(fiber)
        return Effect.ensuring(effect, Effect.sync(() => jobs.delete(fiber)))
      }).pipe(
        Effect.catchAllCause((cause) => (Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Something went wrong", cause))),
        Effect.interruptible,
        Effect.forkIn(scope),
        Effect.asVoid,
      )

    /** The open question, unless it's been open so long it no longer counts. */
    const current = (now: number) =>
      asking !== undefined && now - asking.open.at < fresh ? Option.some(asking.open) : Option.none<Open>()

    /** What "it" means now: what's playing, or the latest heard lately, an update or an answer. */
    const subject = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const update = Option.filter(yield* options.lastHeard, ({ playing, at }) => playing || now - at < recall)
      const said = answered !== undefined && now - answered.at < recall ? answered : undefined
      if (Option.isSome(update) && (said === undefined || update.value.playing || update.value.at >= said.at)) {
        return { _tag: "Session", update: update.value.update, said: update.value.update.spoken } satisfies Subject
      }
      return said?.subject ?? ({ _tag: "Nothing" } satisfies Subject)
    })

    /** What yapd asked in the last ten minutes, so no question is asked in the same words again. */
    const askedLately = Effect.gen(function* () {
      const kept = yield* journal.since((yield* Clock.currentTimeMillis) - fresh, { kinds: ["answer"] })
      return kept.filter(question).flatMap(({ said }) => (said === undefined ? [] : [said]))
    })

    /** Threads a search for his words turns up, to add to the desk. T3 Code answers in a few ms, so only what's there within the cap is taken. */
    const searching = (heard: string) =>
      Threads.searched(heard, threads.search).pipe(
        Effect.orElseSucceed((): ReadonlyArray<Threads.Ref> => []),
        Effect.timeoutTo({ duration: cap, onTimeout: () => [], onSuccess: (found): ReadonlyArray<Threads.Ref> => found }),
      )

    /** What the brain goes by, from memory: the desk, the journal and what's known of usage. */
    const situate = (utterance: Utterance, about: Subject, lines: ReadonlyArray<Line>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        // One he hasn't heard yet can't be what he's answering.
        const open = Option.filter(current(now), () => asking?.said === true)
        const focus =
          about._tag === "Thread" ? Option.some(about.ref) : about._tag === "Answer" ? about.about : Option.none<Threads.Ref>()
        const pending = Option.match(open, { onNone: () => [], onSome: ({ candidates }) => candidates })
        // A reply is about what he just heard, which is on the desk already.
        const found = utterance.via === "reply" ? [] : yield* searching(utterance.heard)
        const [shortlist, recent, spoke, usage, asked, acted] = yield* Effect.all([
          threads.desk(focus, pending, utterance.via === "reply" ? desk.reply : desk.asked, found, desk.named, utterance.heard),
          journal.since(now - lately.span, { most: 2 * lately.most, kinds: ["update", "reply", "dictation", "answer", "started", "notice", "sent", "action"] }),
          journal.since(now - day, { most: 1, kinds: ["dictation", "reply"] }),
          threads.usage,
          askedLately,
          // The last thing done, whatever it was, so "scratch that" never reaches past it to something before.
          ledger.latest(scratchable),
        ])
        const missed = yield* journal.unheard(spoke.at(-1)?.at ?? now - day, unheard)
        // What was done, like a stop, but not the bookkeeping of questions closed, which says nothing.
        const done = recent.filter(({ kind, said }) => kind !== "action" || said !== undefined).slice(-lately.most)
        return {
          utterance,
          subject: about,
          lines,
          open,
          desk: shortlist,
          lately: [...done, ...starting].toSorted((one, other) => one.at - other.at),
          unheard: missed,
          usage,
          second: Option.none(),
          asked,
          acted,
          now,
        } satisfies Brain.Situation
      })

    /** What it comes to without the model, when that's enough. */
    const glance = (utterance: Utterance, about: Subject, lines: ReadonlyArray<Line>) =>
      Effect.gen(function* () {
        const against = version
        const situation = yield* situate(utterance, about, lines)
        return { version: against, situation, quick: Brain.fast(situation, yield* persona.lines) } satisfies Glance
      })

    const worked = (glanced: Glance, utterance: Utterance, about: Subject, decision: Brain.Decision, source: Thought["source"]): Thought => ({
      utterance,
      subject: about,
      decision,
      situation: glanced.situation,
      version: glanced.version,
      source,
    })

    /** What the model makes of it, or, when it can't be asked, a line saying so. */
    const decide = (glanced: Glance, utterance: Utterance, about: Subject) =>
      brain.decide(glanced.situation).pipe(
        Effect.map((decision) => worked(glanced, utterance, about, decision, "model")),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Could not work out what you meant", error)
            const spoken = `I couldn't work that out just now${addressed(yield* persona.lines)}. What you said is in my log.`
            return worked(glanced, utterance, about, Brain.decision({ act: "answer", spoken }), "failed")
          }),
        ),
      )

    const think = (utterance: Utterance, about: Subject, lines: ReadonlyArray<Line>) =>
      Effect.flatMap(glance(utterance, about, lines), (glanced) =>
        glanced.quick === undefined ? decide(glanced, utterance, about) : Effect.succeed(worked(glanced, utterance, about, glanced.quick, "fast")),
      )

    const called = (situation: Brain.Situation, handle: string) => situation.desk.threads.find((listed) => listed.handle === handle)

    /** How a decision reads in the log: what, about which thread, how sure, and how it was reached. */
    const routed = (thought: Thought, ms: number) => {
      const { act, target, sure, pending } = thought.decision
      const listed = called(thought.situation, target)
      return [
        `${act}${listed === undefined ? "" : ` → ${listed.called} (${listed.ref.machine})`}`,
        sure,
        ...(pending === "" ? [] : [`${pending} the question`]),
        thought.source === "fast" ? "at once" : thought.source === "failed" ? "the model failed" : `${(ms / 1000).toFixed(1)} s`,
      ].join(", ")
    }

    /** Closes the open question, with what became of it, and stops it being asked again. */
    const close = (open: Open, how: string, by?: string) =>
      Effect.gen(function* () {
        if (asking?.open.id !== open.id) return
        const repeat = asking.repeat
        asking = undefined
        version++
        if (repeat !== undefined) yield* Fiber.interruptFork(repeat)
        yield* Effect.logInfo(`Closed the question, ${how}: ${open.asked}`)
        yield* journal.write({
          at: yield* Clock.currentTimeMillis,
          kind: "action",
          utterance: open.utterance,
          detail: { open: how, asked: open.asked, ...(by === undefined ? {} : { by }) },
        })
        // Offered once: not taken up, it's never offered again on its own.
        if (how !== "answered") yield* forgo(open, `The question was ${how}.`)
      })

    /**
     * A message offered to be sent again that he didn't take up, which is
     * never offered again on its own. It may still have got there, so the
     * same words said again are asked about, never sent under new ids.
     */
    const forgo = (open: Open, reason: string) =>
      Option.match(open.resend, { onNone: () => Effect.void, onSome: (commandId) => hands.leave(commandId, reason) })

    /** Opens a question in place of any other, unless yapd was turned off since what it's about was said. */
    const opening = (open: Omit<Open, "id" | "version" | "at">, utterance: Pick<Utterance, "turns">) =>
      Effect.gen(function* () {
        const power = yield* options.power
        if (!power.on || power.turns !== utterance.turns) return quiet({ _tag: "Nothing" })
        if (asking !== undefined) yield* close(asking.open, "replaced")
        const at = yield* Clock.currentTimeMillis
        version++
        asking = { open: { ...open, id: mint(at, "o"), version, at }, asks: 1, repeat: undefined, held: false, said: false }
        yield* Effect.logInfo(`Asked: ${open.asked}`)
        return { say: open.asked, subject: { _tag: "Answer", said: open.asked, about: askedAbout(open) }, kind: "question" } satisfies Outcome
      })

    /** Something being said may answer the open question, so it isn't said meanwhile, nor asked again until that's known. */
    const hold = Effect.suspend(() => {
      if (asking === undefined) return Effect.void
      const repeat = asking.repeat
      asking.held = true
      asking.repeat = undefined
      return repeat === undefined ? Effect.void : Fiber.interruptFork(repeat)
    })

    /** Lets a question go that went unanswered as often as it's asked, and says so. */
    const letGo = (open: Open) =>
      Effect.gen(function* () {
        yield* close(open, "dropped: unanswered")
        const { turns } = yield* options.power
        yield* deliver(reply(Brain.dropped(open, yield* persona.lines), { _tag: "Nothing" }), { id: open.utterance, turns })
        yield* offering
      })

    /**
     * Asks the open question once more, now, in words not asked lately, or
     * lets it go once every wording has been used. However often it was asked
     * already: he asked to hear it, so he's still there to answer it.
     */
    const reask = (said: Lines) =>
      Effect.gen(function* () {
        const before = yield* askedLately
        if (asking === undefined) return quiet({ _tag: "Nothing" })
        const { open, repeat } = asking
        asking.repeat = undefined
        if (repeat !== undefined) yield* Fiber.interruptFork(repeat)
        const asked = Brain.reworded(open, before, said)
        if (asked === undefined) {
          yield* close(open, "dropped: asked enough")
          return reply(said.leaving, { _tag: "Nothing" })
        }
        asking = { ...asking, open: { ...open, asked }, asks: asking.asks + 1, repeat: undefined, held: false }
        yield* Effect.logInfo(`Asked again: ${asked}`)
        return { say: asked, subject: { _tag: "Answer", said: asked, about: askedAbout(open) }, kind: "question" } satisfies Outcome
      })

    /** A minute on, the question is asked once more in other words, or let go with a word if it's been asked as often as it will be. */
    const due = (id: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (asking?.open.id !== id) return
        // This is the asking again, so it's no longer waited for.
        asking.repeat = undefined
        const power = yield* options.power
        if (!power.on || asking?.open.id !== id) return
        if (asking.asks >= asks) return yield* letGo(asking.open)
        const { utterance } = asking.open
        yield* deliver(yield* reask(yield* persona.lines), { id: utterance, turns: power.turns })
      })

    /** Asks it again, or lets it go, a minute from now, unless something said meanwhile closes it first. */
    const later = (id: string) =>
      Effect.gen(function* () {
        if (asking?.open.id !== id || asking.held || asking.repeat !== undefined) return
        const repeat = yield* Effect.sleep(again).pipe(Effect.zipRight(turn.withPermits(1)(due(id))), Effect.interruptible, Effect.forkIn(scope))
        if (asking?.open.id === id) asking.repeat = repeat
      })

    /**
     * Its listening window ended without an answer: asked again in other
     * words a minute later the first time, let go with a word the second,
     * whatever it asks, as he wants it.
     */
    const unanswered = (id: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Not while something's being said that may answer it, nor twice over.
        if (asking?.open.id !== id || asking.held || asking.repeat !== undefined) return
        if (asking.asks >= asks) return yield* letGo(asking.open)
        yield* later(id)
      })

    /** What was being said came to nothing, so the open question is waited on again, as if it went unanswered. */
    const release = Effect.suspend(() => {
      if (asking === undefined || !asking.held) return Effect.void
      asking.held = false
      return later(asking.open.id)
    })

    /** Says something now, ahead of the rest of the answer, like that it's looking. */
    const meanwhile = (spoken: string, utterance: Utterance) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        options.tell(
          { id: mint(at, "a"), kind: "answer", priority: "needs-you", spoken, at, stale: Effect.succeed(false) },
          utterance.turns,
        ),
      )

    /** An answer, which what he said next can be about, as a step of its request: the rest of it follows. */
    const answer = (spoken: string, about: Option.Option<Threads.Listed>, thought: Thought, said: Lines, step: number) =>
      Effect.gen(function* () {
        const text = spoken.trim() === "" ? said.misheard : spoken.trim()
        // What he missed has now been heard, once the model has told him.
        if (Brain.catchingUp(thought.utterance.heard) || thought.decision.how === "missed") {
          yield* journal.markHeard(thought.situation.unheard.map(({ id }) => id), yield* Clock.currentTimeMillis)
        }
        const ref = Option.map(about, ({ ref }) => ref)
        const told = { say: text, subject: { _tag: "Answer", said: text, about: ref }, kind: "answer" } satisfies Outcome
        return yield* onward(thought, told, ref, step + 1, said)
      })

    /** Reads what a thread is doing now, and answers from it with a second look. */
    const look = (target: Threads.Listed, thought: Thought, said: Lines, step: number) =>
      Effect.gen(function* () {
        yield* meanwhile(said.checking, thought.utterance)
        const detail = yield* threads.detail(target.ref, target.thread.pendingRuntimeRequest?.id).pipe(Effect.either)
        if (Either.isLeft(detail)) {
          yield* Effect.logWarning(`Could not read ${target.called}`, detail.left)
          return reply(`I couldn't read ${target.called} just now${addressed(said)}. ${detail.left.reason}`, thought.subject)
        }
        const second = { ...thought.situation, second: Option.some({ ref: target.ref, detail: detail.right }) }
        const decided = yield* brain.decide(second).pipe(Effect.either)
        if (Either.isLeft(decided) || decided.right.spoken.trim() === "") {
          if (Either.isLeft(decided)) yield* Effect.logWarning("Could not answer from what I read", decided.left)
          return reply(`I read ${target.called}, but couldn't put it into words just now${addressed(said)}.`, thought.subject)
        }
        return yield* answer(decided.right.spoken, Option.some(target), thought, said, step)
      })

    /** Searches the threads, or what yapd heard and said, and answers from what's found with a second look. */
    const find = (thought: Thought, said: Lines, step: number) =>
      Effect.gen(function* () {
        const { decision, situation } = thought
        const wanted = decision.text.trim() || thought.utterance.heard
        const now = yield* Clock.currentTimeMillis
        let found: ReadonlyArray<string>
        if (decision.how === "journal") {
          const words = Threads.distinctive(wanted)
          const kept = yield* journal.since(now - 30 * day, { most: 2000 })
          found = kept
            .map((entry) => ({ entry, score: words.filter((word) => `${entry.said ?? ""} ${entry.text ?? ""}`.toLowerCase().includes(word)).length }))
            .filter(({ score }) => score > 0)
            .toSorted((one, other) => other.score - one.score || other.entry.at - one.entry.at)
            .slice(0, 8)
            .map(({ entry }) => `${ago(entry.at, now)}, ${entry.kind}${entry.project === undefined ? "" : ` in ${entry.project}`}: ${Brain.fenced(entry.said ?? entry.text ?? "")}`)
        } else {
          const matches = yield* Threads.matching(wanted, threads.search).pipe(Effect.either)
          if (Either.isLeft(matches)) return reply(`I couldn't search your threads just now${addressed(said)}. ${matches.left.reason}`, thought.subject)
          found = yield* Effect.forEach(matches.right.slice(0, 8), ({ ref, snippet }) =>
            Effect.gen(function* () {
              const listed = situation.desk.threads.find((listed) => Threads.same(listed.ref, ref))
              const title = listed?.handle ?? Option.match(yield* threads.find(ref), { onNone: () => "a thread", onSome: ({ title }) => Brain.fenced(title, 90) })
              return `${title}: ${Brain.fenced(snippet, 300)}`
            }),
          )
        }
        if (found.length === 0) return reply(`I couldn't find anything like that${addressed(said)}.`, thought.subject)
        const decided = yield* brain.decide({ ...situation, second: Option.some({ found }) }).pipe(Effect.either)
        if (Either.isLeft(decided) || decided.right.spoken.trim() === "") {
          return reply(`I found something, but couldn't put it into words just now${addressed(said)}.`, thought.subject)
        }
        const about = Option.fromNullable(called(situation, decided.right.target))
        return yield* answer(decided.right.spoken, about, thought, said, step)
      })

    /** Notes work as it starts, as part of starting it, so turning yapd off can't come between the two. */
    const noting =
      (utterance: Utterance, dictated: string): Drafts.Noted =>
      ({ started, machine, request, spoken, about }) =>
        Effect.gen(function* () {
          yield* threads.keep({ machine: machine.name, id: started.thread }, { prompt: request.prompt, dictated, description: about })
          const now = yield* Clock.currentTimeMillis
          yield* journal.write({
            at: now,
            kind: "started",
            machine: machine.name,
            project: started.project,
            thread: started.thread,
            directory: started.directory,
            said: spoken,
            text: request.prompt,
            utterance: utterance.id,
          })
          yield* Effect.logInfo(`Started ${started.thread}, ${((now - utterance.at) / 1000).toFixed(1)} s after it was said`)
        })

    /**
     * What's said of new work. `asked` is whether the request was asked about
     * already, which it never is twice: neither then, nor when reading the
     * project, which comes back later, would ask while another question is open.
     */
    const begun = (outcome: Drafts.Outcome, utterance: Utterance, said: Lines, asked: boolean): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        switch (outcome._tag) {
          case "Said":
            return reply(outcome.spoken, { _tag: "Nothing" })
          case "Started": {
            const { started, machine, spoken } = outcome
            return { say: spoken, subject: { _tag: "Answer", said: spoken, about: Option.some({ machine: machine.name, id: started.thread }) }, kind: "done" } satisfies Outcome
          }
          case "Asked": {
            const about = outcome.about || "that"
            if (asked || asking !== undefined) {
              yield* Effect.logInfo(`Leaving it, rather than ask: ${outcome.question}`)
              return reply(`I left ${about} for now, since I'd have to ask you something about it${addressed(said)}.`, { _tag: "Nothing" })
            }
            const words = Brain.unrepeated({ kind: "project", asked: outcome.question, about: outcome.about }, yield* askedLately, said)
            if (words === undefined) return reply(`I still can't tell which project ${about} goes in, so I left it${addressed(said)}.`, { _tag: "Nothing" })
            return yield* opening(
              {
                kind: "project",
                utterance: utterance.id,
                heard: utterance.heard,
                decision: Brain.decision({ act: "start", text: utterance.heard }),
                candidates: [],
                asked: words,
                about: outcome.about,
                material: Option.some(outcome.material),
                resend: Option.none(),
              },
              utterance,
            )
          }
          case "Launching": {
            // T3 Code can take minutes to get a worktree ready, so what comes of it is said when it's ready, and nothing else waits for it meanwhile.
            const arrived = yield* options.awaiting
            const under: Kept = {
              id: 0,
              at: yield* Clock.currentTimeMillis,
              kind: "started",
              machine: outcome.machine.name,
              project: outcome.project,
              said: `Starting ${outcome.about || "it"}, which T3 Code is still getting ready.`,
              utterance: utterance.id,
            }
            starting.add(under)
            yield* background(
              outcome.then.pipe(
                Effect.flatMap((after) => begun(after, utterance, said, asked)),
                Effect.flatMap((told) => deliver(told, utterance)),
                Effect.ensuring(Effect.zipRight(Effect.sync(() => starting.delete(under)), arrived)),
                Effect.annotateLogs({ utterance: utterance.id }),
              ),
            )
            return quiet({ _tag: "Nothing" })
          }
          case "Looking": {
            // Reading the project takes a while, so what comes of it is said when it's ready.
            yield* background(
              outcome.then.pipe(
                Effect.flatMap((after) => turn.withPermits(1)(Effect.flatMap(begun(after, utterance, said, asked), (told) => deliver(told, utterance)))),
                Effect.annotateLogs({ utterance: utterance.id }),
              ),
            )
            return reply(outcome.spoken, { _tag: "Nothing" })
          }
        }
      })

    /**
     * The prompt for what was said, begun as it was heard when it might be new
     * work, or now. None if yapd was turned off meanwhile: nothing starts for
     * what was said before.
     */
    const written = (utterance: Utterance, lines: ReadonlyArray<Line>, answering?: Material) =>
      Effect.gen(function* () {
        const ahead = writing.get(utterance.id)
        const prompt = yield* Fiber.join(ahead ?? (yield* Effect.forkIn(drafts.begin(lines, answering), scope)))
        const power = yield* options.power
        return !power.on || power.turns !== utterance.turns ? Option.none() : Option.some(prompt)
      })

    /** Starts new work, as a step of its request. Whether it is new work, the brain decided; where it goes and what it says, the writer. */
    const start = (thought: Thought, said: Lines, step: number) =>
      Effect.gen(function* () {
        const { utterance } = thought
        const ready = yield* written(utterance, [{ speaker: "user", text: utterance.heard }])
        if (Option.isNone(ready)) return quiet(thought.subject)
        const prompt = ready.value
        if (Either.isLeft(prompt)) return reply(prompt.left, thought.subject)
        const outcome = yield* drafts.start(prompt.right, noting(utterance, utterance.heard), undefined, { utterance: utterance.id, step })
        const told = yield* begun(outcome, utterance, said, false)
        // What comes of starting it is known only later, so the rest isn't done on the strength of it, and he's told so, ahead of any question.
        const rest = thought.decision.rest.trim()
        if (rest === "") return told
        const left = `I left the rest for now${addressed(said)}: ${rest.replace(/[.!?]+$/, "")}.`
        return told.kind === "question"
          ? { ...told, say: joined(left, told.say, said) }
          : { ...told, say: joined(told.say, left, said), kind: told.kind === "none" ? "answer" : told.kind }
      })

    /** An answer to which project new work is for: the prompt is written again with it, and a second question isn't asked. */
    const project = (open: Open, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        const { utterance } = thought
        const lines: ReadonlyArray<Line> = [
          { speaker: "yapd", text: open.asked },
          { speaker: "user", text: utterance.heard },
        ]
        const ready = yield* written(utterance, lines, Option.getOrUndefined(open.material))
        if (Option.isNone(ready)) return quiet(thought.subject)
        const prompt = ready.value
        if (Either.isLeft(prompt)) return reply(prompt.left, thought.subject)
        if (["ask", "wait", "drop"].includes(prompt.right.decision.action)) {
          yield* Effect.logInfo(`Leaving it, since that didn't settle the project. ${prompt.right.decision.why}`)
          return reply(said.leaving, thought.subject)
        }
        const outcome = yield* drafts.start(prompt.right, noting(utterance, open.heard), undefined, { utterance: utterance.id, step: 0 })
        if (outcome._tag === "Asked") {
          yield* Effect.logInfo("Leaving it, since that didn't settle the project")
          return reply(said.leaving, thought.subject)
        }
        return yield* begun(outcome, utterance, said, true)
      })

    /** What a thread is called in what's said, unless it's the one he's on about, which goes without saying. */
    const naming = (ref: Threads.Ref, situation: Brain.Situation) =>
      Option.exists(Brain.focused(situation), ({ ref: focus }) => Threads.same(focus, ref))
        ? Option.none<string>()
        : Option.fromNullable(situation.desk.threads.find((listed) => Threads.same(listed.ref, ref))?.called)

    /** Two steps' lines as one, "sir" said once. */
    const joined = (first: string, then: string, said: Lines) => {
      const sir = addressed(said)
      return `${first} ${sir !== "" && first.includes(sir) ? then.replace(sir, "") : then}`.trim()
    }

    /** What a decision to change a thread asks of the hands, if it says enough to do it. `last` is the last thing done, which taking back means. */
    const acted = (decision: Brain.Decision, target: Option.Option<Threads.Listed>, heard: string, last: Option.Option<Ledger.Row>): Hands.Act | undefined => {
      const to = Option.map(target, ({ ref }) => ref)
      // Taking back a stop is letting it carry on.
      const stopped = Option.exists(
        last,
        (row) => row.kind === "stop" && row.state === "sent" && Option.match(to, { onNone: () => true, onSome: ({ machine, id }) => row.machine === machine && row.thread === id }),
      )
      switch (decision.act) {
        case "send":
          return Option.isNone(to)
            ? undefined
            : { _tag: "Message", to: to.value, text: decision.text.trim() || heard, how: decision.how === "after" || decision.how === "restart" ? decision.how : "now" }
        case "stop":
          return Option.isNone(to) ? undefined : { _tag: "Stop", to: to.value }
        case "undo":
          return { _tag: "Undo", to, carry: decision.how === "carry" || stopped }
        default:
          return undefined
      }
    }

    /**
     * Says what came of changing a thread, and notes it, why too when it
     * didn't go: as a question when there's one to ask, like whether to send
     * again what may not have got there, under the same ids. Once a step is
     * done, the rest of the request is worked out and done as the next step.
     */
    const told = (
      act: Hands.Act,
      outcome: Hands.Outcome,
      thought: Thought,
      said: Lines,
      at: { readonly step: number; readonly commandId: string; readonly quietly?: boolean },
    ): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const { utterance, situation, decision } = thought
        const ref =
          outcome._tag === "Done"
            ? outcome.to
            : outcome._tag === "Twin" || outcome._tag === "Read"
              ? { machine: outcome.row.machine, id: outcome.row.thread }
              : act._tag === "Undo"
                ? Option.getOrUndefined(act.to)
                : act.to
        const called = ref === undefined ? Option.none<string>() : naming(ref, situation)
        // In a question it's always named, since the question has to say what it's about.
        const name = (ref === undefined ? undefined : situation.desk.threads.find((listed) => Threads.same(listed.ref, ref))?.called) ?? "it"
        const subject: Subject = { _tag: "Answer", said: "", about: Option.fromNullable(ref) }
        const now = yield* Clock.currentTimeMillis
        /** The entry it's noted in: what went, or didn't and why, and what's said of it. What only asks first sent nothing. */
        const noting = (line: string | undefined, detail: Record<string, unknown>, sent = true) =>
          journal.write({
            at: now,
            kind: act._tag === "Message" && sent ? "sent" : "action",
            ...(ref === undefined ? {} : { machine: ref.machine, thread: ref.id }),
            ...(act._tag === "Message" ? { text: act.text } : {}),
            ...(line === undefined ? {} : { said: line }),
            utterance: utterance.id,
            detail: { commandId: at.commandId, act: act._tag, outcome: outcome._tag, ...detail },
          })
        const asking = (open: Omit<Open, "id" | "version" | "at">) => opening(open, utterance)
        const base = { utterance: utterance.id, heard: utterance.heard, material: Option.none(), candidates: ref === undefined ? [] : [ref] }
        switch (outcome._tag) {
          case "Done": {
            // Gone as asked after a step said on its own, it's noted and not said.
            const line = at.quietly === true ? "" : Hands.done(act, outcome.how, said, called)
            yield* noting(line === "" ? undefined : line, { how: outcome.how })
            const first: Outcome = { say: line, subject: { ...subject, said: line }, kind: "done" }
            // Taking a stop back is two steps: letting go of the queue, then the message to carry on.
            return yield* onward(thought, first, Option.some(outcome.to), at.step + (act._tag === "Undo" ? 2 : 1), said)
          }
          case "Twin": {
            // One that may not have got there is offered again under its own ids; one that did, to a thread that hasn't answered since, is asked about.
            const doing = `send that to ${name} again`
            yield* noting(undefined, { twin: outcome.row.commandId }, false)
            if (outcome.row.state !== "sent") {
              const asked = `I couldn't confirm that got ${Option.match(called, { onNone: () => "there", onSome: (name) => `to ${name}` })} before${addressed(said)}. ${unaddressed(said.again, said)}`
              return yield* asking({ ...base, kind: "resend", decision, asked, about: doing, resend: Option.some(outcome.row.commandId) })
            }
            return yield* asking({ ...base, kind: "confirm", decision, asked: Hands.twice(outcome.row.at, now, said, called), about: doing, resend: Option.none() })
          }
          case "Read": {
            const text = typeof outcome.row.body === "object" && outcome.row.body !== null && "text" in outcome.row.body ? String(outcome.row.body.text) : ""
            yield* noting(undefined, { read: outcome.row.commandId }, false)
            return yield* asking({
              ...base,
              kind: "offer",
              decision: Brain.decision({ act: "send", text: Hands.ignore(text), how: "now" }),
              asked: Hands.read(said, called),
              about: `tell ${name} to ignore that`,
              resend: Option.none(),
            })
          }
          default: {
            const line = Hands.failed(act, outcome, said, called)
            yield* noting(line, { reason: outcome.reason })
            const again = "again" in outcome ? outcome.again : Option.none<string>()
            if (Option.isSome(again) && act._tag === "Message") {
              return yield* asking({ ...base, kind: "resend", decision, asked: line, about: `send that to ${name} again`, resend: again })
            }
            return { say: line, subject: { ...subject, said: line }, kind: "done" } satisfies Outcome
          }
        }
      })

    /** Once a step has gone as asked, the rest of its request, if there's any, as the next step. */
    const onward = (thought: Thought, first: Outcome, on: Option.Option<Threads.Ref>, next: number, said: Lines): Effect.Effect<Outcome> =>
      thought.decision.rest.trim() !== "" && next < steps ? rest(thought, first, on, next, said) : Effect.succeed(first)

    /**
     * The rest of a request with several steps, worked out again now that the
     * step before is done, with "it" the thread that was, and done as the next
     * step. One line covers the lot; a failure stops the rest, and says so.
     */
    const rest = (thought: Thought, first: Outcome, on: Option.Option<Threads.Ref>, step: number, said: Lines): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const utterance: Utterance = { ...thought.utterance, heard: thought.decision.rest }
        yield* Effect.logInfo(`Then: ${utterance.heard}`)
        // Working it out has no effect, so it carries on whether or not what's said waits for it.
        const thinking = yield* Effect.forkIn(
          think(utterance, { _tag: "Answer", said: first.say, about: on }, [
            { speaker: "user", text: thought.utterance.heard },
            { speaker: "yapd", text: first.say },
          ]),
          scope,
        )
        const ready = yield* Effect.timeoutOption(Fiber.join(thinking), joining)
        if (Option.isSome(ready)) return yield* then(ready.value, first, step, said, false)
        // Not worked out in time, the step before is said now, on its own, and the rest is done once it is, one request at a time as ever.
        yield* Effect.logInfo("Saying what's done so far, while the rest is worked out")
        yield* background(
          Fiber.join(thinking).pipe(
            Effect.flatMap((next) => turn.withPermits(1)(Effect.flatMap(then(next, quiet(first.subject), step, said, true), (after) => deliver(after, thought.utterance)))),
            Effect.annotateLogs({ utterance: thought.utterance.id }),
          ),
        )
        return first
      })

    /** What comes of the rest of a request, worked out, said with what was said of the step before. `quietly` when that was said already. */
    const then = (next: Thought, first: Outcome, step: number, said: Lines, quietly: boolean): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        if (next.source === "failed") return { ...first, say: joined(first.say, `I couldn't work out the rest${addressed(said)}.`, said) }
        if (next.decision.act === "dismiss" || next.decision.act === "resume") return first
        const after = yield* follow(Brain.check(next.decision, next.situation, said), next, said, { step, twice: false, quietly })
        if (after.say === "") return first
        return { ...after, say: joined(first.say, after.say, said) }
      })

    /** Changes a thread as decided, once, unless yapd was turned off and on since it was said (I8). */
    const write = (plan: Brain.Plan, thought: Thought, said: Lines, at: Stepping) =>
      Effect.gen(function* () {
        const { utterance } = thought
        const power = yield* options.power
        if (!power.on || power.turns !== utterance.turns) {
          yield* Effect.logInfo("Not doing it, since yapd was turned off after it was said")
          return quiet(thought.subject)
        }
        const act = acted(plan.decision, plan.target, utterance.heard, thought.situation.acted)
        if (act === undefined) return reply(said.cantTell, thought.subject)
        const outcome = yield* hands.run({ utterance: utterance.id, step: at.step }, act, { twice: at.twice })
        return yield* told(act, outcome, thought, said, {
          step: at.step,
          commandId: Ledger.ids(utterance.id, at.step, false).commandId,
          ...(at.quietly === true ? { quietly: true } : {}),
        })
      })

    /**
     * A yes to doing what was asked about: the same thing on the same thread,
     * as it's known now, checked as anything done is, and never asked about a
     * second time. To sending again, it's the same step under the same ids,
     * once; a yes that doesn't stand lets it go for good. A no with something
     * else instead, like another thread or other words, is that something else,
     * and what was asked about isn't done.
     */
    const agreeing = (open: Open, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        const { utterance, situation } = thought
        if (!Brain.agrees(open, thought.decision, situation.desk)) {
          yield* forgo(open, "He asked for something else instead.")
          // Words left out are the ones asked about, as for "no, the Mina one".
          const answered = thought.decision
          const instead = answered.act === open.decision.act && answered.text.trim() === "" ? { ...answered, text: open.decision.text } : answered
          const checked = Brain.check(instead, situation, said)
          if (checked._tag === "Ask") {
            yield* Effect.logInfo("Leaving it, rather than ask again")
            return reply(said.leaving, thought.subject)
          }
          yield* Effect.logInfo("Doing what he asked instead of what I asked about")
          return yield* follow(checked, { ...thought, decision: instead }, said)
        }
        const target = Option.fromNullable(open.candidates[0]).pipe(
          Option.flatMap((ref) => Option.fromNullable(situation.desk.threads.find((listed) => Threads.same(listed.ref, ref)))),
        )
        const decision = Brain.decision({
          ...open.decision,
          target: Option.match(target, { onNone: () => "", onSome: ({ handle }) => handle }),
          sure: "high",
          others: "",
          pending: "answers",
        })
        const checked = Brain.check(decision, situation, said)
        const resend = Option.filter(open.resend, () => checked._tag === "Do" && checked.plan.decision.act === "send" && Option.isSome(target))
        if (Option.isNone(resend)) yield* forgo(open, "His yes didn't stand.")
        if (checked._tag === "Ask") {
          yield* Effect.logInfo("Leaving it, rather than ask again")
          return reply(said.leaving, thought.subject)
        }
        if (Option.isSome(resend) && Option.isSome(target)) {
          const power = yield* options.power
          if (!power.on || power.turns !== utterance.turns) return quiet(thought.subject)
          const outcome = yield* hands.again(resend.value)
          const act: Hands.Act = { _tag: "Message", to: target.value.ref, text: open.decision.text, how: "now" }
          return yield* told(act, outcome, { ...thought, decision: open.decision }, said, { step: 0, commandId: resend.value })
        }
        return yield* follow(checked, { ...thought, decision }, said, { step: 0, twice: true })
      })

    /** Does what was decided and checked: a step of its request, which changes a thread under that step's ids. */
    const perform = (plan: Brain.Plan, thought: Thought, said: Lines, at: Stepping = { step: 0, twice: false }): Effect.Effect<Outcome> => {
      const { decision, target } = plan
      switch (decision.act) {
        case "send":
        case "stop":
        case "undo":
          return write(plan, thought, said, at)
        case "answer":
          return answer(decision.spoken, target, thought, said, at.step)
        case "look":
          return Option.match(target, {
            onNone: () => Effect.succeed(reply(said.cantTell, thought.subject)),
            onSome: (target) => look(target, thought, said, at.step),
          })
        case "find":
          return find(thought, said, at.step)
        case "again":
          return Effect.gen(function* () {
            const { subject } = thought
            // A dictation cut it off, so it's about to be said again from the start, and once is enough.
            if (subject._tag !== "Nothing" && (yield* options.queued(subject.said))) {
              yield* Effect.logInfo("Not saying it again, since it's about to be said again from the start")
              return quiet(subject)
            }
            const last = subject._tag === "Nothing" ? Brain.nothingSaid(said) : subject.said
            return { say: decision.spoken.trim() || last, subject, kind: "answer" } satisfies Outcome
          })
        case "start":
          return start(thought, said, at.step)
        case "dismiss":
        case "resume":
          return Effect.succeed(quiet(thought.subject))
        default:
          return Effect.succeed(reply(Brain.notYet(said), thought.subject))
      }
    }

    const follow = (
      checked: Brain.Checked,
      thought: Thought,
      said: Lines,
      at: Stepping = { step: 0, twice: false },
    ): Effect.Effect<Outcome> => {
      switch (checked._tag) {
        case "Say":
          return Effect.succeed(reply(checked.spoken, thought.subject))
        case "Ask":
          return opening(checked.open, thought.utterance)
        case "Do":
          return perform(checked.plan, thought, said, at)
      }
    }

    /** Acting on it, with the turn already held. */
    const acting = (thought: Thought): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const { utterance } = thought
        const off = Effect.map(options.power, (power) => !power.on || power.turns !== utterance.turns)
        const stopped = Effect.as(Effect.logInfo("Not acting on it, since yapd was turned off after it was said"), quiet(thought.subject))
        // Turned off since, nothing is done for it, not even working it out again.
        if (yield* off) return yield* stopped
        let decided = thought
        if (decided.version !== version) {
          yield* Effect.logInfo("Working it out again, since the open question changed meanwhile")
          decided = yield* think(utterance, decided.subject, decided.situation.lines)
          if (yield* off) return yield* stopped
        }
        const { decision } = decided
        // Nothing was really said, like words Whisper hears in silence: a question stays open.
        if (decided.source === "fast" && decision.act === "resume") return quiet(decided.subject)
        const said = yield* persona.lines
        // Nothing was made of it, so that's all that's said, and what he missed isn't marked heard. Still, he said something after the question he heard, which closes it.
        if (decided.source === "failed") {
          if (asking?.said === true) yield* close(asking.open, utterance.via === "reply" ? "dropped: unclear" : "replaced", utterance.id)
          return reply(decision.spoken, decided.subject)
        }
        const now = yield* Clock.currentTimeMillis
        if (asking !== undefined && Option.isNone(current(now))) yield* close(asking.open, "dropped: unanswered")
        const open = asking?.open
        if (open === undefined) return yield* follow(Brain.check(decision, decided.situation, said), decided, said)
        // He never heard it, so what he said is something new, which takes its place, and he's told what was left for it.
        if (asking?.said === false) {
          if (decision.act === "resume") return quiet(decided.subject)
          yield* close(open, "replaced", utterance.id)
          yield* deliver(reply(Brain.left(open, said), decided.subject), utterance)
          return yield* follow(Brain.check(decision, decided.situation, said), decided, said)
        }
        // He didn't catch the question, so it's asked again in other words, now rather than later.
        if (decision.act === "again" && decision.pending === "answers") return yield* reask(said)
        // Saying again just what was asked about, like the same message to the same thread, is a yes to it.
        const repeated = Brain.yesNo(open.kind) && decision.target !== "" && Brain.agrees(open, decision, decided.situation.desk)
        const answers = (decision.pending === "answers" || repeated) && decision.act !== "resume"
        yield* close(open, decision.act === "resume" ? "dropped: unclear" : answers ? "answered" : "replaced", utterance.id)
        if (!answers) return yield* follow(Brain.check(decision, decided.situation, said), decided, said)
        if (decision.act === "dismiss") {
          yield* forgo(open, "He said not to send it again.")
          return reply(said.leaving, decided.subject)
        }
        if (open.kind === "project") return yield* project(open, decided, said)
        if (open.kind !== "which") return yield* agreeing(open, decided, said)
        const checked = Brain.check(decision, decided.situation, said)
        // At most one question: one the answer doesn't settle is let go.
        if (checked._tag === "Ask") {
          yield* Effect.logInfo("Leaving it, since the answer didn't settle which one")
          return reply(said.leaving, decided.subject)
        }
        return yield* follow(checked, decided, said)
      }).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.as(Effect.logInfo("Stopped working on it, since yapd was turned off"), quiet(thought.subject))
            : Effect.logError("Could not act on what you said", cause).pipe(
                Effect.zipRight(persona.lines),
                Effect.map((said) => reply(`Something went wrong on my side${addressed(said)}. What you said is in my log.`, thought.subject)),
              ),
        ),
      )

    /**
     * What's said back to the question: worked out as he talks, acted on once
     * he's stopped, in the background. Only words nobody said, like Whisper
     * hears in silence, leave it waiting: anything else closes it, even talk
     * that wasn't meant for yapd.
     */
    const listen =
      (open: Open) =>
      (heard: string, voiced: number): Effect.Effect<Option.Option<Effect.Effect<void>>> =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const { turns } = yield* options.power
        const utterance: Utterance = { id: mint(at, "u"), heard, via: "reply", at, voiced, turns }
        const thought = yield* think(utterance, { _tag: "Answer", said: open.asked, about: askedAbout(open) }, [{ speaker: "yapd", text: open.asked }])
        if (thought.source === "fast" && thought.decision.act === "resume") return Option.none()
        // Too little speech to be his, a yes or a pick that would change a thread isn't taken: the question stays open, as if unanswered.
        if (Brain.murmured(thought.decision, utterance)) {
          yield* Effect.logInfo(`Not taking "${heard}" as the answer, with only ${voiced.toFixed(2)} s of speech`)
          return Option.none()
        }
        return Option.some(
          Effect.flatMap(options.awaiting, (arrived) =>
            background(
              turn.withPermits(1)(
                Effect.gen(function* () {
                  yield* Effect.logInfo(`Heard: ${heard}`)
                  const outcome = yield* acting(thought)
                  yield* note(thought, outcome, at)
                  yield* deliver(outcome, utterance)
                  yield* offering
                }),
              ).pipe(Effect.ensuring(arrived), Effect.annotateLogs({ utterance: utterance.id })),
            ),
          ),
        )
      })

    /** Says what came of a request ahead of anything else, and notes it in the journal. */
    const deliver = (outcome: Outcome, utterance: Pick<Utterance, "id" | "turns">): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (outcome.say === "") return
        // Turned off since, nothing about it is said, so nothing is noted as said.
        const power = yield* options.power
        if (!power.on || power.turns !== utterance.turns) return yield* Effect.logInfo(`Not saying "${outcome.say}", since yapd was turned off`)
        const at = yield* Clock.currentTimeMillis
        const open = outcome.kind === "question" && asking !== undefined ? asking.open : undefined
        const about = outcome.subject._tag === "Answer" ? outcome.subject.about : Option.none<Threads.Ref>()
        // Work that started has its own entry.
        if (outcome.kind !== "done") {
          yield* journal.write({
            at,
            kind: "answer",
            ...Option.match(about, { onNone: () => ({}), onSome: ({ machine, id }) => ({ machine, thread: id }) }),
            said: outcome.say,
            utterance: utterance.id,
            ...(open === undefined ? {} : { detail: { question: true, open: open.id } }),
          })
        }
        yield* Effect.logInfo(`Said: ${outcome.say}`)
        const { subject } = outcome
        yield* options.tell(
          {
            id: mint(at, "a"),
            kind: open !== undefined ? "question" : outcome.kind === "done" ? "done" : "answer",
            priority: "needs-you",
            spoken: outcome.say,
            at,
            // "It" means this once he's heard it, not while it waits behind something else he's hearing.
            saying: Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.sync(() => {
                answered = { subject, at: now }
                if (open !== undefined && asking?.open.id === open.id) asking.said = true
              }),
            ),
            ...(open === undefined
              ? { stale: Effect.succeed(false) }
              : {
                  open: open.id,
                  // Only while it's the question open and nothing being said may answer it, so it's never said after what settles it.
                  stale: Effect.sync(() => asking?.open.id !== open.id || asking.held),
                  question: {
                    answer: listen(open),
                    unanswered: background(turn.withPermits(1)(unanswered(open.id))),
                  },
                }),
          },
          utterance.turns,
        )
      })

    /** Notes what he said and what was made of it. */
    const note = (thought: Thought, outcome: Outcome, began: number) =>
      Effect.gen(function* () {
        const { utterance, decision } = thought
        const ms = (yield* Clock.currentTimeMillis) - began
        // What was said back has an entry of its own.
        yield* journal.write({
          at: utterance.at,
          kind: utterance.via === "reply" ? "reply" : "dictation",
          text: utterance.heard,
          utterance: utterance.id,
          detail: { via: utterance.via, source: thought.source, decision, ms, outcome: outcome.kind },
        })
        yield* Effect.logInfo(`Timing: ${(ms / 1000).toFixed(1)} s from what was said to what to say`)
      })

    /**
     * Offers to send again the next message a restart found didn't get
     * there, once nothing else is asked and he isn't dictating: one question
     * at a time, each offered once.
     */
    const offering: Effect.Effect<void> = Effect.gen(function* () {
      while (asking === undefined && presses.length === 0) {
        const row = lost.shift()
        if (row === undefined) return
        const power = yield* options.power
        const sent = typeof row.body === "object" && row.body !== null && "text" in row.body ? String(row.body.text) : ""
        const ref = { machine: row.machine, id: row.thread }
        const listed = (yield* threads.desk(Option.none(), [ref], 1)).threads.find((listed) => Threads.same(listed.ref, ref))
        // Sent again or taken back since it was found, or too long ago now, it's nothing to offer.
        if (Option.isNone(yield* hands.still(row.commandId))) {
          yield* Effect.logInfo(`Not offering ${row.commandId} again, since something came of it meanwhile or it's too long ago`)
          yield* hands.leave(row.commandId, "Too long ago to offer, or something came of it meanwhile.")
          continue
        }
        if (!power.on || listed === undefined || sent === "") {
          yield* hands.leave(row.commandId, power.on ? "Its thread is gone." : "yapd was off when it could have been offered.")
          continue
        }
        const said = yield* persona.lines
        const offered = yield* opening(
          {
            kind: "resend",
            utterance: row.utterance,
            heard: sent,
            decision: Brain.decision({ act: "send", text: sent, how: "now" }),
            candidates: [ref],
            asked: Hands.lost(said, Option.some(listed.called)),
            about: `send that to ${listed.called} again`,
            material: Option.none(),
            resend: Option.some(row.commandId),
          },
          power,
        )
        yield* deliver(offered, { id: row.utterance, turns: power.turns })
      }
    }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("Could not offer to send it again", cause)))

    /** Works out what he said and acts on it, then says what came of it, one request at a time. */
    const respond = (utterance: Utterance) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Heard: ${utterance.heard}`)
        // Whatever comes of it is said, so the speaker gets ready while it's worked out.
        yield* options.coming
        const began = yield* Clock.currentTimeMillis
        const about = utterance.via === "shortcut" && pressed !== undefined ? pressed : yield* subject
        pressed = undefined
        const glanced = yield* glance(utterance, about, [])
        let ahead: Fiber.RuntimeFiber<Either.Either<Drafts.Written, string>> | undefined
        let thought: Thought
        if (glanced.quick !== undefined) thought = worked(glanced, utterance, about, glanced.quick, "fast")
        else {
          // In case it's new work, or names the project asked about, the prompt is written while the model works out which.
          const asked = Option.filter(glanced.situation.open, ({ kind }) => kind === "project")
          const lines: ReadonlyArray<Line> = Option.match(asked, {
            onNone: () => [{ speaker: "user", text: utterance.heard }],
            onSome: (open) => [
              { speaker: "yapd", text: open.asked },
              { speaker: "user", text: utterance.heard },
            ],
          })
          ahead = yield* drafts.begin(lines, Option.getOrUndefined(Option.flatMap(asked, ({ material }) => material))).pipe(Effect.forkIn(scope))
          writing.set(utterance.id, ahead)
          thought = yield* decide(glanced, utterance, about)
          const { act, pending } = thought.decision
          // Kept only for what it was written for: new work, or the answer to which project.
          const answering = Option.isSome(asked) && pending === "answers"
          if (!(answering || (act === "start" && Option.isNone(asked)))) {
            writing.delete(utterance.id)
            yield* Fiber.interruptFork(ahead)
          }
        }
        yield* Effect.logInfo(`Routed: ${routed(thought, (yield* Clock.currentTimeMillis) - began)}`)
        const outcome = yield* acting(thought).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              writing.delete(utterance.id)
              return ahead === undefined ? Effect.void : Fiber.interruptFork(ahead)
            }),
          ),
        )
        yield* note(thought, outcome, began)
        yield* deliver(outcome, utterance)
        yield* offering
        return utterance.id
      }).pipe(Effect.ensuring(release), turn.withPermits(1), Effect.annotateLogs({ utterance: utterance.id }))

    /**
     * A dictation ended, and dictations end in the order they began: the press
     * it began with, the oldest left once any whose dictation ended without a
     * word, like one that failed, are let go of.
     */
    const ended = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      while (presses.length > 1 && now - presses[0]!.at > longest) yield* presses.shift()!.arrived
      return presses.shift()?.arrived
    })

    const heard = (input: Omit<Utterance, "id">) =>
      Effect.gen(function* () {
        const utterance: Utterance = { ...input, id: mint(input.at, "u") }
        // A dictation's answer was awaited from when the shortcut was pressed.
        const arrived = (input.via === "shortcut" ? yield* ended : undefined) ?? (yield* options.awaiting)
        return yield* Effect.zipRight(hold, respond(utterance)).pipe(Effect.ensuring(arrived))
      })

    return {
      think,
      act: (thought) => turn.withPermits(1)(Effect.flatMap(acting(thought), (outcome) => Effect.as(deliver(outcome, thought.utterance), outcome))),
      heard,
      prepare: Effect.gen(function* () {
        // What's dictated is answered before anything else is said.
        presses.push({ at: yield* Clock.currentTimeMillis, arrived: yield* options.awaiting })
        yield* hold
        pressed = yield* subject
        const shortlist = yield* threads.desk(Option.none(), [], desk.vocabulary)
        yield* drafts.prepare(shortlist.threads.map(({ thread }) => thread.title))
        yield* Effect.forkIn(threads.refreshUsage, scope)
      }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("Could not get ready for the dictation", cause))),
      nothing: Effect.zipRight(release, Effect.flatMap(ended, (arrived) => arrived ?? Effect.void)),
      // Not one he hasn't heard yet, which what he said can't have been about.
      replied: Effect.suspend(() => (asking === undefined || !asking.said ? Effect.void : close(asking.open, "replaced"))),
      open: Effect.map(Clock.currentTimeMillis, current),
      drop: Effect.gen(function* () {
        if (asking !== undefined) yield* close(asking.open, "dropped: off")
        pressed = undefined
        // No answer is on its way any more, and the dictations they were for are dropped too.
        yield* Effect.forEach(presses.splice(0), ({ arrived }) => arrived, { discard: true })
        yield* Effect.forEach([...writing.values(), ...jobs], Fiber.interruptFork, { discard: true })
      }),
      undelivered: (rows) =>
        Effect.gen(function* () {
          lost.push(...rows)
          yield* turn.withPermits(1)(offering)
        }),
    } satisfies Assistant["Type"]
  })
