import { Clock, type Duration, Effect, Exit, Fiber, Option, Queue, Scope, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, AudioError, type Playback } from "./Audio.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, RelayError, type Thread } from "./Relay.ts"
import { Journal } from "./Journal.ts"
import { Persona } from "./Persona.ts"
import { agreed, gist, halts, type Line, noted, type Reply, Responder } from "./Responder.ts"
import type * as Threads from "./Threads.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { extension, Voice } from "./Voice.ts"

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
  readonly audio: string
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
}

type Signal =
  | Exclude<Endpointer.Event, { readonly _tag: "Onset" }>
  /**
   * Might be the user, or with `echo`, yapd's own voice getting into the
   * microphone, as it can until the echo cancellation has learnt it.
   */
  | { readonly _tag: "Onset"; readonly echo: boolean }
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
 * The microphone for a whole update, so nothing the user says is missed
 * between lines, like while yapd works out what to say back.
 */
interface Ear {
  readonly signals: Queue.Queue<Signal>
  deaf: boolean
}

/** How a line went: played out, or talked over, with what the user said. */
type Outcome =
  | { readonly _tag: "Finished" }
  | {
      readonly _tag: "Interrupted"
      /** How far it got, in seconds. */
      readonly at: number
      readonly duration: number
      readonly audio: Float32Array
      readonly ear: Ear
      /**
       * What yapd was saying around when he began, when that was while its
       * own voice could still get into the microphone: what was heard may be
       * some of that, or his first word lost under it.
       */
      readonly echo?: string
      /** How far into the line he began, which is no further than where it stopped: what he'd heard of it when he spoke. */
      readonly onset: number
    }

/** How long the microphone stays open after yapd stops, for a reply to what it just said. */
const linger: Duration.DurationInput = "3 seconds"
/** Longer after a question, which takes a moment's thought to answer. */
const pondering: Duration.DurationInput = "8 seconds"
/** Longer than the longest utterance, so only a microphone that went quiet trips it. */
const patience = "40 seconds"
/**
 * How long after he began it what he's saying can still be "Mute.", in
 * milliseconds, even said again and again, and heard out once he's stopped:
 * what goes on longer, like a TV, is no reason to keep listening for it.
 */
const outburst = 4_000
/** Volume while it's still unclear whether the user is talking. */
const ducked = 0.25
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

/** Seconds either side of when the user began that what yapd was saying is given with what he said, since where each word falls in a line is only guessed. */
const reach = 4

/** The words of `text` said between `start` and `end` seconds into its `duration`, as far as that can be told from where they fall in it. */
export const between = (text: string, duration: number, start: number, end: number) => {
  if (duration <= 0) return text
  const words = text.split(/\s+/).filter((word) => word !== "")
  return words.slice(Math.max(0, Math.floor((words.length * start) / duration)), Math.max(0, Math.ceil((words.length * end) / duration))).join(" ")
}

/** Muting the thread of an update he spoke over, in so many words: done once he's stopped, giving back what's said of it. */
interface Muting {
  readonly intent: "mute"
  readonly spoken: ""
  readonly message: ""
  readonly muting: Effect.Effect<string>
}

/** Something yapd asks the user for itself, like which project new work is for, rendered and ready to be asked. */
export interface Question {
  readonly audio: string
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
   * pause, when they did, which is surely theirs, as yapd had stopped by then.
   * Said over it, `unsaid` is what yapd hadn't said of it yet a moment
   * before they began, as far as where it had got to tells, like its
   * options: none when all of it was said.
   */
  readonly answer: (heard: string, voiced: number, echo?: string, afterPause?: string, unsaid?: string) => Effect.Effect<Option.Option<Effect.Effect<void>>>
}

/** An answer to what the user asked yapd, rendered and ready to be said, which they can follow up as they can an update. */
export interface Answer extends Omit<Question, "answer"> {
  /** Works out what they meant by what they said over it or right after, as a question's `answer` does: none means it wasn't meant for yapd. */
  readonly followUp: Question["answer"]
  /** Run once it's been said to the end, before the wait for a follow-up, since the user has heard it by then. */
  readonly through?: Effect.Effect<void>
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
   * When all he said over an update is to mute or unmute its thread, in so
   * many words and plainly his, how that's done, giving back what's said of
   * it: never anything sent to the agent. None for anything else, which is
   * worked out as ever.
   */
  readonly mute?: (update: Update, heard: string, voiced: number, echo: string | undefined) => Option.Option<Effect.Effect<string>>
  /**
   * Turns yapd off as the menu does, for "Mute." said on its own over
   * anything it says, or right after: his emergency off. Turning off cuts off
   * what's being said, so this comes back only should yapd stay on. Without
   * it, "Mute." is a stop, as it always was.
   */
  readonly off?: Effect.Effect<void>
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
     * microphone, was about muting, as that "mute" may be its own.
     */
    const halted = (heard: string, echo: string | undefined) => options.off !== undefined && halts(heard) && !/mute/i.test(echo ?? "")

