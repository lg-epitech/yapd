import { Clock, Deferred, Duration, Effect, Either, Exit, Fiber, Option, Queue, Scope, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, AudioError, type Playback } from "./Audio.ts"
import { handoffLines, surelyHis, worded } from "./Brain.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, RelayError, type Thread } from "./Relay.ts"
import { Journal, routinesIn, routinesNamed } from "./Journal.ts"
import * as Latency from "./Latency.ts"
import { addressed, type Lines, Persona } from "./Persona.ts"
import { type Reply, type Responded, Responder } from "./Responder.ts"
import * as T3Actions from "./T3Actions.ts"
import type * as Threads from "./Threads.ts"
import { type TranscribeError, Transcriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { type Early, early as inParts, extension, type Started, Voice } from "./Voice.ts"
import { again as sayAgain, agreed, gist, halts, type Line, noted, pardon, question } from "./Words.ts"

/** An update, rendered and ready to be read out. */
export interface Update {
  readonly session: string
  readonly project: string
  readonly turn: Turn
  /** Whether the agent asked something, needs a decision or permission, or failed. */
  readonly needsYou: boolean
  /** Its headline, or all of it when it's said in full. */
  readonly spoken: string
  /** The rest, said when he asks for more, when only its headline is said. */
  readonly more?: string
  /** Its whole, which is what it is, however it starts playing. */
  readonly audio: string
  /**
   * How it was rendered, when that was started on its own, which whoever's
   * done with it gives up, removing its files: with its first part, `first`,
   * when that was out before the whole, which it then starts playing from.
   */
  readonly render?: Started
  readonly first?: string
  readonly thread: Thread
  /** When its turn stopped. */
  readonly at: number
  /** The T3 Code thread it came from, when its hook could be tied to one, or T3 Code told of it. */
  readonly about?: Threads.Ref
  /**
   * The T3 Code thread a hook from another machine is known to be from, for
   * what's shown and muted only: what's said over it still goes the way hooks
   * always have.
   */
  readonly owner?: Threads.Ref
  /**
   * The subagent of T3 Code's own it came from, what that's called aloud,
   * and the thread it's part of, when its chain could be followed up to one:
   * like `owner`, for what's kept, shown and muted only, since what's said
   * over it goes the way hooks always have.
   */
  readonly subagent?: { readonly child: Threads.Ref; readonly called?: string; readonly head?: { readonly ref: Threads.Ref; readonly called?: string } }
}

type Signal =
  | Exclude<Endpointer.Event, { readonly _tag: "Onset" | "Pause" | "Resumed" | "Utterance" }>
  /**
   * They've finished, with what was heard of it, when it was transcribed as
   * he paused at its end: the same audio, so the same words, only sooner.
   */
  | { readonly _tag: "Utterance"; readonly audio: Float32Array; readonly heard?: Effect.Effect<string> }
  /**
   * Might be the user, or with `echo`, yapd's own voice getting into the
   * microphone, as it can until the echo cancellation has learnt it. `at` is
   * when it came in, by the clock, however long it then waits to be looked at.
   */
  | { readonly _tag: "Onset"; readonly echo: boolean; readonly at: number }
  /** The microphone stopped, like when the helper quits. */
  | { readonly _tag: "Deaf" }
  /** The rest carry the id of what sent them, so one that's no longer waited on is let go. */
  | { readonly _tag: "Finished"; readonly id: number }
  /** The playback broke off, like when the audio helper quits: what it played wasn't heard to the end. */
  | { readonly _tag: "Broke"; readonly id: number; readonly error: AudioError }
  | { readonly _tag: "Lingered"; readonly id: number }
  /** The reply is whatever the one who asked for it works out: what to do about an update, or an answer to a question. */
  | { readonly _tag: "Replied"; readonly id: number; readonly reply: unknown }

/**
 * A line as it plays, which may be its first part, then on into its whole, as
 * one: `at` is how far into the whole it has got, always a place in it, and
 * `length` how long the whole is, once that's known. A plain playback's are
 * its own.
 */
interface Playing extends Playback {
  readonly at?: Effect.Effect<number>
  readonly length?: Effect.Effect<number>
}

/**
 * The microphone for a whole update, so nothing the user says is missed
 * between lines, like while yapd works out what to say back.
 */
interface Ear {
  readonly signals: Queue.Queue<Signal>
  deaf: boolean
  /**
   * Whether what he says is to be worked out, so it's transcribed as he
   * pauses: while a line listens for what he says over it or after it, or
   * what he said is worked out. Never while only "Mute." is listened for,
   * as over a notice, nor for someone else's talk, which longer than "Mute."
   * could be is never transcribed, nor while nothing listens.
   */
  early: boolean
}

/**
 * A line said to the end that's listened to from its end, for a reply: how
 * long it was, when it ended, by the clock, and talk still going then, if any,
 * with how far into the line it began, when by the clock, whether yapd's own
 * voice may be in it, and whether it began `over` the line, rather than once
 * it had ended.
 */
interface Ended {
  readonly duration: number
  readonly finished: number
  readonly open?: { readonly onset: number; readonly since: number; readonly echo: boolean; readonly over: boolean }
}

/** How a line went: played out, maybe to be listened to from its end, or talked over, with what the user said. */
type Outcome =
  | { readonly _tag: "Finished"; readonly ended?: Ended }
  | {
      readonly _tag: "Interrupted"
      /** How far it got, in seconds. */
      readonly at: number
      readonly duration: number
      readonly audio: Float32Array
      /** What he said, when it was transcribed as he paused at its end. */
      readonly heard?: Effect.Effect<string>
      readonly ear: Ear
      /**
       * What yapd was saying around when he began, when that was while its
       * own voice could still get into the microphone: what was heard may be
       * some of that, or his first word lost under it.
       */
      readonly echo?: string
      /** How far into the line he began, which is no further than where it stopped: what he'd heard of it when he spoke. */
      readonly onset: number
      /** When it had played to the end, by the clock, if it had: listening on after it, how late he is is still counted from then. */
      readonly finished?: number
      /** How long after it had played to the end he began, in seconds: 0 when he began over it. */
      readonly lateBy: number
      /** When he stopped talking, by the clock: the quiet that tells he has, before what he said came in. */
      readonly stopped: number
      /**
       * Begun over a line said to the end, with yapd's own voice maybe in it,
       * and run on past its end: what may be his reply, which the line's own
       * voice got into the microphone with as it ended.
       */
      readonly carried?: true
    }

/** How long the microphone stays open after yapd stops, for a reply to what it just said. */
export const linger: Duration.DurationInput = "3 seconds"
/** Longer after an answer to what he asked, or a failure, which he may well want to follow up once he's taken it in. */
export const answering: Duration.DurationInput = "6 seconds"
/** Longer after a question, which takes a moment's thought to answer. */
export const pondering: Duration.DurationInput = "8 seconds"
/**
 * How long after a line has ended, in milliseconds, the microphone stays open
 * at least, even once an answer he asked for waits to be said next: what he
 * begins by then, like a reply or "Mute.", is still this line's, never cut off
 * by the next.
 */
const grace = 2_000
/** How long working out what he said can take, in milliseconds, before a tick tells him he was heard. */
const ticking = 300
/**
 * How long after what he said came in, in milliseconds, what code acts on
 * alone, like "Yes." or an option's name, is held: about as long as
 * transcribing it took before it was transcribed as he paused, so a breath
 * and more words after it still make one utterance, never a yes sent alone.
 */
export const breath = 350
/**
 * How soon after the tick is sent, in milliseconds, what the microphone hears
 * may be the tick itself: its 60 ms, played as late as an output that lags
 * like Bluetooth's, about 300 ms, can play it, a room's tail after it, and
 * the frames the endpointer takes to call that speech.
 */
const ringing = 800
/** Longer than the longest utterance, so only a microphone that went quiet trips it. */
const patience = "40 seconds"
/**
 * How long after he began it what he's saying can still be "Mute.", in
 * milliseconds, even said again and again, and heard out once he's stopped:
 * what goes on longer, like a TV, is no reason to keep listening for it. Nor
 * is anything listened for longer than that once the moment after a line
 * played through for "Mute." alone is over, nor Whisper waited for longer.
 */
const outburst = 4_000
/**
 * How long "Mute.", even said again and again, can go on, in seconds of
 * speech: what's longer, like a TV's talk, isn't it, so Whisper isn't asked.
 */
const curt = 2.5
/**
 * How long the moment after a line played through for "Mute." alone lasts
 * once something waits to be said next, in milliseconds: it's the pause
 * between lines, so a "Mute." begun as the line ended is heard, and what's
 * next starts hardly later than it would. Once it's over, a "Mute." begun
 * within as long after other talk ended is heard out too.
 */
const breather = 500
/**
 * How long before the line ended, in milliseconds, what he's begun can be
 * and still be heard out once the moment after it is over: as long as the
 * silence that tells he's stopped, so a "Mute." begun over the line's last
 * words, which that silence shows only once the line has ended, isn't cut in
 * two. Begun any earlier and still going, it's other talk, like a TV's.
 */
const brink = 700
/**
 * How long, in milliseconds, a "Mute." begun just as that moment is over is
 * waited for, a few frames, so it isn't cut in two between the line and the
 * microphone of what's said next.
 */
const beat = 100
/** Volume while it's still unclear whether the user is talking. */
const ducked = 0.25
/**
 * How far before its first part ends a line's whole takes over, in seconds:
 * inside the quiet that part ends in, after its last word, where both have
 * the very same samples, so the switch falls where nothing is heard.
 */
const handover = 0.15
/** How long the rest of a line is waited for once it's needed, as when its first part has played, before the line breaks off. */
const slowest = "10 seconds"
/** How far back to pick up after talk that wasn't meant for yapd. */
const rewind = 1.5
/**
 * How far back to pick up after only its own voice stopped it, or what may
 * have been: just before, a word or two. Any nearer and it starts mid-word
 * with nothing for the echo cancellation to learn from before it's stopped
 * again, which doubled how often that happens over a line's first seconds.
 */
const before = 0.8
/**
 * How long speech can go on past where yapd stopped and still be only its
 * own voice dying away, in the room and in the voice detector: more than
 * that, someone else was talking. Its own voice was measured going on up to
 * 0.38 s past with Silero, his "Thank you." 0.5 s or more.
 */
const overhang = 0.45
/**
 * Logged each time it picks up again after its own voice stopped a line over
 * its first seconds, so how often that happens on his speakers can be counted
 * from the log.
 */
export const ownVoice = "Stopped for its own voice over its first seconds, so it picks up again"
/** Logged instead when it picks up again there after his talk that went on past where it stopped, but wasn't meant for it. */
export const notMeant = "Picked up again over its first seconds after talk not meant for it"
/** How near its end a line can be stopped and still count as said, with nothing of it left to go back to. */
const ending = 0.3
/**
 * How long before he began talking over a question the words yapd was saying
 * may not have been taken in, as he was about to speak by then: what he'd
 * heard of it is reckoned to that moment, so it errs towards his having heard
 * less, never more.
 */
const reaction = 0.3
/** Talk that wasn't meant for yapd, after which the rest of an update plays without listening, say for a TV. */
const misses = 3
/** How long to wait for the rest when the user trails off, before working out a reply. */
const hesitation = "3 seconds"
/** Words as they're compared, whatever their case and the punctuation at their end. */
const plainly = (text: string) => text.trim().toLowerCase().replace(/[.!]+$/, "")

/**
 * Whether the model's answer is the rest of an update as it was left out,
 * maybe with him addressed before or after it, like "Sir, requests back off…"
 * or "…, sir.": then the rest rendered already says the same.
 */
export const restOf = (text: string, more: string) => {
  if (more === "") return false
  const rest = plainly(more)
  const said = plainly(text)
  return said === rest || said.replace(/^[a-z']+(?: [a-z']+)?, /, "") === rest || said.replace(/, [a-z']+(?: [a-z']+)?$/, "") === rest
}

/** How long the user can keep adding to what they said, since talk that goes on longer is more likely a TV. */
const rambling = 60_000

/** Words a sentence hardly ever ends on. */
const dangling = /\b(and|or|but|to|the|a|an|of|for|with|my|your|if|when|because)[.,]?$/i

/** Whether the user seems to have stopped mid-thought: Whisper marks trailing off with an ellipsis. */
export const unfinished = (heard: string) => /(\.\.\.|…|,)$/.test(heard) || dangling.test(heard)

/** What the user said before and after a pause, as one. */
export const together = (before: string, after: string) =>
  after === "" ? before : `${before.replace(/\s*(\.\.\.|…)$/, "")} ${after}`

/** What's said of a reply held back because the work it answers has been given something else since. */
export const movedOn = "You've moved on from that since, so I held it back."

/** Seconds, as they're kept: to a hundredth. */
const hundredths = (seconds: number) => Math.round(seconds * 100) / 100

/** Milliseconds as they're logged, in seconds. */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/**
 * Logs, as the answer to what he handed over from an update starts to play,
 * how long that took from when it was last worked out, a moment after his
 * last word, and each part of it, so where the time goes can be counted.
 */
