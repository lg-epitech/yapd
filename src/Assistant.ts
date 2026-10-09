import { Cause, Clock, Context, Duration, Effect, Either, Exit, Fiber, FiberSet, Option } from "effect"
import * as Brain from "./Brain.ts"
import type * as Conversation from "./Conversation.ts"
import type * as Drafts from "./Drafts.ts"
import * as Hands from "./Hands.ts"
import type { Notice } from "./Inbox.ts"
import type { Entry, Journal, Kept } from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import { addressed, type Lines, Persona, unaddressed } from "./Persona.ts"
import * as Questions from "./Questions.ts"
import { enough, gist, type Line } from "./Responder.ts"
import * as Show from "./Show.ts"
import * as T3Actions from "./T3Actions.ts"
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
  /** How many times yapd had been turned on or off when it was said, as its shortcut was pressed for a dictation, so nothing is done for it after. */
  readonly turns: number
}

/** What a thread asks of the user, which a short answer can settle. */
export type Asks =
  | {
      readonly _tag: "Approval"
      readonly requestId: string
      readonly decisions: ReadonlyArray<string>
      readonly inFull: boolean
    }
  | {
      readonly _tag: "Question"
      readonly requestId: string
      readonly questions: Extract<T3Actions.Request, { readonly _tag: "Question" }>["questions"]
      /** How T3 Code takes the answer: straight to the agent, or as a message, which needs every part it needs. */
      readonly mode: Extract<T3Actions.Request, { readonly _tag: "Question" }>["mode"]
      /** The part being asked, from the first. */
      readonly part: number
      /** What he answered of the parts before it, by their ids, sent all together once the last is answered. */
      readonly collected: Readonly<Record<string, Questions.Answer>>
      /** Whether he heard the part being asked through to yapd's pick. */
      readonly inFull: boolean
      /** The part a message he dictated to its thread answered, by its id, which goes whatever comes of the parts after it. */
      readonly dictated?: string
    }
  /** The agent's own message ended on a question. */
  | { readonly _tag: "Agent" }

/**
 * What a thread waits on him for that he heard asked, the thread, and when he
 * first heard all of it, which only what he said after can answer: for a
 * question, all of the part he's got to, none yet once he's only answered
 * the one before, so nothing he said before he heard a part answers it.
 */
interface Heard {
  readonly ref: Threads.Ref
  readonly asks: Exclude<Asks, { readonly _tag: "Agent" }>
  readonly through: number | undefined
}

/**
 * What a thread waits on him for, worded to be asked as the one question
 * open: an approval, or a question with its options, which his answer
 * settles in T3 Code for him.
 */
export interface Asking {
  readonly ref: Threads.Ref
  readonly asks: Exclude<Asks, { readonly _tag: "Agent" }>
  /** As it's asked: "The Tezos migration wants to push the branch. Say 'approve' if you want it, sir." */
  readonly asked: string
  /** What a yes does, after "whether to", or what it's about: "allow the Tezos migration to push the branch". */
  readonly about: string
  /** How it's asked again, in other words, each once. */
  readonly rewordings: ReadonlyArray<string>
  /** For a question: how each of its parts is put to him. */
  readonly parts?: ReadonlyArray<Questions.Wording>
  /** What it's kept as in the journal, under the key it's said once under, ever. */
  readonly entry: Entry & { readonly key: string }
  /** The entry it was kept under already, and he never heard, as when yapd restarted while asking it: it's asked under that one. */
  readonly kept?: number
}

/** What a thread waits on him for, worded: to be asked, or only told, when it isn't answered by voice, like a secret. */
export type Worded =
  | { readonly _tag: "Ask"; readonly asking: Asking }
  | { readonly _tag: "Tell"; readonly spoken: string; readonly entry: Entry & { readonly key: string } }

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
  /** An update from a session T3 Code doesn't run, and what of it was said last, like an answer over it. */
  | { readonly _tag: "Session"; readonly update: Conversation.Update; readonly said: string }
  | {
      readonly _tag: "Answer"
      readonly said: string
      readonly about: Option.Option<Threads.Ref>
      /** What he missed that it told him, by journal entry, which counts as heard once he's heard it to the end, said again or not. */
      readonly missed?: ReadonlyArray<number>
      /** Whether it answered him catching up, even with nothing he missed, so what he says back to it is part of catching up. */
      readonly catchingUp?: true
      /** The question it asks, if it does: once that's closed, however quietly, it's told rather than asked again (I4). */
      readonly question?: Open
      /** The question it was, in the words it was asked in, once it's closed: shown as it was, but told rather than asked again (I4). */
      readonly asked?: string
    }

/** The one question yapd has open, and what it's about. */
export interface Open {
  readonly id: string
  readonly version: number
  /** Its own, or what a thread waits on him for: an approval, or a question with its options. */
  readonly kind: "which" | "confirm" | "offer" | "project" | "resend" | "approval" | "question"
  /** The request it belongs to. */
  readonly utterance: string
  /** What the user said in that request. */
  readonly heard: string
  /** What was understood, minus what's being asked. */
  readonly decision: Brain.Decision
  readonly candidates: ReadonlyArray<Threads.Ref>
  /** The exact words said: any news, then the question. */
  readonly asked: string
  /** What it's about in a few words, for asking it again and letting it go: the request, or the threads it chooses between. */
  readonly about: string
  readonly at: number
  /** For the project of new work: what its prompt is written from. */
  readonly material: Option.Option<Material>
  /** For sending again: the command to dispatch again. */
  readonly resend: Option.Option<string>
  /** What the question follows, like why a message didn't go, or that it went lately, which is said on its own if he never hears the question. */
  readonly news?: string
  /** For what a thread waits on him for: the one request it is, which an answer settles, and nothing else. */
  readonly asks?: Asks
  /** For what a thread waits on him for: how it's asked again, in other words, each once. */
  readonly rewordings?: ReadonlyArray<string>
  /** For a thread's question: how the part being asked is put to him. */
  readonly wording?: Questions.Wording
  /**
   * After news, the question on its own, like "Send it again?", as whatever
   * asks it puts it, never worked out from the news, which said on its own
   * isn't always put as it is before the question. A line saying it again may
   * leave the news out, and it's still the question asked again (I4).
   */
  readonly question?: string
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
  /** What he missed that it tells him, by journal entry, which counts as heard once he's heard it to the end, and not before. */
  readonly missed?: ReadonlyArray<number>
  /** What was decided on a second look, at a thread or at what was found, which the answer is. */
  readonly second?: Brain.Decision
  /** What he said looked like a secret, so it wasn't sent, and isn't kept in the journal either. */
  readonly withheld?: boolean
  /** A card to put on his screen as it's said. */
  readonly card?: Show.Draft
  /** Whether the card holds what couldn't be read aloud, like a command, which makes it the one that goes up when another step of the request has one too. */
  readonly unreadable?: boolean
  /** Whether it took his card down, after which only its own card goes up, never one a step before it had. */
  readonly hides?: boolean
  /** What's said in place of `say` if no app is there to show its card by the time it's said: the line as it's worked out with none watching. */
  readonly unseen?: string
  /**
   * The line for going ahead said last in its breath, by it or by a step before
   * it that one without its own, like a stop, follows, which one picked for a
   * step said after it is kept from being.
   */
  readonly onIt?: string
  /** Run once what's said is known to be playing, like noting the line for going ahead it starts with as the one he heard last. */
  readonly confirmed?: Effect.Effect<void>
}

/** What the user says to yapd itself, worked out and acted on. */
export class Assistant extends Context.Tag("yapd/Assistant")<
  Assistant,
  {
    /** No side effects; it may be called again while the user carries on. */
    readonly think: (utterance: Utterance, subject: Subject, lines: ReadonlyArray<Line>) => Effect.Effect<Thought>
    /** Once, one request at a time; thinks once more if the open question changed meanwhile. Never fails. */
    readonly act: (thought: Thought) => Effect.Effect<Outcome>
    /**
     * A dictation, begun with the shortcut `press`, or a typed request: worked
     * out and acted on, then what came of it said ahead of anything else. None
     * when yapd is off or was turned off since it was said, however late it's
     * handed on: then nothing is done for it at all. Turned off while it's
     * worked out or acted on, it stops there, and is none too.
     */
    readonly heard: (utterance: Omit<Utterance, "id">, press?: number) => Effect.Effect<Option.Option<string>>
    /**
     * The shortcut was pressed to start a dictation, `began` then, or now if not
     * known, when yapd had been turned on or off `turns` times: the open question
     * asked by then waits for what's dictated.
     */
    readonly prepare: (press: number, turns: number, began?: number) => Effect.Effect<void>
    /** The dictation a press began came to nothing, like one cancelled, failed or with no words in it: the open question is waited on again. */
    readonly nothing: (press: number) => Effect.Effect<void>
    /** Something was said over an update, which takes the place of whatever yapd asked before that he heard. */
    readonly replied: Effect.Effect<void>
    readonly open: Effect.Effect<Option.Option<Open>>
    /**
     * yapd was turned off: the open question is closed, whatever was being
     * worked out, written up or done for a request stops, and the card that's
     * up comes down, with none still to go up ever going up.
     */
    readonly drop: Effect.Effect<void>
    /** Messages a restart found didn't get there: each is offered to be sent again once, one at a time. */
    readonly undelivered: (rows: ReadonlyArray<Ledger.Row>) => Effect.Effect<void>
    /** Steps a restart couldn't confirm, like a stop, or a message it can't offer: each is said once, with why, and never done again. */
    readonly unconfirmed: (rows: ReadonlyArray<Ledger.Row>) => Effect.Effect<void>
    /** yapd was turned on: what a restart found while it was off is said, or offered, now. */
    readonly back: Effect.Effect<void>
    /** yapd starts saying something of its own accord about a thread, like that it failed, which "it" then means. */
    readonly mention: (ref: Threads.Ref, said: string) => Effect.Effect<void>
    /**
     * What a thread waits on him for, to ask once nothing else is asked and
     * he isn't dictating, while it still waits on it: once, ever, and once
     * more after something new cut it off before he heard all of it.
     */
    readonly ask: (asking: Asking) => Effect.Effect<void>
    /** What a thread waited on him for was dealt with, in T3 Code or anywhere: it's not asked, and if it's being asked, it's let go without a word. */
    readonly settled: (requestId: string) => Effect.Effect<void>
    /** A machine's threads can be seen again, like rig's once it can be reached: what waits on him there, put by meanwhile, is asked. */
    readonly returned: (machine: string) => Effect.Effect<void>
  }
>() {}

/** "It" means what's playing, or what was heard within this long. */
const recall = 15 * 60_000
/** How long after a question went unanswered it's asked again. */
const again: Duration.DurationInput = "1 minute"
/** How many times a question is asked before it's let go. */
const asks = 2
/** How long "later" puts a thread's question off. */
const snooze = 10 * 60_000
/** How many times a thread's question can have its place taken, or be put off, before it's let go with a word. */
const interruptions = 3
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
 * `besides` is the line for going ahead the step before says in the same
 * breath, which its own is kept from being.
 */
interface Stepping {
  readonly step: number
  readonly twice: boolean
  readonly quietly?: boolean
  readonly besides?: string
}

const quiet = (subject: Subject): Outcome => ({ say: "", subject, kind: "none" })

/** Small counts as words, from one, the way a line starts with them. */
const counted = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"]

/** What ends a catch-up while updates wait to be read next, which it leaves to them: how many are coming up. */
const comingUp = (count: number, said: Lines) =>
  count === 0 ? "" : ` ${counted[count - 1] ?? count} more ${count === 1 ? "update is" : "updates are"} coming up${addressed(said)}.`

/** Something said back that isn't about a thread. */
const reply = (say: string, subject: Subject): Outcome => ({ say, subject: { _tag: "Answer", said: say, about: Option.none() }, kind: say === "" ? "none" : "answer" })

/** Something said back about a thread, which "it" then means. */
const regarding = (say: string, about: Option.Option<Threads.Ref>): Outcome => ({ say, subject: { _tag: "Answer", said: say, about }, kind: say === "" ? "none" : "answer" })

/** What's said once what waits on him is put by till its machine's threads can be seen again, to be asked then. */
const onceBack = "I'll ask you again once I can."

/** What's said of something left rather than asked about, since a question is open already. */
const unasked = (about: string, said: Lines) => `I left ${about || "that"} for now, since I'd have to ask you something about it${addressed(said)}.`

/** What a question left unasked would have asked, said after the news it follows, which named what it's about already. */
const unaskedAfter = (open: Pick<Open, "kind" | "about">) =>
  open.kind === "resend" || open.kind === "confirm" ? "I didn't ask about sending it again" : `I didn't ask whether to ${open.about}`

/** The thread a yes or no question, or a thread's own, is about, which it names, so what's said once it's answered needn't name it again. */
const askedAbout = (open: Pick<Open, "kind" | "candidates">) =>
  Brain.yesNo(open.kind) || open.kind === "question" ? Option.fromNullable(open.candidates[0]) : Option.none<Threads.Ref>()

/** The request a question is about, when it's what a thread waits on him for. */
const requestOf = (open: Pick<Open, "asks">) => (open.asks === undefined || open.asks._tag === "Agent" ? undefined : open.asks.requestId)

/**
 * What's waiting to be asked of what a thread waits on him for: whether it's
 * asked again, and whether its key was kept as it was first said. A thread's
 * question, which keeps waiting for him in T3 Code, comes back after
 * whatever took its place, from the part he'd got to, and is let go with a
 * word only once it's been put off or had its place taken too often.
 */
interface Queued {
  readonly asking: Asking
  readonly again: boolean
  kept?: Option.Option<Option.Option<number>>
  /** Not asked before then, as one he put off, or one that gave way to another. */
  readonly notBefore?: number | undefined
  /** How many times it's been asked once it's put, when that isn't once: it's asked once more, as one gone unanswered, only that often. */
  readonly asks?: number | undefined
  /** How it's put: brought back, or asked once more having gone unanswered. Otherwise as it was first asked. */
  readonly back?: "here" | "still" | undefined
  /** How many times something he said took its place once he'd started hearing it. */
  readonly interrupted?: number | undefined
  /** How many times he put it off. */
  readonly snoozed?: number | undefined
  /** Asked no more, but let go with a word, once it's had its place taken too often. */
  readonly letGo?: boolean | undefined
  /**
   * Brought back from a wait that was no asking of his, nor anything taking
   * its place, like a press that came to nothing, yapd turned off and on, or
   * its machine's threads out of sight as he answered: it's put even in words
   * asked lately, never let go for want of others.
   */
  readonly costless?: boolean | undefined
  /** The words it was brought back in at no cost to him lately, which it can still be asked once more in, as it goes unanswered. */
  readonly free?: ReadonlyArray<string> | undefined
}

/** A thread's question, with how far he'd got in answering it. */
type QuestionAsks = Extract<Asks, { readonly _tag: "Question" }>

/**
 * What he answered of a thread's question in one breath: the part he'd got
 * to, all of it, a list for one that takes several, one option a line. Never
 * the parts after, which he's yet to hear, and are asked once this one is
 * answered. With what it was, as it's said before the next. None when it's
 * nothing that part can take, like words a form that takes only its options
 * can't. `dictated` when it's a message he dictated to the thread.
 */
const fill = (asks: QuestionAsks, text: string, dictated = false): { readonly asks: QuestionAsks; readonly ack: string } | undefined => {
  const question = asks.questions[asks.part]
  if (question === undefined) return undefined
  const part = Questions.said(question, Option.none())
  const answer = Questions.resolve(part, text)
  if (answer._tag !== "Picked" && answer._tag !== "Words") return undefined
  const collected = { ...asks.collected, [question.id]: answer }
  return { asks: { ...asks, collected, part: asks.part + 1, ...(dictated ? { dictated: question.id } : {}) }, ack: Questions.ack(part, answer) }
}

/** A thread's question from its first part, with nothing he'd answered of it. */
const fromTheStart = ({ dictated: _, ...asks }: QuestionAsks): QuestionAsks => ({ ...asks, part: 0, collected: {}, inFull: false })

/**
 * A thread's question with the message he dictated to its thread taken back
 * out of it, as if he'd never said it: from the part it answered, which is
 * asked again, so it goes neither with the rest nor once it's let go.
 */
const withdrawn = ({ dictated, ...asks }: QuestionAsks): QuestionAsks => {
  if (dictated === undefined) return asks
  const at = asks.questions.findIndex(({ id }) => id === dictated)
  const collected = Object.fromEntries(Object.entries(asks.collected).filter(([id]) => id !== dictated))
  return { ...asks, collected, part: at < 0 ? asks.part : Math.min(asks.part, at), inFull: false }
}

/**
 * What goes of a thread's question he lets go, by his word or unanswered,
 * when what he'd answered of it holds a message he dictated to its thread:
 * all he answered, with the parts he hadn't left out, as when he skips them,
 * so the message still goes, as he asked. Undefined when there's none.
 */
const leftWith = (asks: Asks | undefined): QuestionAsks | undefined => {
  if (asks?._tag !== "Question" || asks.dictated === undefined || !Object.hasOwn(asks.collected, asks.dictated)) return undefined
  const collected = Object.fromEntries(asks.questions.map(({ id }): [string, Questions.Answer] => [id, asks.collected[id] ?? { _tag: "Skip" }]))
  return { ...asks, collected, part: asks.questions.length }
}

/** Whether he's part-way through a thread's question: past its first part, or with some of it answered. */
const partway = (asks: Asks): asks is QuestionAsks => asks._tag === "Question" && (asks.part > 0 || Object.keys(asks.collected).length > 0)

/**
 * A thread's question as a yes to it is taken. Asked which one then, without
 * yapd's pick, a yes is to the one option left, when only one is, and to none
 * otherwise, and a place, like "the first one", is among the others he was
 * offered. Asked any other way, its words name yapd's pick again, which a
 * yes is to: it's always to what he heard last.
 */
const leaning = (open: Open): Pick<Open, "wording"> | Record<never, never> => {
  const { wording } = open
  if (wording === undefined || open.asked !== wording.instead) return {}
  const others = wording.part.options.flatMap((_, index) => (Option.contains(wording.part.recommended, index) ? [] : [index]))
  const recommended = others.length === 1 ? Option.fromNullable(others[0]) : Option.none<number>()
  return { wording: { ...wording, part: { ...wording.part, recommended, among: others } } }
}

/** A thread's question as it was asked, the part he'd got to and what he'd answered of it, to be queued to come back. */
const resumed = (from: Queued, open: Pick<Open, "asks">, changes: Omit<Queued, "asking" | "again" | "kept">): Queued => ({
  ...from,
  asking: { ...from.asking, asks: open.asks?._tag === "Question" ? { ...open.asks, inFull: false } : from.asking.asks },
  notBefore: undefined,
  asks: undefined,
  back: undefined,
  letGo: undefined,
  costless: undefined,
  ...changes,
})

/**
 * An answer to a question, with what it left out taken from what was asked
 * about: the rest of the request, and a message's words, or failing those the
 * request's own, never the answer's, like "The first." or "Yes.", which
 * aren't for the thread.
 */
const filled = (decision: Brain.Decision, open: Pick<Open, "decision" | "heard">): Brain.Decision => ({
  ...decision,
  text: decision.act === "send" && decision.text.trim() === "" && open.decision.act === "send" ? open.decision.text.trim() || open.heard : decision.text,
  rest: decision.rest.trim() || open.decision.rest,
})

/** When a message goes in, as the brain's `how` says it: an empty one is at once. */
const when = (how: string): T3Actions.When => (how === "after" || how === "restart" ? how : "now")

/** A desk with nothing on it, for words worked out against one that's gone, whose handles name nothing now. */
const nowhere: Threads.Desk = { threads: [], away: [] }

