import { Clock, type Duration, Effect, Fiber, Option, Queue, Scope, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, AudioError, type Playback } from "./Audio.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, RelayError, type Thread } from "./Relay.ts"
import { Journal } from "./Journal.ts"
import { Persona } from "./Persona.ts"
import { enough, gist, hallucinated, type Line, type Reply, Responder } from "./Responder.ts"
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
  readonly spoken: string
  readonly audio: string
  readonly thread: Thread
  /** When its turn stopped. */
  readonly at: number
}

type Signal =
  | Exclude<Endpointer.Event, { readonly _tag: "Onset" }>
  /** Might be the user, or with `echo`, yapd's own voice getting into the microphone, as it can until the echo cancellation has learnt it. */
  | { readonly _tag: "Onset"; readonly echo: boolean }
  /** All the user has said so far of what may be yapd's own voice, passed on as it goes, so he needn't finish before it's told apart. */
  | { readonly _tag: "Partial"; readonly audio: Float32Array }
  /** The microphone stopped, like when the helper quits. */
  | { readonly _tag: "Deaf" }
  /** The rest carry the id of what sent them, so one that's no longer waited on is let go. */
  | { readonly _tag: "Finished"; readonly id: number }
  /** The playback broke off, like when the audio helper quits: what it played wasn't heard to the end. */
  | { readonly _tag: "Broke"; readonly id: number; readonly error: AudioError }
  | { readonly _tag: "Lingered"; readonly id: number }
  /** The reply is whatever the one who asked for it works out: what to do about an update, or an answer to a question. */
  | { readonly _tag: "Replied"; readonly id: number; readonly reply: unknown }
  /** What was made of what may have been yapd's own voice: the words, and whether they were his. */
  | { readonly _tag: "Looked"; readonly id: number; readonly heard: string; readonly his: boolean }

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
      /** What was made of it already, when it had to be before yapd stopped for it, since it may have been its own voice. */
      readonly heard?: string
    }

/** Something the user said over a line, kept in order while what came before it may yet turn out to be yapd's own voice. */
interface Talk {
  /** What passes on what was made of it, when it had to be. */
  readonly id: number
  readonly audio: Float32Array
  /** Whether it was him, unknown while it's being made out. */
  his: boolean | undefined
  heard: string | undefined
}

/** How long the microphone stays open after yapd stops, for a reply to what it just said. */
const linger: Duration.DurationInput = "3 seconds"
/** Longer after a question, which takes a moment's thought to answer. */
const pondering: Duration.DurationInput = "8 seconds"
/** Longer than the longest utterance, so only a microphone that went quiet trips it. */
const patience = "40 seconds"
/** Volume while it's still unclear whether the user is talking. */
const ducked = 0.25
/** How far back to pick up after talk that wasn't meant for yapd. */
const rewind = 1.5
/** Talk that wasn't meant for yapd, after which the rest of an update plays without listening, say for a TV. */
const misses = 3
/** How long to wait for the rest when the user trails off, before working out a reply. */
const hesitation = "3 seconds"
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

/** The part of `text` heard in `fraction` of its audio, marked when it's cut short. */
export const cut = (text: string, fraction: number) => {
  if (fraction >= 1) return text
  const words = text.split(/\s+/)
  return `${words.slice(0, Math.max(1, Math.round(words.length * fraction))).join(" ")}…`
}

/** Frames of what may be yapd's own voice between each look at all of it so far, while it goes on: about a second. */
const glance = Math.round(rate / frame)

/** Seconds either side of the user talking that yapd's words are looked for in what he said, since where each falls in a line is only guessed. */
const reach = 2

/** What Whisper makes of yapd's own voice getting into the microphone, or of near-silence, which nobody said. */
const madeUp: ReadonlySet<string> = new Set([
  ...hallucinated, "verse", "end of song", "the end", "music", "thank you for watching", "thank you very much", "thank you so much",
  "thanks for listening", "please subscribe", "bye bye", "see you next time",
])

/** The words of `text` said between `start` and `end` seconds into its `duration`, as far as that can be told from where they fall in it. */
export const between = (text: string, duration: number, start: number, end: number) => {
  if (duration <= 0) return text
  const words = text.split(/\s+/).filter((word) => word !== "")
  return words.slice(Math.max(0, Math.floor((words.length * start) / duration)), Math.max(0, Math.ceil((words.length * end) / duration))).join(" ")
}