export const answeredIn = (since: number, parts: { readonly responder?: number; readonly brain: number; readonly acting?: number; readonly rendering?: number }) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.logInfo(
      `Handoff answered: ${seconds(now - since)} from his last word (${[
        ...(parts.responder === undefined ? [] : [`Responder ${seconds(parts.responder)}`]),
        `Brain ${seconds(parts.brain)}`,
        ...(parts.acting === undefined ? [] : [`acting ${seconds(parts.acting)}`]),
        ...(parts.rendering === undefined ? [] : [`rendering ${seconds(parts.rendering)}`]),
      ].join(", ")})`,
    ),
  )

/** Seconds of speech in what the user said, less the quiet the endpointer keeps either side of it. */
export const voiced = (audio: Float32Array) =>
  Math.max(0, (audio.length - (Endpointer.defaults.lead + Endpointer.defaults.tail) * frame) / rate)

/** Samples a second from the microphone, and in each frame of it. */
const rate = 16000
const frame = 512

/** How many of the words of `text` were said in `fraction` of its audio, at least the first. */
const saidOf = (words: ReadonlyArray<string>, fraction: number) => Math.max(1, Math.round(words.length * fraction))

/** The part of `text` heard in `fraction` of its audio, marked when it's cut short. */
export const cut = (text: string, fraction: number) => {
  if (fraction >= 1) return text
  const words = text.split(/\s+/)
  return `${words.slice(0, saidOf(words, fraction)).join(" ")}…`
}

/** The rest of `text`, that wasn't said in `fraction` of its audio: nothing when it was all said. */
export const unsaid = (text: string, fraction: number) => {
  if (fraction >= 1) return ""
  const words = text.split(/\s+/)
  return words.slice(saidOf(words, fraction)).join(" ")
}

/** Whether all of what was heard is the last words of `line`, as words compare, symbols and all: its own voice dying away as it ended. */
const trailing = (heard: string, line: string) => {
  const words = (text: string) => worded(text).split(" ").filter((word) => word !== "")
  const said = words(heard)
  const own = words(line)
  return said.length > 0 && said.length <= own.length && said.every((word, at) => word === own[own.length - said.length + at])
}

/**
 * What was heard after the last words of `line` it began with, as it's
 * written: what came once yapd's own voice had ended, so none of it is
 * yapd's, like the "Mute." of "the Tezos migration. Mute.". None when it
 * didn't begin with them, as words compare, symbols and all, or when
 * they're said earlier in the line too, so they may not have been its
 * last, like the "on" of "On it, sir: … runs on.".
 */
const beyond = (heard: string, line: string) => {
  const said = Array.from(heard.matchAll(/\S+/gu), (word) => ({ word: worded(word[0]), end: word.index + word[0].length })).filter(({ word }) => word !== "")
  const own = worded(line).split(" ").filter((word) => word !== "")
  for (let length = Math.min(said.length, own.length); length > 0; length--) {
    const last = own.slice(own.length - length)
    if (!said.slice(0, length).every(({ word }, at) => word === last[at])) continue
    const earlier = own.some((_, at) => at < own.length - length && last.every((word, offset) => own[at + offset] === word))
    return earlier ? undefined : heard.slice(said[length - 1]!.end).trim()
  }
  return undefined
}

/** Seconds either side of when the user began that what yapd was saying is given with what he said, since where each word falls in a line is only guessed. */
const reach = 4

/** The words of `text` said between `start` and `end` seconds into its `duration`, as far as that can be told from where they fall in it. */
export const between = (text: string, duration: number, start: number, end: number) => {
  if (duration <= 0) return text
  const words = text.split(/\s+/).filter((word) => word !== "")
  return words.slice(Math.max(0, Math.floor((words.length * start) / duration)), Math.max(0, Math.ceil((words.length * end) / duration))).join(" ")
}

/**
 * Muting the thread of an update he spoke over, or changing how yapd talks,
 * in so many words: done once he's stopped, giving back what's said of it,
 * with what it changed, if that's known. Without yapd's assistant, what the
 * mute hook hands over is this too, giving back only what's said of it.
 */
interface Muting {
  readonly intent: "mute"
  readonly spoken: ""
  readonly message: ""
  readonly muting: Effect.Effect<string>
  readonly made?: "mute" | "mode"
}

/**
 * What the mute hook makes of what he said over an update, plainly his: a
 * change in so many words, done once he's stopped, giving back what's said of
 * it; or what's about mutes or subagents in other words, which yapd's
 * assistant works out, with what's said of it without one.
 */
export type Hooked =
  | { readonly _tag: "Done"; readonly made: "mute" | "mode"; readonly doing: Effect.Effect<string> }
  | { readonly _tag: "Over"; readonly line: Effect.Effect<string> }

/** What an Act is run with: whether its update was put back, how long the Responder took, with its model, and when it was last worked out. */
export interface Running {
  readonly cutOff: boolean
  readonly reply: { readonly ms: number; readonly modelMs?: number }
  /** When what he said was worked out for the last time, a moment after his last word. */
  readonly since: number
}

/**
 * What something he said over an update, handed to yapd's assistant, comes
 * to: let go, as talk not meant for yapd or what may all be its own words;
 * dismissed; answered, `unattended` when that turns down what only his word
 * does while he isn't at hand; passed to the update's own session as the
 * Responder's messages are, with a line for a rest left; or acted on, as a
 * follow-up to an answer is, once he's stopped, `aims` when at the update
 * itself, `doubted` when all of it may be yapd's own words, and `unattended`
 * when its first step is turned down so. With how it
 * was worked out, without the model or by it, how long that took and the
 * model's part, and what it came to, as it's logged, never his words nor the
 * model's.
 */
export type Handed = (
  | { readonly _tag: "Resume"; readonly logged?: Effect.Effect<void> }
  | { readonly _tag: "Dismiss" }
  | { readonly _tag: "Answer"; readonly spoken: string; readonly unattended?: true }
  | { readonly _tag: "Pass"; readonly message: string; readonly left?: string }
  | { readonly _tag: "Act"; readonly aims: boolean; readonly doubted: boolean; readonly unattended?: true; readonly run: (running: Running) => Effect.Effect<void> }
) & {
  readonly source: "fast" | "model" | "failed"
  readonly ms: number
  readonly modelMs?: number
  readonly routed: string
}

/** Works out what he said over an update, handed to yapd's assistant, as a follow-up's `followUp` does, with when he stopped talking. */
export type Handing = (heard: string, voiced: number, echo?: string, afterPause?: string, unsaid?: string, stopped?: number) => Effect.Effect<Handed>

/** What the line being said over an update is, which tells what "scratch that" said over it or right after can take back. */
export type Made = "update" | "sent" | "mute" | "mode" | "answer" | "again"

/**
 * What he said over an update comes to, and how that was worked out: as his
 * emergency off, by the mute hook, said again, by the Responder at once or by
 * its model, or handed to yapd's assistant, with how long the model took, in
 * milliseconds, both calls for what's handed over; or the model failed.
 * Handed over, what it came to, and how long the Responder took first.
 */
export interface Worked {
  readonly reply: Reply | Muting
  readonly source: "halt" | "mute" | "again" | "assistant" | Responded["source"] | "failed"
  readonly modelMs?: number
  readonly handed?: Handed
  readonly replied?: { readonly ms: number; readonly modelMs?: number }
}

/**
 * Works out what he said over an update, plainly or not, in order: his
 * emergency off, "Mute."; the mute hook's change in so many words, or what
 * it hands to yapd's assistant without asking the Responder; hearing the
 * line again, with no model, only in words that can't answer it when the
 * update needs him, and only while it `may` be said again; then the
 * Responder, whose "assistant" goes to yapd's assistant, or, with none,
 * is told to ask with the shortcut. Its message of what may all be yapd's
 * own words, with nothing surely his after a pause, goes to yapd's
 * assistant too, never sent as it is: there it's let go, or at most asked
 * about in code's own question, as what's said back to a "done" line is.
 * With no assistant, it's sent as ever.
 */
export const reading = (parts: {
  readonly heard: string
  readonly voiced: number
  readonly afterPause: string
  readonly halt: boolean
  readonly echo: string | undefined
  readonly needsYou: boolean
  readonly hooked: Option.Option<Hooked>
  /** Whether the line may be said again, which it is at most twice. */
  readonly may: boolean
  readonly respond: (heard: string, voiced: number, afterPause: string) => Effect.Effect<Worked>
  /** Hands it to yapd's assistant, `muting` when the mute hook did, with when he stopped talking. */
  readonly over?: (muting: boolean) => (heard: string, voiced: number, afterPause: string, stopped?: number) => Effect.Effect<Handed>
  /** When he stopped talking, by the clock, when that's known. */
  readonly stopped?: number
  /** What's said for what's yapd's to do without its assistant. */
  readonly shortcut: Effect.Effect<string>
}): Effect.Effect<Worked> =>
  Effect.gen(function* () {
    const { heard, voiced, afterPause, over } = parts
    if (parts.halt) return { reply: { intent: "dismiss", spoken: "", message: "" }, source: "halt" }
    if (Option.isSome(parts.hooked)) {
      const hooked = parts.hooked.value
      if (hooked._tag === "Done") return { reply: { intent: "mute", spoken: "", message: "", muting: hooked.doing, made: hooked.made }, source: "mute" }
      if (over === undefined) return { reply: { intent: "mute", spoken: "", message: "", muting: hooked.line }, source: "mute" }
      return handedOver(yield* over(true)(heard, voiced, afterPause, parts.stopped))
    }
    const asking = parts.needsYou ? pardon : sayAgain
    if (parts.echo === undefined && parts.may && asking.has(gist(heard))) return { reply: { intent: "answer", spoken: "", message: "" }, source: "again" }
    const [took, worked] = yield* Effect.timed(parts.respond(heard, voiced, afterPause))
    // A message the Responder made of what may all be yapd's own words is never sent as it is: yapd's assistant lets it go, or asks first.
    const echoed = !surelyHis({ ...(parts.echo === undefined ? {} : { echo: parts.echo }), afterPause })
    const handing = worked.reply.intent === "assistant" || (worked.reply.intent === "send" && echoed && over !== undefined)
    if (!handing) return worked
    if (over === undefined) return { ...worked, reply: { intent: "answer", spoken: yield* parts.shortcut, message: "" } }
    const replied = { ms: Duration.toMillis(took), ...(worked.modelMs === undefined ? {} : { modelMs: worked.modelMs }) }
    return handedOver(yield* over(false)(heard, voiced, afterPause, parts.stopped), replied)
  })

/** What's handed over comes to, as the Responder's replies are told: with both calls' model time, when there was any. */
const handedOver = (handed: Handed, replied?: Worked["replied"]): Worked => {
  const modelMs = handed.modelMs === undefined && replied?.modelMs === undefined ? undefined : (handed.modelMs ?? 0) + (replied?.modelMs ?? 0)
  return {
    reply:
      handed._tag === "Pass"
        ? { intent: "send", spoken: "", message: handed.message }
        : handed._tag === "Answer"
          ? { intent: "answer", spoken: handed.spoken, message: "" }
          : { intent: handed._tag === "Act" ? "assistant" : handed._tag === "Dismiss" ? "dismiss" : "resume", spoken: "", message: "" },
    source: "assistant",
    ...(modelMs === undefined ? {} : { modelMs }),
    handed,
    ...(replied === undefined ? {} : { replied }),
  }
}

/** Something yapd asks the user for itself, like which project new work is for, rendered and ready to be asked. */
export interface Question {
  /** Its whole, which is what it is, however it starts playing. */
  readonly audio: string
  /** Its first part, when that's out before its whole, which it then starts playing from. */
  readonly first?: Early
  /** What it says, so its own voice getting into the microphone as it starts isn't taken for an answer. */
  readonly spoken: string
  /** Run once it starts playing the first time, which is when the user hears of it: never when it can't be played. */
  readonly saying?: Effect.Effect<void>
  /** Run each time it plays to the end, before the wait for an answer: the user has heard all of it, whatever they say next. */
  readonly through?: Effect.Effect<void>
  /** What its options are called, which what's said back is heard listening for, since Whisper mishears names it doesn't expect. */
  readonly terms?: ReadonlyArray<string>
  /** Like `saying`, but once it's known to be playing, which with afplay is only once it has played to the end. */
  readonly confirmed?: Effect.Effect<void>
  /**
   * Works out what the user meant by what they said, and how many seconds of
   * it were speech, which may be called again with all of it if they carry
   * on. What it returns is run once they've stopped, and none means it
   * wasn't an answer. With `echo`, what yapd was saying around when they
   * began, while its own voice could still get into the microphone: the
   * first words heard may be some of it, or their first word lost under it.
   * With it, `afterPause` is what they said once they carried on after a
   * pause, when they did, which is surely theirs, as yapd had stopped by then;
   * or what they said after its last words, when its own voice ran on into
   * what they said as it ended.
   * Said over it, `unsaid` is what yapd hadn't said of it yet a moment
   * before they began, as far as where it had got to tells, like its
   * options: none when all of it was said. `carried` when they began over
   * its last words, all of it said, and ran on past its end: what they said
   * after them is their reply to it, however short. `stopped` is when they
   * stopped talking, by the clock, which what comes of it is timed from.
   */
  readonly answer: (
    heard: string,
    voiced: number,
    echo?: string,
    afterPause?: string,
    unsaid?: string,
    carried?: boolean,
    stopped?: number,
  ) => Effect.Effect<Option.Option<Effect.Effect<void>>>
}