/** Whether a journal entry is a question yapd asked. */
const question = (kept: Kept) => typeof kept.detail === "object" && kept.detail !== null && "question" in kept.detail

/** The question a journal entry asked on its own, without the news before it, unless it's from a yapd that didn't keep it. */
const alone = (kept: Kept) => {
  const asked = (kept.detail as { readonly question?: unknown }).question
  return typeof asked === "string" ? [asked] : []
}

/**
 * Whether a journal entry is him catching up, asking what he missed, at once
 * or on a second look, or asking to hear something again, like a catch-up he
 * didn't hear through, or saying something back to what he missed, like
 * "thanks" or "stop" over it: none tells him anything until he's heard the
 * answer, and what a reply cut off he never did.
 */
const catchUp = (kept: Kept) => {
  if (Brain.catchingUp(kept.text ?? "")) return true
  if (typeof kept.detail !== "object" || kept.detail === null) return false
  const { decision, second, over } = kept.detail as {
    readonly decision?: Partial<Brain.Decision>
    readonly second?: Partial<Brain.Decision>
    readonly over?: unknown
  }
  return decision?.how === "missed" || second?.how === "missed" || decision?.act === "again" || over === "catch-up"
}

/** Whether "it" is an answer telling him what he missed, or what he asked catching up, so what he says back to it is part of catching up. */
const caughtUp = (subject: Subject) => subject._tag === "Answer" && (subject.missed !== undefined || subject.catchingUp === true)

/**
 * What "it" means once what came of something he said is said: said back to
 * catching up, whatever came of it, like an answer, a card or a later step of
 * the request, is part of catching up too, unless it asks him something, so
 * thanks after it doesn't hide what he didn't hear either.
 */
const along = (thought: Pick<Thought, "utterance" | "subject">, subject: Subject): Subject =>
  thought.utterance.via === "reply" && caughtUp(thought.subject) && subject._tag === "Answer" && subject.question === undefined && !caughtUp(subject)
    ? { ...subject, catchingUp: true }
    : subject

/** Whether he only told yapd to stop what it's saying, like "skip" or "stop, stop", rather than taking it in, like "thanks". */
const hushed = (heard: string) => enough.has([...new Set(gist(heard).split(" "))].join(" "))