    /** Starts listening, if there's a microphone. That's only known once something plays. */
    const open = (scope: Scope.Scope) =>
      Effect.gen(function* () {
        const detect = yield* vad.make.pipe(Effect.option)
        if (Option.isNone(detect)) return undefined
        const microphone = yield* audio.microphone.pipe(Scope.extend(scope))
        if (Option.isNone(microphone)) return undefined
        const ear: Ear = { signals: yield* Queue.unbounded<Signal>(), deaf: false }
        const endpointer = new Endpointer.Endpointer()
        yield* Stream.fromQueue(microphone.value).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              // As the frame came in, since by the time it's looked at, yapd may well have learnt its own voice.
              const echo = yield* audio.echo(frame)
              const event = endpointer.push(frame, yield* detect.value(frame), echo)
              return event?._tag === "Onset" ? ({ _tag: "Onset", echo } satisfies Signal) : event
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

    /** The microphone for whatever is said in the scope, opened when it's first needed. */
    const hearing = (scope: Scope.Scope) => {
      let opened: Ear | undefined
      return Effect.suspend(() =>
        opened === undefined
          ? open(scope).pipe(
              Effect.tap((ear) => {
                opened = ear
              }),
            )
          : Effect.succeed(opened),
      )
    }

    /**
     * Plays a line, `text`, from `from` seconds, listening if there's an ear,
     * then `wait` longer for a reply. `begun` runs once it's playing, never
     * when it can't be played, `confirmed` once it's known to be, which with
     * afplay is only once it has played to the end, and `through` once it
     * has, before that wait: the user has heard it, whatever they say after.
     * `heeding`, it plays through whatever's said, listening only for
     * "Mute.", over it and the usual moment after it, whatever `wait` is,
     * ducked while he talks over it when it `ducks`.
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
        readonly ducks?: boolean
      } = {},
    ) =>
      Effect.gen(function* () {
        const { wait = linger, begun = Effect.void, confirmed = Effect.void, through = Effect.void, heeding = false, ducks = false } = given
        const playback = yield* audio.play(path, from)
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
        return yield* (heeding ? heed(playback, listening, text, from, played, ducks) : listen(playback, listening, text, from, wait, played))
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
     * say for a TV. Nothing else said over it stops it, and nothing else of
     * what's said is kept or logged. What `ducks`, like a notice, is ducked
     * while he talks, as a line it listens over is, so he hears at once he's
     * heard and his word is heard clear of it, and it's back to full volume
     * once what he said is heard out and isn't "Mute.": never the rest of a
     * line played through for a TV, which talk that goes on would keep
     * quiet. What he's still saying once that moment is over is heard out,
     * for as long as it could be "Mute.".
     */
    const heed = (playback: Playback, ear: Ear, text: string, from: number, through: Effect.Effect<void>, ducks: boolean) =>
      Effect.gen(function* () {
        const { signals } = ear
        const id = fresh()
        const began = yield* Clock.currentTimeMillis
        yield* playback.finished.pipe(
          Effect.tap(() => through),
          Effect.match({
            onFailure: (error): Signal => ({ _tag: "Broke", id, error }),
            onSuccess: (): Signal => ({ _tag: "Finished", id }),
          }),
          Effect.flatMap((signal) => Queue.offer(signals, signal)),
          Effect.forkScoped,
        )
        const position = Effect.map(Clock.currentTimeMillis, (now) => Math.min(playback.duration, from + (now - began) / 1000))
        /** How far into the line he began what he's saying, when by the clock, and whether that was while yapd's own voice could still get into the microphone. */
        let onset: number | undefined
        let since = 0
        let echoing = false
        /** Played to the end, and then the usual moment after it too. */
        let played = false
        let over = false
        /** Back to full volume, while it's still playing, once what ducked it is over. */
        const unduck = Effect.suspend(() => (ducks && !played ? playback.volume(1) : Effect.void))
        // Once it's all over, only what he's still saying is waited for, while it could yet be "Mute.": a microphone gone quiet, or talk
        // that goes on, like a TV's, ends it as one gone deaf does.
        const next = Effect.suspend(() =>
          over
            ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
                Queue.take(signals).pipe(
                  Effect.timeout(Math.max(0, since + outburst - now)),
                  Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
                ),
              )
            : Queue.take(signals),
        )
        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              onset = yield* position
              since = yield* Clock.currentTimeMillis
              echoing = signal.echo
              if (ducks && !played) yield* playback.volume(ducked)
              break
            case "Abandoned":
              onset = undefined
              echoing = false
              if (over) return { _tag: "Finished" } satisfies Outcome
              yield* unduck
              break
            case "Utterance": {
              // Heard out before what comes after, so it's never missed as the line ends.
              const at = yield* position
              const begun = onset ?? at
              const echo = echoing ? between(text, playback.duration, begun - reach, Math.max(at, begun) + reach) : undefined
              onset = undefined
              echoing = false
              if (options.off !== undefined && halted(yield* unlogged(signal.audio), echo)) {
                // Its voice ends at once, never waiting on all turning off does first. Should yapd stay on, it's a stop.
                yield* playback.stop
                yield* options.off
                return { _tag: "Finished" } satisfies Outcome
              }
              if (over) return { _tag: "Finished" } satisfies Outcome
              yield* unduck
              break
            }
            case "Finished":
              if (signal.id !== id) break
              if (ear.deaf) return { _tag: "Finished" } satisfies Outcome
              played = true
              yield* Effect.sleep(linger).pipe(Effect.zipRight(Queue.offer(signals, { _tag: "Lingered", id })), Effect.forkScoped)
              break
            case "Lingered":
              if (signal.id !== id) break
              if (onset === undefined) return { _tag: "Finished" } satisfies Outcome
              over = true
              break
            case "Broke":
              if (signal.id === id) return yield* Effect.fail(signal.error)
              break
            case "Deaf":
              if (played) return { _tag: "Finished" } satisfies Outcome
              yield* unduck
              break
            default:
              break
          }
        }
      })

    const listen = (playback: Playback, ear: Ear, text: string, from: number, wait: Duration.DurationInput, through: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const { signals } = ear
        const id = fresh()
        const began = yield* Clock.currentTimeMillis
        // Failing ends it too, or this could wait for a signal that never comes. Played to the end, it's heard
        // there and then, even when a stop asked for just before is still being answered: only playing to the
        // end finishes it, never being stopped.
        yield* playback.finished.pipe(
          Effect.tap(() =>
            Effect.zipRight(
              Effect.sync(() => {
                completed = true
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
        let stoppedAt: number | undefined
        /** How far into the line he began what he's saying, and whether that was while yapd's own voice could still get into the microphone. */
        let onset: number | undefined
        let echoing = false
        let lingering: { readonly id: number; readonly fiber: Fiber.RuntimeFiber<void> } | undefined
        const stopLingering = Effect.suspend(() => {
          const fiber = lingering?.fiber
          lingering = undefined
          return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
        })
        const startLingering = Effect.gen(function* () {
          yield* stopLingering
          const id = fresh()
          const fiber = yield* Effect.sleep(wait).pipe(
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
        /** How far into the line yapd has got, in seconds. */
        const position = Effect.map(Clock.currentTimeMillis, (now) => stoppedAt ?? Math.min(playback.duration, from + (now - began) / 1000))

        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              speaking = true
              onset = yield* position
              echoing = signal.echo
              yield* stopLingering
              if (playing) yield* playback.volume(ducked)
              break
            case "Speech":
              yield* stopLingering
              if (playing) {
                playing = false
                cut = true
                stoppedAt = yield* playback.stop
              }
              break
            case "Abandoned":
              speaking = false
              if (playing) yield* playback.volume(1)
              else yield* startLingering
              break
            case "Utterance": {
              const at = stoppedAt ?? playback.duration
              const begun = onset ?? at
              return {
                _tag: "Interrupted",
                at,
                duration: playback.duration,
                audio: signal.audio,
                ear,
                // To where it stopped, or where he began, should the helper put that a moment before.
                onset: Math.min(at, begun),
                ...(echoing ? { echo: between(text, playback.duration, begun - reach, Math.max(at, begun) + reach) } : {}),
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
     * the end, as for a reply to it: for when only its own voice, or what may
     * have been, got into the microphone as it ended.
     */
    const harken = (text: string, duration: number, ear: Effect.Effect<Ear | undefined>, wait: Duration.DurationInput) =>
      Effect.gen(function* () {
        const listening = yield* ear
        if (listening === undefined || listening.deaf) return { _tag: "Finished" } satisfies Outcome
        const ended: Playback = { duration, confirmed: true, finished: Effect.void, stop: Effect.succeed(duration), volume: () => Effect.void }
        return yield* listen(ended, listening, text, duration, wait, Effect.void)
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
     * into it, like "Can you…" then "mute.", which mutes something. Unless
     * it trails off itself, it's given back at once, never waiting on
     * whether he carries on.
     */
    const settle = <R>(
      ear: Ear,
      first: string,
      audio: Float32Array,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      hesitates: boolean,
      echo: string | undefined,
      respond: (heard: string, voiced: number, afterPause: string, halt: boolean) => Effect.Effect<R>,
    ) =>
      Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + rambling
        let heard = first
        let speech = voiced(audio)
        /** All he said once he carried on after `first`, kept apart so it can be told it's surely his. */
        let afterPause = ""
        let halt = halted(first, echo)
        while (true) {
          // Not for what may all be yapd's own voice, cut off where it stopped, like "the PR is ready for": that's no sign he's trailing off.
          const replying =
            unfinished(heard) && (hesitates || heard !== first)
              ? Effect.zipRight(Effect.sleep(hesitation), respond(heard, speech, afterPause, halt))
              : respond(heard, speech, afterPause, halt)
          // "Mute." not trailing off is acted on at once, so what's said after it, like his phone answered, can't take it back.
          if (ear.deaf || (yield* Clock.currentTimeMillis) > until || (halt && !unfinished(heard))) return { heard, afterPause, halt, reply: yield* replying }
          const id = fresh()
          const fiber = yield* replying.pipe(
            Effect.flatMap((reply) => Queue.offer(ear.signals, { _tag: "Replied", id, reply })),
            Effect.fork,
          )

          let speaking = false
          let carryingOn = false
          let held: R | undefined
          let more: Float32Array | undefined
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
                if (!speaking) return { heard, afterPause, halt, reply: signal.reply as R }
                held = signal.reply as R
                break
              case "Onset":
                speaking = true
                break
              case "Abandoned":
                speaking = false
                if (held !== undefined) return { heard, afterPause, halt, reply: held }
                break
              case "Speech":
                carryingOn = true
                held = undefined
                yield* Fiber.interrupt(fiber)
                break
              case "Utterance":
                more = signal.audio
                break waiting
              case "Deaf":
                speaking = false
                if (carryingOn) break waiting
                if (held !== undefined) return { heard, afterPause, halt, reply: held }
                break
              case "Finished":
              case "Broke":
              case "Lingered":
                break
            }
          }
          yield* Fiber.interrupt(fiber)
          if (more === undefined) continue
          const after = yield* transcribe(more)
          const before = heard
          heard = together(heard, after)
          afterPause = afterPause === "" ? after : together(afterPause, after)
          // Only what added words, since speech Whisper made nothing of isn't in what was heard.
          if (after !== "") {
            speech += voiced(more)
            halt = halted(heard, echo) || (!unfinished(before) && halted(after, undefined))
          }
        }
      })

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
        yield* Effect.logInfo(`${result === "queued" ? "Queued" : typeof result === "object" ? "Held" : "Sent"}: ${text}`)
        return result
      })

    /** What the user said, logged once it's known it's fit to be, as what's said over an update may not be; listening for `terms`, when there are any. */
    const unlogged = (audio: Float32Array, terms?: ReadonlyArray<string>) =>
      transcriber.transcribe(audio, terms).pipe(Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))))

    const transcribe = (audio: Float32Array, terms?: ReadonlyArray<string>) =>
      unlogged(audio, terms).pipe(Effect.tap((heard) => (heard === "" ? Effect.void : Effect.logInfo(`Heard: ${heard}`))))

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
     * all of it may yet have been its own voice, `unsure`.
     */
    const whose = (outcome: Extract<Outcome, { readonly _tag: "Interrupted" }>, first: string) => {
      const { echo, onset } = outcome
      if (echo === undefined) return { itself: false, unsure: false }
      if (first === "") return { itself: true, unsure: true }
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
     * been only its own voice.
     */
    const converse = (update: Update, through: Effect.Effect<void> = Effect.void) =>
      Effect.suspend(() => {
        const rendered: Array<string> = []
        return Effect.gen(function* () {
          const ear = hearing(yield* Effect.scope)
          const lines: Array<Line> = []
          let text = update.spoken
          let path = update.audio
          let from = 0
          let missed = 0
          /** Said to the end, the line's length, when only its own voice, or what may have been, stopped it as it ended: it listens on once for his reply. */
          let ended: number | undefined
          let lingered = false
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
            missed = 0
            lingered = false
            return true
          }
          /**
           * The rest of the update, rendered as its headline starts to play, so "more" plays it at once: not before, since one voice
           * renders one thing at a time, and the next update's headline would wait behind it.
           */
          const more = update.more?.trim() ?? ""
          let rest: { readonly path: string; readonly fiber: Fiber.RuntimeFiber<void, unknown> } | undefined

          while (true) {
            if (rest === undefined && more !== "") {
              const path = join(options.dir, `${crypto.randomUUID()}${extension}`)
              rendered.push(path)
              rest = { path, fiber: yield* Effect.forkScoped(voice.render(more, path)) }
            }
            // Past so much talk that wasn't meant for yapd, the rest plays through whatever's said, say for a TV, listening only for "Mute.",
            // over it and the moment after. Only a line it listened over to the end listens on after it for a reply.
            const heeding = missed >= misses
            const outcome: Outcome =
              ended === undefined
                ? yield* speak(path, text, from, heeding ? heedful(ear) : ear, {
                    // Noted only once it's known to play, so a line for going ahead that fails to render or play, or that a dictation cuts in before, never counts as the last one he heard.
                    confirmed: path === update.audio ? Effect.void : persona.said(text),
                    through: path === update.audio ? through : Effect.void,
                    heeding,
                  })
                : yield* harken(text, ended, ear, linger)
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

            const first = yield* unlogged(outcome.audio)
            const { itself, echo, unsure } = whose(outcome, first)
            // Its own last words as it ended leave him the usual moment to reply, once.
            const listenOn = () => {
              if (lingered) return false
              lingered = true
              ended = outcome.duration
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
            const responding = (heard: string, afterPause: string) =>
              responder
                .respond({
                  project: update.project,
                  turn: update.turn,
                  needsYou: update.needsYou,
                  lines: [...lines, { speaker: "yapd", text: said }],
                  heard,
                  ...(echo === undefined ? {} : { echo, ...(afterPause === "" ? {} : { afterPause }) }),
                  ...(left === "" ? {} : { unsaid: left }),
                  ...(more === "" ? {} : { more }),
                })
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.logWarning("Could not reply", error).pipe(
                      Effect.zipRight(persona.lines),
                      Effect.map((lines): Reply => ({ intent: "answer", spoken: lines.misheard, message: "" })),
                    ),
                  ),
                )
            const { heard, afterPause, halt, reply } = yield* settle(outcome.ear, first, outcome.audio, unlogged, !unsure, echo, (heard, voiced, afterPause, halt) =>
              halt
                ? Effect.succeed<Reply | Muting>({ intent: "dismiss", spoken: "", message: "" })
                : Option.match(options.mute?.(update, heard, voiced, echo) ?? Option.none(), {
                    onSome: (muting) => Effect.succeed<Reply | Muting>({ intent: "mute", spoken: "", message: "", muting }),
                    onNone: () => responding(heard, afterPause),
                  }),
            )
            // "Mute." turns yapd off at once, which cuts this off, with nothing of it noted or sent. Should yapd stay on, it's a stop.
            if (halt && options.off !== undefined) yield* options.off
            // Muting its thread is done, and said, once he's stopped.
            const muted = reply.intent === "mute" ? yield* reply.muting : undefined
            const answer = muted ?? reply.spoken
            // Held back as it could give a secret away, it's kept and logged nowhere: whether it is, is known before either.
            const withheld = reply.intent === "send" && (yield* options.withholds(update, plain(reply.message)))
            yield* Effect.logInfo(withheld ? "Heard something to send that could give a secret away, so it's held back" : `Heard: ${heard}`)
            yield* Effect.logInfo(`Reply: ${reply.intent}${answer === "" ? "" : `, saying: ${answer}`}`)
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
                said: answer,
                ...(withheld ? {} : { text: heard }),
                detail: {
                  intent: reply.intent,
                  ...(reply.message === "" || withheld ? {} : { message: reply.message }),
                  // What may have been its own voice in his words, kept with them for whatever reads them back.
                  ...(echo === undefined || withheld ? {} : { echo, ...(afterPause === "" ? {} : { afterPause }) }),
                  ...(withheld ? { withheld } : {}),
                },
              })
              yield* options.replied
            }

            if (reply.intent === "dismiss") {
              if (doubted) return false
              if (pickUp()) continue
              return true
            }
            if (reply.intent === "resume") {
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
            // Over an update that needs him, before all of it was said, what he changed is said, then it carries on from where it stopped.
            if (reply.intent === "mute" && update.needsYou && !after && path === update.audio) resume = Math.max(from, outcome.at - rewind)
            text = reply.intent === "send" ? yield* pass(update, reply) : answer
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
            }
            else {
              path = join(options.dir, `${crypto.randomUUID()}${extension}`)
              rendered.push(path)
              yield* voice.render(text, path)
            }
            yield* options.saying(update, text)
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
     * breaks off.
     */
    const exchange = (said: Omit<Question, "answer">, respond: Question["answer"], wait: Duration.DurationInput) =>
      Effect.gen(function* () {
        const ear = hearing(yield* Effect.scope)
        // Listening for its options, if it has any, all of what he says back, however long he goes on.
        const hear = (audio: Float32Array) => transcribe(audio, said.terms)
        let from = 0
        let missed = 0
        let begun = said.saying ?? Effect.void
        let confirmed = said.confirmed ?? Effect.void
        /** As for an update, the line's length when it listens on once after its own voice as it ended. */
        let ended: number | undefined
        let lingered = false
        while (true) {
          // As for an update, past so much talk that wasn't meant for yapd, the rest plays through whatever's said, listening only for "Mute.".
          const heeding = missed >= misses
          const outcome: Outcome =
            ended === undefined
              ? yield* speak(said.audio, said.spoken, from, heeding ? heedful(ear) : ear, { wait, begun, confirmed, through: said.through ?? Effect.void, heeding })
              : yield* harken(said.spoken, ended, ear, wait)
          ended = undefined
          begun = Effect.void
          confirmed = Effect.void
          if (outcome._tag === "Finished") return false
          const first = yield* hear(outcome.audio)
          // Nothing heard over its first seconds is its own voice, no answer, nor talk that wasn't meant for yapd.
          const { itself, echo, unsure } = whose(outcome, first)
          // What it hadn't said yet when he began, a moment before, so what he could have heard of it is known, like a question's options:
          // never from where it stopped, which takes him for having heard what it said as he was already talking. Nothing once all of it was.
          const left = outcome.at < outcome.duration ? unsaid(said.spoken, Math.max(0, outcome.onset - reaction) / outcome.duration) : ""
          const settled =
            itself || first === ""
              ? undefined
              : yield* settle(outcome.ear, first, outcome.audio, hear, !unsure, echo, (heard, voiced, afterPause, halt) =>
                  halt
                    ? Effect.succeed(Option.none<Effect.Effect<void>>())
                    : respond(heard, voiced, echo, echo === undefined || afterPause === "" ? undefined : afterPause, left === "" ? undefined : left),
                )
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
            ended = outcome.duration
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
     * it or right after, for as long as after an update, since it's what they
     * asked to hear rather than something they're asked. Returns whether they
     * followed it up, and fails when it can't be played or breaks off.
     */
    const answer = (said: Answer) => exchange(said, said.followUp, linger)

    /**
     * Says something of yapd's own that nothing he'd say over it has anywhere
     * to go, like a notice: it plays through whatever's said, ducked while
     * he talks, listening only for "Mute.", over it and the usual moment
     * after it, so its `through` runs as soon as it's said to the end. Fails
     * when it can't be played or breaks off.
     */
    const tell = (said: Pick<Answer, "audio" | "spoken" | "saying" | "confirmed" | "through">) =>
      Effect.gen(function* () {
        const ear = heedful(hearing(yield* Effect.scope))
        yield* speak(said.audio, said.spoken, 0, ear, {
          begun: said.saying ?? Effect.void,
          confirmed: said.confirmed ?? Effect.void,
          through: said.through ?? Effect.void,
          heeding: true,
          ducks: true,
        })
      }).pipe(Effect.scoped)

    return {
      converse,
      ask,
      answer,
      tell,
      /** Whether a follow-up to the session, or this particular update, is on its way. */
      sending: (session: string, update?: Update) => Effect.sync(() =>
        update === undefined ? [...sending.keys()].some((update) => update.session === session) : sending.has(update),
      ),
    }
  })