/** An answer to what the user asked yapd, rendered and ready to be said, which they can follow up as they can an update. */
export interface Answer extends Omit<Question, "answer"> {
  /** Works out what they meant by what they said over it or right after, as a question's `answer` does: none means it wasn't meant for yapd. */
  readonly followUp: Question["answer"]
  /** Run once it's been said to the end, before the wait for a follow-up, since the user has heard it by then. */
  readonly through?: Effect.Effect<void>
  /** How long the microphone stays open for a follow-up once it's been said to the end: as after any answer, unless said. */
  readonly wait?: Duration.DurationInput
  /**
   * Whether it's followed up only from its end: it plays through whatever's
   * said over it, never turned down, listening only for "Mute.", as a notice
   * does, then listens for a reply, like after a failure or work that started.
   */
  readonly after?: boolean
  /** Whether its words are logged nowhere, like what came of a request held back as a secret. */
  readonly withheld?: boolean
}

/**
 * Reads updates out while listening. Talking over yapd ducks it at once and
 * stops it once it's clearly speech; what the user said then decides whether it
 * stops there, answers, sends the agent a follow-up, or carries on. Begun
 * while its own voice could still get into the microphone, all that's heard
 * is taken whole as ever, with what yapd was saying around then, which some
 * of it may be, and it picks up again when the model takes it for that, or
 * when Whisper heard nothing at all.
 */