/** Whether what was heard was taken for noise rather than anything he said to yapd. */
const noise = (kept: Kept) =>
  typeof kept.detail === "object" && kept.detail !== null && (kept.detail as { readonly decision?: Partial<Brain.Decision> }).decision?.act === "resume"

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
  /** What's on his screen. */
  readonly show: Show.Show["Type"]
  /** Queues something to say, unless yapd was turned off since `since`. */
  readonly tell: (notice: Notice, since?: number) => Effect.Effect<void>
  /** Whether yapd is on, and how many times it was turned on or off. */
  readonly power: Effect.Effect<{ readonly on: boolean; readonly turns: number }>
  /**
   * The update being read, or the last one the user heard, what of it was
   * said last, like an answer over it, and when, with how many times yapd had
   * been turned on or off as it was read.
   */
  readonly lastHeard: Effect.Effect<
    Option.Option<{ readonly update: Conversation.Update; readonly said: string; readonly at: number; readonly playing: boolean; readonly turns: number }>
  >
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
  /** Drops an update he told to stop, even one a dictation cut off to be read again, which then counts as heard. */
  readonly skip: (update: Conversation.Update) => Effect.Effect<void>
  /** The updates waiting to be read, like one a dictation cut off, by their entry in the journal: coming up, so not missed. */
  readonly upcoming: Effect.Effect<ReadonlyArray<number>>
  /** What a thread waits on him for, read and worded now, to read back what he answers by dictation, unless he's heard it. */
  readonly compose: (ref: Threads.Ref, requestId: string) => Effect.Effect<Option.Option<Worded>>
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
    /**
     * The open question, with what's being said meanwhile that may answer it,
     * by press or request, which holds it until each is dealt with; when it
     * first started being said to him, and when he'd heard all of it as it
     * was last asked, so what he said before either is told apart, however
     * late it's handed on; and for what a thread waits on him for, what it
     * was asked from.
     */
    let asking:
      | {
          open: Open
          asks: number
          repeat: Fiber.RuntimeFiber<void> | undefined
          /** When it's due to be asked again, while it's waiting to be. */
          due: number | undefined
          held: Set<string>
          said: number | undefined
          whole: number | undefined
          /** Whether he skipped a part T3 Code needs an answer to, which it was asked once more for. */
          skipped: boolean
          from?: Queued
        }
      | undefined
    /** Changes whenever the open question does, so what was worked out against another can tell. */
    let version = 0
    /**
     * Cards still to go up with what's waiting to be said, by the request each
     * is for, which "hide that" keeps down: every one when it's said on its
     * own, but only its own request's when it's a later step of one, like
     * "show me everything, then hide that", which is about the card that
     * request put up and no other. Each is let go of as its line is said, or
     * once it won't be, and all of them, kept down, once yapd is turned off,
     * which drops what's waiting, though one being said just then may not
     * have gone up yet.
     */
    const cards = new Set<{ readonly request: string; down: boolean }>()
    /**
     * What yapd said last of its own accord, which "it" may mean, when it
     * started saying it, and how many times yapd had been turned on or off
     * then: once it's turned off, nothing said before is "it", nor said or
     * shown again.
     */
    let answered: { readonly subject: Subject; readonly at: number; readonly turns: number } | undefined
    /**
     * For each press whose dictation hasn't ended, by the press: what "it"
     * meant then, before the dictation stopped what was playing, and what lets
     * updates be said again once its answer is queued.
     */
    const presses = new Map<number, { readonly subject: Subject; readonly arrived: Effect.Effect<void> }>()
    /**
     * Presses whose dictation has ended, from the last one got ready for on:
     * getting ready for one can take until after it's over, or only begin
     * then, and must hold nothing once it is. One that came to nothing keeps
     * the question he'd heard by then, which it may have cut off, and which
     * nothing else would wait on again.
     */
    const over = new Map<number, string | undefined>()
    /** Prompts being written for what was said before it's known whether it's new work, by utterance. */
    const writing = new Map<string, Fiber.RuntimeFiber<Either.Either<Drafts.Written, string>>>()
    /** What's under way for a request, being worked out or in the background, stopped when yapd is turned off. */
    const jobs = yield* FiberSet.make()
    /** How many times yapd had been turned on or off when it was last turned off, so what's begun after for a request heard by then is stopped too. */
    let dropped = Number.NEGATIVE_INFINITY
    /**
     * Work being started, by the request it's for, which the journal only has
     * once T3 Code has it ready: from when yapd starts reading through its
     * project, if it does, until the launch settles, even once yapd is turned
     * off, so the model knows not to start it again meanwhile.
     */
    const starting = new Map<string, Kept>()
    /** What a restart found, waiting its turn to be said: messages to offer to send again, and steps it couldn't confirm, to say so. */
    const restarted: Array<{ readonly row: Ledger.Row; readonly offer: boolean }> = []
    /** What threads wait on him for, waiting their turn to be asked, after what a restart found. */
    const asked: Array<Queued> = []
    /** Questions about what a thread waited on him for that was dealt with in T3 Code, which a late answer does nothing to. */
    const gone = new Set<string>()
    /** Questions put by while their machine's threads couldn't be seen, which his hearing or answering them then doesn't note as heard. */
    const putBy = new Set<string>()
    /** What threads wait on him for that he's heard asked, by request, oldest first: answered by dictation, it's done as he says. */
    const known = new Map<string, Heard>()

    /** Whether a thread still waits on him for this request, as T3 Code last said, even behind a newer one. */
    const still = (ref: Threads.Ref, requestId: string) => threads.waiting(ref, requestId)

    /** Takes every copy of a thread's request out of what's waiting to be asked, and gives them back. */
    const dequeue = (requestId: string) => {
      const queued = asked.filter(({ asking: waiting }) => waiting.asks.requestId === requestId)
      if (queued.length > 0) asked.splice(0, asked.length, ...asked.filter(({ asking: waiting }) => waiting.asks.requestId !== requestId))
      return queued
    }

    /**
     * What's waiting to be asked that can be now: the first that's due, on a
     * machine whose threads can be seen. One on a machine whose can't, like
     * rig's while it can't be reached, waits for them to be back, without
     * holding up the rest.
     */
    const askable = (now: number) =>
      Effect.findFirst(asked, ({ asking: waiting, notBefore }) =>
        (notBefore ?? now) > now ? Effect.succeed(false) : Effect.map(threads.unseen(waiting.ref.machine), Option.isNone),
      )

    const mint = (at: number, prefix: string) => `${prefix}${at.toString(36)}${crypto.randomUUID().slice(0, 4)}`

    /** Whether yapd is off, or was turned off since it had been turned on or off `turns` times, so nothing is done now for what was said by then. */
    const outdated = (turns: number) => Effect.map(options.power, (power) => !power.on || power.turns !== turns)

    /**
     * Under way for a request heard when yapd had been turned on or off
     * `turns` times, and stoppable even when begun from what can't be
     * stopped, like an answer being taken in. It's among the jobs from when
     * it's begun, not from when it starts running, so turning yapd off just
     * after can't miss it; and begun as yapd is being turned off, it's
     * stopped like the rest.
     */
    const job = <A, E>(effect: Effect.Effect<A, E>, turns: number) =>
      Effect.gen(function* () {
        const fiber = yield* effect.pipe(Effect.interruptible, FiberSet.run(jobs))
        if (turns <= dropped) yield* Fiber.interruptFork(fiber)
        return fiber
      })

    /** In the background for a request, which nothing waits for. */
    const background = <A, E>(effect: Effect.Effect<A, E>, turns: number) =>
      Effect.asVoid(
        job(
          Effect.catchAllCause(effect, (cause) => (Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Something went wrong", cause))),
          turns,
        ),
      )

    /**
     * A request being worked out and acted on, which turning yapd off stops
     * like what's in the background for it, from the model to the prompt
     * being written: then nothing comes of it, as if it had been said before,
     * and what's asked once yapd is on again doesn't wait for it. Stopped too
     * when whatever waits for it is.
     */
    const stoppable = (request: Effect.Effect<Option.Option<string>>, utterance: Utterance) =>
      // Begun and among the jobs before anything can stop whatever waits for it, so it's never left running on its own.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* job(request, utterance.turns)
          const exit = yield* restore(Fiber.await(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
          if (Exit.isSuccess(exit) || !Cause.isInterruptedOnly(exit.cause)) return yield* exit
          yield* Effect.logInfo("Stopped working on it, since yapd was turned off").pipe(Effect.annotateLogs({ utterance: utterance.id }))
          return Option.none<string>()
        }),
      )

    /** Whether he'd heard it, as `at` says he had, by the time he said this: what he said before can't be about it, however late it's handed on. */
    const heardBy = (utterance: Pick<Utterance, "at">, at: number | undefined) => at !== undefined && at <= utterance.at

    /**
     * The open question, unless it's been open so long it no longer counts:
     * for an approval or a thread's question, with whether he'd heard all of
     * it as it was last asked by the time he said what's answering it, `by`,
     * which a plain yes to it needs, and what a yes to a question is to.
     */
    const current = (now: number, by = Number.POSITIVE_INFINITY) => {
      if (asking === undefined || now - asking.open.at >= fresh) return Option.none<Open>()
      const { open, whole } = asking
      const asks = open.asks
      if (asks === undefined || asks._tag === "Agent") return Option.some(open)
      return Option.some({ ...open, asks: { ...asks, inFull: heardBy({ at: by }, whole) }, ...leaning(open) })
    }

    /**
     * The open question, if it was asked by the time this was said, and he
     * hadn't started hearing it only after: one asked after, or one said to
     * him only once he'd said this, can't be what it's about, so it never
     * answers, dismisses or closes it. One he hasn't heard at all yet is his
     * to have something new take its place.
     */
    const before = (utterance: Pick<Utterance, "at">) =>
      asking !== undefined && asking.open.at <= utterance.at && (asking.said === undefined || heardBy(utterance, asking.said)) ? asking : undefined

    /**
     * Whether what he said was said back to something other than the
     * question, like an answer he follows up, which it can't be the answer
     * to, however it's taken: only what's said back to the question itself,
     * or dictated or typed, can be.
     */
    const apart = (utterance: Pick<Utterance, "via">, about: Subject, open: Pick<Open, "id" | "asked">) =>
      utterance.via === "reply" && !(about._tag === "Answer" && (about.question?.id === open.id || about.said === open.asked))

    /**
     * What "it" means now: what's playing, or the latest heard lately, an
     * update or an answer, but nothing from before yapd was last turned off.
     */
    const subject = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { turns } = yield* options.power
      const update = Option.filter(yield* options.lastHeard, (heard) => heard.turns === turns && (heard.playing || now - heard.at < recall))
      const said = answered !== undefined && answered.turns === turns && now - answered.at < recall ? answered : undefined
      if (Option.isSome(update) && (said === undefined || update.value.playing || update.value.at >= said.at)) {
        return { _tag: "Session", update: update.value.update, said: update.value.said } satisfies Subject
      }
      return said?.subject ?? ({ _tag: "Nothing" } satisfies Subject)
    })

    /**
     * What "it" means as what he said is worked out, however long after it
     * was found: a question it asks that's closed since, however quietly,
     * like by "hide that", a thanks, or what's typed while he dictates, is
     * told as what it asked, never asked again (I4).
     */
    const meaning = (about: Subject, now: number) =>
      Effect.gen(function* () {
        const question = about._tag === "Answer" ? about.question : undefined
        if (about._tag !== "Answer" || question === undefined || Option.exists(current(now), ({ id }) => id === question.id)) return about
        const { question: _, ...told } = about
        return { ...told, said: Brain.recalled(question, yield* persona.lines), asked: about.said } satisfies Subject
      })

    /**
     * What something was worked out against, with "it" as it means once it's
     * acted on: a question closed since, like one let go meanwhile as it went
     * unanswered too long, is told as what it asked, never asked again (I4).
     */
    const afresh = (situation: Brain.Situation) =>
      Effect.map(
        Effect.flatMap(Clock.currentTimeMillis, (now) => meaning(situation.subject, now)),
        (subject): Brain.Situation => ({ ...situation, subject }),
      )

    /** What yapd asked in the last ten minutes, so no question is asked in the same words again. */
    const askedLately = Effect.gen(function* () {
      const kept = yield* journal.since((yield* Clock.currentTimeMillis) - fresh, { kinds: ["answer"] })
      const lines = yield* persona.lines
      // In its own words, without "it's on your screen" when it went up on a card as it was asked, and the question alone, since saying it
      // again may leave out the news before it, like "Send it again?" without that the message may not have got there.
      return kept.filter(question).flatMap((kept) => [...(kept.said === undefined ? [] : [kept.said, Show.offScreen(kept.said, lines)]), ...alone(kept)])
    })

    /**
     * Threads a search for his words turns up, to add to the desk. T3 Code
     * answers in a few ms, so only what each machine found within the cap is
     * taken: rig, further off, being slow never costs what this one found.
     */
    const searching = (heard: string) =>
      Threads.searched(heard, (words) => Effect.map(threads.search(words, cap), ({ matches }) => matches)).pipe(
        Effect.orElseSucceed((): ReadonlyArray<Threads.Ref> => []),
      )

    /** What the brain goes by, from memory: the desk, the journal and what's known of usage. */
    const situate = (utterance: Utterance, meant: Subject, lines: ReadonlyArray<Line>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const about = yield* meaning(meant, now)
        // One he hadn't heard by the time he said this can't be what he's answering, nor one asked after; nor, said back to something said
        // since, like an answer he follows up, one that isn't what he's saying it back to.
        const open = Option.filter(current(now, utterance.at), (open) => before(utterance)?.said !== undefined && !apart(utterance, about, open))
        const focus = Brain.about(about)
        const pending = Option.match(open, { onNone: () => [], onSome: ({ candidates }) => candidates })
        // A reply is about what he just heard, which is on the desk already.
        const found = utterance.via === "reply" ? [] : yield* searching(utterance.heard)
        const [shortlist, recent, spoke, usage, asked, coming, acted] = yield* Effect.all([
          threads.desk(focus, pending, utterance.via === "reply" ? desk.reply : desk.asked, found, desk.named, utterance.heard),
          journal.since(now - lately.span, { most: 2 * lately.most, kinds: ["update", "reply", "dictation", "answer", "started", "notice", "sent", "action"] }),
          journal.since(now - day, { most: 20, kinds: ["dictation", "reply"] }),
          threads.usage,
          askedLately,
          options.upcoming,
          // The last thing done, whatever it was, so "scratch that" never reaches past it to something before.
          ledger.latest(scratchable),
        ])
        // What he hasn't heard since he last said something, other than catching up, which he may never have heard the
        // answer to, or something only heard as noise, like a cough taken for "Thank you.". Not what's waiting to be
        // read, like an update his asking cut off: he's told of that as it's read, not twice.
        const since = spoke.findLast((kept) => !catchUp(kept) && !noise(kept))?.at ?? now - day
        const missed = (yield* journal.unheard(since, unheard + coming.length)).filter(({ id }) => !coming.includes(id)).slice(-unheard)
        // What was done, like a stop, even what he was never told of since he turned yapd off, but not the bookkeeping of questions closed, which says nothing.
        const done = recent.filter((kept) => kept.kind !== "action" || kept.said !== undefined || Brain.unsaid(kept) !== undefined).slice(-lately.most)
        const seen = yield* options.show.seen
        return {
          utterance,
          subject: about,
          lines,
          open,
          desk: shortlist,
          lately: [...done, ...starting.values()].toSorted((one, other) => one.at - other.at),
          unheard: missed,
          usage,
          second: Option.none(),
          asked,
          acted,
          now,
          ...Option.match(seen, { onNone: () => ({}), onSome: ({ title }) => ({ showing: title }) }),
        } satisfies Brain.Situation
      })

    /** What it comes to without the model, when that's enough. */
    const glance = (utterance: Utterance, about: Subject, lines: ReadonlyArray<Line>) =>
      Effect.gen(function* () {
        const against = version
        const situation = yield* situate(utterance, about, lines)
        return { version: against, situation, quick: Brain.fast(situation, yield* persona.lines) } satisfies Glance
      })

    /** What was worked out, about what "it" meant as it was. */
    const worked = (glanced: Glance, utterance: Utterance, decision: Brain.Decision, source: Thought["source"]): Thought => ({
      utterance,
      subject: glanced.situation.subject,
      decision,
      situation: glanced.situation,
      version: glanced.version,
      source,
    })

    /** What the model makes of it, or, when it can't be asked, a line saying so. */
    const decide = (glanced: Glance, utterance: Utterance) =>
      brain.decide(glanced.situation).pipe(
        Effect.map((decision) => worked(glanced, utterance, decision, "model")),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Could not work out what you meant", error)
            const spoken = `I couldn't work that out just now${addressed(yield* persona.lines)}. What you said is in my log.`
            return worked(glanced, utterance, Brain.decision({ act: "answer", spoken }), "failed")
          }),
        ),
      )

    const think = (utterance: Utterance, about: Subject, lines: ReadonlyArray<Line>) =>
      Effect.flatMap(glance(utterance, about, lines), (glanced) =>
        glanced.quick === undefined ? decide(glanced, utterance) : Effect.succeed(worked(glanced, utterance, glanced.quick, "fast")),
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
        const { repeat, whole, from, said, due } = asking
        // Put by till its machine's threads can be seen again, a thread's question is still to be heard, even by a yapd restarted
        // meanwhile, which asks what waits on him that he hasn't heard, under the entry it was kept under.
        const unheard = from?.kept !== undefined && open.kind === "question" && how === "dropped: out of sight" ? Option.flatten(from.kept) : Option.none<number>()
        if (how === "dropped: out of sight" && open.kind === "question") putBy.add(open.id)
        if (from !== undefined && open.kind === "question") {
          // A thread's question still waits for him in T3 Code, so whatever took its place, even what made no sense, it's asked again
          // first thing after, from the part he'd got to, or when it was due to be anyway; the third time it's let go with a word.
          // Turned off, it's asked once yapd is on again, out of sight, like rig's while it can't be reached, once its machine's
          // threads can be seen again, and cut off by a press that came to nothing, at once: none is any asking of his, nor anything
          // taking its place, so none costs it the words it's asked in.
          const waits = how === "dropped: off" || how === "dropped: out of sight" || how === "dropped: nothing said"
          const interrupted = (from.interrupted ?? 0) + (!waits && said !== undefined ? 1 : 0)
          const back = said === undefined ? from.back : "here"
          if (waits) asked.unshift(resumed(from, open, { asks: asking.asks, back, costless: true }))
          else if (how === "replaced" || how === "dropped: unclear") {
            asked.unshift(resumed(from, open, { asks: asking.asks, back, interrupted, notBefore: due, letGo: interrupted >= interruptions }))
          }
        } else if (from !== undefined && (whole === undefined || how === "dropped: out of sight")) {
          // What a thread waits on him for, cut off before he heard all of it by something new, or what made no sense, is asked once more,
          // after; cut off by turning yapd off, it's asked once it's on again, since it still waits on him, and that's no asking of his.
          // Out of sight, heard or not, it's asked once its machine's threads can be seen again: in other words, when he'd heard it.
          if (how === "dropped: off") asked.unshift({ ...from, costless: true })
          else if (how === "dropped: out of sight") asked.unshift({ ...from, ...(said === undefined ? {} : { back: "here" as const }), costless: true })
          else if (!from.again && (how === "replaced" || how === "dropped: unclear")) asked.unshift({ ...from, again: true, costless: undefined })
        }
        asking = undefined
        version++
        if (repeat !== undefined) yield* Fiber.interruptFork(repeat)
        if (Option.isSome(unheard)) yield* journal.markUnheard([unheard.value])
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
    const forgo = (open: Pick<Open, "resend">, reason: string) =>
      Option.match(open.resend, { onNone: () => Effect.void, onSome: (commandId) => hands.leave(commandId, reason) })

    /**
     * What a thread waits on him for that he let go, or that was let go with
     * a word, noted as heard under the entry it was asked under, however
     * little of it he heard: it's never brought up again of yapd's own accord,
     * as when its machine's T3 Code catches up again, though it still waits
     * for him in T3 Code, where he can ask for it.
     */
    const letBe = (from: Queued | undefined) =>
      Effect.gen(function* () {
        const row = from?.kept === undefined ? Option.none<number>() : Option.flatten(from.kept)
        if (Option.isSome(row)) yield* journal.markHeard([row.value], yield* Clock.currentTimeMillis)
      })

    /**
     * Opens a question in place of any other, unless yapd was turned off
     * since what it's about was said, or another was asked since, which stays
     * open: only one ever is, so this one is left with a word instead, with
     * what didn't go and the rest of its request, and a message it would have
     * offered to send again is never offered on its own.
     */
    const opening = (open: Omit<Open, "id" | "version" | "at">, utterance: Pick<Utterance, "turns" | "at">) =>
      Effect.gen(function* () {
        const power = yield* options.power
        if (!power.on || power.turns !== utterance.turns) return quiet({ _tag: "Nothing" })
        if (asking !== undefined && before(utterance) === undefined) {
          yield* Effect.logInfo(`Leaving it, rather than ask in place of a question asked since: ${open.asked}`)
          yield* forgo(open, "Another question was asked before it could be.")
          const said = yield* persona.lines
          const waiting = "since I'm waiting on your answer to something else"
          const left =
            open.kind === "which"
              ? said.cantTell
              : open.news !== undefined
                ? `${open.news} ${unaskedAfter(open)}, ${waiting}.`
                : Brain.yesNo(open.kind)
                  ? `I didn't ask whether to ${open.about}, ${waiting}${addressed(said)}.`
                  : unasked(open.about, said)
          return unfinished(reply(left, { _tag: "Nothing" }), open.decision.rest, said)
        }
        if (asking !== undefined) yield* close(asking.open, "replaced")
        const at = yield* Clock.currentTimeMillis
        version++
        // A dictation begun before it was asked can't be answering it, so nothing holds it yet.
        const opened = { ...open, id: mint(at, "o"), version, at }
        asking = { open: opened, asks: 1, repeat: undefined, due: undefined, held: new Set(), said: undefined, whole: undefined, skipped: false }
        yield* Effect.logInfo(`Asked: ${open.asked}`)
        return { say: open.asked, subject: { _tag: "Answer", said: open.asked, about: askedAbout(open), question: opened }, kind: "question" } satisfies Outcome
      })

    /** Something being said may answer the open question, so it isn't said meanwhile, nor asked again until that's known. */
    const hold = (key: string, since?: number) =>
      Effect.suspend(() => {
        // What began before the question was asked can't be answering it.
        if (asking === undefined || (since !== undefined && since < asking.open.at)) return Effect.void
        const repeat = asking.repeat
        asking.held.add(key)
        asking.repeat = undefined
        return repeat === undefined ? Effect.void : Fiber.interruptFork(repeat)
      })

    /** Lets a question go that went unanswered as often as it's asked, and says so: a thread's is then what "it" means, for him to ask for it. */
    const letGo = (open: Open) =>
      Effect.gen(function* () {
        const from = asking?.open.id === open.id ? asking.from : undefined
        const { turns } = yield* options.power
        const said = yield* persona.lines
        // With a message he dictated among what he answered of it, the message goes, as `parting` has it, or it's put by till it can.
        const message = leftWith(open.asks)
        const away = message === undefined ? Option.none<Outcome>() : yield* putBack(open, said)
        if (Option.isNone(away)) yield* close(open, "dropped: unanswered")
        if (message !== undefined) {
          yield* deliver(Option.isSome(away) ? away.value : yield* unbidden(open.candidates[0], message, said), { id: open.utterance, turns })
          return yield* offering
        }
        yield* letBe(from)
        const left = regarding(Brain.dropped(open, said), open.kind === "question" ? askedAbout(open) : Option.none())
        yield* deliver(unfinished(left, open.decision.rest, said), { id: open.utterance, turns })
        yield* offering
      })

    /**
     * Asks the open question once more, now, in words not asked lately, or
     * lets it go once every wording has been used. However often it was asked
     * already: he asked to hear it, so he's still there to answer it. A
     * thread's question is asked as `how` says: in full, as he asked to hear
     * it again, which uses up none of its asks; with what its options mean;
     * which one then, without yapd's pick; which of them all, to a form his
     * words didn't fit; as a part T3 Code needs an answer to; or, by
     * default, once more as it went unanswered.
     */
    const reask = (said: Lines, how: "still" | "again" | "more" | "instead" | "which" | "needed" = "still") =>
      Effect.gen(function* () {
        const before = yield* askedLately
        if (asking === undefined) return quiet({ _tag: "Nothing" })
        const { open, repeat, from } = asking
        asking.repeat = undefined
        asking.due = undefined
        if (repeat !== undefined) yield* Fiber.interruptFork(repeat)
        const { wording } = open
        // Asked once more as it went unanswered, words it was only brought back in at no cost to him lately, like as a press came to
        // nothing, are still his to hear once more, rather than it being let go for want of others: its asks still bound it.
        const spare = how === "still" ? before.filter((line) => !(from?.free ?? []).includes(line)) : before
        const anew = (question: typeof open) => Brain.reworded(question, before, said) ?? Brain.reworded(question, spare, said)
        // Asked which one, which of them, or for a part it needs already, the same words again would only get the same answer, and no
        // question is asked twice in the same words: it's let go instead. What its options mean is said as often as he asks.
        const asked =
          wording === undefined
            ? anew(open)
            : how === "more"
              ? wording.more
              : how === "instead" || how === "which" || how === "needed"
                ? open.asked === wording[how]
                  ? undefined
                  : wording[how]
                : anew({ ...open, rewordings: how === "again" ? wording.again : wording.still })
        if (asked === undefined) {
          const message = leftWith(open.asks)
          const away = message === undefined ? Option.none<Outcome>() : yield* putBack(open, said)
          if (Option.isSome(away)) return away.value
          yield* close(open, "dropped: asked enough")
          if (message !== undefined) return yield* unbidden(open.candidates[0], message, said)
          yield* letBe(from)
          const left = wording === undefined ? reply(said.leaving, { _tag: "Nothing" }) : regarding(wording.letGo, askedAbout(open))
          return unfinished(left, open.decision.rest, said)
        }
        // Heard again on his asking, or with what its options mean, a thread's question is asked no more often: a minute on, it's still asked once more.
        const counted = wording === undefined || how === "still" || how === "instead" || how === "which" || how === "needed"
        // In other words, it follows no news, so it's the question on its own. Its wording stays as it was: asked which one then, what a yes
        // is to is worked out from these words, as `leaning` has it.
        const reworded = { ...open, asked, question: asked }
        asking = { ...asking, open: reworded, asks: asking.asks + (counted ? 1 : 0), repeat: undefined, due: undefined, held: new Set(), whole: undefined }
        yield* Effect.logInfo(`Asked again: ${asked}`)
        return { say: asked, subject: { _tag: "Answer", said: asked, about: askedAbout(open), question: reworded }, kind: "question" } satisfies Outcome
      })

    /**
     * Asked to see the open question, it's asked once more as `reask` does,
     * `how` it says, with what's said put on his screen as it's said, rather
     * than closed and said again in the words it was asked in.
     */
    const reshown = (said: Lines, situation: Brain.Situation, how: Parameters<typeof reask>[1] = "still") =>
      Effect.gen(function* () {
        const asked = yield* reask(said, how)
        if (asked.kind !== "question") return asked
        const { say, card, unseen } = yield* options.show.present("said", Option.none(), { ...situation, subject: asked.subject }, said)
        return {
          ...asked,
          say,
          ...Option.match(card, { onNone: () => ({}), onSome: (card) => ({ card }) }),
          ...(unseen === undefined ? {} : { unseen }),
        } satisfies Outcome
      })

    /** A minute on, the question is asked once more in other words, or let go with a word if it's been asked as often as it will be. */
    const due = (id: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (asking?.open.id !== id) return
        // This is the asking again, so it's no longer waited for.
        asking.repeat = undefined
        asking.due = undefined
        const power = yield* options.power
        if (!power.on || asking?.open.id !== id) return
        if (asking.asks >= asks) return yield* letGo(asking.open)
        const { utterance } = asking.open
        yield* deliver(yield* reask(yield* persona.lines), { id: utterance, turns: power.turns })
        // Let go, as when it's been asked every way lately, what's next is asked.
        yield* offering
      })

    /** Asks it again, or lets it go, a minute from now, unless something said meanwhile closes it first. */
    const later = (id: string) =>
      Effect.gen(function* () {
        if (asking?.open.id !== id || asking.held.size > 0 || asking.repeat !== undefined) return
        const at = (yield* Clock.currentTimeMillis) + Duration.toMillis(again)
        const repeat = yield* Effect.sleep(again).pipe(Effect.zipRight(turn.withPermits(1)(due(id))), Effect.interruptible, Effect.forkIn(scope))
        if (asking?.open.id === id) {
          asking.repeat = repeat
          asking.due = at
        }
      })

    /**
     * Its listening window ended without an answer: asked again in other
     * words a minute later the first time, let go with a word the second,
     * whatever it asks, as he wants it. A thread's question gives way to
     * another waiting to be asked, which is asked at once, and comes back to
     * be asked once more no sooner than a minute later.
     */
    const unanswered = (id: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Not while something's being said that may answer it, nor twice over.
        if (asking?.open.id !== id || asking.held.size > 0 || asking.repeat !== undefined) return
        if (asking.asks >= asks) return yield* letGo(asking.open)
        const now = yield* Clock.currentTimeMillis
        const { open, from, asks: count } = asking
        if (open.kind === "question" && from !== undefined && Option.isSome(yield* askable(now))) {
          if (asking?.open.id !== id) return
          const back = resumed(from, open, { asks: count + 1, back: "still", notBefore: now + Duration.toMillis(again) })
          yield* close(open, "dropped: unanswered, others waiting")
          asked.push(back)
          return yield* offering
        }
        yield* later(id)
      })

    /**
     * What was being said has been dealt with, and left the open question
     * open, so as far as that goes it came to nothing: once nothing else
     * being said holds it, it's taken up again as `resume` has it.
     */
    const release = (key: string) =>
      Effect.suspend(() => {
        if (asking === undefined || !asking.held.delete(key) || asking.held.size > 0) return Effect.void
        return resume(asking.open.id)
      })

    /**
     * The open question, once a press or a request that came to nothing, like
     * a faint word Whisper hears in silence, no longer holds it, nor anything
     * else: a thread's he hadn't heard all of, which the press may have cut
     * off or kept from being said at all, comes back at once from the part
     * he'd got to, using up none of its asks nor its interruptions, since that
     * was no asking of his, nor anything taking its place; anything else is
     * waited on again, as if it went unanswered.
     */
    const resume = (id: string) =>
      Effect.suspend(() => {
        if (asking?.open.id !== id || asking.held.size > 0) return Effect.void
        if (asking.open.kind !== "question" || asking.from === undefined || asking.whole !== undefined) return later(id)
        return Effect.zipRight(close(asking.open, "dropped: nothing said"), Effect.forkIn(turn.withPermits(1)(offering), scope))
      })

    /** Says something now, ahead of the rest of the answer, like that it's looking. */
    const meanwhile = (spoken: string, utterance: Utterance) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        options.tell(
          { id: mint(at, "a"), kind: "answer", priority: "needs-you", spoken, at, stale: Effect.succeed(false) },
          utterance.turns,
        ),
      )

    /**
     * An answer, which what he said next can be about, decided at once or on a
     * `second` look, with the `card` that goes up with it for what it couldn't
     * read aloud, and what's said in its place if no app shows it by then, as
     * a step of its request: the rest of it follows.
     */
    const answer = (
      spoken: string,
      about: Option.Option<Threads.Listed>,
      thought: Thought,
      said: Lines,
      step: number,
      second?: Brain.Decision,
      aside?: { readonly card: Show.Draft; readonly unseen?: string },
    ) =>
      Effect.gen(function* () {
        const { how } = second ?? thought.decision
        const catching = Brain.catchingUp(thought.utterance.heard) || how === "missed"
        // What's waiting to be read was left out of a catch-up, so he's told it's coming up rather than told it twice.
        const coming = catching ? comingUp((yield* options.upcoming).length, said) : ""
        const text = `${spoken.trim() === "" ? said.misheard : spoken.trim()}${coming}`
        // What he missed is heard once he's heard the model tell him, which a dictation can cut off and turning yapd off can stop.
        const missed = catching ? thought.situation.unheard.map(({ id }) => id) : []
        const ref = Option.map(about, ({ ref }) => ref)
        const told = {
          say: text,
          subject: { _tag: "Answer", said: text, about: ref, ...(missed.length === 0 ? {} : { missed }), ...(catching ? { catchingUp: true } : {}) },
          kind: "answer",
          ...(missed.length === 0 ? {} : { missed }),
          ...(second === undefined ? {} : { second }),
          ...(aside === undefined ? {} : { card: aside.card, unreadable: true }),
          ...(aside?.unseen === undefined ? {} : { unseen: `${aside.unseen.trim()}${coming}` }),
        } satisfies Outcome
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
        const spoken = decided.right.spoken.trim()
        // What it waits on can't be read out, so its card goes up with the answer, ahead of whatever the rest of the request comes to.
        return yield* Option.match(yield* options.show.aside(target, detail.right, spoken, said), {
          onNone: () => answer(spoken, Option.some(target), thought, said, step, decided.right),
          onSome: (aside) => answer(aside.say, Option.some(target), thought, said, step, decided.right, aside),
        })
      })

    /** Searches the threads, or what yapd heard and said, and answers from what's found with a second look. */
    const find = (thought: Thought, said: Lines, step: number) =>
      Effect.gen(function* () {
        const { decision, situation } = thought
        const wanted = decision.text.trim() || thought.utterance.heard
        const now = yield* Clock.currentTimeMillis
        let found: ReadonlyArray<string>
        /** The machines whose threads a search couldn't look through, so finding nothing isn't said as if there were nothing there. */
        const missed = new Set<string>()
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
          const search = (words: string) =>
            Effect.map(threads.search(words), (searched) => {
              for (const name of searched.missed) missed.add(name)
              return searched.matches
            })
          const matches = yield* Threads.matching(wanted, search).pipe(Effect.either)
          if (Either.isLeft(matches)) return reply(`I couldn't search your threads just now${addressed(said)}. ${matches.left.reason}`, thought.subject)
          found = yield* Effect.forEach(matches.right.slice(0, 8), ({ ref, snippet }) =>
            Effect.gen(function* () {
              const listed = situation.desk.threads.find((listed) => Threads.same(listed.ref, ref))
              const title = listed?.handle ?? Option.match(yield* threads.find(ref), { onNone: () => "a thread", onSome: ({ title }) => Brain.fenced(title, 90) })
              return `${title}: ${Brain.fenced(snippet, 300)}`
            }),
          )
        }
        if (found.length === 0) {
          const unsearched = [...missed].map((name) => `${name}'s`).join(" or ")
          return reply(
            missed.size === 0
              ? `I couldn't find anything like that${addressed(said)}.`
              : `I couldn't find anything like that${addressed(said)}, but I couldn't search ${unsearched} threads just now.`,
            thought.subject,
          )
        }
        const decided = yield* brain.decide({ ...situation, second: Option.some({ found }) }).pipe(Effect.either)
        if (Either.isLeft(decided) || decided.right.spoken.trim() === "") {
          return reply(`I found something, but couldn't put it into words just now${addressed(said)}.`, thought.subject)
        }
        const about = Option.fromNullable(called(situation, decided.right.target))
        return yield* answer(decided.right.spoken, about, thought, said, step, decided.right)
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
     * Shows work as being started for a request, in place of whatever was
     * shown for it before, and gives back what stops showing it, unless
     * something else is shown for it by then.
     */
    const underWay = (utterance: Utterance, where: { readonly project: string; readonly machine: Drafts.Machine }, said: string) =>
      Effect.gen(function* () {
        const shown: Kept = {
          id: 0,
          at: yield* Clock.currentTimeMillis,
          kind: "started",
          machine: where.machine.name,
          project: where.project,
          said,
          utterance: utterance.id,
        }
        starting.set(utterance.id, shown)
        return Effect.sync(() => {
          if (starting.get(utterance.id) === shown) starting.delete(utterance.id)
        })
      })

    /**
     * What's said of new work. `asked` is whether the request was asked about
     * already, which it never is twice: neither then, nor when reading the
     * project, which comes back later, would ask while another question is open.
     */
    const begun = (outcome: Drafts.Outcome, thought: Thought, said: Lines, asked: boolean): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const { utterance } = thought
        switch (outcome._tag) {
          case "Said":
            return reply(outcome.spoken, { _tag: "Nothing" })
          case "Started": {
            const { started, machine, spoken } = outcome
            return {
              say: spoken,
              subject: { _tag: "Answer", said: spoken, about: Option.some({ machine: machine.name, id: started.thread }) },
              kind: "done",
              // Only once it's known to play, so a line for going ahead that's dropped as yapd is turned off, or can't be played, never counts as the last one he heard.
              confirmed: persona.said(spoken),
            } satisfies Outcome
          }
          case "Asked": {
            const about = outcome.about || "that"
            if (asked || asking !== undefined) {
              yield* Effect.logInfo(`Leaving it, rather than ask: ${outcome.question}`)
              return reply(unasked(outcome.about, said), { _tag: "Nothing" })
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
            const settled = yield* underWay(utterance, outcome, `Starting ${outcome.about || "it"}, which T3 Code is still getting ready.`)
            // Under way until the launch itself settles, not only until what's said of it stops: turning yapd off stops that, but not the launch.
            yield* outcome.then.pipe(Effect.ensuring(settled), Effect.forkIn(scope))
            yield* background(
              outcome.then.pipe(
                Effect.flatMap((after) => begun(after, thought, said, asked)),
                Effect.flatMap((told) => deliver(told, thought)),
                Effect.ensuring(arrived),
                Effect.annotateLogs({ utterance: utterance.id }),
              ),
              utterance.turns,
            )
            return quiet({ _tag: "Nothing" })
          }
          case "Looking": {
            // Reading the project takes a while, so what comes of it is said when it's ready. It's under way from now, so asking for it again meanwhile doesn't start it twice.
            const settled = yield* underWay(utterance, outcome, `Starting ${outcome.about || "it"}, once I've read through ${outcome.project}.`)
            yield* background(
              outcome.then.pipe(
                Effect.flatMap((after) =>
                  // A launch takes the reading's place at once, rather than once it's this request's turn, so nothing in between can hide it.
                  (after._tag === "Launching" ? begun(after, thought, said, asked) : turn.withPermits(1)(begun(after, thought, said, asked))).pipe(
                    Effect.flatMap((told) => deliver(told, thought)),
                  ),
                ),
                Effect.ensuring(settled),
                Effect.annotateLogs({ utterance: utterance.id }),
              ),
              utterance.turns,
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
        // Written here when it wasn't begun ahead, so it stops with whatever stops this, like yapd being turned off.
        const prompt = yield* ahead === undefined ? drafts.begin(lines, answering) : Fiber.join(ahead)
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
        const told = yield* begun(outcome, thought, said, false)
        // What comes of starting it is known only later, so the rest isn't done on the strength of it, and he's told so, ahead of any question.
        const rest = thought.decision.rest.trim()
        if (rest === "") return told
        const left = `I left the rest for now${addressed(said)}: ${Brain.speakable(rest, thought.situation.desk).replace(/[.!?]+$/, "")}.`
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
        return yield* begun(outcome, thought, said, true)
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

    /** An outcome with what's said of it changed, both as it's worked out and as it's said in its place if no app shows its card by then. */
    const retold = (outcome: Outcome, change: (say: string) => string): Outcome => ({
      ...outcome,
      say: change(outcome.say),
      ...(outcome.unseen === undefined ? {} : { unseen: change(outcome.unseen) }),
    })

    /**
     * What's said of a step that didn't go, or wasn't done, with what was left
     * of its request after it, since a failure stops the rest, and nothing he
     * asked for goes without a word. `desk` is the one the rest was worked out
     * against, which a handle in it is named by; none names nothing.
     */
    const unfinished = (outcome: Outcome, rest: string, said: Lines, desk: Threads.Desk = nowhere): Outcome => {
      const left = Brain.speakable(rest, desk).replace(/[.!?]+$/, "")
      if (left === "") return outcome
      return { ...retold(outcome, (say) => joined(say, `I left the rest${addressed(said)}: ${left}.`, said)), kind: outcome.kind === "none" ? "answer" : outcome.kind }
    }

    /** What's said ahead of what comes of something new, when the question it took the place of held more of its request: that it was left. */
    const ahead = (outcome: Outcome, rest: string, said: Lines): Outcome => {
      const left = Brain.speakable(rest, nowhere).replace(/[.!?]+$/, "")
      if (left === "") return outcome
      return { ...retold(outcome, (say) => joined(`I left the rest${addressed(said)}: ${left}.`, say, said)), kind: outcome.kind === "none" ? "answer" : outcome.kind }
    }

    /** What a decision to change a thread asks of the hands, if it says enough to do it. `last` is the last thing done, which taking back means. */
    const acted = (
      decision: Brain.Decision,
      target: Option.Option<Threads.Listed>,
      heard: string,
      last: Option.Option<Ledger.Row>,
      asks?: Asks,
    ): Hands.Act | undefined => {
      const to = Option.map(target, ({ ref }) => ref)
      // Taking back a stop is letting it carry on.
      const stopped = Option.exists(
        last,
        (row) =>
          row.kind === "stop" &&
          row.state === "sent" &&
          Option.match(to, { onNone: () => true, onSome: ({ machine, id }) => row.machine === machine && row.thread === id }),
      )
      switch (decision.act) {
        case "send": {
          if (Option.isNone(to)) return undefined
          const text = decision.text.trim() || heard
          // To a thread waiting on a question he's heard, it goes as the answer to the part he'd got to, as `answerFor` filled it in.
          if (asks?._tag === "Question") {
            const replied = replying(asks)
            return replied === undefined ? undefined : { _tag: "Reply", to: to.value, requestId: asks.requestId, answers: replied.answers, said: Option.none(), as: "message" }
          }
          return { _tag: "Message", to: to.value, text, how: when(decision.how) }
        }
        case "stop":
          return Option.isNone(to) ? undefined : { _tag: "Stop", to: to.value }
        case "undo":
          return { _tag: "Undo", to, carry: decision.how === "carry" || stopped }
        case "decide": {
          if (Option.isNone(to) || asks?._tag !== "Approval") return undefined
          // Allowed only with "approve" as his answer, however it came here, never a plain yes, nor with more after it; for the rest of the
          // thread's work only when he said so, whatever the model took it for; never for always.
          const allowing = decision.how === "accept" || decision.how === "session"
          if (allowing && (decision.rest.trim() !== "" || !Brain.approving(heard))) return undefined
          const allowed: Hands.Decision | undefined =
            decision.how === "decline" ? "decline" : decision.how === "session" && Brain.forSession(heard) ? "acceptForSession" : allowing ? "accept" : undefined
          return allowed === undefined ? undefined : { _tag: "Decide", to: to.value, requestId: asks.requestId, decision: allowed }
        }
        case "reply": {
          if (Option.isNone(to) || asks?._tag !== "Question") return undefined
          const replied = replying(asks)
          // A message he dictated, going as its answer once he let the rest of it go, is said to have gone as that.
          return replied === undefined ? undefined : { _tag: "Reply", to: to.value, requestId: asks.requestId, ...replied, ...(decision.how === "left" ? { as: "left" as const } : {}) }
        }
        default:
          return undefined
      }
    }

    /**
     * What a thread's question is answered with, from what he answered of
     * each part: the options he picked, as it takes them, his own words as he
     * said them, and nothing for a part he skipped. Never something he didn't
     * say, nor nothing at all. What's said back is the options he picked for
     * the part he just answered, when he picked any: never one from a part
     * before, acknowledged already, as if it answered one he skipped.
     */
    const replying = (asks: QuestionAsks) => {
      const sent = Questions.answers(asks, asks.collected)
      if (Either.isLeft(sent) || Object.keys(sent.right).length === 0) return undefined
      const just = asks.questions[asks.part - 1]
      const answer = just === undefined ? undefined : asks.collected[just.id]
      const said = just !== undefined && answer?._tag === "Picked" ? Option.some(Questions.spoken(Questions.said(just, Option.none()), answer.options)) : Option.none<string>()
      return { answers: sent.right, said }
    }

    /**
     * Says what came of changing a thread, and notes it, why too when it
     * didn't go: as a question when there's one to ask, like whether to send
     * again what may not have got there, under the same ids. Once a step is
     * done, the rest of the request is worked out and done as the next step.
     * `free` is how what follows the note is let be stopped, when the change
     * and its note can't be. `putBy` when what an answer that didn't go was
     * to is put back to be asked again, which he's told.
     */
    const told = (
      act: Hands.Act,
      outcome: Hands.Outcome,
      thought: Thought,
      said: Lines,
      at: { readonly step: number; readonly commandId: string; readonly quietly?: boolean; readonly besides?: string; readonly putBy?: boolean },
      free: <A>(effect: Effect.Effect<A>) => Effect.Effect<A> = (effect) => effect,
    ): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const { utterance, situation } = thought
        /** Sending again a message other than the one asked for now, like the word to carry on: as it went, with the rest of the request after it. */
        const resending = (text: string, how: string) => Brain.decision({ act: "send", text, how, rest: thought.decision.rest })
        const onceMore = "again" in outcome ? outcome.again : Option.none<string>()
        // What may go again is about the thread it was for, which "carry on" needn't name.
        const kept = Option.isSome(onceMore) ? yield* ledger.get(onceMore.value) : Option.none<Ledger.Row>()
        // A question about it is about the words that went, or were to, at the time they went at, like behind a turn that was waiting, which an answer can't stand in for.
        const went = Option.flatMap(kept, Hands.went)
        const decision =
          act._tag === "Message"
            ? { ...thought.decision, text: act.text, ...Option.match(went, { onNone: () => ({}), onSome: ({ how }) => ({ how }) }) }
            : thought.decision
        const ref =
          outcome._tag === "Done"
            ? outcome.to
            : outcome._tag === "Twin" || outcome._tag === "Read"
              ? { machine: outcome.row.machine, id: outcome.row.thread }
              : Option.isSome(kept)
                ? { machine: kept.value.machine, id: kept.value.thread }
                : act._tag === "Undo"
                  ? Option.getOrUndefined(act.to)
                  : act.to
        const called = ref === undefined ? Option.none<string>() : naming(ref, situation)
        // In a question it's always named, since the question has to say what it's about.
        const name = (ref === undefined ? undefined : situation.desk.threads.find((listed) => Threads.same(listed.ref, ref))?.called) ?? "it"
        const subject: Subject = { _tag: "Answer", said: "", about: Option.fromNullable(ref) }
        const now = yield* Clock.currentTimeMillis
        // Held back since it could give a secret away, his words aren't kept, here or with what he said.
        const withheld = Hands.guarded(outcome)
        /**
         * The entry it's noted in: what went, or didn't and why, and what's
         * said of it. Only a message that went is noted as sent; what didn't
         * go, or only asks first, is something done or said. Once yapd was
         * turned off since he said it, nothing is said of it, so nothing is
         * noted as said: what would have been is kept aside.
         */
        const noting = (line: string | undefined, detail: Record<string, unknown>) =>
          Effect.gen(function* () {
            const unsaid = line !== undefined && (yield* outdated(utterance.turns))
            yield* journal.write({
              at: now,
              kind: act._tag === "Message" && outcome._tag === "Done" ? "sent" : "action",
              ...(ref === undefined ? {} : { machine: ref.machine, thread: ref.id }),
              ...(act._tag === "Message" && !withheld ? { text: act.text } : {}),
              ...(line === undefined || unsaid ? {} : { said: line }),
              utterance: utterance.id,
              detail: { commandId: at.commandId, act: act._tag, outcome: outcome._tag, ...(unsaid ? { unsaid: line } : {}), ...detail },
            })
          })
        const asking = (open: Omit<Open, "id" | "version" | "at">) => free(opening(open, utterance))
        const base = { utterance: utterance.id, heard: utterance.heard, material: Option.none(), candidates: ref === undefined ? [] : [ref] }
        switch (outcome._tag) {
          case "Done": {
            // Gone as asked after a step said on its own, it's noted and not said; held behind a turn that's waiting, or in the queue a stop held till he says, he's told why.
            const quietly = at.quietly === true && outcome.waiting === undefined && !Hands.held(outcome)
            // His line for going ahead, a different one from the last he heard and from one the step before says with it, picked only when it's said, and noted only once it plays.
            const onIt = !quietly && Hands.goesAhead(act, outcome.how, outcome) ? yield* persona.onIt(at.besides) : undefined
            const line = quietly ? "" : Hands.done(act, outcome.how, onIt === undefined ? said : { ...said, onIt }, called, outcome)
            yield* noting(line === "" ? undefined : line, {
              how: outcome.how,
              ...(outcome.waiting === undefined ? {} : { waiting: outcome.waiting }),
              ...(outcome.stopped === undefined ? {} : { stopped: outcome.stopped }),
            })
            const first: Outcome = {
              say: line,
              subject: { ...subject, said: line },
              kind: "done",
              // Only once it's known to play, so a line for going ahead dropped as yapd was turned off, or that couldn't be played, never counts as the last one he heard.
              // With none of its own, like a stop, the one said before it in the same breath is still the one the next is kept from being.
              ...(onIt === undefined ? (at.besides === undefined ? {} : { onIt: at.besides }) : { onIt, confirmed: persona.said(onIt) }),
            }
            // Taking a stop back is two steps, letting go of the queue, then the message to carry on, as is a restart done as a stop, then the message.
            return yield* free(onward(thought, first, Option.some(outcome.to), at.step + (act._tag === "Undo" || outcome.stopped !== undefined ? 2 : 1), said))
          }
          case "Twin": {
            // One that may not have got there is offered again under its own ids; one that did, to a thread that hasn't answered since, is asked about.
            const doing = `send that to ${name} again`
            // Twinned by an earlier word to carry on, that's what a yes sends.
            const twin = act._tag === "Message" ? decision : Option.match(Hands.went(outcome.row), { onNone: () => decision, onSome: ({ text, how }) => resending(text, how) })
            yield* noting(undefined, { twin: outcome.row.commandId })
            if (outcome.row.state !== "sent") {
              const news = `I couldn't confirm that got ${Option.match(called, { onNone: () => "there", onSome: (name) => `to ${name}` })} before${addressed(said)}.`
              const question = unaddressed(said.again, said)
              const asked = `${news} ${question}`
              // Sent again under its own ids, it goes at the time it first went, whatever time these words say, like at once for one told to a turn once it was stopped.
              const again = Option.match(Hands.went(outcome.row), { onNone: () => twin, onSome: ({ how }) => ({ ...twin, how }) })
              return yield* asking({ ...base, kind: "resend", decision: again, asked, about: doing, resend: Option.some(outcome.row.commandId), news, question })
            }
            return yield* asking({
              ...base,
              kind: "confirm",
              decision: twin,
              asked: Hands.twice(outcome.row.at, now, said, called),
              about: doing,
              resend: Option.none(),
              news: Hands.sentBefore(outcome.row.at, now, said, called),
              question: Hands.twiceAsks,
            })
          }
          case "Read": {
            const text = typeof outcome.row.body === "object" && outcome.row.body !== null && "text" in outcome.row.body ? String(outcome.row.body.text) : ""
            yield* noting(undefined, { read: outcome.row.commandId })
            return yield* asking({
              ...base,
              kind: "offer",
              decision: Brain.decision({ act: "send", text: Hands.ignore(text), how: "now", rest: decision.rest }),
              asked: Hands.read(said, called),
              about: `tell ${name} to ignore that`,
              resend: Option.none(),
              news: Hands.readAlready(said, called),
              question: Hands.readAsks,
            })
          }
          case "Moot": {
            // Dealt with in T3 Code meanwhile: nothing's done, and he's told so, and the rest of the request still is.
            const line = Brain.dealtWith(said)
            yield* noting(line, { reason: "It no longer waited on it." })
            return yield* free(onward(thought, { say: line, subject: { ...subject, said: line }, kind: "done" }, Option.fromNullable(ref), at.step + 1, said))
          }
          default: {
            const line = `${Hands.failed(act, outcome, said, called)}${at.putBy === true ? ` ${onceBack}` : ""}`
            yield* noting(line, { reason: outcome.reason, ...(outcome.stopped === undefined ? {} : { stopped: outcome.stopped }) })
            // What didn't go, and why, without the question, which isn't always put as the line puts it, like "couldn't tell it yet" for "the
            // message didn't get there": so the question is kept as the line asks it, never worked out from the news.
            const news = Hands.failed(act, "again" in outcome ? { ...outcome, again: Option.none<string>() } : outcome, said, called)
            const question = unaddressed(said.again, said)
            if (Option.isSome(onceMore) && act._tag === "Message") {
              return yield* asking({ ...base, kind: "resend", decision, asked: line, about: `send that to ${name} again`, resend: onceMore, news, question })
            }
            // The word to carry on, after letting go of the queue, is offered again the same way.
            if (Option.isSome(onceMore) && act._tag === "Undo" && act.carry) {
              return yield* asking({
                ...base,
                kind: "resend",
                decision: resending(Hands.carryOn, "now"),
                asked: line,
                about: `ask ${name} to carry on`,
                resend: onceMore,
                news,
                question,
              })
            }
            return unfinished({ say: line, subject: { ...subject, said: line }, kind: "done", ...(withheld ? { withheld } : {}) }, decision.rest, said, situation.desk)
          }
        }
      })

    /**
     * Once a step has gone as asked, the rest of its request, if there's any,
     * as the next step. Once the request has taken as many steps as one takes,
     * what's left of it is said to be left, never dropped without a word.
     */
    const onward = (thought: Thought, first: Outcome, on: Option.Option<Threads.Ref>, next: number, said: Lines): Effect.Effect<Outcome> =>
      thought.decision.rest.trim() === ""
        ? Effect.succeed(first)
        : next < steps
          ? rest(thought, first, on, next, said)
          : Effect.succeed(unfinished(first, thought.decision.rest, said, thought.situation.desk))

    /**
     * The rest of a request with several steps, worked out again now that the
     * step before is done, with "it" the thread that was, and done as the next
     * step. One line covers the lot; a failure stops the rest, and says so.
     */
    const rest = (thought: Thought, first: Outcome, on: Option.Option<Threads.Ref>, step: number, said: Lines): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const utterance: Utterance = { ...thought.utterance, heard: thought.decision.rest }
        yield* Effect.logInfo(`Then: ${utterance.heard}`)
        // Working it out has no effect, so it carries on whether or not what's said waits for it, until yapd is turned off, which stops it like the rest of the request.
        // "It" is the step before as it'll be said, part of catching up when that is, so what the rest comes to is too, however late it's said.
        const thinking = yield* job(
          think(utterance, along(thought, { _tag: "Answer", said: first.say, about: on }), [
            { speaker: "user", text: thought.utterance.heard },
            // Nothing said of the step before, like a thanks, is nothing to show.
            ...(first.say === "" ? [] : [{ speaker: "yapd", text: first.say } satisfies Line]),
          ]),
          utterance.turns,
        )
        const ready = yield* Effect.timeoutOption(Fiber.join(thinking), joining)
        if (Option.isSome(ready)) return yield* then(ready.value, first, step, said, false)
        // Not worked out in time, the step before is said now, on its own, and the rest is done once it is, one request at a time as ever.
        yield* Effect.logInfo("Saying what's done so far, while the rest is worked out")
        yield* background(
          Fiber.join(thinking).pipe(
            // Only what's done waits its turn, not working it out.
            Effect.flatMap((next) => turn.withPermits(1)(Effect.flatMap(then(next, quiet(first.subject), step, said, true), (after) => deliver(after, thought)))),
            Effect.annotateLogs({ utterance: thought.utterance.id }),
          ),
          thought.utterance.turns,
        )
        return first
      })

    /**
     * A step whose card a step after it took down: it never goes up, nor is
     * it said to be on his screen, and what it comes to took it down too, so
     * no card from before it goes up either.
     */
    const unshown = (step: Outcome, said: Lines): Outcome => {
      const { card, unreadable: _, unseen: __, ...rest } = step
      const say = card === undefined ? step.say : Show.offScreen(step.say, said)
      const subject: Subject = step.subject._tag !== "Nothing" && step.subject.said === step.say ? { ...step.subject, said: say } : step.subject
      return { ...rest, say, subject, hides: true }
    }

    /** What comes of the rest of a request, worked out, said with what was said of the step before. `quietly` when that was said already. */
    const then = (next: Thought, first: Outcome, step: number, said: Lines, quietly: boolean): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        if (next.source === "failed") return retold(first, (say) => joined(say, `I couldn't work out the rest${addressed(said)}.`, said))
        if ((next.decision.act === "dismiss" && next.decision.rest.trim() === "") || next.decision.act === "resume") return first
        // A line for going ahead the step before says is kept from being said again in the same breath.
        const after = yield* follow(Brain.check(next.decision, next.situation, said), next, said, {
          step,
          twice: false,
          quietly,
          ...(first.onIt === undefined ? {} : { besides: first.onIt }),
        })
        // Taken down by the rest, like "and hide that", the card of the step before never goes up once it's said.
        const before = after.hides === true ? unshown(first, said) : first
        if (after.say === "") return before
        // What he missed that the step before told him is heard once he's heard the lot, as is what the rest told him.
        const missed = [...(before.missed ?? []), ...(after.missed ?? [])]
        const second = before.second ?? after.second
        // One card goes up with the lot: the rest's, the last he asked for, unless only the step before's holds what couldn't be read aloud, like a
        // command he couldn't hear. Only the line of the step it's for says it's on his screen, so he's never told so of one that isn't.
        const kept = after.card === undefined || (before.card !== undefined && before.unreadable === true && after.unreadable !== true) ? before : after
        const onScreen = (step: Outcome) => (step.card === undefined || step === kept ? step.say : Show.offScreen(step.say, said))
        const say = joined(onScreen(before), onScreen(after), said)
        // Said with no app to show its card by then, each step is said as it is with none watching.
        const unseen = kept.unseen === undefined ? undefined : joined(before.unseen ?? before.say, after.unseen ?? after.say, said)
        // What "it" means is what the rest was about, and what's said again is the lot, as heard, with what he missed that the lot told him, but never a question asked as part of it.
        const subject: Subject =
          after.kind === "question" || after.subject._tag === "Nothing"
            ? after.subject
            : after.subject._tag === "Answer"
              ? { ...after.subject, said: say, ...(missed.length === 0 ? {} : { missed }) }
              : { ...after.subject, said: say }
        const { unseen: _, ...rest } = after
        // Of two lines for going ahead, the one said last is the one a step after both is kept from, and the last he heard: each is noted in turn, once it's known to play.
        const onIt = after.onIt ?? before.onIt
        const confirmed =
          before.confirmed === undefined || after.confirmed === undefined
            ? (after.confirmed ?? before.confirmed)
            : Effect.zipRight(before.confirmed, after.confirmed)
        return {
          ...rest,
          say,
          subject,
          ...(missed.length === 0 ? {} : { missed }),
          ...(second === undefined ? {} : { second }),
          ...(kept.card === undefined ? {} : { card: kept.card }),
          ...(kept.unreadable === true ? { unreadable: true } : {}),
          ...(before.hides === true ? { hides: true } : {}),
          ...(unseen === undefined ? {} : { unseen }),
          ...(onIt === undefined ? {} : { onIt }),
          ...(confirmed === undefined ? {} : { confirmed }),
        }
      })

    /** Changes a thread as decided, once, unless yapd was turned off and on since it was said (I8): for what it waits on him for, only `asks`, the request he heard. */
    const write = (plan: Brain.Plan, thought: Thought, said: Lines, at: Stepping, asks?: Asks) =>
      Effect.gen(function* () {
        const { utterance } = thought
        const power = yield* options.power
        if (!power.on || power.turns !== utterance.turns) {
          yield* Effect.logInfo("Not doing it, since yapd was turned off after it was said")
          return quiet(thought.subject)
        }
        const act = acted(plan.decision, plan.target, utterance.heard, thought.situation.acted, asks)
        if (act === undefined) return reply(said.cantTell, thought.subject)
        // Answered now, however it was asked, what a thread waits on him for is never asked again of yapd's own accord, like a copy put
        // by while its machine's threads couldn't be seen, which its T3 Code may not show as answered just yet.
        const queued = asks !== undefined && asks._tag !== "Agent" && (act._tag === "Decide" || act._tag === "Reply") ? dequeue(asks.requestId) : []
        // Once it's begun, it's seen through and noted: turning yapd off meanwhile only stops what's said of it, and any step not written yet, like one after a look at the thread, or telling a turn it stopped (I8).
        const wanted = Effect.map(outdated(utterance.turns), (off) => !off)
        return yield* Effect.uninterruptibleMask((free) =>
          Effect.flatMap(hands.run({ utterance: utterance.id, step: at.step }, act, { twice: at.twice, wanted }), (outcome) =>
            Effect.flatMap(restoring(act, outcome, queued), (putBy) =>
              told(
                act,
                outcome,
                thought,
                said,
                {
                  step: at.step,
                  commandId: Ledger.ids(utterance.id, at.step, false).commandId,
                  ...(at.quietly === true ? { quietly: true } : {}),
                  ...(at.besides === undefined ? {} : { besides: at.besides }),
                  ...(putBy ? { putBy } : {}),
                },
                free,
              ),
            ),
          ),
        )
      })

    /**
     * What was taken out of what's waiting to be asked for an answer that
     * didn't go, while its machine's threads can't be seen, like rig's as it
     * drops out while the model works out what he said: it still waits on
     * him, so it's put back, to be asked from the part he'd got to once they
     * can be seen again, at no cost to it, as `reaching` puts an answer by.
     * Whether it was, which he's told.
     */
    const restoring = (act: Hands.Act, outcome: Hands.Outcome, queued: ReadonlyArray<Queued>) =>
      Effect.gen(function* () {
        if (queued.length === 0 || (act._tag !== "Decide" && act._tag !== "Reply") || (outcome._tag !== "Refused" && outcome._tag !== "NotSent")) return false
        if (Option.isNone(yield* threads.unseen(act.to.machine))) return false
        yield* Effect.logInfo(`Putting it back to be asked, since ${act.to.machine}'s threads can't be seen right now`)
        asked.unshift(...queued.map((waiting): Queued => ({ ...waiting, back: "here", letGo: undefined, costless: true })))
        return true
      })

    /**
     * A yes to doing what was asked about: the same thing on the same thread,
     * as it's known now, checked as anything done is, and never asked about a
     * second time, with anything he added done after it. To sending again,
     * it's the same step under the same ids, once; a yes that doesn't stand
     * lets it go for good. The same words to the same thread at another time,
     * like "yes, but once it's done", are still a yes to sending them, at that
     * time, which sending again takes only when it never left yapd. A no
     * with something else instead, like another thread or other words, is
     * that something else, and what was asked about isn't done.
     */
    const agreeing = (open: Open, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        const { utterance, situation } = thought
        const target = Option.fromNullable(open.candidates[0]).pipe(
          Option.flatMap((ref) => Option.fromNullable(situation.desk.threads.find((listed) => Threads.same(listed.ref, ref)))),
        )
        const handle = Option.match(target, { onNone: () => "", onSome: ({ handle }) => handle })
        // What he left out is what was asked about: its words, as for "no, the Mina one", and its thread, as for "no, stop it instead".
        const answered = filled(thought.decision, open)
        const instead =
          answered.target === "" && handle !== "" && (answered.act === "send" || answered.act === "stop")
            ? { ...answered, target: handle, sure: "high" as const, others: "" }
            : answered
        const timed =
          instead.act === "send" &&
          open.decision.act === "send" &&
          handle !== "" &&
          instead.target === handle &&
          Ledger.digest(instead.text) === Ledger.digest(open.decision.text)
        const agreed = Brain.agrees(open, thought.decision, situation.desk)
        if (!agreed && !timed) {
          yield* forgo(open, "He asked for something else instead.")
          const checked = Brain.check(instead, situation, said)
          if (checked._tag === "Ask") {
            yield* Effect.logInfo("Leaving it, rather than ask again")
            return unfinished(reply(said.leaving, thought.subject), instead.rest, said)
          }
          yield* Effect.logInfo("Doing what he asked instead of what I asked about")
          return yield* follow(checked, { ...thought, decision: instead }, said)
        }
        const decision = !agreed
          ? instead
          : filled(
              Brain.decision({ ...open.decision, target: handle, sure: "high", others: "", pending: "answers", rest: thought.decision.rest }),
              open,
            )
        const checked = Brain.check(decision, situation, said)
        const resend = Option.filter(open.resend, () => checked._tag === "Do" && checked.plan.decision.act === "send" && Option.isSome(target))
        if (Option.isNone(resend)) yield* forgo(open, "His yes didn't stand.")
        if (checked._tag === "Ask") {
          yield* Effect.logInfo("Leaving it, rather than ask again")
          return unfinished(reply(said.leaving, thought.subject), decision.rest, said)
        }
        if (Option.isSome(resend) && Option.isSome(target)) {
          const power = yield* options.power
          if (!power.on || power.turns !== utterance.turns) return quiet(thought.subject)
          // Under the same ids, at the time he says now, which only one that never left can take.
          const act: Hands.Act = { _tag: "Message", to: target.value.ref, text: decision.text, how: when(decision.how) }
          const commandId = resend.value
          return yield* Effect.uninterruptibleMask((free) =>
            Effect.flatMap(hands.again(commandId, { how: act.how }), (outcome) => told(act, outcome, { ...thought, decision }, said, { step: 0, commandId }, free)),
          )
        }
        return yield* follow(checked, { ...thought, decision }, said, { step: 0, twice: true })
      })

    /**
     * The thread his answer to what it waits on him for goes to, as it is
     * now, before the question is closed: on the desk what he said was worked
     * out against, or read again when it wasn't on it, like rig's while its
     * threads couldn't be seen then, back since; none once it's gone. Given
     * while its machine's threads can't be seen, like rig's while it can't be
     * reached or this Mac's while T3 Code restarts, none of it goes, and he's
     * told why, never that it's been dealt with, which can't be known then.
     * It still waits on him, so it's put by, to be asked from the part he'd
     * got to once they can be seen again. `message` when what goes is a
     * message he dictated to its thread, as he lets the rest of it go, which
     * is what he's told didn't.
     */
    const reaching = (open: Open, thought: Thought, said: Lines, message = false) =>
      Effect.gen(function* () {
        const { decision, utterance, situation } = thought
        const ref = open.candidates[0]
        if (ref === undefined) return Either.right(Option.none<Threads.Listed>())
        const why = yield* threads.unseen(ref.machine)
        if (Option.isNone(why)) {
          const listed = situation.desk.threads.find((listed) => Threads.same(listed.ref, ref))
          const now = listed ?? (yield* threads.desk(Option.none(), [ref], 1)).threads.find((listed) => Threads.same(listed.ref, ref))
          return Either.right(Option.fromNullable(now))
        }
        yield* Effect.logInfo(`Not answering it, since ${ref.machine}'s threads can't be seen right now`)
        yield* close(open, "dropped: out of sight", utterance.id)
        const yours = message ? "your message" : open.kind === "approval" ? (decision.how === "decline" ? "your no" : "your go-ahead") : "your answer"
        return Either.left(regarding(`I couldn't get ${yours} to it${addressed(said)}: ${Hands.after(why.value)} ${onceBack}`, askedAbout(open)))
      })

    /**
     * His answer to what a thread waits on him for, as the question open
     * asked it: about that thread, `target` as `reaching` found it, and the
     * very request he heard, whatever the model took it for. Something else
     * instead is done in its place, which leaves the request waiting in T3 Code.
     */
    const settle = (open: Open, target: Option.Option<Threads.Listed>, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        const { decision, situation } = thought
        if (decision.act !== (open.kind === "approval" ? "decide" : "reply")) return yield* follow(Brain.check(decision, situation, said), thought, said)
        if (Option.isNone(target)) return reply(Brain.dealtWith(said), thought.subject)
        return yield* write({ decision: { ...decision, target: target.value.handle }, target }, thought, said, { step: 0, twice: false }, open.asks)
      })

    /**
     * Puts a thread's question off ten minutes, as he said: it comes back
     * then, from the part he'd got to. The third time, it's let go with a
     * word instead, and still waits for him in T3 Code, where he can ask for it.
     */
    const putOff = (open: Open, from: Queued | undefined, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        const snoozed = (from?.snoozed ?? 0) + 1
        const left = from === undefined || snoozed >= interruptions ? leftWith(open.asks) : undefined
        if (left !== undefined) return yield* bidden(open, left, thought, said)
        yield* close(open, "dropped: later", thought.utterance.id)
        if (from === undefined || snoozed >= interruptions) {
          yield* letBe(from)
          return regarding(open.wording?.letGo ?? said.leaving, askedAbout(open))
        }
        asked.push(resumed(from, open, { back: "here", snoozed, notBefore: (yield* Clock.currentTimeMillis) + snooze }))
        yield* Effect.logInfo(`Put off: ${open.asked}`)
        return regarding(`I'll bring it back in ten minutes${addressed(said)}.`, askedAbout(open))
      })

    /**
     * A message he dictated to a thread, taken as the answer to a part of its
     * question, once he lets the rest of it go, by his word or as it goes
     * unanswered: it still goes, as he asked, as its answer, with the parts
     * he hadn't answered left out, as when he skips them, and he's told it
     * went, or why it didn't, never that the question was left. To `target`,
     * the thread as it is now; none once it's gone.
     */
    const parting = (target: Option.Option<Threads.Listed>, left: QuestionAsks, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        if (Option.isNone(target)) return reply(Brain.dealtWith(said), thought.subject)
        const decision: Brain.Decision = { ...thought.decision, act: "reply", how: "left", target: target.value.handle }
        yield* Effect.logInfo("Sending the message he dictated as its answer, with the parts he let go left out")
        return yield* write({ decision, target }, { ...thought, decision }, said, { step: 0, twice: false }, left)
      })

    /** As `parting` has it, let go by his word: the question open closed as answered, or put by while its machine's threads can't be seen. */
    const bidden = (open: Open, left: QuestionAsks, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        const target = yield* reaching(open, thought, said, true)
        if (Either.isLeft(target)) return target.left
        yield* close(open, "answered", thought.utterance.id)
        return yield* parting(target.right, left, thought, said)
      })

    /**
     * A thread's question let go with a message he dictated among what he
     * answered of it, while its machine's threads can't be seen: nothing can
     * go, nor can it be known to be dealt with, so it's put by, as `reaching`
     * puts an answer by, and asked once they can be seen again, with what's
     * said of it. None while they can be seen.
     */
    const putBack = (open: Open, said: Lines) =>
      Effect.gen(function* () {
        const ref = open.candidates[0]
        const why = ref === undefined ? Option.none<string>() : yield* threads.unseen(ref.machine)
        if (Option.isNone(why)) return Option.none<Outcome>()
        yield* Effect.logInfo(`Not sending his message as its answer, since ${ref?.machine}'s threads can't be seen right now`)
        yield* close(open, "dropped: out of sight")
        return Option.some(regarding(`I couldn't get your message to it${addressed(said)}: ${Hands.after(why.value)} ${onceBack}`, askedAbout(open)))
      })

    /**
     * The question open, with the message he dictated to its thread taken
     * back out of it, as `withdrawn` has it, as it's open and as he's got to
     * it, so it goes neither with the rest nor once it's let go.
     */
    const withdrawing = (open: Open): Open => {
      if (asking?.open.id !== open.id || open.asks?._tag !== "Question" || open.asks.dictated === undefined) return open
      const asks = withdrawn(open.asks)
      const heard = known.get(asks.requestId)
      if (heard?.asks._tag === "Question") known.set(asks.requestId, { ...heard, asks: withdrawn(heard.asks), through: undefined })
      const taken = { ...open, asks }
      asking = { ...asking, open: taken }
      return taken
    }

    /** As `parting` has it, let go with nothing he said, under ids of its own, naming the thread it went to. */
    const unbidden = (ref: Threads.Ref | undefined, left: QuestionAsks, said: Lines) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const { turns } = yield* options.power
        const utterance: Utterance = { id: mint(at, "n"), heard: "", via: "reply", at, voiced: 0, turns }
        const situation = yield* situate(utterance, { _tag: "Nothing" }, [])
        const thought: Thought = { utterance, subject: situation.subject, decision: Brain.decision({ act: "reply" }), situation, version, source: "fast" }
        const found = (desk: Threads.Desk) => (ref === undefined ? undefined : desk.threads.find((listed) => Threads.same(listed.ref, ref)))
        const listed = found(situation.desk) ?? (ref === undefined ? undefined : found(yield* threads.desk(Option.none(), [ref], 1)))
        return yield* parting(Option.fromNullable(listed), left, thought, said)
      })

    /**
     * What a thread's request is asked from, now it's open again some other
     * way than from the queue, like read back on his asking: any copy still
     * queued to come back is taken out, so it's never asked twice over, nor
     * from a part he's past, once it's let go. How often it was put off, or
     * had its place taken, carries over, as do the words it was brought back
     * in at no cost to him.
     */
    const unqueued = (from: Queued): Queued => {
      const queued = dequeue(from.asking.asks.requestId)
      if (queued.length === 0) return from
      const most = (count: "snoozed" | "interrupted") => Math.max(from[count] ?? 0, ...queued.map((waiting) => waiting[count] ?? 0)) || undefined
      const free = [...new Set([from, ...queued].flatMap((waiting) => waiting.free ?? []))]
      return { ...from, snoozed: most("snoozed"), interrupted: most("interrupted"), ...(free.length === 0 ? {} : { free }) }
    }

    /** Opens a part of a thread's question, in these words, with what he answered of it before, as it was asked from `from`. */
    const askingPart = (open: Open, from: Queued | undefined, asks: QuestionAsks, wording: Questions.Wording, words: string, utterance: Pick<Utterance, "turns" | "at">) =>
      Effect.gen(function* () {
        const outcome = yield* opening(
          {
            kind: "question",
            utterance: open.utterance,
            heard: "",
            decision: open.decision,
            candidates: open.candidates,
            asked: words,
            about: open.about,
            material: Option.none(),
            resend: Option.none(),
            asks,
            rewordings: wording.still,
            wording,
          },
          utterance,
        )
        if (asking?.open.asks === asks && from !== undefined) asking.from = unqueued(resumed(from, { asks }, {}))
        return outcome
      })

    /**
     * His answer to the part of a thread's question being asked, about that
     * thread, `target` as `reaching` found it, and the very request he heard,
     * whatever the model took it for: kept until the last part, then all of
     * it sent at once. Each part but the last is acknowledged as the next is
     * asked, as what comes of what he said, so it's said next; every part
     * skipped, nothing's sent.
     */
    const answering = (open: Open, from: Queued | undefined, answer: Questions.Answer, target: Option.Option<Threads.Listed>, thought: Thought, said: Lines) =>
      Effect.gen(function* () {
        if (open.asks?._tag !== "Question") return reply(said.cantTell, thought.subject)
        const asks = open.asks
        if (Option.isNone(target)) return reply(Brain.dealtWith(said), thought.subject)
        const question = asks.questions[asks.part]
        if (question === undefined) return reply(said.cantTell, thought.subject)
        const answered: QuestionAsks = { ...asks, collected: { ...asks.collected, [question.id]: answer }, part: asks.part + 1, inFull: false }
        const next = from?.asking.parts?.[answered.part]
        if (next !== undefined) {
          // Where he's got to, so a dictation, or the question brought back, picks up from there: a part he's yet to hear.
          const heard = known.get(asks.requestId)
          if (heard !== undefined) known.set(asks.requestId, { ...heard, asks: answered, through: undefined })
          const ack = Questions.ack(open.wording?.part ?? Questions.said(question, Option.none()), answer)
          const words = answered.part === asks.questions.length - 1 ? next.last(ack) : next.next(ack)
          return yield* askingPart(open, from, answered, next, words, thought.utterance)
        }
        if (Object.values(answered.collected).every(({ _tag }) => _tag === "Skip")) {
          yield* letBe(from)
          return regarding(said.leaving, Option.some(target.value.ref))
        }
        return yield* write({ decision: { ...thought.decision, act: "reply", target: target.value.handle }, target }, thought, said, { step: 0, twice: false }, answered)
      })

    /**
     * What a thread waits on him for that he'd heard asked by the time he
     * said this, `utterance`, and that this answers, an approval or a
     * question: what it shows it waits on, or else the latest still waiting
     * behind something it asked since, which T3 Code's summary of the thread
     * shows in its place.
     */
    const meant = (ref: Threads.Ref, shown: string, kind: "Approval" | "Question", utterance: Pick<Utterance, "at">) =>
      Effect.gen(function* () {
        const answers = (heard: Heard) => Threads.same(heard.ref, ref) && heard.asks._tag === kind && heardBy(utterance, heard.through)
        const showing = known.get(shown)
        if (showing !== undefined && answers(showing)) return Option.some(showing.asks)
        for (const heard of [...known.values()].toReversed()) {
          if (heard.asks.requestId !== shown && answers(heard) && (yield* still(ref, heard.asks.requestId))) return Option.some(heard.asks)
        }
        return Option.none<Heard["asks"]>()
      })

    /**
     * Allowing, turning down or answering what a thread waits on him for,
     * said with no question about it open: done as he says only for a
     * request he's heard asked, even one now behind something it asked
     * since, and an approval only with "approve". Otherwise what it waits on
     * is read back to him as its question, so his answer is to what he heard.
     * A question he's heard is answered from the part he'd got to, and once
     * he's answered every part, it's sent; until then, the next is asked. With
     * nothing in his answer, he wants to hear it: it's read to him again from
     * the part he'd got to, even once he's heard it, or let go of it.
     */
    const unprompted = (plan: Brain.Plan, target: Threads.Listed, thought: Thought, said: Lines, at: Stepping, dictated = false) =>
      Effect.gen(function* () {
        const { decision } = plan
        const pending = target.thread.pendingRuntimeRequest
        if (pending === null) return reply(Brain.dealtWith(said), thought.subject)
        const heard = Option.getOrUndefined(yield* meant(target.ref, pending.id, decision.act === "decide" ? "Approval" : "Question", thought.utterance))
        // Allowed only with "approve", whatever the model took his words for: a plain yes, however it's put, has it read back to him. So
        // does an approve with more after it, which may as well be to what's in the rest, as the model split it.
        const unapproved = heard?._tag === "Approval" && decision.how !== "decline" && (decision.rest.trim() !== "" || !Brain.approving(thought.utterance.heard))
        const hearing = decision.act === "reply" && decision.text.trim() === ""
        if (heard?._tag === "Approval" && !unapproved) return yield* write(plan, thought, said, at, heard)
        // Words a form that takes only its options can't take ask the part he'd got to once more, as over the question itself.
        const filled = heard?._tag === "Question" && !hearing ? fill(heard, decision.text, dictated) : undefined
        if (heard?._tag === "Question" && filled !== undefined) {
          if (filled.asks.part >= filled.asks.questions.length) return yield* write(plan, thought, said, at, filled.asks)
          // Where he's got to, so what's asked next picks up from there: a part he's yet to hear.
          known.set(heard.requestId, { ref: target.ref, asks: filled.asks, through: undefined })
        }
        const request = heard?.requestId ?? pending.id
        // Asked since he said this, it's the question open, his to answer now he's heard it: it isn't read back over itself.
        if (asking !== undefined && requestOf(asking.open) === request && Threads.same(asking.open.candidates[0] ?? { machine: "", id: "" }, target.ref)) {
          yield* Effect.logInfo("Not reading back what it waits on, since it's the question open, asked since he said this")
          return quiet(thought.subject)
        }
        const worded = yield* options.compose(target.ref, request)
        if (Option.isNone(worded)) return reply(`I couldn't read what ${target.called} is waiting on just now${addressed(said)}.`, thought.subject)
        const about = { _tag: "Answer", said: "", about: Option.some(target.ref) } satisfies Subject
        // Said now, so it's never brought up again as news, and noted as heard once he's heard it, so it's nothing he missed.
        const kept = yield* journal.claim(worded.value._tag === "Tell" ? worded.value.entry : worded.value.asking.entry)
        if (worded.value._tag === "Tell") {
          const missed = Option.toArray(Option.flatten(kept))
          return { say: worded.value.spoken, subject: { ...about, said: worded.value.spoken }, kind: "answer", ...(missed.length === 0 ? {} : { missed }) } satisfies Outcome
        }
        const { asking: waiting } = worded.value
        // From the part he'd got to, when he's heard it, with what he'd answered of it.
        const progress = waiting.asks._tag === "Question" ? known.get(request)?.asks : undefined
        const asks =
          waiting.asks._tag === "Question" && progress?._tag === "Question"
            ? { ...waiting.asks, part: progress.part, collected: progress.collected, ...(progress.dictated === undefined ? {} : { dictated: progress.dictated }) }
            : waiting.asks
        const part = asks._tag === "Question" ? waiting.parts?.[asks.part] : undefined
        const words =
          part === undefined || asks._tag !== "Question"
            ? waiting.asked
            : filled !== undefined
              ? asks.part === asks.questions.length - 1
                ? part.last(filled.ack)
                : part.next(filled.ack)
              : hearing || heard !== undefined || asks.part > 0
                ? part.here
                : waiting.asked
        const why =
          hearing
            ? "since he asked to hear it"
            : filled !== undefined
              ? "from the part after the one he answered"
              : heard?._tag === "Question"
                ? "since it takes only its options"
                : heard !== undefined
                  ? "since only 'approve' allows one"
                  : "since he hasn't heard it asked"
        yield* Effect.logInfo(`Reading back what it waits on, ${why}`)
        const read = yield* opening(
          {
            kind: asks._tag === "Approval" ? "approval" : "question",
            utterance: thought.utterance.id,
            heard: thought.utterance.heard,
            decision: asks._tag === "Approval" ? Brain.decision({ act: "decide", how: "accept" }) : Brain.decision({ act: "reply" }),
            candidates: [waiting.ref],
            asked: words,
            about: waiting.about,
            material: Option.none(),
            resend: Option.none(),
            asks,
            rewordings: part?.still ?? waiting.rewordings,
            ...(part === undefined ? {} : { wording: part }),
          },
          thought.utterance,
        )
        // Asked as a notice would be, under the entry it was just kept under.
        if (asking?.open.utterance === thought.utterance.id && asking.open.asks === asks) asking.from = unqueued({ asking: { ...waiting, asks }, again: false, kept })
        // Read back for want of an approve on its own, what he said after it is said to be left.
        return unapproved ? ahead(read, decision.rest, said) : read
      })

    /**
     * What a message for now goes as instead, to a thread waiting on a
     * question he's heard and it still waits on: its answer, since a message
     * steered into the turn meanwhile may sit unread, or end the question.
     * The part he'd got to is answered with it as with anything he'd answer
     * it with: an option it names goes as that option, as the form takes it.
     * Only the last part's answer sends it: with parts after it, those are
     * asked first, as after a dictated answer. Never for one T3 Code takes
     * as a message itself, nor a part he hadn't heard all of by the time he
     * said it, like the next one cut off, which is asked after, nor a form
     * that takes only its options, which can't take it: it goes as the
     * message it is.
     */
    const answerFor = (plan: Brain.Plan, utterance: Pick<Utterance, "at" | "heard">) =>
      Effect.gen(function* () {
        const { decision, target } = plan
        if (Option.isNone(target) || when(decision.how) !== "now") return undefined
        const pending = target.value.thread.pendingRuntimeRequest
        const heard = pending === null ? undefined : known.get(pending.id)
        if (heard?.asks._tag !== "Question" || heard.asks.mode !== "live" || !Threads.same(heard.ref, target.value.ref) || !heardBy(utterance, heard.through)) return undefined
        const answered = fill(heard.asks, decision.text.trim() || utterance.heard)
        if (answered === undefined) return undefined
        return (yield* still(heard.ref, heard.asks.requestId)) ? answered.asks : undefined
      })

    /** Does what was decided and checked: a step of its request, which changes a thread under that step's ids. */
    const perform = (plan: Brain.Plan, thought: Thought, said: Lines, at: Stepping = { step: 0, twice: false }): Effect.Effect<Outcome> => {
      const { decision, target } = plan
      switch (decision.act) {
        case "send":
          return Effect.flatMap(answerFor(plan, thought.utterance), (asks) =>
            // Never sent with parts he's yet to hear left out, as if skipped: he's asked the next, as when he dictates an answer.
            asks !== undefined && asks.part < asks.questions.length && Option.isSome(target)
              ? unprompted({ ...plan, decision: { ...decision, act: "reply", text: decision.text.trim() || thought.utterance.heard } }, target.value, thought, said, at, true)
              : write(plan, thought, said, at, asks),
          )
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
        case "decide":
        case "reply":
          return Option.match(target, {
            onNone: () => Effect.succeed(reply(said.cantTell, thought.subject)),
            onSome: (target) => unprompted(plan, target, thought, said, at),
          })
        case "again":
          return Effect.gen(function* () {
            const situation = yield* afresh(thought.situation)
            const { subject } = situation
            // A dictation cut it off, so it's about to be said again from the start, and once is enough.
            if (subject._tag !== "Nothing" && (yield* options.queued(subject.said))) {
              yield* Effect.logInfo("Not saying it again, since it's about to be said again from the start")
              return quiet(subject)
            }
            const last = subject._tag === "Nothing" ? Brain.nothingSaid(said) : subject.said
            // Said again, what he missed that it told him is heard once he's heard it to the end this time.
            const missed = subject._tag === "Answer" ? subject.missed : undefined
            // The model's words only when there's something to say again that isn't a closed question: with nothing, they can only be from before yapd
            // was turned off and on, and a question, closed or not, is never said again in the words it was asked in, whatever their case or
            // punctuation or wherever it addresses him (I4), nor once "it's on your screen" is taken off it, in whatever case or punctuation, as
            // it is before it's said.
            const theirs = Show.offScreen(decision.spoken.trim(), said)
            const taken =
              subject._tag !== "Nothing" && !(subject._tag === "Answer" && subject.asked !== undefined) && !Brain.echoes(theirs, situation.asked, said)
            // Whether what was asked to be seen is on his screen is told only as it goes up.
            const say = Show.offScreen((taken ? theirs : "") || last, said)
            // Shown too while an app watches, for what's still not caught the second time.
            const card = subject._tag === "Nothing" ? Option.none() : yield* options.show.caption(say, situation)
            return {
              say,
              subject,
              kind: "answer",
              ...(missed === undefined ? {} : { missed }),
              ...Option.match(card, { onNone: () => ({}), onSome: (card) => ({ card }) }),
            } satisfies Outcome
          })
        case "start":
          return start(thought, said, at.step)
        case "show": {
          // Shown, then the rest of the request, like "and tell it to fix the checks", with "it" the thread shown.
          // A later step of the request takes down only a card it put up, like "show me everything, then hide that", never one asked for after it.
          const mine = at.step === 0 ? undefined : thought.utterance.id
          const shown = Effect.flatMap(afresh(thought.situation), (situation) => options.show.present(decision.how, target, situation, said, mine))
          return Effect.flatMap(shown, ({ say, card, about, hides, unseen }) => {
            if (hides === true) for (const kept of cards) if (at.step === 0 || kept.request === thought.utterance.id) kept.down = true
            return onward(
              thought,
              {
                say,
                subject: say === "" ? thought.subject : { _tag: "Answer", said: say, about },
                kind: say === "" ? "none" : "answer",
                ...Option.match(card, { onNone: () => ({}), onSome: (card) => ({ card }) }),
                ...(hides === true ? { hides } : {}),
                ...(unseen === undefined ? {} : { unseen }),
              },
              about,
              at.step + 1,
              said,
            )
          })
        }
        case "dismiss":
          // Nothing more to say to this, and the rest, like "thanks, and tell it to open a PR", still to do.
          return onward(thought, quiet(thought.subject), Option.none(), at.step + 1, said)
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
          return Effect.succeed(unfinished(reply(checked.spoken, thought.subject), thought.decision.rest, said, thought.situation.desk))
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
        // Told to stop the update he was hearing, it isn't read again once the dictation that cut it off is dealt with.
        if (decision.act === "dismiss" && decided.subject._tag === "Session" && hushed(utterance.heard)) yield* options.skip(decided.subject.update)
        const said = yield* persona.lines
        // Nothing was made of it, so that's all that's said, and what he missed isn't marked heard. Still, he said something after the question he heard, which closes it.
        if (decided.source === "failed") {
          const heard = before(utterance)
          if (heard?.said === undefined) return reply(decision.spoken, decided.subject)
          const { open } = heard
          yield* close(open, utterance.via === "reply" ? "dropped: unclear" : "replaced", utterance.id)
          return ahead(reply(decision.spoken, decided.subject), open.decision.rest, said)
        }
        const now = yield* Clock.currentTimeMillis
        if (asking !== undefined && Option.isNone(current(now))) yield* close(asking.open, "dropped: unanswered")
        // One asked since he said this stays open, to be asked as usual, as if it weren't there.
        const opened = before(utterance)
        if (opened === undefined) return yield* follow(Brain.check(decision, decided.situation, said), decided, said)
        // Taking back what he just did, of the question's thread or none named, a message he dictated, taken as the answer to a part of the
        // question, is taken back out of it. That was all he took back, since it never went: he's told so, and the question's asked again
        // after, from the part it answered. Let go with "scratch that", it's let go without it.
        const undone = decided.situation.desk.threads.find(({ handle }) => handle === decision.target)
        const ours = undone === undefined || opened.open.candidates.some((ref) => Threads.same(ref, undone.ref))
        const takenBack = ours && (decision.act === "undo" || (decision.act === "dismiss" && Brain.takesBack(utterance.heard)))
        const open = takenBack ? withdrawing(opened.open) : opened.open
        if (open !== opened.open && decision.act === "undo") {
          yield* close(open, "replaced", utterance.id)
          return yield* onward(decided, reply(`Withdrawn${addressed(said)}.`, decided.subject), Option.none(), 1, said)
        }
        // Whether "it" is the question, as when he pressed the shortcut while it was being asked, even if it broke off before he'd heard it all.
        const asked = decided.subject._tag === "Answer" && (decided.subject.question?.id === open.id || decided.subject.said === open.asked)
        // Said back to something said since, like an answer he follows up, it's never the answer, however it was taken: it takes its place.
        const aside = apart(utterance, decided.subject, open)
        // He didn't catch the question, so it's asked again in other words, now rather than later, however that was taken: what he'd hear is the
        // question, which is never closed and then said again (I4). Taken as an answer while "it" is something else, only once he's heard the
        // question: until then it's still waiting its turn, and what he asks to hear again is what he was hearing. A thread's is asked in full,
        // as he asked, or with what its options mean, or which one then, without yapd's pick.
        if (decision.act === "again" && (asked || (decision.pending === "answers" && opened.said !== undefined && !aside))) {
          const how = decision.how === "more" || decision.how === "instead" || decision.how === "which" ? decision.how : "again"
          return yield* reask(said, open.kind !== "question" ? "still" : how)
        }
        // Nor when he asks to see it, which is hearing it again too.
        if (decision.act === "show" && decision.how === "said" && asked) return yield* reshown(said, decided.situation, open.kind !== "question" ? "still" : "again")
        // He never heard it, so what he said is something new, which takes its place, and he's told what was left for it: what didn't go, and the rest of its request.
        if (opened.said === undefined) {
          if (decision.act === "resume") return quiet(decided.subject)
          yield* close(open, "replaced", utterance.id)
          // What a thread waits on him for is asked after instead, so there's nothing to tell him of it now.
          if (requestOf(open) !== undefined) return yield* follow(Brain.check(decision, decided.situation, said), decided, said)
          const left = open.news === undefined ? Brain.left(open, said) : `${open.news} ${unaskedAfter(open)}, since you'd moved on.`
          yield* deliver(unfinished(reply(left, decided.subject), open.decision.rest, said), decided)
          return yield* follow(Brain.check(decision, decided.situation, said), decided, said)
        }
        // Saying again just what was asked about, like the same message to the same thread, is a yes to it. To sending one again, whatever
        // time the words say: it's asked about at the time it first went, which may not be theirs, like at once to a turn stopped for it.
        const same = open.kind === "resend" ? { ...decision, how: "" } : decision
        const repeated = Brain.yesNo(open.kind) && decision.target !== "" && Brain.agrees(open, same, decided.situation.desk)
        // What a thread waits on him for is only answered for that thread: naming another, like "approve the Mina one instead", is
        // something new, which the model's pick of thread stands for, and leaves the one asked about waiting.
        const named = decided.situation.desk.threads.find(({ handle }) => handle === decision.target)
        const elsewhere = requestOf(open) !== undefined && named !== undefined && !open.candidates.some((ref) => Threads.same(ref, named.ref))
        const answers = (decision.pending === "answers" || repeated) && decision.act !== "resume" && !elsewhere && !aside
        // An approval is allowed only by the word its asking named, "approve" or "allow", never a plain yes, "sure", "OK", "go ahead" or
        // "do it", however risky it looks and whatever the model took them for: he's told it needs an "approve", in the same words for any,
        // and it's left waiting for him to say it. Even with "approve", only once he's heard all of it as it was last asked, since what it
        // would run comes last: otherwise it's asked once more, in full, then it's let go. A no needs neither.
        const approval = open.asks?._tag === "Approval" ? open.asks : undefined
        const allowing = answers && approval !== undefined && decision.act === "decide" && decision.how !== "decline"
        if (allowing && !Brain.approving(utterance.heard)) {
          yield* close(open, "dropped: not approved", utterance.id)
          return unfinished(reply(Brain.unapproved(said), decided.subject), decision.rest, said, decided.situation.desk)
        }
        // With more after it, like "approve it, and tell the Mina one to wait", his approve may as well be to what's in the rest, as the
        // model split it: it's asked again on its own, saying the rest was left, so only an approve to it alone allows it.
        if (allowing && decision.rest.trim() !== "") {
          yield* Effect.logInfo("Asking it again on its own, since his approve came with more")
          if ((asking?.asks ?? asks) < asks) return ahead(yield* reask(said), decision.rest, said)
          yield* close(open, "dropped: not approved", utterance.id)
          return unfinished(reply(Brain.unapproved(said), decided.subject), decision.rest, said, decided.situation.desk)
        }
        if (allowing && !heardBy(utterance, opened.whole)) {
          if ((asking?.asks ?? asks) < asks) return yield* reask(said)
          yield* close(open, "dropped: not heard in full", utterance.id)
          return reply(Brain.cutShort(said), decided.subject)
        }
        const question = open.kind === "question" && answers && open.asks?._tag === "Question" ? open.asks : undefined
        // Put off, a thread's question comes back in ten minutes, from the part he'd got to.
        if (question !== undefined && decision.act === "dismiss" && decision.how === "later") return yield* putOff(open, opened.from, decided, said)
        // Let go with a message he dictated among what he answered of it, the message goes, as `parting` has it.
        const left = question !== undefined && decision.act === "dismiss" ? leftWith(question) : undefined
        if (left !== undefined) return yield* bidden(open, left, decided, said)
        if (question !== undefined && decision.act === "reply") {
          const asked = question.questions[question.part]
          // Asked which one then, a place counts among the others he was offered, as `leaning` has it, with the model or without.
          const leaned = { ...open, ...leaning(open) }.wording?.part
          const part = leaned ?? (asked === undefined ? undefined : Questions.said(asked, Option.none()))
          const answer: Questions.Reply | undefined = decision.how === "skip" ? { _tag: "Skip" } : part === undefined ? undefined : Questions.resolve(part, decision.text)
          // What only agrees, said before he heard yapd's pick, isn't to it, however the model took it, alone or with others he named: it's
          // asked again in full, as a plain yes is then. Asked which one then, the pick is the one option left, as `leaning` has it.
          const pick = leaned === undefined ? undefined : Option.getOrUndefined(leaned.recommended)
          if (
            decided.source === "model" &&
            leaned !== undefined &&
            pick !== undefined &&
            !heardBy(utterance, opened.whole) &&
            answer?._tag === "Picked" &&
            answer.options.includes(pick) &&
            !Questions.mentions(leaned, pick, utterance.heard)
          ) {
            yield* Effect.logInfo("Asking it again in full, since he only agreed before he heard which one I'd go with")
            return yield* reask(said, "again")
          }
          switch (answer?._tag) {
            // Nothing in it, he wants to hear it again; words a form can't take, which of them it takes, with yapd's pick.
            case "Again":
              return yield* reask(said, "again")
            case "Instead":
              return yield* reask(said, "instead")
            case "Which":
              return yield* reask(said, "which")
            case "Skip":
              // A part T3 Code needs an answer to is asked once more, saying so; skipped again, the question is let go with a word.
              if (question.mode === "message" && asked?.required === true) {
                if (!opened.skipped) {
                  opened.skipped = true
                  return yield* reask(said, "needed")
                }
                yield* close(open, "dropped: skipped", utterance.id)
                yield* letBe(opened.from)
                return regarding(open.wording?.letGo ?? said.leaving, askedAbout(open))
              }
              break
          }
          if (answer?._tag === "Picked" || answer?._tag === "Words" || answer?._tag === "Skip") {
            const { from } = opened
            const target = yield* reaching(open, decided, said)
            if (Either.isLeft(target)) return target.left
            yield* close(open, "answered", utterance.id)
            return yield* answering(open, from, answer, target.right, decided, said)
          }
        }
        // Nor is an approval allowed or turned down, nor his answer to a question taken as it is, while its machine's threads can't be seen.
        const target =
          answers && decision.act === (open.kind === "approval" ? "decide" : open.kind === "question" ? "reply" : undefined)
            ? yield* reaching(open, decided, said)
            : Either.right(Option.none<Threads.Listed>())
        if (Either.isLeft(target)) return target.left
        // A thread's question is settled here only by letting it go: anything else, like a message to its thread that can't go as its
        // answer, leaves it waiting in T3 Code, so it's asked again after, unless that dealt with it.
        const settles = answers && (open.kind !== "question" || decision.act === "dismiss")
        yield* close(open, decision.act === "resume" ? "dropped: unclear" : settles ? "answered" : "replaced", utterance.id)
        if (!answers) return ahead(yield* follow(Brain.check(decision, decided.situation, said), decided, said), open.decision.rest, said)
        if (decision.act === "dismiss") {
          yield* forgo(open, "He said not to send it again.")
          yield* letBe(opened.from)
          // What he asked for after what's let go is left too, and what he says to do after the no is done. Let go of a thread's
          // question, "it" is that thread, so he can ask for its question.
          const left = open.kind === "question" ? regarding(said.leaving, askedAbout(open)) : reply(said.leaving, decided.subject)
          return yield* onward(decided, unfinished(left, open.decision.rest, said), Option.none(), 1, said)
        }
        if (open.kind === "project") return yield* project(open, decided, said)
        if (open.kind === "approval" || open.kind === "question") return yield* settle(open, target.right, decided, said)
        // Said again, rather than heard as an answer, like "yes, but once it's done", it's a plain yes.
        if (open.kind !== "which") return yield* agreeing(open, decision.pending === "answers" ? decided : { ...decided, decision: same }, said)
        const picked = filled(decision, open)
        const checked = Brain.check(picked, decided.situation, said)
        // At most one question: one the answer doesn't settle is let go.
        if (checked._tag === "Ask") {
          yield* Effect.logInfo("Leaving it, since the answer didn't settle which one")
          return unfinished(reply(said.leaving, decided.subject), picked.rest, said)
        }
        return yield* follow(checked, { ...decided, decision: picked }, said)
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
        /**
         * What it asked was dealt with in T3 Code meanwhile, so a late answer to
         * it does nothing, and he's told so: it's noted, but not in his words
         * when they look like a secret, as an answer given in time isn't.
         */
        const late = Effect.gen(function* () {
          const withheld = T3Actions.revealing(heard)
          yield* Effect.logInfo(`Not acting on ${withheld ? "what he said" : `"${heard}"`}, since what it answers was dealt with in T3 Code`)
          yield* journal.write({
            at,
            kind: "reply",
            ...(withheld ? {} : { text: heard }),
            utterance: utterance.id,
            detail: { via: "reply", gone: open.asked, ...(withheld ? { withheld } : {}) },
          })
          yield* deliver(regarding(Brain.dealtWith(yield* persona.lines), askedAbout(open)), utterance)
        })
        if (gone.has(open.id)) return Option.some(late)
        const thought = yield* think(utterance, { _tag: "Answer", said: open.asked, about: askedAbout(open), question: open }, [{ speaker: "yapd", text: open.asked }])
        if (thought.source === "fast" && thought.decision.act === "resume") return Option.none()
        // Too little speech to be his, a yes or a pick that would change a thread isn't taken: the question stays open, as if unanswered.
        if (Brain.murmured(thought.decision, utterance)) {
          yield* Effect.logInfo(`Not taking "${heard}" as the answer, with only ${voiced.toFixed(2)} s of speech`)
          return Option.none()
        }
        return Option.some(takeUp(thought, { instead: { moot: Effect.sync(() => gone.has(open.id)), late } }))
      })

    /**
     * What's said over an answer or right after it: a follow-up to it, with
     * "it" what the answer was about, like "tell it to fix the tests" after
     * how a thread is doing, worked out as he talks and acted on once he's
     * stopped, as what he dictates is. Talk that wasn't meant for yapd, or a
     * change to a thread with too little speech to be his, isn't taken: the
     * answer carries on, or the microphone closes. `line` is what he heard of
     * it, which can be its words for no app to show its card.
     */
    const followUp =
      (about: Subject, line: Effect.Effect<string>) =>
      (heard: string, voiced: number): Effect.Effect<Option.Option<Effect.Effect<void>>> =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const { turns } = yield* options.power
          const utterance: Utterance = { id: mint(at, "u"), heard, via: "reply", at, voiced, turns }
          const thought = yield* think(utterance, about, [{ speaker: "yapd", text: yield* line }])
          if (thought.decision.act === "resume") return Option.none()
          if (Brain.murmured(thought.decision, utterance)) {
            yield* Effect.logInfo(`Not taking "${heard}" as a follow-up, with only ${voiced.toFixed(2)} s of speech`)
            return Option.none()
          }
          // Taken, it holds a question asked since the answer that he's yet to hear, like one an agent asked meanwhile, so it isn't said
          // while this is acted on: this takes its place, and it's asked after.
          const holding = `reply:${utterance.id}`
          return Option.some(Effect.zipRight(hold(holding, at), takeUp(thought, { holding })))
        })

    /**
     * What's said back to something yapd said, once he's stopped: acted on in
     * the background, in its turn, with nothing but answers said until what
     * comes of it is, and noted like what he dictates. Unless what it was said
     * back to is `moot` by then, like a question dealt with in T3 Code
     * meanwhile: then only what's `late` is done. Whatever held the open
     * question for it, `holding`, lets go once it's dealt with, however that
     * ends.
     */
    const takeUp = (
      thought: Thought,
      given: { readonly instead?: { readonly moot: Effect.Effect<boolean>; readonly late: Effect.Effect<void> }; readonly holding?: string } = {},
    ) =>
      Effect.flatMap(options.awaiting, (arrived) =>
        background(
          turn.withPermits(1)(
            Effect.gen(function* () {
              if (given.instead !== undefined && (yield* given.instead.moot)) return yield* given.instead.late
              yield* Effect.logInfo(`Heard: ${thought.utterance.heard}`)
              const outcome = yield* acting(thought)
              yield* note(thought, outcome, thought.utterance.at)
              yield* deliver(outcome, thought)
              yield* offering
            }),
          ).pipe(
            Effect.ensuring(arrived),
            Effect.ensuring(given.holding === undefined ? Effect.void : release(given.holding)),
            Effect.annotateLogs({ utterance: thought.utterance.id }),
          ),
          thought.utterance.turns,
        ),
      )

    /**
     * Says what came of a request ahead of anything else, and notes it in the
     * journal. `of` is what he said that it came of, as it was worked out, or
     * only which request it's for, like one a restart found.
     */
    const deliver = (outcome: Outcome, of: Thought | Pick<Utterance, "id" | "turns">): Effect.Effect<void> =>
      Effect.gen(function* () {
        const utterance = "utterance" in of ? of.utterance : of
        if (outcome.say === "") return
        // Turned off since, nothing about it is said, so nothing is noted as said.
        const power = yield* options.power
        if (!power.on || power.turns !== utterance.turns) return yield* Effect.logInfo(`Not saying "${outcome.say}", since yapd was turned off`)
        const at = yield* Clock.currentTimeMillis
        const open = outcome.kind === "question" && asking !== undefined ? asking.open : undefined
        const about = outcome.subject._tag === "Answer" ? outcome.subject.about : Option.none<Threads.Ref>()
        // What a thread waits on him for is kept under its key as it's first said, even asked again after something cut it off, which is its entry, so it's said once, ever.
        const from = open === undefined ? undefined : asking?.from
        const claim = from !== undefined && from.kept === undefined ? from : undefined
        const request = open === undefined ? undefined : requestOf(open)
        // Work that started has its own entry.
        const entry =
          outcome.kind === "done" || claim !== undefined
            ? Option.none<number>()
            : yield* journal.write({
                at,
                kind: "answer",
                ...Option.match(about, { onNone: () => ({}), onSome: ({ machine, id }) => ({ machine, thread: id }) }),
                said: outcome.say,
                utterance: utterance.id,
                // The question on its own too, apart from the news before it.
                ...(open === undefined ? {} : { detail: { question: Brain.alone(open), open: open.id } }),
              })
        yield* Effect.logInfo(`Said: ${outcome.say}`)
        const { missed, card } = outcome
        const subject = "utterance" in of ? along(of, outcome.subject) : outcome.subject
        /** Puts back what "it" meant, and whether he'd heard the question, from before it started being said. */
        let unsaid: Effect.Effect<void> = Effect.void
        // Its card goes up under the line "say that again" repeats, which can be less than what's said now, like without "I couldn't work out the rest", so it comes back with that line.
        const line = subject._tag === "Nothing" ? outcome.say : subject.said
        // Taken down by voice before it's said, like by the rest of its request said on its own, its card never goes up.
        const kept = card === undefined ? undefined : { request: utterance.id, down: false }
        if (kept !== undefined) cards.add(kept)
        // Told while an app was there to show its card, it's said as it is with none watching if none is by the time it's played, or the card won't go up.
        const { unseen } = outcome
        const instead = card === undefined || unseen === undefined || unseen === outcome.say || unseen === "" ? undefined : unseen
        /**
         * Whether it's played in the words said in its place, which are then
         * what it's noted as having said, never "it's on your screen": only
         * once they're rendered, since its own words go if they can't be.
         */
        let reworded = false
        const off = Effect.map(options.show.watched, (watched) => !watched || kept?.down === true)
        const used = Effect.sync(() => {
          reworded = true
        })
        const kind = open !== undefined ? "question" : outcome.kind === "done" ? "done" : "answer"
        yield* options.tell(
          {
            id: mint(at, "a"),
            kind,
            priority: "needs-you",
            spoken: outcome.say,
            ...(instead === undefined ? {} : { instead: { spoken: instead, when: off, used } }),
            at,
            // "It" means this once he's heard it, not while it waits behind something else he's hearing, and its card goes up as he hears of it.
            saying: Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Effect.sync(() => {
                const before = answered
                // Asked again in other words, he may have heard it already, from when he first did.
                const heard = asking?.said
                const meant = { subject, at: now, turns: utterance.turns }
                answered = meant
                if (open !== undefined && asking?.open.id === open.id) asking.said ??= now
                unsaid = Effect.sync(() => {
                  if (answered === meant) answered = before
                  if (open !== undefined && asking?.open.id === open.id) asking.said = heard
                })
              }),
            ).pipe(
              Effect.zipRight(
                Effect.suspend(() => {
                  if (kept === undefined || card === undefined) return Effect.void
                  cards.delete(kept)
                  return kept.down ? Effect.void : Effect.asVoid(options.show.put(card, { said: line, turns: utterance.turns, request: utterance.id }))
                }),
              ),
              Effect.zipRight(Effect.suspend(() => (reworded && instead !== undefined && Option.isSome(entry) ? journal.reword(entry.value, instead) : Effect.void))),
              // Why a machine can't be reached, once he's heard it, isn't said again until it's been back and gone down again.
              Effect.zipRight(threads.heard(outcome.say)),
            ),
            // What he missed that it told him, even before a question it asks, as when he asked what he missed and what a thread wants.
            ...(missed === undefined && (open === undefined || request === undefined)
              ? {}
              : {
                  heard: Effect.gen(function* () {
                    if (missed !== undefined) yield* journal.markHeard(missed, yield* Clock.currentTimeMillis)
                    // Heard, or answered, what a thread waits on him for has its entry noted as heard, however many times it took to ask it: not
                    // once it's put by, since it's still to be asked.
                    if (open === undefined || request === undefined || putBy.has(open.id)) return
                    const row = from?.kept === undefined ? Option.none() : Option.flatten(from.kept)
                    if (Option.isSome(row)) yield* journal.markHeard([row.value], yield* Clock.currentTimeMillis)
                  }),
                }),
            // Never said, like gone stale or dropped by a dictation that cut it off, its card is let go of all the same.
            ...(kept === undefined
              ? {}
              : {
                  gone: Effect.sync(() => {
                    cards.delete(kept)
                  }),
                }),
            ...(outcome.confirmed === undefined ? {} : { confirmed: outcome.confirmed }),
            // An answer can be followed up about what it was about, in the words he heard it in.
            ...(kind === "answer" ? { followUp: followUp(subject, Effect.sync(() => (reworded && instead !== undefined ? instead : outcome.say))) } : {}),
            ...(open === undefined
              ? { stale: Effect.succeed(false) }
              : {
                  open: open.id,
                  // Only while it's the question open and nothing being said may answer it, so it's never said after what settles it.
                  stale: Effect.gen(function* () {
                    if (asking?.open.id !== open.id || asking.held.size > 0) return true
                    if (request === undefined) return false
                    // What a thread waits on him for, dealt with in T3 Code since, or said before, is let go without a word, and what's next is asked.
                    // Its machine's threads can't be seen, like rig's while it can't be reached, it's put by without a word, never as dealt with,
                    // heard or not: it's asked again once they can be, from the part he'd got to.
                    const ref = open.candidates[0] ?? { machine: "", id: "" }
                    const waits = yield* still(ref, request)
                    if (waits && claim !== undefined && claim.kept === undefined) claim.kept = yield* journal.claim(claim.asking.entry)
                    if (waits && (claim === undefined || Option.isSome(claim.kept ?? Option.none()))) return false
                    const away = !waits && Option.isSome(yield* threads.unseen(ref.machine))
                    if (asking?.open.id === open.id) {
                      if (!waits && !away) gone.add(open.id)
                      yield* close(open, waits ? "dropped: said before" : away ? "dropped: out of sight" : "dropped: dealt with in T3 Code")
                      yield* Effect.forkIn(turn.withPermits(1)(offering), scope)
                    }
                    return true
                  }),
                  question: {
                    // Heard to the end, a plain yes can only be to it, and what a thread waits on is his to answer by dictation too.
                    through: Effect.flatMap(Clock.currentTimeMillis, (now) =>
                      Effect.sync(() => {
                        if (asking?.open.id !== open.id) return
                        asking.whole ??= now
                        const [ref] = open.candidates
                        // From when he first heard all of it, which what he said before, however late it's handed on, can't answer: for a
                        // thread's question, all of this part, since what he said before he heard it was about the part before, or nothing.
                        if (open.asks !== undefined && open.asks._tag !== "Agent" && ref !== undefined) {
                          const was = known.get(open.asks.requestId)
                          const same = was !== undefined && (was.asks._tag !== "Question" || (open.asks._tag === "Question" && was.asks.part === open.asks.part))
                          known.set(open.asks.requestId, { ref, asks: open.asks, through: (same ? was.through : undefined) ?? now })
                        }
                      }),
                    ),
                    answer: listen(open),
                    // What a thread's question offers, for what he says back to be heard listening for.
                    ...(open.wording === undefined ? {} : { terms: open.wording.terms }),
                    unanswered: background(turn.withPermits(1)(unanswered(open.id)), utterance.turns),
                    // Broken off, he can't be taken to have heard it, so what he says next is something new, as before it was said.
                    unsaid: Effect.suspend(() => unsaid),
                  },
                }),
          },
          utterance.turns,
        )
      })

    /** Notes what he said and what was made of it, at once and on a second look: not his words, when they looked like a secret. */
    const note = (thought: Thought, outcome: Outcome, began: number) =>
      Effect.gen(function* () {
        const { utterance } = thought
        const { second, withheld = false } = outcome
        const decision = withheld ? { ...thought.decision, text: "", rest: "" } : thought.decision
        const ms = (yield* Clock.currentTimeMillis) - began
        // Said back to what he missed, cutting it off or after it, it's part of catching up, so it never hides what he didn't hear
        // of that from the next "what did I miss?": heard to the end, it's heard, and never told again anyway.
        const over = utterance.via === "reply" && caughtUp(thought.subject) ? { over: "catch-up" } : {}
        // What was said back has an entry of its own.
        yield* journal.write({
          at: utterance.at,
          kind: utterance.via === "reply" ? "reply" : "dictation",
          ...(withheld ? {} : { text: utterance.heard }),
          utterance: utterance.id,
          detail: {
            via: utterance.via,
            source: thought.source,
            decision,
            ...(second === undefined ? {} : { second }),
            ...over,
            ms,
            outcome: outcome.kind,
            ...(withheld ? { withheld } : {}),
          },
        })
        yield* Effect.logInfo(`Timing: ${(ms / 1000).toFixed(1)} s from what was said to what to say`)
      })

    /**
     * Asks what a thread waits on him for, as the one question open, unless
     * it no longer waits on it: a thread's question from the part he'd got
     * to, as it's brought back or asked once more, in words not asked lately,
     * or, once it's had its place taken too often, let go with a word.
     */
    const put = (waiting: Queued, turns: number) =>
      Effect.gen(function* () {
        const { ref, asks: request, asked: words, about, rewordings, parts } = waiting.asking
        if (!(yield* still(ref, request.requestId))) {
          // Its machine's threads out of sight just now, it's put back to wait for them, since it may still wait on him: it's asked once
          // they're back, from the part he'd got to, and holds up nothing meanwhile.
          if (Option.isSome(yield* threads.unseen(ref.machine))) {
            asked.unshift(waiting)
            return yield* Effect.logInfo(`Not asking "${words}" until ${ref.machine}'s threads can be seen again`)
          }
          return yield* Effect.logInfo(`Not asking "${words}", since it no longer waits on it`)
        }
        const at = yield* Clock.currentTimeMillis
        // Its own, since no request of his is what it's for.
        const utterance = mint(at, "n")
        const part = request._tag === "Question" ? parts?.[request.part] : undefined
        const left = leftWith(request)
        if (part !== undefined && waiting.letGo === true) {
          yield* Effect.logInfo(`Letting go of the question on ${about}, since its place was taken too often`)
          if (left !== undefined) return yield* deliver(yield* unbidden(ref, left, yield* persona.lines), { id: utterance, turns })
          yield* letBe(waiting)
          return yield* deliver(regarding(part.letGo, Option.some(ref)), { id: utterance, turns })
        }
        const before = yield* askedLately
        const said = yield* persona.lines
        /** In words not asked `lately`, of these: brought back, or asked once more, then the other way. */
        const fresh = (wordings: ReadonlyArray<string>, lately: ReadonlyArray<string>) => Brain.reworded({ kind: "question", asked: "", about, rewordings: wordings }, lately, said)
        const back = waiting.back ?? (request._tag === "Question" && request.part > 0 ? "here" : undefined)
        // Brought back, a part of a question is put as `back` says, and an approval he'd heard in other words than it was asked in. Either
        // way it names its thread, since it comes up of yapd's own accord: "Again, sir: …" is only for his asking to hear it again.
        const worded = (lately: ReadonlyArray<string>) =>
          back === undefined
            ? words
            : part === undefined
              ? Brain.reworded({ kind: request._tag === "Approval" ? "approval" : "question", asked: words, about, rewordings }, lately, said)
              : fresh(back === "still" ? [...part.still, part.here] : [part.here, ...part.still], lately)
        // Words it was only brought back in at no cost to him lately are still its to be put in, rather than it being let go for want of
        // others; and brought back at no cost to him now, it's put as it was first brought back, or asked, even in words asked lately.
        const free = (waiting.free ?? []).filter((line) => before.includes(line))
        const unsaid = worded(before)
        const wording =
          unsaid ?? worded(before.filter((line) => !free.includes(line))) ?? (waiting.costless === true ? (part?.here ?? words) : undefined)
        if (wording === undefined) {
          yield* Effect.logInfo(`Letting go of the question on ${about}, since it's been asked in every way lately`)
          if (left !== undefined) return yield* deliver(yield* unbidden(ref, left, said), { id: utterance, turns })
          yield* letBe(waiting)
          return yield* deliver(regarding(part?.letGo ?? said.leaving, Option.some(ref)), { id: utterance, turns })
        }
        const outcome = yield* opening(
          {
            kind: request._tag === "Approval" ? "approval" : "question",
            utterance,
            heard: "",
            decision: request._tag === "Approval" ? Brain.decision({ act: "decide", how: "accept" }) : Brain.decision({ act: "reply" }),
            candidates: [ref],
            asked: wording,
            about,
            material: Option.none(),
            resend: Option.none(),
            asks: request,
            rewordings: part?.still ?? rewordings,
            ...(part === undefined ? {} : { wording: part }),
          },
          { turns, at },
        )
        if (asking?.open.utterance === utterance) {
          asking.from = { ...waiting, free: waiting.costless === true && unsaid !== undefined ? [...free, wording] : free }
          // Asked once more as it went unanswered, it's asked no more after that.
          if (waiting.asks !== undefined) asking.asks = waiting.asks
        }
        yield* deliver(outcome, { id: utterance, turns })
      })

    /** Wakes to ask what's put off once it's due, if nothing comes up before: one wake, for the soonest. */
    let waking: { readonly at: number; readonly fiber: Fiber.RuntimeFiber<void> } | undefined

    /** Asks the soonest of what's put off once it's due, unless it's set to already. */
    const wake = (now: number) =>
      Effect.gen(function* () {
        // Not for what's due already, which waits for what's asked now to be done with, rather than wake for it over and over.
        const soonest = Math.min(...asked.flatMap(({ notBefore }) => (notBefore === undefined || notBefore <= now ? [] : [notBefore])))
        if (!Number.isFinite(soonest) || (waking !== undefined && waking.at <= soonest)) return
        if (waking !== undefined) yield* Fiber.interruptFork(waking.fiber)
        const fiber = yield* Effect.sleep(Math.max(0, soonest - now)).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              waking = undefined
            }),
          ),
          Effect.zipRight(turn.withPermits(1)(offering)),
          Effect.interruptible,
          Effect.forkIn(scope),
        )
        waking = { at: soonest, fiber }
      })

    /**
     * A thread's question that went unanswered, and waits out its minute to
     * be asked once more, gives way to another that's due, as it does when
     * that one is waiting as it goes unanswered: the other is asked at once,
     * and it comes back once its minute is up. Not while anything being said
     * may answer it.
     */
    const givingWay = Effect.gen(function* () {
      if (asking === undefined || asking.repeat === undefined || asking.held.size > 0 || presses.size > 0) return
      const { open, from, due } = asking
      const now = yield* Clock.currentTimeMillis
      if (open.kind !== "question" || from === undefined || due === undefined || Option.isNone(yield* askable(now))) return
      if (asking?.open.id !== open.id) return
      if (asking.asks >= asks) return yield* letGo(open)
      const back = resumed(from, open, { asks: asking.asks + 1, back: "still", notBefore: due })
      yield* close(open, "dropped: unanswered, others waiting")
      asked.push(back)
    })

    /**
     * Says the next thing a restart found, once nothing else is asked, he
     * isn't dictating and yapd is on: one question at a time, each offered
     * once. A message that didn't get there is offered to be sent again, or,
     * when it can't be by then, like one too long ago, said so with why; a
     * step it couldn't confirm is said once, with why.
     */
    const offering: Effect.Effect<void> = Effect.gen(function* () {
      yield* givingWay
      while (asking === undefined && presses.size === 0) {
        const power = yield* options.power
        // Off, it waits for him to be back.
        if (!power.on) return
        const next = restarted.shift()
        // Then what threads wait on him for, one at a time: the first that's due, or, when none is yet, the soonest once it is. One on a
        // machine whose threads can't be seen waits for them, which it's asked once they're back.
        if (next === undefined) {
          const now = yield* Clock.currentTimeMillis
          const due = yield* askable(now)
          if (Option.isNone(due)) return yield* wake(now)
          const index = asked.indexOf(due.value)
          if (index === -1) continue
          asked.splice(index, 1)
          yield* put(due.value, power.turns)
          continue
        }
        const { row, offer } = next
        const kept = yield* ledger.get(row.commandId)
        // Sent again or taken back since it was found, or found to have gone after all, there's nothing to offer or say.
        if (offer ? !Option.exists(kept, Ledger.offerable) : row.state !== "sent" && Option.exists(kept, ({ state }) => state === "sent")) {
          yield* Effect.logInfo(`Not saying anything of ${row.commandId}, since something came of it meanwhile`)
          continue
        }
        const went = Hands.went(row)
        const sent = Option.match(went, { onNone: () => "", onSome: ({ text }) => text })
        const ref = { machine: row.machine, id: row.thread }
        const listed = (yield* threads.desk(Option.none(), [ref], 1)).threads.find((listed) => Threads.same(listed.ref, ref))
        const said = yield* persona.lines
        /** Said once, with why, and journaled with it: as unknown, unless it's known not to have gone, like new work found not to have started. */
        const telling = (line: string, reason: string) =>
          Effect.gen(function* () {
            yield* journal.write({
              at: yield* Clock.currentTimeMillis,
              kind: "action",
              machine: row.machine,
              thread: row.thread,
              said: line,
              utterance: row.utterance,
              detail: { commandId: row.commandId, act: row.kind === "message" ? "Message" : row.kind, outcome: row.state === "failed" ? "NotSent" : "Unknown", reason },
            })
            yield* deliver({ say: line, subject: { _tag: "Answer", said: line, about: Option.some(ref) }, kind: "done" }, { id: row.utterance, turns: power.turns })
          })
        if (!offer) {
          const reason = row.reason ?? Hands.unconfirmable
          const called = Option.fromNullable(listed?.called)
          yield* telling(row.kind === "message" ? Hands.unoffered(said, called, reason) : Hands.unsure(row, said, called, reason), reason)
          continue
        }
        const why = Option.isNone(yield* hands.still(row.commandId)) ? Hands.tooLong : sent === "" ? "I can't read back what it said." : undefined
        if (why !== undefined || listed === undefined) {
          const archived = Option.exists(yield* threads.find(ref), ({ archivedAt }) => archivedAt !== null)
          const reason = why ?? (archived ? "Its thread is archived now." : "I can't find its thread now.")
          yield* hands.leave(row.commandId, reason)
          yield* Effect.logWarning(`Could not offer to send ${row.commandId} again: ${reason}`)
          yield* telling(Hands.unoffered(said, Option.fromNullable(listed?.called), reason), reason)
          continue
        }
        const offered = yield* opening(
          {
            kind: "resend",
            utterance: row.utterance,
            heard: sent,
            // As it went, so a plain yes sends it as it was.
            decision: Brain.decision({ act: "send", text: sent, how: Option.match(went, { onNone: () => "now", onSome: ({ how }) => how }) }),
            candidates: [ref],
            asked: Hands.lost(said, Option.some(listed.called)),
            about: `send that to ${listed.called} again`,
            material: Option.none(),
            resend: Option.some(row.commandId),
            news: Hands.missing(said, Option.some(listed.called)),
            question: unaddressed(said.again, said),
          },
          { turns: power.turns, at: yield* Clock.currentTimeMillis },
        )
        yield* deliver(offered, { id: row.utterance, turns: power.turns })
      }
      // Something's asked, or he's dictating: what's put off is looked at again once it's due, in case what's asked then waits out its minute.
      yield* wake(yield* Clock.currentTimeMillis)
    }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("Could not say what I found after restarting, or ask what waits on you", cause)))

    /** Works out what he said and acts on it, then says what came of it, one request at a time. `pressed` is what "it" meant as its shortcut was pressed. */
    const respond = (utterance: Utterance, pressed: Subject | undefined) => {
      /** The prompt being written in case it's new work, if it is being. */
      let ahead: Fiber.RuntimeFiber<Either.Either<Drafts.Written, string>> | undefined
      /** Stops writing it, unless it was kept for what it was written for, which takes it from here. */
      const letGo = Effect.suspend(() => {
        writing.delete(utterance.id)
        return ahead === undefined ? Effect.void : Fiber.interruptFork(ahead)
      })
      return Effect.gen(function* () {
        // Checked again once it's its turn: yapd may have been turned off and on while it waited behind another.
        if (yield* outdated(utterance.turns)) {
          yield* Effect.logInfo(`Not worked out, since yapd was turned off after it was said: ${utterance.heard}`)
          return Option.none<string>()
        }
        yield* Effect.logInfo(`Heard: ${utterance.heard}`)
        // Whatever comes of it is said, so the speaker gets ready while it's worked out.
        yield* options.coming
        const began = yield* Clock.currentTimeMillis
        const about = pressed ?? (yield* subject)
        const glanced = yield* glance(utterance, about, [])
        let thought: Thought
        if (glanced.quick !== undefined) thought = worked(glanced, utterance, glanced.quick, "fast")
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
          // Noted as it's begun, so it's stopped however this ends, even stopped while the model works it out.
          yield* drafts.begin(lines, Option.getOrUndefined(Option.flatMap(asked, ({ material }) => material))).pipe(
            Effect.interruptible,
            Effect.forkIn(scope),
            Effect.tap((fiber) =>
              Effect.sync(() => {
                ahead = fiber
                writing.set(utterance.id, fiber)
              }),
            ),
            Effect.uninterruptible,
          )
          thought = yield* decide(glanced, utterance)
          const { act, pending } = thought.decision
          // Kept only for what it was written for: new work, or the answer to which project.
          const answering = Option.isSome(asked) && pending === "answers"
          if (!(answering || (act === "start" && Option.isNone(asked)))) yield* letGo
        }
        yield* Effect.logInfo(`Routed: ${routed(thought, (yield* Clock.currentTimeMillis) - began)}`)
        const outcome = yield* acting(thought).pipe(Effect.ensuring(letGo))
        yield* note(thought, outcome, began)
        yield* deliver(outcome, thought)
        yield* offering
        return Option.some(utterance.id)
      }).pipe(Effect.ensuring(letGo), turn.withPermits(1), Effect.annotateLogs({ utterance: utterance.id }))
    }

    /** The dictation a press began has ended, however long it took: what was kept for it, let go of. `cut` is the question it may have cut off. */
    const ended = (press: number | undefined, cut?: string) =>
      Effect.sync(() => {
        if (press === undefined) return undefined
        over.set(press, cut)
        const kept = presses.get(press)
        presses.delete(press)
        return kept
      })

    const heard = (input: Omit<Utterance, "id">, press?: number) =>
      Effect.suspend(() => {
        const utterance: Utterance = { ...input, id: mint(input.at, "u") }
        // Held by its press since it began, or from now for a typed request, and let go of however it ends, even
        // stopped while it waits its turn.
        const holding = press === undefined ? `request:${utterance.id}` : `press:${press}`
        return Effect.gen(function* () {
          // A dictation's answer was awaited from when the shortcut was pressed, and "it" is what he was listening to then.
          const kept = yield* ended(press)
          // Said before yapd was turned off, it isn't even worked out, however late it's handed on.
          if (yield* outdated(utterance.turns)) return yield* Effect.as(kept?.arrived ?? Effect.void, Option.none<string>())
          const arrived = kept?.arrived ?? (yield* options.awaiting)
          // Only a question asked by the time it was said is held by it, however late it's handed on.
          return yield* Effect.zipRight(hold(holding, utterance.at), stoppable(respond(utterance, kept?.subject), utterance)).pipe(Effect.ensuring(arrived))
        }).pipe(Effect.ensuring(release(holding)))
      })

    return {
      think,
      act: (thought) => turn.withPermits(1)(Effect.flatMap(acting(thought), (outcome) => Effect.as(deliver(outcome, thought), outcome))),
      heard,
      prepare: (press: number, turns: number, began?: number) =>
        Effect.gen(function* () {
          // Pressed then, however late it's got ready for: a question asked after can't be what it answers.
          const at = began ?? (yield* Clock.currentTimeMillis)
          // Presses are got ready for one at a time, in order, so none before this one will be again.
          for (const earlier of over.keys()) if (earlier < press) over.delete(earlier)
          // Pressed before yapd was turned off, however late it's handed on, there's nothing to get ready for.
          if (yield* outdated(turns)) return
          // What's dictated is answered before anything else is said, and kept with what "it" means now, for that dictation alone.
          const about = yield* subject
          const arrived = yield* options.awaiting
          // Turned off and on while that was found out: dropping cleared what was kept, so this keeps and holds nothing.
          if (yield* outdated(turns)) return yield* arrived
          // Its dictation is over already, dealt with or come to nothing, so there's nothing left to keep or hold for it.
          if (over.has(press)) {
            // Come to nothing, it let go of nothing, so a question it would have held, which it may have cut off, is taken up again now instead.
            const cut = over.get(press)
            if (cut !== undefined && asking?.open.id === cut && at >= asking.open.at) {
              yield* resume(cut)
              yield* Effect.forkIn(turn.withPermits(1)(offering), scope)
            }
            return yield* arrived
          }
          presses.set(press, { subject: about, arrived })
          yield* hold(`press:${press}`, at)
          const shortlist = yield* threads.desk(Option.none(), [], desk.vocabulary)
          // What the open question offers first, since what he dictates may answer it.
          yield* drafts.prepare(
            shortlist.threads.map(({ thread }) => thread.title),
            asking?.open.wording?.terms ?? [],
          )
          yield* Effect.forkIn(threads.refreshUsage, scope)
        }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("Could not get ready for the dictation", cause))),
      // Whatever it held is let go of: a press from before yapd was turned off holds nothing that's open now anyway.
      nothing: (press) =>
        Effect.gen(function* () {
          yield* release(`press:${press}`)
          // In case it isn't got ready for yet, so it held nothing, it keeps the question he'd heard by now, which it may have cut off.
          const kept = yield* ended(press, asking?.said !== undefined ? asking.open.id : undefined)
          yield* kept?.arrived ?? Effect.void
          // What waited for the dictation to be over is asked now.
          yield* Effect.forkIn(turn.withPermits(1)(offering), scope)
        }),
      // Not one he hasn't heard yet, which what he said can't have been about. What was left of its request is said.
      replied: Effect.suspend(() => {
        if (asking === undefined || asking.said === undefined) return Effect.void
        const { open } = asking
        return Effect.gen(function* () {
          yield* close(open, "replaced")
          const { turns } = yield* options.power
          yield* deliver(ahead(quiet({ _tag: "Nothing" }), open.decision.rest, yield* persona.lines), { id: open.utterance, turns })
          yield* Effect.forkIn(turn.withPermits(1)(offering), scope)
        })
      }),
      open: Effect.map(Clock.currentTimeMillis, current),
      drop: Effect.gen(function* () {
        dropped = (yield* options.power).turns
        // Nothing said before is on his screen once yapd is on again, where an app that connects would show it.
        for (const pending of cards) pending.down = true
        cards.clear()
        yield* options.show.hide()
        if (asking !== undefined) yield* close(asking.open, "dropped: off")
        // What he'd answered of a thread's question is never sent once yapd's been turned off and on (I8): it's brought back from its
        // first part, and only what he answers then goes. Nor is what he dictates taken for a part until he's heard it again.
        for (const [index, waiting] of asked.entries()) {
          const { asks } = waiting.asking
          if (partway(asks)) asked[index] = { ...waiting, asking: { ...waiting.asking, asks: fromTheStart(asks) }, back: "here" }
        }
        for (const [requestId, heard] of known) {
          if (partway(heard.asks)) known.set(requestId, { ...heard, asks: fromTheStart(heard.asks), through: undefined })
        }
        // No answer is on its way any more, and the dictations they were for are dropped too.
        const kept = [...presses.values()]
        presses.clear()
        yield* Effect.forEach(kept, ({ arrived }) => arrived, { discard: true })
        yield* Effect.forEach([...writing.values(), ...jobs], Fiber.interruptFork, { discard: true })
      }),
      undelivered: (rows) =>
        Effect.gen(function* () {
          restarted.push(...rows.map((row) => ({ row, offer: true })))
          yield* turn.withPermits(1)(offering)
        }),
      unconfirmed: (rows) =>
        Effect.gen(function* () {
          restarted.push(...rows.map((row) => ({ row, offer: false })))
          yield* turn.withPermits(1)(offering)
        }),
      // In its turn, so turning yapd on never waits for it.
      back: Effect.asVoid(Effect.forkIn(turn.withPermits(1)(offering), scope)),
      mention: (ref, said) =>
        Effect.flatMap(Effect.all([Clock.currentTimeMillis, options.power]), ([at, { turns }]) =>
          Effect.sync(() => {
            answered = { subject: { _tag: "Answer", said, about: Option.some(ref) }, at, turns }
          }),
        ),
      ask: (waiting) =>
        Effect.suspend(() => {
          const { requestId } = waiting.asks
          // Heard of twice, as on starting and from T3 Code at once, it's asked the once.
          if (asked.some(({ asking: queued }) => queued.asks.requestId === requestId) || (asking !== undefined && requestOf(asking.open) === requestId)) return Effect.void
          // Found unheard as yapd was turned on, it may have been heard since, asked once more meanwhile: then it isn't again.
          if (waiting.kept !== undefined && known.has(requestId)) return Effect.void
          // Kept already and never heard, it's asked under that entry.
          asked.push({ asking: waiting, again: false, ...(waiting.kept === undefined ? {} : { kept: Option.some(Option.some(waiting.kept)) }) })
          return Effect.asVoid(Effect.forkIn(turn.withPermits(1)(offering), scope))
        }),
      settled: (requestId) =>
        Effect.gen(function* () {
          known.delete(requestId)
          dequeue(requestId)
          if (asking === undefined || requestOf(asking.open) !== requestId) return
          // Being asked, or asked already: a late answer does nothing, and what's next is asked.
          const { open } = asking
          gone.add(open.id)
          yield* close(open, "dropped: dealt with in T3 Code")
          yield* Effect.forkIn(turn.withPermits(1)(offering), scope)
        }),
      returned: (machine) =>
        Effect.suspend(() =>
          asked.some(({ asking: waiting }) => waiting.ref.machine === machine) ? Effect.asVoid(Effect.forkIn(turn.withPermits(1)(offering), scope)) : Effect.void,
        ),
    } satisfies Assistant["Type"]
  })