/** A word as it's matched, so "tests" is "test" and "it's" is "it", but "is" is still "is". */
const stem = (word: string) => {
  const stemmed = word.replace(/'s$/, "")
  return stemmed.length > 3 ? stemmed.replace(/s$/, "") : stemmed
}

/** Whether Whisper may have heard one word as the other, like "codecs" for "Codex", or "yap" for "yapd". */
const alike = (one: string, other: string) => {
  const [first, second] = [stem(one), stem(other)]
  let shared = 0
  while (shared < first.length && shared < second.length && first[shared] === second[shared]) shared++
  return first === second || shared >= 4 || (shared >= 3 && shared === Math.min(first.length, second.length))
}

/**
 * How many of the words heard over a line yapd had only just started are the
 * user's own, rather than its voice getting into the microphone before the echo
 * cancellation has learnt it: none when there are none, or only what Whisper
 * makes up, or when no more of them are his than are words yapd was `saying`
 * then, as near as Whisper heard them. A "stop", on its own or said over
 * those, is always his.
 */
export const theirs = (heard: string, saying: string) => {
  const words = heard
    .split(/[.!?]+/)
    .map(gist)
    .filter((sentence) => sentence !== "" && !madeUp.has(sentence))
    .flatMap((sentence) => sentence.split(" "))
    // Single letters, like the "D" of "yap D", are as likely either's.
    .filter((word) => word.length > 1)
  // With its names, which Whisper hears wrong more than anything yapd says.
  const yapd = saying.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter((word) => word !== "")
  const own = words.filter((word) => !yapd.some((said) => alike(word, said)))
  if (enough.has(words.join(" "))) return words.length
  if (enough.has(own.join(" "))) return own.length
  return own.length > words.length - own.length ? own.length : 0
}


/** Something yapd asks the user for itself, like which project new work is for, rendered and ready to be asked. */
export interface Question {
  readonly audio: string
  /** What it says, so its own voice getting into the microphone as it starts isn't taken for an answer. */
  readonly spoken?: string
  /** Run once it starts playing the first time, which is when the user hears of it: never when it can't be played. */
  readonly saying?: Effect.Effect<void>
  /** Like `saying`, but once it's known to be playing, which with afplay is only once it has played to the end. */
  readonly confirmed?: Effect.Effect<void>
  /**
   * Works out what the user meant by what they said, and how many seconds of
   * it were speech, which may be called again with all of it if they carry
   * on. What it returns is run once they've stopped, and none means it
   * wasn't an answer.
   */
  readonly answer: (heard: string, voiced: number) => Effect.Effect<Option.Option<Effect.Effect<void>>>
}

/**
 * Reads updates out while listening. Talking over yapd ducks it at once and
 * stops it once it's clearly speech, or, while its own voice can still get into
 * the microphone, once Whisper has made out that it's the user; what the user
 * said then decides whether it stops there, answers, sends the agent a
 * follow-up, or carries on.
 */
export const make = (options: {
  readonly dir: string
  /** Whether unrelated activity has made the update stale. */
  readonly moved: (update: Update) => Effect.Effect<boolean>
  /** Delivers the follow-up, or queues it until the session can receive it, using its latest thread. */
  readonly send: (update: Update, message: string) => Effect.Effect<"sent" | "queued", RelayError>
  /** Says how a follow-up went when the update it answers was cut off before yapd could, noting it with the persona once it plays. */
  readonly late: (update: Update, spoken: string, failed: boolean) => Effect.Effect<void>
  /** Something was said over an update and taken in, which takes the place of whatever yapd asked before. */
  readonly replied: Effect.Effect<void>
  /** yapd starts saying something back over an update, like an answer or word of a follow-up, which is then what the user heard last. */
  readonly saying: (update: Update, line: string) => Effect.Effect<void>
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

    /** Starts listening, if there's a microphone. That's only known once something plays. */
    const open = (scope: Scope.Scope) =>
      Effect.gen(function* () {
        const detect = yield* vad.make.pipe(Effect.option)
        if (Option.isNone(detect)) return undefined
        const microphone = yield* audio.microphone.pipe(Scope.extend(scope))
        if (Option.isNone(microphone)) return undefined
        const ear: Ear = { signals: yield* Queue.unbounded<Signal>(), deaf: false }
        const endpointer = new Endpointer.Endpointer()
        /** Whether what's being said began while yapd's own voice could still get into the microphone. */
        let unsure = false
        /** Frames of that since all of it was last passed on, once it's speech. */
        let since: number | undefined
        yield* Stream.fromQueue(microphone.value).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              const event = endpointer.push(frame, yield* detect.value(frame))
              if (event === undefined) {
                if (since === undefined || ++since < glance) return undefined
                since = 0
                return { _tag: "Partial", audio: endpointer.soFar() } satisfies Signal
              }
              switch (event._tag) {
                case "Onset":
                  // As it starts, since by the time it's made out, yapd may well have learnt its own voice.
                  unsure = yield* audio.echoing
                  return { _tag: "Onset", echo: unsure } satisfies Signal
                case "Speech":
                  since = unsure ? 0 : undefined
                  return event
                default:
                  unsure = false
                  since = undefined
                  return event
              }
            }),
          ),
          Stream.runForEach((signal) => (signal === undefined ? Effect.void : Queue.offer(ear.signals, signal))),
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
     * Plays a line from `from` seconds, listening if there's an ear, then
     * `wait` longer for a reply. `text` is what it says, which tells yapd's own
     * voice getting into the microphone from the user. `begun` runs once it's
     * playing, never when it can't be played, `confirmed` once it's known to
     * be, which with afplay is only once it has played to the end, and
     * `through` once it has, before that wait: the user has heard it, whatever
     * they say after.
     */
    const speak = (
      path: string,
      from: number,
      ear: Effect.Effect<Ear | undefined>,
      given: {
        readonly text?: string
        readonly wait?: Duration.DurationInput
        readonly begun?: Effect.Effect<void>
        readonly confirmed?: Effect.Effect<void>
        readonly through?: Effect.Effect<void>
      } = {},
    ) =>
      Effect.gen(function* () {
        const { text = "", wait = linger, begun = Effect.void, confirmed = Effect.void, through = Effect.void } = given
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
        return yield* listen(playback, listening, { text, from }, wait, played)
      }).pipe(Effect.scoped)

    /**
     * Listens over a line, `text` played from `from` seconds, and stops it as
     * soon as the user talks over it. Talk that begins while yapd's own voice
     * can still get into the microphone may be just that, so yapd carries on
     * over it until Whisper has made out that it's him, and lets it go when
     * it isn't.
     */
    const listen = (
      playback: Playback,
      ear: Ear,
      line: { readonly text: string; readonly from: number },
      wait: Duration.DurationInput,
      through: Effect.Effect<void>,
    ) =>
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
        /**
         * Talk that began while yapd's own voice could still get into the
         * microphone, until it ends: how far into the line it began, whether a
         * look at it so far found it's him, and the look under way.
         */
        let doubt: { readonly at: number; his: boolean; looking: number | undefined } | undefined
        /** Talk that ended while some of it is still being made out, in the order it was said, so none of his is lost or put out of order. */
        const pending: Array<Talk> = []
        /** One look at a time, so Whisper never works on two at once. */
        const whisper = yield* Effect.makeSemaphore(1)
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
        const position = Effect.map(Clock.currentTimeMillis, (now) => stoppedAt ?? Math.min(playback.duration, line.from + (now - began) / 1000))
        /** Stops yapd for him to speak. */
        const halt = Effect.gen(function* () {
          playing = false
          cut = true
          stoppedAt = yield* playback.stop
        })
        /**
         * Makes out what may have been yapd's own voice, begun `at` seconds into
         * the line, without holding up playing or listening, and passes on
         * whether it was him, which takes at least `least` words of his own.
         * Returns the id it's passed on with.
         */
        const look = (audio: Float32Array, at: number, least: number) =>
          Effect.gen(function* () {
            const id = fresh()
            const saying = between(line.text, playback.duration, at - reach, (yield* position) + reach)
            yield* transcriber.transcribe(audio).pipe(
              Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))),
              whisper.withPermits(1),
              Effect.flatMap((heard) => Queue.offer(signals, { _tag: "Looked", id, heard, his: theirs(heard, saying) >= least })),
              Effect.forkScoped,
            )
            return id
          })
        const interrupted = (audio: Float32Array, heard: string | undefined): Outcome => ({
          _tag: "Interrupted",
          at: stoppedAt ?? playback.duration,
          duration: playback.duration,
          audio,
          ear,
          ...(heard === undefined ? {} : { heard }),
        })
        /**
         * What he said over the line, once none of it is still being made out
         * and he's finished whatever he went on to say: none until then, nor
         * when it was all yapd's own voice, which is let go.
         */
        const heardOut = () => {
          if (pending.some((talk) => talk.his === undefined)) return undefined
          if (speaking && !deaf && pending.some((talk) => talk.his === true)) return undefined
          const his = pending.splice(0).filter((talk) => talk.his === true)
          if (his.length === 0) return undefined
          // Each made out on its own, unless there's more than one, which Whisper then hears together.
          return his.length === 1 ? interrupted(his[0]!.audio, his[0]!.heard) : interrupted(Endpointer.concat(his.map((talk) => talk.audio)), undefined)
        }
        /** How it ends once the microphone has gone and nothing's left to make out: not yet while it's still playing. */
        const deafened = Effect.gen(function* () {
          if (broken !== undefined) return yield* Effect.fail(broken)
          // Stopped for him to speak, and gone deaf before he'd finished, it was never heard to the end, nor what he said.
          if (cut && !completed) return yield* Effect.fail(new AudioError({ message: "The microphone went away while he was talking over it" }))
          return playing ? undefined : ({ _tag: "Finished" } satisfies Outcome)
        })

        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              speaking = true
              yield* stopLingering
              // Over what may be its own voice, it carries on just as it was until it's made out that it isn't.
              if (signal.echo) doubt = { at: yield* position, his: false, looking: undefined }
              else if (playing) yield* playback.volume(ducked)
              break
            case "Speech":
              yield* stopLingering
              if (playing && doubt === undefined) yield* halt
              break
            case "Partial":
              // One look at a time, while there's still something to stop for him.
              if (doubt === undefined || doubt.his || doubt.looking !== undefined || !playing) break
              // Two words of his at least, since Whisper can make one up of a stretch cut off mid-word.
              doubt.looking = yield* look(signal.audio, doubt.at, 2)
              break
            case "Abandoned": {
              speaking = false
              const doubted = doubt !== undefined
              doubt = undefined
              const heard = heardOut()
              if (heard !== undefined) return heard
              if (playing) {
                if (!doubted) yield* playback.volume(1)
              } else if (pending.length === 0) yield* startLingering
              break
            }
            case "Utterance": {
              speaking = false
              const doubted = doubt
              doubt = undefined
              if (doubted !== undefined && !doubted.his) {
                pending.push({ id: yield* look(signal.audio, doubted.at, 1), audio: signal.audio, his: undefined, heard: undefined })
                break
              }
              if (pending.length === 0) return interrupted(signal.audio, undefined)
              // Said after what's still being made out, it waits for that, so what he said stays in order.
              pending.push({ id: fresh(), audio: signal.audio, his: true, heard: undefined })
              const heard = heardOut()
              if (heard !== undefined) return heard
              break
            }
            case "Looked": {
              if (doubt !== undefined && doubt.looking === signal.id) {
                doubt.looking = undefined
                if (!signal.his) break
                yield* Effect.logInfo(`Stopping for him: ${signal.heard}`)
                doubt.his = true
                if (playing) yield* halt
                break
              }
              const looked = pending.find((talk) => talk.id === signal.id)
              if (looked === undefined) break
              looked.his = signal.his
              looked.heard = signal.heard
              yield* Effect.logInfo(signal.his ? `Heard: ${signal.heard}` : `Carried on over its own voice${signal.heard === "" ? "" : `: ${signal.heard}`}`)
              if (signal.his && playing) yield* halt
              const heard = heardOut()
              if (heard !== undefined) return heard
              // It was all yapd's own voice, so it's as if nothing had been said.
              if (pending.length > 0 || playing || speaking) break
              if (deaf) {
                const ending = yield* deafened
                if (ending !== undefined) return ending
              }
              yield* startLingering
              break
            }
            case "Finished":
              // Heard already, as it finished. Also arrives for a playback the user stopped, which is already dealt with.
              if (signal.id !== id || !playing) break
              playing = false
              // What may have been him decides how it ends, once it's made out.
              if (pending.length > 0) break
              if (deaf) return { _tag: "Finished" } satisfies Outcome
              if (!speaking) yield* startLingering
              break
            case "Broke":
              if (signal.id !== id) break
              // Stopped for him to speak, or with what may have been him still being made out, it waits on what he says, unless nothing comes of it.
              if (!playing || pending.length > 0) {
                if (playing) stoppedAt = yield* position
                playing = false
                broken = signal.error
                break
              }
              // As without a microphone: cut short, it wasn't heard, and there's nothing to wait for a reply to.
              return yield* Effect.fail(signal.error)
            case "Lingered":
              if (signal.id !== lingering?.id) break
              if (broken !== undefined) return yield* Effect.fail(broken)
              return { _tag: "Finished" } satisfies Outcome
            case "Deaf": {
              deaf = true
              const heard = heardOut()
              if (heard !== undefined) return heard
              // What may have been him decides how it ends, once it's made out.
              if (pending.length > 0) break
              const ending = yield* deafened
              if (ending !== undefined) return ending
              yield* playback.volume(1)
              break
            }
            case "Replied":
              break
          }
        }
      })

    /**
     * Works out a reply while still listening, so pausing mid-thought doesn't cut
     * the user off: if they carry on before it's ready, it starts again with all
     * they said, and how many seconds of all of it were speech. Nothing's done
     * with a reply while they might still be talking.
     */
    const settle = <R>(
      ear: Ear,
      first: string,
      audio: Float32Array,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      respond: (heard: string, voiced: number) => Effect.Effect<R>,
    ) =>
      Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + rambling
        let heard = first
        let speech = voiced(audio)
        while (true) {
          const replying = unfinished(heard) ? Effect.zipRight(Effect.sleep(hesitation), respond(heard, speech)) : respond(heard, speech)
          if (ear.deaf || (yield* Clock.currentTimeMillis) > until) return { heard, reply: yield* replying }
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
                if (!speaking) return { heard, reply: signal.reply as R }
                held = signal.reply as R
                break
              case "Onset":
                speaking = true
                break
              case "Abandoned":
                speaking = false
                if (held !== undefined) return { heard, reply: held }
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
                if (held !== undefined) return { heard, reply: held }
                break
              case "Finished":
              case "Broke":
              case "Lingered":
              case "Partial":
              case "Looked":
                break
            }
          }
          yield* Fiber.interrupt(fiber)
          if (more === undefined) continue
          const after = yield* transcribe(more)
          heard = together(heard, after)
          // Only what added words, since speech Whisper made nothing of isn't in what was heard.
          if (after !== "") speech += voiced(more)
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
            result === "queued" ? Effect.succeed(lines.queued) : reply.spoken === "" ? persona.onIt() : Effect.succeed(reply.spoken),
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
        yield* Effect.logInfo(`${result === "queued" ? "Queued" : "Sent"}: ${text}`)
        return result
      })

    const transcribe = (audio: Float32Array) =>
      transcriber.transcribe(audio).pipe(
        Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))),
        Effect.tap((heard) => (heard === "" ? Effect.void : Effect.logInfo(`Heard: ${heard}`))),
      )

    /**
     * Reads an update out and talks it over. `through` runs as soon as the
     * update itself has been read to the end, even with the microphone still
     * open for a reply, since the user has heard it by then.
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

          while (true) {
            const outcome: Outcome = yield* speak(path, from, missed < misses ? ear : Effect.succeed(undefined), {
              text,
              // Noted only once it's known to play, so a line for going ahead that fails to render or play, or that a dictation cuts in before, never counts as the last one he heard.
              confirmed: path === update.audio ? Effect.void : persona.said(text),
              through: path === update.audio ? through : Effect.void,
            })
            if (outcome._tag === "Finished") return
            // Replying to something yapd had finished saying: there's nothing to go back to.
            const after = outcome.at >= outcome.duration
            // Always forward, so talk that keeps coming can't hold an update back forever.
            const carryOn = () => {
              missed++
              from = Math.max(from, outcome.at - rewind)
            }

            const first = outcome.heard ?? (yield* transcribe(outcome.audio))
            if (first === "") {
              if (after) return
              carryOn()
              continue
            }

            const said = cut(text, outcome.duration > 0 ? outcome.at / outcome.duration : 1)
            const { heard, reply } = yield* settle(outcome.ear, first, outcome.audio, transcribe, (heard) =>
              responder
                .respond({
                  project: update.project,
                  turn: update.turn,
                  needsYou: update.needsYou,
                  lines: [...lines, { speaker: "yapd", text: said }],
                  heard,
                })
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.logWarning("Could not reply", error).pipe(
                      Effect.zipRight(persona.lines),
                      Effect.map((lines): Reply => ({ intent: "answer", spoken: lines.misheard, message: "" })),
                    ),
                  ),
                ),
            )
            yield* Effect.logInfo(`Reply: ${reply.intent}${reply.spoken === "" ? "" : `, saying: ${reply.spoken}`}`)
            if (reply.intent !== "resume") {
              yield* journal.write({
                at: yield* Clock.currentTimeMillis,
                kind: "reply",
                host: update.thread.origin.host,
                project: update.project,
                thread: update.session,
                directory: update.thread.cwd,
                said: reply.spoken,
                text: heard,
                detail: { intent: reply.intent, ...(reply.message === "" ? {} : { message: reply.message }) },
              })
              yield* options.replied
            }

            if (reply.intent === "dismiss") return
            if (reply.intent === "resume") {
              if (after) return
              carryOn()
              continue
            }

            lines.push({ speaker: "yapd", text: said }, { speaker: "user", text: heard })
            text =
              reply.intent === "send"
                ? yield* pass(update, reply)
                : reply.spoken
            if (text === "") return
            path = join(options.dir, `${crypto.randomUUID()}${extension}`)
            rendered.push(path)
            yield* voice.render(text, path)
            yield* options.saying(update, text)
            from = 0
            missed = 0
          }
        }).pipe(
          Effect.scoped,
          Effect.ensuring(Effect.promise(() => Promise.all(rendered.map((path) => rm(path, { force: true }))))),
          Effect.annotateLogs({ project: update.project }),
        )
      })

    /**
     * Asks the user something and listens for what they say over it or right
     * after, like with an update. Returns whether they answered, and fails
     * when it can't be played or breaks off.
     */
    const ask = (question: Question) =>
      Effect.gen(function* () {
        const ear = hearing(yield* Effect.scope)
        let from = 0
        let missed = 0
        let begun = question.saying ?? Effect.void
        let confirmed = question.confirmed ?? Effect.void
        while (true) {
          const outcome: Outcome = yield* speak(question.audio, from, missed < misses ? ear : Effect.succeed(undefined), {
            text: question.spoken ?? "",
            wait: pondering,
            begun,
            confirmed,
          })
          begun = Effect.void
          confirmed = Effect.void
          if (outcome._tag === "Finished") return false
          const first = outcome.heard ?? (yield* transcribe(outcome.audio))
          const answer = first === "" ? Option.none() : (yield* settle(outcome.ear, first, outcome.audio, transcribe, question.answer)).reply
          if (Option.isSome(answer)) {
            // They've answered, so it's taken in even if a dictation starts right now.
            yield* Effect.uninterruptible(answer.value)
            return true
          }
          // Talk that wasn't an answer, after the question was asked in full, leaves it unanswered.
          if (outcome.at >= outcome.duration) return false
          missed++
          from = Math.max(from, outcome.at - rewind)
        }
      }).pipe(Effect.scoped)

    return {
      converse,
      ask,
      /** Whether a follow-up to the session, or this particular update, is on its way. */
      sending: (session: string, update?: Update) => Effect.sync(() =>
        update === undefined ? [...sending.keys()].some((update) => update.session === session) : sending.has(update),
      ),
    }
  })