export const make = (options: {
  readonly dir: string
  /** Whether unrelated activity has made the update stale. */
  readonly moved: (update: Update) => Effect.Effect<boolean>
  /**
   * Delivers the follow-up, or queues it until the session can receive it,
   * using its latest thread; or says what came of it when that's more than
   * sent or queued, like held behind a turn waiting on the user.
   */
  readonly send: (update: Update, message: string) => Effect.Effect<"sent" | "queued" | { readonly said: string }, RelayError>
  /** Says how a follow-up went when the update it answers was cut off before yapd could. */
  readonly late: (update: Update, spoken: string, failed: boolean) => Effect.Effect<void>
  /** Something was said over an update and taken in, which takes the place of whatever yapd asked before. */
  readonly replied: Effect.Effect<void>
  /** yapd starts saying something back over an update, like an answer or word of a follow-up, which is then what the user heard last. */
  readonly saying: (update: Update, line: string) => Effect.Effect<void>
  /** Whether what the user said to send over an update would be held back as it could give a secret away, so their words are kept and logged nowhere. */
  readonly withholds: (update: Update, message: string) => Effect.Effect<boolean>
  /**
   * When all he said over an update is to mute or unmute its thread, or to
   * change how yapd talks, in so many words and plainly his, how that's done,
   * giving back what's said of it; or, about mutes or subagents in other
   * words, plainly his, what's handed to yapd's assistant: never anything
   * sent to the agent. None for anything else, which is worked out as ever.
   */
  readonly mute?: (update: Update, heard: string, voiced: number, echo: string | undefined) => Option.Option<Hooked>
  /**
   * What hands what he said over an update, `line`, after the exchange so
   * far, `lines`, to yapd's assistant, as the Responder took it for yapd's
   * to do, or the mute hook did, `muting`: `made` is what the line is.
   * Without it, that's said to be asked with the shortcut.
   */
  readonly over?: (update: Update, lines: ReadonlyArray<Line>, line: string, made: Made, muting: boolean) => Handing
  /**
   * The names of his routines, as they are now, whose steps only the
   * shortcut sends: one said over an update is never sent to its agent as
   * the bare words.
   */
  readonly routines?: Effect.Effect<ReadonlyArray<string>>
  /**
   * Turns yapd off as the menu does, for "Mute." said on its own over
   * anything it says, or right after: his emergency off. Turning off cuts off
   * what's being said, so this comes back only should yapd stay on. Without
   * it, "Mute." is a stop, as it always was.
   */
  readonly off?: Effect.Effect<void>
  /**
   * Once something waits to be said next: the moment after a line played
   * through listening only for "Mute.", like a notice, is then over after the
   * pause between lines, rather than holding it up. Without it, that moment
   * is the usual one.
   */
  readonly queued?: Effect.Effect<void>
  /**
   * Once an answer he asked for waits to be said next: the wait for a reply
   * after an answer, or after a line listened to from its end, is then over
   * soon after the line ended, rather than holding it up. Without it, that
   * wait is never cut short.
   */
  readonly asked?: Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const lifetime = yield* Effect.scope
    const audio = yield* Audio
    const vad = yield* Vad
    const transcriber = yield* Transcriber
    const responder = yield* Responder
    const voice = yield* Voice
    const persona = yield* Persona
    const journal = yield* Journal

    let ids = 0
    const fresh = () => ++ids

    /**
     * Whether what he said is his emergency off, with nothing to work out of
     * it, wherever he said it: only not when what yapd was saying around
     * when he began, while its own voice could still get into the
     * microphone, was about muting, as that "mute" may be its own. With
     * `own`, a line said to the end that its own voice may have run on from
     * into what he said, it's also what he said after its last words alone,
     * like the "Mute." of "the Tezos migration. Mute.", which came once its
     * voice had ended, so is never its own, even after a line about muting.
     */
    const halted = (heard: string, echo: string | undefined, own?: string) =>
      options.off !== undefined && ((!/mute/i.test(echo ?? "") && halts(heard)) || (own !== undefined && halts(beyond(heard, own) ?? "")))

    /** Once something waits to be said next, if that's ever known. */
    const queued = options.queued ?? Effect.never
    /** Once an answer he asked for waits to be said next, if that's ever known. */
    const asked = options.asked ?? Effect.never
    /** The tick that tells him he was heard, logged so how often it plays, and what's heard right after, can be counted. */
    const tick = Effect.zipRight(audio.tick, Effect.logInfo("Ticked"))

    /**
     * Starts listening, if there's a microphone. That's only known once
     * something plays. What he says is transcribed as he pauses, listening
     * for `terms` when there are any, so it's heard by the time the silence
     * that tells he's stopped is over: what he carries on after is let go,
     * and what fails is transcribed again once he's stopped.
     */
    const open = (scope: Scope.Scope, terms?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const detect = yield* vad.make.pipe(Effect.option)
        if (Option.isNone(detect)) return undefined
        const microphone = yield* audio.microphone.pipe(Scope.extend(scope))
        if (Option.isNone(microphone)) return undefined
        const ear: Ear = { signals: yield* Queue.unbounded<Signal>(), deaf: false, early: false }
        const endpointer = new Endpointer.Endpointer()
        /** What he'd said by his last pause, being transcribed, while he hasn't carried on since. */
        let paused: Fiber.RuntimeFiber<Either.Either<string, TranscribeError>> | undefined
        /** How many times what he said was transcribed as he paused, and how often he carried on after: logged with what he said. */
        let pauses = 0
        let resumed = 0
        yield* Stream.fromQueue(microphone.value).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              // As the frame came in, since by the time it's looked at, yapd may well have learnt its own voice.
              const echo = yield* audio.echo(frame)
              const event = endpointer.push(frame, yield* detect.value(frame), echo)
              switch (event?._tag) {
                case "Onset":
                  return { _tag: "Onset", echo, at: yield* Clock.currentTimeMillis } satisfies Signal
                case "Pause":
                  paused = ear.early ? yield* Effect.forkIn(Effect.either(transcriber.transcribe(event.audio, terms)), scope) : undefined
                  if (paused !== undefined) pauses++
                  return undefined
                case "Resumed":
                  // Carried on, what he'd said by then is no use: a run still waiting its turn never holds up the one that counts.
                  if (paused !== undefined) {
                    resumed++
                    yield* Fiber.interruptFork(paused)
                  }
                  paused = undefined
                  return undefined
                case "Utterance": {
                  const early = event.paused ? paused : undefined
                  paused = undefined
                  // Never his words: only how often he paused and carried on, so what that wastes is known.
                  if (pauses > 0) yield* Effect.logInfo(`Pauses: ${pauses} transcribed, carried on after ${resumed}, ${early === undefined ? "heard once he'd stopped" : "heard as he paused"}`)
                  pauses = 0
                  resumed = 0
                  if (early === undefined) return { _tag: "Utterance", audio: event.audio } satisfies Signal
                  const { audio: said } = event
                  return {
                    _tag: "Utterance",
                    audio: said,
                    heard: Effect.flatMap(Fiber.join(early), Either.match({ onLeft: () => unlogged(said, terms), onRight: Effect.succeed })),
                  } satisfies Signal
                }
                default:
                  return event
              }
            }),
          ),
          Stream.runForEach((event) => (event === undefined ? Effect.void : Queue.offer(ear.signals, event))),
          Effect.ignore,
          Effect.zipRight(
            Effect.suspend(() => {
              ear.deaf = true
              return Queue.offer(ear.signals, { _tag: "Deaf" })
            }),
          ),
          Effect.forkIn(scope),
        )
        return ear
      })

    /** The microphone for whatever is said in the scope, opened when it's first needed, listening for `terms` when there are any. */
    const hearing = (scope: Scope.Scope, terms?: ReadonlyArray<string>) => {
      let opened: Ear | undefined
      return Effect.suspend(() =>
        opened === undefined
          ? open(scope, terms).pipe(
              Effect.tap((ear) => {
                opened = ear
              }),
            )
          : Effect.succeed(opened),
      )
    }

    /**
     * Plays a line's first part, then its whole from where that ends, as one
     * playback, once the whole is rendered: from inside the quiet the first
     * part ends in, where both have the same samples, so the helper's switch
     * falls where nothing is heard; or, when the whole comes later than that,
     * or nothing says when the first part began, as with afplay, from the
     * first part's end, waiting there for the whole as long as `slowest`. Only
     * the whole's end finishes it, and it fails when either file can't be
     * played, or the whole isn't rendered. Stopped, it never plays on, and
     * where it got to is a place in the whole, as the first part's places
     * already are. How long the whole is comes from its render, never from a
     * file. Should it never be rendered, it's taken to be as long as makes the
     * first part's words fall where they do in it, so what he heard of it is
     * reckoned from those words alone, and never as all of it.
     */
    const chained = (first: Early, path: string, text: string) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const part = yield* audio.play(first.path, 0)
        const began = yield* Clock.currentTimeMillis
        const paced = (part.duration * text.split(/\s+/).length) / Math.max(1, Option.getOrElse(yield* first.render.words, () => 1))
        const whole = first.render.whole.pipe(
          Effect.timeoutFail({ duration: slowest, onTimeout: () => new AudioError({ message: "The rest of the line didn't render in time" }) }),
          Effect.catchAll((cause) => (cause instanceof AudioError ? Effect.fail(cause) : Effect.fail(new AudioError({ message: "The rest of the line didn't render", cause })))),
        )
        let level = 1
        /** The whole, once it's playing, from where, and when it began, by the clock. */
        let rest: { readonly playback: Playback; readonly from: number; readonly began: number } | undefined
        /** The first part played to its end, and the whole not playing yet. */
        let ended = false
        let stopped: number | undefined
        const halted = yield* Deferred.make<void>()
        // Starting the whole and stopping are one at a time, so a stop never misses what just started.
        const lock = yield* Effect.makeSemaphore(1)
        const playing = Effect.gen(function* () {
          const inside =
            part.confirmed && part.duration > handover
              ? yield* Effect.raceFirst(
                  Effect.sleep(Math.max(0, (part.duration - handover) * 1000 - ((yield* Clock.currentTimeMillis) - began))).pipe(
                    Effect.zipRight(first.render.done),
                    // Rendered by then, or not, as failing it's only known once the first part has played to its end.
                    Effect.flatMap((done) => (done ? Effect.isSuccess(first.render.whole) : Effect.succeed(false))),
                  ),
                  Effect.as(part.finished, false),
                )
              : false
          if (!inside) {
            yield* part.finished
            ended = true
          }
          // Not knowing where its first part ends, it can't carry on from there without saying some of it twice.
          if (part.duration <= 0) return yield* new AudioError({ message: "Could not tell where the line's first part ends" })
          yield* whole
          const from = inside ? part.duration - handover : part.duration
          const started = yield* lock.withPermits(1)(
            Effect.suspend(() =>
              stopped !== undefined
                ? Effect.succeed(undefined)
                : Effect.tap(audio.play(path, from).pipe(Scope.extend(scope)), (playback) =>
                    Effect.map(Clock.currentTimeMillis, (now) => {
                      rest = { playback, from, began: now }
                    }),
                  ),
            ),
          )
          if (started === undefined) return yield* Effect.never
          // The helper starts every play at full volume.
          if (level !== 1) yield* started.volume(level)
          yield* started.finished
        })
        // Stopped, it never finishes, as a line stopped never does.
        const going = yield* Effect.raceFirst(Effect.as(playing, true), Effect.as(Deferred.await(halted), false)).pipe(
          Effect.flatMap((played) => (played ? Effect.void : Effect.never)),
          Effect.forkScoped,
        )
        return {
          duration: part.duration,
          confirmed: part.confirmed,
          finished: Fiber.join(going),
          stop: lock.withPermits(1)(
            Effect.gen(function* () {
              if (stopped !== undefined) return stopped
              // Where the first part stopped, or ended, or where the whole did, which the helper counts from its own start.
              const at = rest === undefined ? yield* part.stop : yield* rest.playback.stop
              stopped = at
              yield* Deferred.succeed(halted, undefined)
              return at
            }),
          ),
          volume: (value: number) =>
            Effect.suspend(() => {
              level = value
              return (rest?.playback ?? part).volume(value)
            }),
          at: Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sync(() => {
              if (stopped !== undefined) return stopped
              if (rest !== undefined) return Math.min(rest.playback.duration, rest.from + (now - rest.began) / 1000)
              return ended ? part.duration : Math.min(part.duration, (now - began) / 1000)
            }),
          ),
          length: whole.pipe(
            Effect.map((length) => length ?? paced),
            Effect.orElseSucceed(() => paced),
          ),
        } satisfies Playing
      })

    /** Lines rendered again once their whole failed, by their render, so it's done once. */
    const renderedAgain = new WeakSet<Early["render"]>()

    /**
     * Plays a line, `text`, from `from` seconds in. One out in parts, `first`,
     * played from its start while its whole renders, plays its first part on
     * into its whole; played otherwise, it plays its whole, waited for as long
     * as `slowest`. Its whole failed, it's rendered again and played whole
     * from its start, maybe with say; but never from further in, which a line
     * rendered again wouldn't carry on from where the first one stopped: then
     * it breaks off.
     */
    const play = (path: string, text: string, from: number, first?: Early): Effect.Effect<Playing, AudioError, Scope.Scope> =>
      Effect.gen(function* () {
        if (first === undefined || renderedAgain.has(first.render)) return yield* audio.play(path, from)
        if (from === 0 && !(yield* first.render.done)) return yield* chained(first, path, text)
        const whole = yield* Effect.exit(first.render.whole.pipe(Effect.timeout(slowest)))
        if (Exit.isSuccess(whole)) return yield* audio.play(path, from)
        if (from > 0 || !(yield* first.render.done)) return yield* new AudioError({ message: "The rest of the line didn't render", cause: whole.cause })
        yield* Effect.logWarning("The rest of the line didn't render, so all of it is rendered again", whole.cause)
        yield* voice.render(text, path).pipe(Effect.mapError((cause) => new AudioError({ message: "Could not render the line again", cause })))
        renderedAgain.add(first.render)
        return yield* audio.play(path, 0)
      })

    /**
     * Plays a line, `text`, from `from` seconds, listening if there's an ear,
     * then `wait` longer for a reply. `begun` runs once it's playing, never
     * when it can't be played, `confirmed` once it's known to be, which with
     * afplay is only once it has played to the end, and `through` once it
     * has, before that wait: the user has heard it, whatever they say after.
     * `heeding`, it plays through whatever's said, never turned down,
     * listening only for "Mute.", over it and the usual moment after it,
     * whatever `wait` is, which is over after the pause between lines once
     * something's queued to be said next; or `replying`, over it only, and
     * it's then listened to from its end. Once `cut` comes, the wait after it
     * is over early.
     */
    const speak = (
      path: string,
      text: string,
      from: number,
      ear: Effect.Effect<Ear | undefined>,
      given: {
        readonly wait?: Duration.DurationInput
        readonly begun?: Effect.Effect<void>
        readonly confirmed?: Effect.Effect<void>
        readonly through?: Effect.Effect<void>
        readonly heeding?: boolean
        readonly replying?: boolean
        readonly cut?: Effect.Effect<void>
        /** Its first part, when it's out in parts. */
        readonly first?: Early
      } = {},
    ) =>
      Effect.gen(function* () {
        const { wait = linger, begun = Effect.void, confirmed = Effect.void, through = Effect.void, heeding = false, replying = false, cut } = given
        const playback = yield* play(path, text, from, given.first)
        yield* begun
        if (playback.confirmed) yield* confirmed
        // Otherwise it's known only as it plays to the end, so it goes with what runs then, holding nothing up meanwhile.
        const played = playback.confirmed ? through : Effect.zipRight(confirmed, through)
        const listening = yield* ear
        if (listening === undefined || listening.deaf) {
          yield* playback.finished
          yield* played
          return { _tag: "Finished" } satisfies Outcome
        }
        return yield* (heeding
          ? heed(playback, listening, text, from, played, replying)
          : listen(playback, listening, text, from, wait, played, undefined, cut === undefined ? {} : { cut }))
      }).pipe(Effect.scoped)

    /**
     * The microphone for a line nothing else he says over it has anywhere to
     * go, listening only for "Mute.": none when that's no emergency off.
     */
    const heedful = (ear: Effect.Effect<Ear | undefined>) => (options.off === undefined ? Effect.succeed(undefined) : ear)

    /**
     * Plays a line through whatever's said over it, listening only for
     * "Mute.", his emergency off, which stops it as soon as he's said it, over
     * the line or the usual moment after it, and then turns yapd off: for a
     * line nothing else he'd say has anywhere to go, like a notice, or the
     * rest of one he's talked over too often with what wasn't meant for yapd,
     * say for a TV. Nothing else said over it stops it or turns it down, so
     * talk in the room, a TV or a video never keeps it low, and nothing else
     * of what's said is kept or logged: what's longer than "Mute." could be
     * isn't even transcribed, nor anything while Whisper isn't ready, and
     * Whisper is never waited on longer than "Mute." could be heard out. The
     * moment after it is over after the pause between lines once something's
     * `queued` to be said next, which listens for "Mute." itself. Only what
     * he'd begun by its end, in it or just before the line ended, is heard out
     * then, for as long as it could be "Mute.", and what he begins a
     * beat after, or right after he's stopped saying something else, so his
     * "Mute." then is neither cut in two nor missed: but nothing is listened
     * for longer than `outburst` once that moment is over, so talk that goes
     * on, like a TV's, holds what's next up a few seconds at most.
     *
     * `replying`, it listens so over the line only, and its moment after is
     * the wait for a reply, which hears "Mute." itself: it gives back when it
     * ended, once `through` has run, with what's still going then. What he
     * begins from its end is that wait's, even while `through` runs. What he
     * began over its last moment is heard out first, as long as it could be
     * "Mute.": anything else is dropped, but with yapd's own voice maybe in
     * it, and still going as the line ended, it's his reply, run on from
     * that, and given back as said over it. What he began before that and is
     * still going is handed on as it is, to be heard out there, as "Mute."
     * too.
     */
    const heed = (playback: Playing, ear: Ear, text: string, from: number, through: Effect.Effect<void>, replying = false) =>
      Effect.gen(function* () {
        const { signals } = ear
        const id = fresh()
        const began = yield* Clock.currentTimeMillis
        const position = playback.at ?? Effect.map(Clock.currentTimeMillis, (now) => Math.min(playback.duration, from + (now - began) / 1000))
        const length = playback.length ?? Effect.succeed(playback.duration)
        /** How far into the line he began what he's saying, when by the clock, and whether that was while yapd's own voice could still get into the microphone. */
        let onset: number | undefined
        let since = 0
        let echoing = false
        /** Played to the end. */
        let played = false
        /** When it played to the end, by the clock, noted before the moment after it can be over. */
        let finished = 0
        /** When the usual moment after it was over too, by the clock: replying, as soon as it's ended. */
        let over: number | undefined
        /** When what he said last ended, or what he began came to nothing, by the clock. */
        let ended = Number.NEGATIVE_INFINITY
        /** Replying, once `through` has run, which the wait for a reply follows. */
        const ran = yield* Deferred.make<void>()
        // The moment after it begins as soon as it's played to the end, however long what was said before takes to make out: over once
        // something waits to be said next, which hears "Mute." itself, and the pause between lines is up, or else after the usual moment.
        const after = Effect.raceFirst(Effect.sleep(linger), Effect.zipRight(Effect.sleep(breather), queued)).pipe(
          Effect.zipRight(Clock.currentTimeMillis),
          Effect.flatMap((at) =>
            Effect.zipRight(
              Effect.sync(() => {
                over = at
              }),
              Queue.offer(signals, { _tag: "Lingered", id }),
            ),
          ),
        )
        yield* replying
          ? playback.finished.pipe(
              Effect.zipRight(Clock.currentTimeMillis),
              Effect.matchEffect({
                onFailure: (error) => Queue.offer(signals, { _tag: "Broke", id, error }),
                // Its end is noted before `through` runs, so what's begun from then is never taken for talk over it, however long that takes.
                onSuccess: (at) =>
                  Effect.sync(() => {
                    finished = at
                    over = at
                  }).pipe(
                    Effect.zipRight(through),
                    Effect.ensuring(Deferred.succeed(ran, undefined)),
                    Effect.zipRight(Queue.offer(signals, { _tag: "Finished", id })),
                  ),
              }),
              Effect.forkScoped,
            )
          : playback.finished.pipe(
              Effect.zipRight(Clock.currentTimeMillis),
              Effect.tap(() => through),
              Effect.matchEffect({
                onFailure: (error) => Queue.offer(signals, { _tag: "Broke", id, error }),
                onSuccess: (at) =>
                  Effect.sync(() => {
                    finished = at
                  }).pipe(Effect.zipRight(Queue.offer(signals, { _tag: "Finished", id })), Effect.zipRight(after)),
              }),
              Effect.forkScoped,
            )
        /** Replying, the wait for a reply follows from its end, once `through` has run, with what's still going then, if anything. */
        const ending = (open?: Ended["open"]) => {
          const ended = finished
          return Effect.zipWith(Deferred.await(ran), length, (_, duration) => ({
            _tag: "Finished",
            ended: { duration, finished: ended, ...(open === undefined ? {} : { open }) },
          }) satisfies Outcome)
        }
        /**
         * Whether what he began at `at` is heard out once that moment is over,
         * at `over`: begun in it or just before the line ended, however long
         * it lasted, or a beat after, or right after what he said last ended,
         * and never once `outburst` has passed since it was over.
         */
        const heeded = (at: number, over: number) => at >= finished - brink && at <= Math.min(Math.max(over + beat, ended + breather), over + outburst)
        // Once it's all over, only what's heeded is waited for, while it could yet be "Mute.": a microphone gone quiet, or talk that goes
        // on, like a TV's, ends it as one gone deaf does. What's come in already is looked at first, however long it waited, but only
        // until `outburst` has passed since that moment was over: then it's over, however much is still waiting to be looked at.
        // Replying, once it's ended, a "Mute." begun over its last moment is waited for as long as it could be one, and then it's over.
        const next = Effect.suspend((): Effect.Effect<Signal | undefined> => {
          if (over === undefined || (replying && onset === undefined)) return Queue.take(signals)
          const last = over + outburst
          const until =
            onset === undefined
              ? Math.min(Math.max(over + beat, ended + breather), last)
              : replying || heeded(since, over)
                ? Math.min(since, over) + outburst
                : over
          return Effect.flatMap(Clock.currentTimeMillis, (now) =>
            now >= last
              ? Effect.succeed(undefined)
              : Effect.flatMap(
                  Queue.poll(signals),
                  Option.match({
                    onSome: (signal) => Effect.succeed(signal),
                    onNone: () =>
                      Queue.take(signals).pipe(
                        Effect.timeout(Math.max(0, until - now)),
                        Effect.orElseSucceed((): Signal | undefined => (replying ? undefined : { _tag: "Deaf" })),
                      ),
                  }),
                ),
          )
        })
        while (true) {
          if (replying && over !== undefined) {
            // Begun as it ended, though looked at just before its end was noted, it's his reply.
            if (onset !== undefined && since >= over) return yield* ending({ onset: yield* length, since, echo: echoing, over: false })
            // Begun before its last moment and still going as it ended, it's handed on as it is, never waited for.
            if (onset !== undefined && since < over - brink) return yield* ending({ onset, since, echo: echoing, over: true })
            if (played && onset === undefined) return yield* ending()
          }
          const signal = yield* next
          // Past the moment after it, which only ever begins once it's played to the end. Replying, what he began over its last
          // moment isn't "Mute." by now, and is handed on as it is.
          if (signal === undefined) {
            if (!replying) return { _tag: "Finished" } satisfies Outcome
            return yield* ending(onset === undefined ? undefined : { onset, since, echo: echoing, over: true })
          }
          switch (signal._tag) {
            case "Onset":
              // Replying, begun as it ended or after, it's his reply, even while `through` is still running.
              if (replying && over !== undefined && signal.at >= over) {
                return yield* ending({ onset: yield* length, since: signal.at, echo: signal.echo, over: false })
              }
              // Begun once that moment is over, but not heeded, it's more of other talk, like a TV's, which holds nothing up.
              if (!replying && over !== undefined && !heeded(signal.at, over)) return { _tag: "Finished" } satisfies Outcome
              onset = yield* position
              since = signal.at
              echoing = signal.echo
              break
            case "Abandoned":
              onset = undefined
              echoing = false
              ended = yield* Clock.currentTimeMillis
              break
            case "Utterance": {
              // Heard out before what comes after, so it's never missed as the line ends.
              ended = yield* Clock.currentTimeMillis
              const at = yield* position
              const begun = onset ?? at
              const echoed = echoing
              const echoOver = (whole: number) => between(text, whole, begun - reach, Math.max(at, begun) + reach)
              onset = undefined
              echoing = false
              // Longer than "Mute." could be, it isn't, so Whisper isn't asked, and nothing waits on it; nor while Whisper can't hear yet,
              // as while its model loads. What it takes longer to make out than "Mute." could be heard out in is taken for something else,
              // as is what it hasn't made out once nothing more is listened for after that moment, so what's next is never held up past then.
              if (options.off !== undefined && voiced(signal.audio) <= curt && (yield* transcriber.ready)) {
                const heard = yield* (signal.heard ?? unlogged(signal.audio)).pipe(
                  Effect.timeout(over === undefined ? outburst : Math.max(0, over + outburst - ended)),
                  Effect.orElseSucceed(() => ""),
                )
                // With yapd's own voice maybe in it, "Mute." said after the line's last words is too. Only a line about muting waits on its
                // whole length to tell whose "mute" it was, as while it plays from its first part, that waits on the rest's render.
                const aboutMuting = echoed && /mute/i.test(text)
                if ((!aboutMuting && halted(heard, undefined)) || (echoed && halted(heard, echoOver(yield* length), text))) {
                  // Its voice ends at once, never waiting on all turning off does first. Should yapd stay on, it's a stop.
                  yield* playback.stop
                  yield* options.off
                  return { _tag: "Finished" } satisfies Outcome
                }
              }
              const echo = echoed ? echoOver(yield* length) : undefined
              // Replying, with yapd's own voice maybe in it, and still going as the line ended, it's his reply that its own voice ran
              // into, worked out as what he said over it, with the line's words as what may be its own: never dropped.
              if (replying && over !== undefined && echo !== undefined) {
                const duration = yield* length
                return yield* Effect.as(Deferred.await(ran), {
                  _tag: "Interrupted",
                  at: duration,
                  duration,
                  audio: signal.audio,
                  ...(signal.heard === undefined ? {} : { heard: signal.heard }),
                  ear,
                  echo,
                  onset: Math.min(duration, begun),
                  finished,
                  lateBy: 0,
                  stopped: ended - Latency.quiet,
                  carried: true,
                } satisfies Outcome)
              }
              break
            }
            case "Finished":
              if (signal.id !== id) break
              if (ear.deaf) return { _tag: "Finished" } satisfies Outcome
              played = true
              break
            case "Broke":
              if (signal.id === id) return yield* Effect.fail(signal.error)
              break
            case "Deaf":
              if (played) return { _tag: "Finished" } satisfies Outcome
              break
            default:
              break
          }
        }
      })

    /**
     * `done` is when the line had already played to the end, by the clock, for
     * listening on after it, then with what he'd begun that's still going,
     * `open`, and `wait` counted from its end, when it's `fromEnd`. Once `cut`
     * comes, the wait is over early: never sooner than `grace` after the line
     * ended, nor while he's talking.
     */
    const listen = (
      playback: Playing,
      ear: Ear,
      text: string,
      from: number,
      wait: Duration.DurationInput,
      through: Effect.Effect<void>,
      done?: number,
      given: { readonly open?: Ended["open"]; readonly fromEnd?: boolean; readonly cut?: Effect.Effect<void> } = {},
    ) =>
      Effect.gen(function* () {
        const { signals } = ear
        const id = fresh()
        const began = yield* Clock.currentTimeMillis
        // Failing ends it too, or this could wait for a signal that never comes. Played to the end, it's heard
        // there and then, even when a stop asked for just before is still being answered: only playing to the
        // end finishes it, never being stopped.
        yield* playback.finished.pipe(
          Effect.zipRight(Clock.currentTimeMillis),
          Effect.tap((at) =>
            Effect.zipRight(
              Effect.sync(() => {
                completed = true
                finished ??= at
              }),
              through,
            ),
          ),
          Effect.match({
            onFailure: (error): Signal => ({ _tag: "Broke", id, error }),
            onSuccess: (): Signal => ({ _tag: "Finished", id }),
          }),
          Effect.flatMap((signal) => Queue.offer(signals, signal)),
          Effect.forkScoped,
        )

        let playing = true
        /** Between an onset and the end of what the user said. */
        let speaking = false
        let deaf = false
        /** Why it broke off after being stopped for him to speak, like the helper quitting, which nothing after may hide. */
        let broken: AudioError | undefined
        /** Stopped for him to speak, rather than played to the end. */
        let cut = false
        /** Played to the end, even with a stop for him to speak still being answered. */
        let completed = false
        /** When it played to the end, by the clock. */
        let finished = done
        let stoppedAt: number | undefined
        /** How far into the line he began what he's saying, and whether that was while yapd's own voice could still get into the microphone. */
        let onset: number | undefined
        /** When he began it, by the clock. */
        let since: number | undefined
        let echoing = false
        /**
         * Begun over the line, said to the end, and still going as it ended:
         * with yapd's own voice maybe in it, what's heard of it is his reply,
         * which its own voice ran into, with the line's words as what may be
         * its own; without, it's someone else's, like a TV's, which nothing
         * waits for, and it's dropped once it ends, unless it's "Mute.".
         */
        let carried: "echo" | "other" | undefined
        const { open } = given
        if (open !== undefined) {
          onset = open.onset
          since = open.since
          echoing = open.echo
          if (open.over) carried = open.echo ? "echo" : "other"
          speaking = carried !== "other"
        }
        // Someone else's talk is only listened to for "Mute.", so it's never transcribed as it pauses.
        ear.early = carried !== "other"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            ear.early = false
          }),
        )
        let lingering: { readonly id: number; readonly fiber: Fiber.RuntimeFiber<void> } | undefined
        const stopLingering = Effect.suspend(() => {
          const fiber = lingering?.fiber
          lingering = undefined
          return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
        })
        const startLingering = Effect.gen(function* () {
          yield* stopLingering
          const id = fresh()
          const now = yield* Clock.currentTimeMillis
          // From its end, however long what came after took, but never less than the pause between lines from now.
          const waiting = given.fromEnd === true && done !== undefined ? Effect.sleep(Math.max(done + Duration.toMillis(wait) - now, breather)) : Effect.sleep(wait)
          // Once an answer he asked for waits, it's over early, though no sooner than `grace` after the line ended, nor the pause between
          // lines from now, and a beat after it waits, so a word he begins just then isn't cut in two.
          const early =
            given.cut === undefined
              ? Effect.never
              : Effect.sleep(Math.max((finished ?? now) + grace - now, breather)).pipe(Effect.zipRight(given.cut), Effect.zipRight(Effect.sleep(beat)))
          const fiber = yield* Effect.raceFirst(waiting, early).pipe(
            Effect.zipRight(Queue.offer(signals, { _tag: "Lingered", id })),
            Effect.asVoid,
            Effect.forkScoped,
          )
          lingering = { id, fiber }
        })
        const next = Effect.suspend(() =>
          speaking && !playing
            ? Queue.take(signals).pipe(
                Effect.timeout(patience),
                Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
              )
            : Queue.take(signals),
        )
        /** How far into the line yapd has got, in seconds: into its whole, when it plays from its first part on into that. */
        const position = Effect.suspend(() =>
          stoppedAt !== undefined
            ? Effect.succeed(stoppedAt)
            : (playback.at ?? Effect.map(Clock.currentTimeMillis, (now) => Math.min(playback.duration, from + (now - began) / 1000))),
        )

        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              speaking = true
              onset = yield* position
              since = signal.at
              echoing = signal.echo
              yield* stopLingering
              if (playing) yield* playback.volume(ducked)
              break
            case "Speech":
              // Someone else's, begun over the line, holds nothing open.
              if (carried === "other") break
              yield* stopLingering
              if (playing) {
                playing = false
                cut = true
                stoppedAt = yield* playback.stop
              }
              break
            case "Abandoned":
              speaking = false
              carried = undefined
              ear.early = true
              if (playing) yield* playback.volume(1)
              else yield* startLingering
              break
            case "Utterance": {
              // Someone else's, begun over the line, is dropped, and the wait carries on. Unless it's "Mute.", heard out as over the line:
              // only what's no longer than that could be, while Whisper can hear, and never waited on longer than it could be heard out in.
              if (carried === "other") {
                carried = undefined
                ear.early = true
                onset = undefined
                since = undefined
                echoing = false
                if (options.off !== undefined && voiced(signal.audio) <= curt && (yield* transcriber.ready)) {
                  const heard = yield* (signal.heard ?? unlogged(signal.audio)).pipe(
                    Effect.timeout(outburst),
                    Effect.orElseSucceed(() => ""),
                  )
                  if (halted(heard, undefined)) {
                    yield* options.off
                    return { _tag: "Finished" } satisfies Outcome
                  }
                }
                break
              }
              // All of the line, however it was played, so where he cut in is a place in all it says.
              const duration = yield* (playback.length ?? Effect.succeed(playback.duration))
              const at = stoppedAt ?? duration
              const begun = onset ?? at
              return {
                _tag: "Interrupted",
                at,
                duration,
                audio: signal.audio,
                ...(signal.heard === undefined ? {} : { heard: signal.heard }),
                ear,
                // To where it stopped, or where he began, should the helper put that a moment before.
                onset: Math.min(at, begun),
                ...(echoing ? { echo: between(text, duration, begun - reach, Math.max(at, begun) + reach) } : {}),
                ...(finished === undefined ? {} : { finished }),
                lateBy: finished === undefined || since === undefined ? 0 : Math.max(0, since - finished) / 1000,
                stopped: (yield* Clock.currentTimeMillis) - Latency.quiet,
                ...(carried === "echo" ? { carried: true } : {}),
              } satisfies Outcome
            }
            case "Finished":
              // Heard already, as it finished. Also arrives for a playback the user stopped, which is already dealt with.
              if (signal.id !== id || !playing) break
              playing = false
              if (deaf) return { _tag: "Finished" } satisfies Outcome
              if (!speaking) yield* startLingering
              break
            case "Broke":
              if (signal.id !== id) break
              // Stopped for him to speak, it waits on what he says, unless nothing comes of it.
              if (!playing) {
                broken = signal.error
                break
              }
              // As without a microphone: cut short, it wasn't heard, and there's nothing to wait for a reply to.
              return yield* Effect.fail(signal.error)
            case "Lingered":
              if (signal.id !== lingering?.id) break
              if (broken !== undefined) return yield* Effect.fail(broken)
              return { _tag: "Finished" } satisfies Outcome
            case "Deaf":
              deaf = true
              if (broken !== undefined) return yield* Effect.fail(broken)
              // Stopped for him to speak, and gone deaf before he'd finished, it was never heard to the end, nor what he said.
              if (cut && !completed) return yield* Effect.fail(new AudioError({ message: "The microphone went away while he was talking over it" }))
              if (!playing) return { _tag: "Finished" } satisfies Outcome
              yield* playback.volume(1)
              break
            case "Replied":
              break
          }
        }
      })

    /**
     * Listens on, `wait` longer, after a line of `duration` that was said to
     * the end, `finished` then by the clock, as for a reply to it: for when
     * only its own voice, or what may have been, got into the microphone as
     * it ended, or for a line listened to from its end, with what's still
     * going as it ended, `open`, and `wait` counted from its end, `fromEnd`.
     * Once `cut` comes, the wait is over early.
     */
    const harken = (
      text: string,
      { duration, finished, open }: { readonly duration: number; readonly finished?: number; readonly open?: Ended["open"] },
      ear: Effect.Effect<Ear | undefined>,
      wait: Duration.DurationInput,
      given: { readonly fromEnd?: boolean; readonly cut?: Effect.Effect<void> } = {},
    ) =>
      Effect.gen(function* () {
        const listening = yield* ear
        if (listening === undefined || listening.deaf) return { _tag: "Finished" } satisfies Outcome
        const ended: Playback = { duration, confirmed: true, finished: Effect.void, stop: Effect.succeed(duration), volume: () => Effect.void }
        return yield* listen(ended, listening, text, duration, wait, Effect.void, finished, { ...given, ...(open === undefined ? {} : { open }) })
      }).pipe(Effect.scoped)

    /**
     * Works out a reply while still listening, so pausing mid-thought doesn't cut
     * the user off: if they carry on before it's ready, it starts again with all
     * they said, how many seconds of all of it were speech, and what they said
     * after `first`, once yapd had stopped. Nothing's done with a reply while
     * they might still be talking. What `hesitates` seems to trail off is
     * given a moment more first. `respond` is told, and it's given back,
     * whether what he said is his emergency off, "Mute.": all of it, unless
     * `echo`, what yapd was saying as he began, was about muting, as that may
     * be its own; or the last of it, said on its own once he carried on after
     * a pause, which is surely his, so what someone else said first, like a
     * colleague walking in, doesn't hide it. Never after what trailed off
     * into it, like "Can you…" then "mute.", which mutes something, unless
     * what came before the pause was longer than "Mute." could be, like a
     * TV's talk. When yapd's own voice ran on into it from `own`, a line
     * said to the end, "Mute." said after its last words is too. Unless it
     * trails off itself, it's given back at once, never waiting on whether
     * he carries on. Once working it out takes more than a moment, a tick
     * tells him he was heard. `respond` is told when he stopped talking, as
     * of what it's given, which `stopped` is for `first`. What `holds`, what
     * code acts on alone, is given back no sooner than `breath` after what
     * it was worked out from came in, so more words after a breath still
     * carry it on, as when what he said was transcribed only then.
     */
    const settle = <R>(
      ear: Ear,
      first: string,
      audio: Float32Array,
      stopped: number,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      hesitates: boolean,
      echo: string | undefined,
      respond: (heard: string, voiced: number, afterPause: string, halt: boolean, stopped: number) => Effect.Effect<R>,
      holds: (reply: R) => boolean,
      own?: string,
    ) =>
      Effect.gen(function* () {
        // What he carries on with is transcribed as he pauses too.
        ear.early = true
        const until = (yield* Clock.currentTimeMillis) + rambling
        let heard = first
        let speech = voiced(audio)
        let last = stopped
        /** All he said once he carried on after `first`, kept apart so it can be told it's surely his. */
        let afterPause = ""
        let halt = halted(first, echo, own)
        /** Between an onset and the end of what he said, while a reply is worked out. */
        let speaking = false
        /** When the tick played, by the clock: once at most, and what's heard right after may be it. */
        let ticked: number | undefined
        // Taking longer than a moment, he's told he was heard, but never while he's talking, nor twice: the wait for him to go on
        // after trailing off isn't counted, nor is "Mute.", which is acted on at once.
        const timed = <A>(attempt: Effect.Effect<A>) =>
          Effect.gen(function* () {
            const timer = yield* Effect.sleep(ticking).pipe(
              Effect.zipRight(
                Effect.suspend(() =>
                  ticked !== undefined || speaking
                    ? Effect.void
                    : Effect.flatMap(Clock.currentTimeMillis, (now) => {
                        ticked = now
                        return tick
                      }),
                ),
              ),
              Effect.fork,
            )
            return yield* attempt.pipe(Effect.ensuring(Fiber.interrupt(timer)))
          })
        while (true) {
          const attempt = halt ? respond(heard, speech, afterPause, halt, last) : timed(respond(heard, speech, afterPause, halt, last))
          // Not for what may all be yapd's own voice, cut off where it stopped, like "the PR is ready for": that's no sign he's trailing off.
          const replying = unfinished(heard) && (hesitates || heard !== first) ? Effect.zipRight(Effect.sleep(hesitation), attempt) : attempt
          // "Mute." not trailing off is acted on at once, so what's said after it, like his phone answered, can't take it back.
          if (ear.deaf || (yield* Clock.currentTimeMillis) > until || (halt && !unfinished(heard))) return { heard, afterPause, halt, stopped: last, reply: yield* replying }
          const id = fresh()
          // When what it's worked out from came in, which the quiet that tells he's stopped is just before.
          const came = last + Latency.quiet
          const fiber = yield* replying.pipe(
            Effect.tap((reply) =>
              holds(reply) ? Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sleep(Math.max(0, came + breath - now))) : Effect.void,
            ),
            Effect.flatMap((reply) => Queue.offer(ear.signals, { _tag: "Replied", id, reply })),
            Effect.fork,
          )

          speaking = false
          let carryingOn = false
          let held: R | undefined
          let more: Extract<Signal, { readonly _tag: "Utterance" }> | undefined
          waiting: while (true) {
            const signal = yield* (speaking || carryingOn)
              ? Queue.take(ear.signals).pipe(
                  Effect.timeout(patience),
                  Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
                )
              : Queue.take(ear.signals)
            switch (signal._tag) {
              case "Replied":
                // Once they carry on, even one that got in before it was stopped is out of date.
                if (signal.id !== id || carryingOn) break
                // Only this call's replies carry its id.
                if (!speaking) return { heard, afterPause, halt, stopped: last, reply: signal.reply as R }
                held = signal.reply as R
                break
              case "Onset":
                speaking = true
                if (ticked !== undefined && signal.at - ticked < ringing) yield* Effect.logInfo("Onset right after the tick")
                break
              case "Abandoned":
                speaking = false
                if (held !== undefined) return { heard, afterPause, halt, stopped: last, reply: held }
                break
              case "Speech":
                if (ticked !== undefined && (yield* Clock.currentTimeMillis) - ticked < ringing) yield* Effect.logInfo("Speech right after the tick")
                carryingOn = true
                held = undefined
                yield* Fiber.interrupt(fiber)
                break
              case "Utterance":
                more = signal
                last = (yield* Clock.currentTimeMillis) - Latency.quiet
                break waiting
              case "Deaf":
                speaking = false
                if (carryingOn) break waiting
                if (held !== undefined) return { heard, afterPause, halt, stopped: last, reply: held }
                break
              case "Finished":
              case "Broke":
              case "Lingered":
                break
            }
          }
          yield* Fiber.interrupt(fiber)
          if (more === undefined) continue
          const after = yield* (more.heard ?? transcribe(more.audio))
          const before = heard
          heard = together(heard, after)
          afterPause = afterPause === "" ? after : together(afterPause, after)
          // Only what added words, since speech Whisper made nothing of isn't in what was heard. "Mute." on its own after more than
          // "Mute." could be is his, however that ended, like a TV's talk cut off mid-sentence.
          if (after !== "") {
            const lead = speech
            speech += voiced(more.audio)
            halt = halted(heard, echo, own) || ((!unfinished(before) || lead > curt) && halted(after, undefined))
          }
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ear.early = false
          }),
        ),
      )

    /** Follow-ups on their way, each attached to the update it answers, with its own mark, so one ending doesn't clear a later one. */
    const sending = new Map<Update, object>()

    /**
     * Sends a follow-up and returns what to say about it. Once the user has said
     * it, it's sent whatever happens to the conversation, like a dictation
     * cutting it off: what's then left unsaid is said later.
     */
    const pass = (update: Update, reply: Reply) =>
      Effect.gen(function* () {
        let failed = false
        const mark = {}
        sending.set(update, mark)
        const lines = yield* persona.lines
        const fiber = yield* follow(update, reply.message).pipe(
          Effect.flatMap((result) =>
            typeof result === "object"
              ? Effect.succeed(result.said)
              : result === "queued"
                ? Effect.succeed(lines.queued)
                : reply.spoken === ""
                  ? persona.onIt()
                  : Effect.succeed(reply.spoken),
          ),
          Effect.catchAll((error) =>
            Effect.logWarning("Could not send the follow-up", { reason: error.reason, error }).pipe(
              Effect.tap(() => {
                failed = true
              }),
              Effect.as(error.reason),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (sending.get(update) === mark) sending.delete(update)
            }),
          ),
          Effect.annotateLogs({ project: update.project }),
          Effect.forkIn(lifetime),
        )
        return yield* Fiber.join(fiber).pipe(
          Effect.onInterrupt(() =>
            Fiber.join(fiber).pipe(
              Effect.flatMap((spoken) => options.late(update, spoken, failed)),
              Effect.forkIn(lifetime),
            ),
          ),
        )
      })

    const follow = (update: Update, message: string) =>
      Effect.gen(function* () {
        // Typing into a session that started something else would steer it, or answer one of its prompts.
        if (yield* options.moved(update)) return yield* new RelayError({ reason: movedOn })
        const text = plain(message)
        const result = yield* options.send(update, text)
        // Never his words when they could give a secret away, as an answer to its agent asking for one may.
        yield* Effect.logInfo(`${result === "queued" ? "Queued" : typeof result === "object" ? "Held" : "Sent"}: ${T3Actions.revealing(text) ? "something that could give a secret away" : text}`)
        return result
      })

    /** What the user said, logged only once all of it is known, and it's known to be fit to be; listening for `terms`, when there are any. */
    const unlogged = (audio: Float32Array, terms?: ReadonlyArray<string>) =>
      transcriber.transcribe(audio, terms).pipe(Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))))

    /**
     * An update's turn as the model is shown it: a prompt that's one of his
     * routines' steps, as yapd sent them its thread and noted them sent, is
     * the routine by its name alone, never its steps, which only the shortcut
     * sends for its name.
     */
    const shownTurn = (update: Update) =>
      Effect.gen(function* () {
        const prompt = Option.getOrUndefined(update.turn.prompt)?.trim() ?? ""
        if (prompt === "" || update.about === undefined) return update.turn
        const sent = (yield* journal.byThread(update.about.machine, update.about.id, 20, ["sent"])).find(
          (kept) => routinesIn(kept).length > 0 && kept.text?.trim() === prompt,
        )
        return sent === undefined ? update.turn : { ...update.turn, prompt: Option.some(routinesNamed(routinesIn(sent))) }
      })

    /** All he said, as it's logged: never what could give a secret away, however he split it between pauses, like a code said two digits at a time. */
    const heardLine = (heard: string) => (T3Actions.revealing(heard) ? "Heard something that could give a secret away, so it isn't logged" : `Heard: ${heard}`)

    /** How long working out what he said over an update took, and the model's part, both calls' when it was handed over. */
    const timing = (ms: number, modelMs: number | undefined, worked: Pick<Worked, "handed" | "replied">) => {
      const { handed, replied } = worked
      const model =
        handed === undefined
          ? modelMs === undefined
            ? "without the model"
            : `${seconds(modelMs)} of it the model's`
          : `${replied?.modelMs === undefined ? "the Responder without its model" : `${seconds(replied.modelMs)} of it the Responder's model`} and ${handed.modelMs === undefined ? "the Brain without its own" : `${seconds(handed.modelMs)} the Brain's`}`
      return Effect.logInfo(`Timing: ${seconds(ms)} to work out a reply, ${model}`)
    }

    /** Two lines as one, addressing him once. */
    const joined = (first: string, then: string, lines: Pick<Lines, "address">) => {
      const sir = addressed(lines)
      return `${first} ${sir !== "" && first.includes(sir) ? then.replace(sir, "") : then}`.trim()
    }

    /**
     * What's known of yapd's own voice in what he said over a line, heard as
     * `first`: whether it was only that, which code takes it for only when
     * Whisper heard nothing at all, so yapd stopped for itself and picks up
     * again, saying nothing and asking nobody; or else what it was saying
     * around when he began, which some of what was heard may be, for the
     * model to judge however short it is. Neither for what he began once its
     * own voice was learnt. Speech that went on past where it stopped is
     * someone else's, which its own voice dying away can't be; and when it
     * had said all of it by then, its own voice can only be its last word or
     * so before him, as after any line, so the model isn't told. Otherwise
     * all of it may yet have been its own voice, `unsure`. What ran on from
     * over a line said to the end into the wait after it, `carried`, is only
     * its own voice when all that was heard is the line's own last words, as
     * words compare, symbols and all: with a word of anyone else's, the model
     * is told, however short it is or wherever it ended.
     */
    const whose = (outcome: Extract<Outcome, { readonly _tag: "Interrupted" }>, first: string, text: string) => {
      const { echo, onset } = outcome
      if (echo === undefined) return { itself: false, unsure: false }
      if (first === "") return { itself: true, unsure: true }
      if (outcome.carried === true) return trailing(first, text) ? { itself: true, unsure: true } : { itself: false, unsure: false, echo }
      const past = voiced(outcome.audio) - Math.max(0, outcome.at - onset) > overhang
      return { itself: false, unsure: !past, ...(past && outcome.at >= outcome.duration - ending ? {} : { echo }) }
    }

    /**
     * Picks up again just before where it stopped over its first seconds, for
     * its own voice, when Whisper heard nothing or the model took it for that,
     * `unsure` whether there was more; or else for his talk that went on past
     * where it stopped but wasn't meant for it. Each is logged in one plain
     * line, with none of his words, so how often its own voice stops a line
     * on his speakers can be counted.
     */
    const again = (outcome: Extract<Outcome, { readonly _tag: "Interrupted" }>, unsure: boolean, from: number) =>
      Effect.logInfo(unsure ? ownVoice : notMeant).pipe(Effect.as(Math.max(from, outcome.at - before)))

    /**
     * Reads an update out and talks it over. `through` runs as soon as the
     * update itself has been read to the end, even with the microphone still
     * open for a reply, since the user has heard it by then. Returns whether
     * he heard it, which he didn't when it ended partway on what may have
     * been only its own voice. The microphone stays open longer after one
     * that asks him something while he's `present`, and after a `replay` of
     * one he heard, which he asked for. It starts `from` that far in, as
     * when it was put back to be read again from where he cut in. What he
     * hands to yapd's assistant over an update that needs him, cut off before
     * its end, that doesn't aim at it, or that may all be yapd's own words,
     * puts it back that way through `back`, run as soon as that's known, so
     * nothing can come between them, and then he hasn't heard it. `begun`
     * runs once the update first starts playing, and what's said back over
     * it is timed from his last word as it does.
     */
    const converse = (
      update: Update,
      through: Effect.Effect<void> = Effect.void,
      given: {
        readonly replay?: boolean
        readonly present?: boolean
        readonly from?: number
        readonly back?: (from: number) => Effect.Effect<void>
        readonly begun?: Effect.Effect<void>
      } = {},
    ) =>
      Effect.suspend(() => {
        const rendered: Array<string> = []
        return Effect.gen(function* () {
          const ear = hearing(yield* Effect.scope)
          const lines: Array<Line> = []
          let text = update.spoken
          let path = update.audio
          /** The first parts of what's said, by the line's file, when they're out before their whole. */
          const parts = new Map<string, Early>()
          if (update.first !== undefined && update.render !== undefined) parts.set(update.audio, { path: update.first, render: update.render })
          let from = given.from ?? 0
          let missed = 0
          /** What the line being said is, which tells what "scratch that" said over it or right after can take back. */
          let made: Made = "update"
          /** How many times the line being said was said again, which it is at most twice. */
          let replays = 0
          /** Said to the end, the line's length and when it ended, when only its own voice, or what may have been, stopped it as it ended: it listens on once for his reply. */
          let ended: { readonly duration: number; readonly finished?: number } | undefined
          let lingered = false
          /** How long the microphone stays open after the update itself, for a reply. */
          const own = update.needsYou && given.present === true && question.test(update.spoken.trim()) ? pondering : given.replay === true ? answering : linger
          /** How long it stays open after the line being said, and whether an answer he asked for waiting ends that early, as after any answer. */
          let window: { readonly wait: Duration.DurationInput; readonly closing: boolean } = { wait: own, closing: false }
          /**
           * Whether the line being said is one the journal keeps none of, like the model's answer to a secret he said, which could give it
           * away: then nor is what he hadn't heard of it when he talks over it, which a few words at a time may not show to be one.
           */
          let unkept = false
          /**
           * Where to pick the update up again once yapd has said what it did of his over it, like going into focus or muting it, when it
           * needs him and he hadn't heard all of it: what it asks him always comes through, as it does whatever the mode or mute.
           */
          let resume: number | undefined
          /** Picks the update up again, when it's to be: whether it is. */
          const pickUp = () => {
            if (resume === undefined) return false
            from = resume
            resume = undefined
            path = update.audio
            text = update.spoken
            made = "update"
            replays = 0
            unkept = false
            missed = 0
            lingered = false
            window = { wait: own, closing: false }
            return true
          }
          /**
           * The rest of the update, rendered as its headline starts to play, so "more" plays it at once: not before, since one voice
           * renders one thing at a time, and the next update's headline would wait behind it.
           */
          const more = update.more?.trim() ?? ""
          let rest: { readonly path: string; readonly fiber: Fiber.RuntimeFiber<void, unknown> } | undefined
          /** What runs as the line about to be played starts: the update's `begun` the first time, then what logs how long a line said back took. */
          let opening = given.begun ?? Effect.void

          while (true) {
            if (rest === undefined && more !== "") {
              const path = join(options.dir, `${crypto.randomUUID()}${extension}`)
              rendered.push(path)
              rest = { path, fiber: yield* Effect.forkScoped(voice.render(more, path)) }
            }
            // Past so much talk that wasn't meant for yapd, the rest plays through whatever's said, say for a TV, listening only for "Mute.",
            // over it and the moment after. Only a line it listened over to the end listens on after it for a reply.
            const heeding = missed >= misses
            const begun = opening
            opening = Effect.void
            const part = parts.get(path)
            const outcome: Outcome =
              ended === undefined
                ? yield* speak(path, text, from, heeding ? heedful(ear) : ear, {
                    begun,
                    wait: window.wait,
                    ...(part === undefined ? {} : { first: part }),
                    // Noted only once it's known to play, so a line for going ahead that fails to render or play, or that a dictation cuts in before, never counts as the last one he heard.
                    confirmed: path === update.audio ? Effect.void : persona.said(text),
                    through: path === update.audio ? through : Effect.void,
                    heeding,
                    ...(window.closing ? { cut: asked } : {}),
                  })
                : yield* harken(text, ended, ear, window.wait, window.closing ? { cut: asked } : {})
            ended = undefined
            if (outcome._tag === "Finished") {
              if (pickUp()) continue
              return true
            }
            // Replying to something yapd had finished saying: there's nothing to go back to.
            const after = outcome.at >= outcome.duration
            // Always forward, so talk that keeps coming can't hold an update back forever.
            const carryOn = () => {
              missed++
              from = Math.max(from, outcome.at - rewind)
            }

            const first = yield* (outcome.heard ?? unlogged(outcome.audio))
            const { itself, echo, unsure } = whose(outcome, first, text)
            // Its own last words as it ended leave him the usual moment to reply, once.
            const listenOn = () => {
              if (lingered) return false
              lingered = true
              ended = outcome
              return true
            }
            // Not talk that wasn't meant for yapd, which it stops listening after so much of: only over its first seconds.
            if (itself) {
              if (after) {
                if (listenOn() || pickUp()) continue
                return true
              }
              from = yield* again(outcome, true, from)
              continue
            }
            if (first === "") {
              if (after) {
                if (pickUp()) continue
                return true
              }
              carryOn()
              continue
            }

            const fraction = outcome.duration > 0 ? outcome.at / outcome.duration : 1
            const said = cut(text, fraction)
            // What it hadn't said yet, so the model knows whether he could have heard what he answers, like the agent's question.
            const left = unsaid(text, fraction)
            /** What the model makes of what he said, as ever. */
            const responding = (heard: string, voiced: number, afterPause: string) =>
              Effect.flatMap(Effect.zip(options.routines ?? Effect.succeed<ReadonlyArray<string>>([]), shownTurn(update)), ([routines, turn]) =>
                responder.respond({
                  project: update.project,
                  turn,
                  needsYou: update.needsYou,
                  lines: [...lines, { speaker: "yapd", text: said }],
                  heard,
                  ...(echo === undefined ? {} : { echo, ...(afterPause === "" ? {} : { afterPause }) }),
                  ...(left === "" ? {} : { unsaid: left }),
                  ...(more === "" ? {} : { more }),
                  ...(routines.length === 0 ? {} : { routines }),
                  voiced,
                  lateBy: outcome.lateBy,
                }),
              ).pipe(
                Effect.catchAll((error) =>
                  Effect.logWarning("Could not reply", error).pipe(
                    Effect.zipRight(persona.lines),
                    Effect.map((lines): Worked => ({ reply: { intent: "answer", spoken: lines.misheard, message: "" }, source: "failed" })),
                  ),
                ),
              )
            /** Hands it to yapd's assistant, with what he'd heard of the line, the exchange before it, and what it is. */
            const handing =
              options.over === undefined
                ? undefined
                : (muting: boolean) => (heard: string, voiced: number, afterPause: string, stopped?: number) =>
                    options.over!(update, [...lines], text, made, muting)(
                      heard,
                      voiced,
                      echo,
                      echo === undefined || afterPause === "" ? undefined : afterPause,
                      left === "" ? undefined : left,
                      stopped,
                    )
            /**
             * What he handed over that's acted on, run as soon as it's known, so a dictation starting then can't drop it: logged, then
             * registered, and the update put back to be read again from a moment before where he cut in, when it needs him, he cut it off
             * before its end, and it doesn't aim at it, or when all of it may be yapd's own words. Otherwise it ends there, and he's heard
             * it. Whether it was put back.
             */
            const handOver = (heard: string, worked: Worked & { readonly ms: number; readonly began: number }, handed: Extract<Handed, { readonly _tag: "Act" }>) =>
              Effect.gen(function* () {
                yield* Effect.logInfo(T3Actions.revealing(heard) ? "Heard something that could give a secret away, so it's held back" : `Heard: ${heard}`)
                yield* Effect.logInfo(`Handed over: ${handed.routed}`)
                yield* timing(worked.ms, worked.modelMs, worked)
                const at = !after && path === update.audio ? Math.max(from, outcome.at - rewind) : resume
                const cutOff = at !== undefined && ((!handed.aims && update.needsYou) || handed.doubted)
                yield* handed.run({ cutOff, reply: worked.replied ?? { ms: 0 }, since: worked.began })
                if (at !== undefined && cutOff) {
                  yield* given.back?.(at) ?? Effect.void
                  return true
                }
                yield* through
                return false
              })
            /**
             * What code acts on alone is held a breath, like a yes sent or a mute: not what the model worked out, which took longer than
             * that, nor what only says something, like the rest he asked for, nor what carries the line on, which talked over stops as
             * any line does.
             */
            const acting = ({ reply, source, handed }: Worked) =>
              (handed?.source ?? source) !== "model" && reply.intent !== "answer" && reply.intent !== "resume"
            /** Whether what he handed over was acted on, and put its update back. */
            let acted: boolean | undefined
            const settled = yield* Effect.uninterruptibleMask((restore) =>
              Effect.tap(
                restore(
                  settle(outcome.ear, first, outcome.audio, outcome.stopped, unlogged, !unsure, echo, (heard, voiced, afterPause, halt, stopped) => {
                    // Asked as each attempt is made, never once it runs, so what it does at once is done even for one cut short: only the work is timed.
                    const hooked = halt ? Option.none<Hooked>() : (options.mute?.(update, heard, voiced, echo) ?? Option.none<Hooked>())
                    return Effect.gen(function* () {
                      const began = yield* Clock.currentTimeMillis
                      const worked = yield* reading({
                        heard,
                        voiced,
                        afterPause,
                        halt,
                        echo,
                        stopped,
                        needsYou: update.needsYou,
                        hooked,
                        may: replays < 2,
                        respond: responding,
                        ...(handing === undefined ? {} : { over: handing }),
                        shortcut: Effect.map(persona.lines, (lines) => handoffLines(lines).shortcut),
                      })
                      return { ...worked, ms: (yield* Clock.currentTimeMillis) - began, voiced, began }
                    })
                  }, acting),
                ),
                // From settle's return until it's registered, it's never cut short: whatever comes then, like a dictation, waits for it.
                (settled) => {
                  const { handed } = settled.reply
                  return handed?._tag === "Act" && !settled.halt
                    ? Effect.map(handOver(settled.heard, settled.reply, handed), (back) => {
                        acted = back
                      })
                    : Effect.void
                },
              ),
            )
            if (acted !== undefined) return !acted
            const { heard, afterPause, halt } = settled
            const { reply, source, modelMs, ms, voiced, handed } = settled.reply
            /** How long what's said back took from his last word, to log as it plays, rendered once it's `ready`. */
            const reached = (steps: ReadonlyArray<readonly [string, number]>, ready: number) => {
              const how = `reply over an update, ${modelMs === undefined ? "fast" : "model"}, ${repeated ? "again" : reply.intent}`
              const timed: ReadonlyArray<readonly [string, number]> = [["heard", settled.reply.began - settled.stopped], ["worked out", ms], ...steps]
              opening = Latency.played(
                timed.reduce((timing, [name, ms]) => Latency.stage(timing, name, ms), Latency.from(how, settled.stopped, "his last word")),
                ready,
                audio.woke,
              )
            }
            // "Mute." turns yapd off at once, which cuts this off, with nothing of it noted or sent. Should yapd stay on, it's a stop.
            if (halt && options.off !== undefined) yield* options.off
            // Muting its thread is done, and said, once he's stopped.
            const muted = reply.intent === "mute" ? yield* reply.muting : undefined
            // Said again, it's the line itself, word for word.
            const repeated = source === "again"
            const answer = repeated ? text : (muted ?? reply.spoken)
            // Held back as it could give a secret away, it's kept and logged nowhere: whether it is, is known before either. Whatever the
            // model made of it, since his words may be one however it's answered, like a "remember …" he's told to ask with the shortcut.
            const holds = reply.intent === "send" && (yield* options.withholds(update, plain(reply.message)))
            const withheld = T3Actions.revealing(heard) || holds
            yield* Effect.logInfo(withheld ? "Heard something that could give a secret away, so it's held back" : `Heard: ${heard}`)
            if (handed !== undefined) yield* Effect.logInfo(`Handed over: ${handed.routed}`)
            // The model's answer may say it back, like "I won't keep sk-…, sir": then only what it made of it is logged, and the answer is
            // said but kept nowhere when it could give one away.
            yield* Effect.logInfo(`Reply: ${reply.intent}${answer === "" || withheld || repeated ? "" : `, saying: ${answer}`}${repeated ? ", saying it again" : ""}`)
            yield* timing(ms, modelMs, settled.reply)
            // Ended partway on no more than what may all have been its own voice, like its "Over—" heard as "Okay.", it's left
            // unheard, so "what did I miss?" brings it back, and nothing of it is noted as his.
            const doubted = reply.intent === "dismiss" && unsure && !after && heard === first
            if (doubted) yield* Effect.logInfo("Ended on what may have been its own voice, so it's left unheard")
            if (reply.intent !== "resume" && !doubted) {
              yield* journal.write({
                at: yield* Clock.currentTimeMillis,
                kind: "reply",
                host: update.thread.origin.host,
                project: update.project,
                // With the thread T3 Code knows it by, when it's tied to one, like the update itself.
                ...(update.about === undefined ? { thread: update.session } : { machine: update.about.machine, thread: update.about.id }),
                directory: update.thread.cwd,
                // What the model answered to what was held back as a secret may give it away in words nothing recognises as one, as may a
                // line said again that's kept nowhere.
                ...(withheld || T3Actions.revealing(answer) || (repeated && unkept) ? {} : { said: answer }),
                ...(withheld ? {} : { text: heard }),
                detail: {
                  intent: reply.intent,
                  ...(reply.message === "" || withheld ? {} : { message: reply.message }),
                  // What may have been its own voice in his words, kept with them for whatever reads them back.
                  ...(echo === undefined || withheld ? {} : { echo, ...(afterPause === "" ? {} : { afterPause }) }),
                  ...(withheld ? { withheld } : {}),
                  // How it was worked out and how long that took, what of the line he hadn't heard, when he began and how long he spoke,
                  // to replay it as it was. Never as `decision`, which the assistant's rows keep, nor `unsaid`, which is what yapd never told him.
                  source,
                  ms,
                  ...(modelMs === undefined ? {} : { modelMs }),
                  // Heard as he paused at its end, rather than once he'd stopped.
                  ...(outcome.heard === undefined ? {} : { early: true }),
                  ...(left === "" || withheld || unkept || T3Actions.revealing(left) ? {} : { left }),
                  after,
                  lateBy: hundredths(outcome.lateBy),
                  needsYou: update.needsYou,
                  voiced: hundredths(voiced),
                },
              })
              // Turned down as what only his word does while he isn't at hand, as a TV's talk may be, nothing of his is taken up: he
              // isn't noted at hand, which would have the next such talk acted on, nor does it take the place of what yapd asked.
              if (handed?._tag !== "Answer" || handed.unattended !== true) yield* options.replied
            }

            if (reply.intent === "dismiss") {
              if (doubted) return false
              if (pickUp()) continue
              return true
            }
            if (reply.intent === "resume") {
              // What may all be yapd's own words, let go by yapd's assistant, is logged as it is wherever else it's let go.
              if (handed?._tag === "Resume") yield* handed.logged ?? Effect.void
              if (after) {
                if ((echo !== undefined && listenOn()) || pickUp()) continue
                return true
              }
              // Taken by the model for its own voice, it's no more talk that wasn't meant for yapd than when Whisper heard nothing. Nor is
              // a nod it carries on after, like an "Okay." or a "Yeah." said before the agent's question, so he hears it: that was meant for it.
              if (echo !== undefined) from = yield* again(outcome, unsure, from)
              else if (noted.has(gist(heard)) || agreed.has(gist(heard))) from = Math.max(from, outcome.at - rewind)
              else carryOn()
              continue
            }

            // With what may have been its own voice in it, so the model asked next still knows, as when he says it again.
            lines.push(
              { speaker: "yapd", text: said },
              { speaker: "user", text: heard, ...(echo === undefined ? {} : { echo, ...(afterPause === "" ? {} : { afterPause }) }) },
            )
            // Said again from its start, as it was, with no model, its window and what was missed over it as they were, so talk that keeps
            // coming still makes it play through.
            if (repeated) {
              replays++
              made = "again"
              from = 0
              lingered = false
              reached([], yield* Clock.currentTimeMillis)
              continue
            }
            // Over an update that needs him, before all of it was said, what he changed is said, then it carries on from where it stopped. So
            // is yapd's own answer to what he handed it, like "Ask me that with the shortcut.", which answers nothing the update asked.
            if ((reply.intent === "mute" || handed?._tag === "Answer") && update.needsYou && !after && path === update.audio) resume = Math.max(from, outcome.at - rewind)
            const passing = yield* Clock.currentTimeMillis
            text = reply.intent === "send" ? yield* pass(update, reply) : answer
            const passed = yield* Clock.currentTimeMillis
            // A rest of what he handed over that was left, as it was for the update's own session, is said with it.
            if (handed?._tag === "Pass" && handed.left !== undefined && text !== "") text = joined(text, handed.left, yield* persona.lines)
            made = reply.intent === "send" ? "sent" : reply.intent === "mute" ? (reply.made ?? "answer") : "answer"
            replays = 0
            // Kept only as the reply's `said`, which it isn't when it could give a secret away, or when what he said is held back.
            unkept = withheld || T3Actions.revealing(text)
            if (text === "") {
              if (pickUp()) continue
              return true
            }
            // The rest he asked for, rendered already, or still rendering, is played as it is, even with the model's "sir" around it;
            // rendered again only if that failed.
            const early = rest !== undefined && restOf(text, more) && Exit.isSuccess(yield* Fiber.await(rest.fiber)) ? rest.path : undefined
            if (early !== undefined) {
              path = early
              text = more
              // The update's own words, which it keeps.
              unkept = false
            }
            else {
              path = join(options.dir, `${crypto.randomUUID()}${extension}`)
              rendered.push(path)
              // Said from its first sentences as soon as they're out, while the rest renders, given up should the talk end first.
              const rendering = yield* inParts(voice, text, path)
              const lead = yield* rendering.first
              if (lead !== path) {
                rendered.push(lead)
                parts.set(path, { path: lead, render: rendering })
              }
            }
            const ready = yield* Clock.currentTimeMillis
            reached([...(reply.intent === "send" ? [["sent", passed - passing] as const] : []), ["rendered", ready - passed]], ready)
            // How long what he handed over took to answer, part by part: passing it on, then rendering.
            if (handed !== undefined) {
              yield* answeredIn(settled.reply.began, {
                ...(settled.reply.replied === undefined ? {} : { responder: settled.reply.replied.ms }),
                brain: handed.ms,
                ...(reply.intent === "send" ? { acting: passed - passing } : {}),
                rendering: (yield* Clock.currentTimeMillis) - passed,
              })
            }
            yield* options.saying(update, text)
            // An answer to what he said over it is listened after as any answer is, cut short once one he asked for waits; anything else,
            // like going ahead, a mute or the rest of the update, as after the update.
            const answered = reply.intent === "answer" && early === undefined
            window = { wait: answered ? answering : linger, closing: answered }
            from = 0
            missed = 0
            lingered = false
          }
        }).pipe(
          Effect.scoped,
          Effect.ensuring(Effect.promise(() => Promise.all(rendered.map((path) => rm(path, { force: true }))))),
          Effect.annotateLogs({ project: update.project }),
        )
      })

    /**
     * Says something of yapd's own and listens for what the user says over it
     * or `wait` after, like with an update: `respond` works out what they
     * meant, and what it gives back is run once they've stopped. Talk it
     * makes nothing of picks up where it cut in, unless it came once all of
     * it was said. Its `through` runs each time it's said to the end, and
     * what they say is heard listening for its `terms`. Returns whether
     * something came of what they said, and fails when it can't be played or
     * breaks off. Listened to `after` it, it plays through whatever's said
     * over it, listening only for "Mute.", and what they say is listened for
     * from its end. Once `cut` comes, the wait after it is over early.
     */
    const exchange = (
      said: Omit<Question, "answer"> & { readonly withheld?: boolean },
      respond: Question["answer"],
      wait: Duration.DurationInput,
      after = false,
      cut: Effect.Effect<void> = Effect.never,
    ) =>
      Effect.gen(function* () {
        // Listening for its options, if it has any, all of what he says back, however long he goes on.
        const ear = hearing(yield* Effect.scope, said.terms)
        const hear = (audio: Float32Array) => unlogged(audio, said.terms)
        let from = 0
        let missed = 0
        let begun = said.saying ?? Effect.void
        let confirmed = said.confirmed ?? Effect.void
        /**
         * As for an update, the line's length and when it ended, when it listens on once after its own voice as it ended, or from its end
         * after it, with what's still going then.
         */
        let ended: { readonly duration: number; readonly finished?: number; readonly open?: Ended["open"] } | undefined
        let lingered = false
        while (true) {
          // As for an update, past so much talk that wasn't meant for yapd, the rest plays through whatever's said, listening only for "Mute.".
          // Listened to after it, it plays through all that's said over it, on the microphone that then hears what he says back.
          const heeding = missed >= misses
          const outcome: Outcome =
            ended === undefined
              ? yield* speak(said.audio, said.spoken, from, heeding && !after ? heedful(ear) : ear, {
                  wait,
                  begun,
                  confirmed,
                  ...(said.first === undefined ? {} : { first: said.first }),
                  through: said.through ?? Effect.void,
                  heeding: heeding || after,
                  replying: after,
                  cut,
                })
              : yield* harken(said.spoken, ended, ear, wait, { fromEnd: after, cut })
          ended = undefined
          begun = Effect.void
          confirmed = Effect.void
          if (outcome._tag === "Finished") {
            if (outcome.ended === undefined) return false
            ended = outcome.ended
            continue
          }
          const first = yield* (outcome.heard ?? hear(outcome.audio))
          // Nothing heard over its first seconds is its own voice, no answer, nor talk that wasn't meant for yapd.
          const { itself, echo, unsure } = whose(outcome, first, said.spoken)
          // Its own last words alone, run on into the wait after it, are logged, so how often that happens can be counted: never what can't be.
          if (outcome.carried === true && itself && first !== "") {
            yield* Effect.logInfo(
              said.withheld === true || T3Actions.revealing(first) ? "Took its own last words for its own voice" : `Took its own last words for its own voice: ${first}`,
            )
          }
          if (outcome.carried === true && !itself) yield* Effect.logInfo("Worked out what ran on from its own voice into the wait after it")
          // What it hadn't said yet when he began, a moment before, so what he could have heard of it is known, like a question's options:
          // never from where it stopped, which takes him for having heard what it said as he was already talking. Nothing once all of it was.
          const left = outcome.at < outcome.duration ? unsaid(said.spoken, Math.max(0, outcome.onset - reaction) / outcome.duration) : ""
          /** Run on from its own voice as it ended, the line whose last words are all there may be of yapd's own in what he said. */
          const own = outcome.carried === true ? said.spoken : undefined
          const settled =
            itself || first === ""
              ? undefined
              : yield* settle(
                  outcome.ear,
                  first,
                  outcome.audio,
                  outcome.stopped,
                  hear,
                  !unsure,
                  echo,
                  (heard, voiced, afterPause, halt, stopped) => {
                    // What he said after the line's last words is surely his, however short, like the "No." of "the Tezos migration. No.".
                    const rest = own === undefined ? "" : (beyond(heard, own) ?? "")
                    const his = worded(rest) === "" ? afterPause : rest
                    return halt
                      ? Effect.succeed(Option.none<Effect.Effect<void>>())
                      : respond(heard, voiced, echo, echo === undefined || his === "" ? undefined : his, left === "" ? undefined : left, outcome.carried, stopped)
                  },
                  // Any answer taken, which a pick, an approval or a stop is, as soon as code has made it out.
                  Option.isSome,
                  own,
                )
          if (settled !== undefined) yield* Effect.logInfo(heardLine(settled.heard))
          // "Mute." turns yapd off at once, which cuts this off: it's no answer, nor anything to follow up. Should yapd stay on, nothing came of it.
          if (settled?.halt === true && options.off !== undefined) {
            yield* options.off
            return false
          }
          const reply = settled?.reply ?? Option.none()
          if (Option.isSome(reply)) {
            // They've answered or followed it up, so it's taken in even if a dictation starts right now.
            yield* Effect.uninterruptible(reply.value)
            return true
          }
          // Its own last words as it ended, or what may have been, leave him the usual moment to answer, once.
          if (outcome.at >= outcome.duration && (itself || echo !== undefined) && !lingered) {
            lingered = true
            ended = outcome
            continue
          }
          // Talk that wasn't meant for yapd, once all of it was said, ends it: a question is left unanswered.
          if (outcome.at >= outcome.duration) return false
          // Nor is what may have been its own voice, as `respond` was told, which is picked up just before.
          if (itself || echo !== undefined) {
            from = yield* again(outcome, unsure, from)
            continue
          }
          missed++
          from = Math.max(from, outcome.at - rewind)
        }
      }).pipe(Effect.scoped)

    /**
     * Asks the user something and listens for what they say over it or right
     * after, like with an update. Returns whether they answered, and fails
     * when it can't be played or breaks off.
     */
    const ask = (question: Question) => exchange(question, question.answer, pondering)

    /**
     * Says an answer to what the user asked and listens for a follow-up over
     * it or right after, longer than after an update, since it's what they
     * asked to hear and may want to follow up, but over once soon after it
     * ended when another answer they asked for waits. Said `after`, only what
     * they say once it's ended is a follow-up. Returns whether they followed
     * it up, and fails when it can't be played or breaks off.
     */
    const answer = (said: Answer) => exchange(said, said.followUp, said.wait ?? answering, said.after === true, asked)

    /**
     * Says something of yapd's own that nothing he'd say over it has anywhere
     * to go, like a notice: it plays through whatever's said, never turned
     * down, listening only for "Mute.", over it and the usual moment after it,
     * so its `through` runs as soon as it's said to the end. That moment is
     * over after the pause between lines once something waits to be said
     * next. Fails when it can't be played or breaks off.
     */
    const tell = (said: Pick<Answer, "audio" | "first" | "spoken" | "saying" | "confirmed" | "through">) =>
      Effect.gen(function* () {
        const ear = heedful(hearing(yield* Effect.scope))
        yield* speak(said.audio, said.spoken, 0, ear, {
          begun: said.saying ?? Effect.void,
          confirmed: said.confirmed ?? Effect.void,
          through: said.through ?? Effect.void,
          heeding: true,
          ...(said.first === undefined ? {} : { first: said.first }),
        })
      }).pipe(Effect.scoped)

    return {
      converse,
      ask,
      answer,
      tell,
      /**
       * Plays a line without listening, as when yapd is off: from its first
       * part on into its whole, when it's out in parts, as any line is.
       */
      playLine: (path: string, text: string, first?: Early) => play(path, text, 0, first),
      /** Whether a follow-up to the session, or this particular update, is on its way. */
      sending: (session: string, update?: Update) => Effect.sync(() =>
        update === undefined ? [...sending.keys()].some((update) => update.session === session) : sending.has(update),
      ),
    }
  })
