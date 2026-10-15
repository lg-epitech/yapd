import { Cause, Chunk, Clock, Context, Deferred, Effect, Either, Fiber, FiberSet, Layer, Option, PubSub, Queue, Scope, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Audio, tone, wav } from "./Audio.ts"
import { defaults } from "./Endpointer.ts"
import * as Floor from "./Floor.ts"
import { dated } from "./Latency.ts"
import { Shortcut } from "./Shortcut.ts"
import { DictationTranscriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { extension, Voice } from "./Voice.ts"

// Dictating new work: the user presses the shortcut, talks for as long as they
// like, pausing to think, and presses it again to send. Updates wait meanwhile.
// It ends at what they said, or at nothing; what's done with it is up to
// whoever listens.

/**
 * A press of the shortcut that starts a dictation, by the number its
 * transcript carries, and how many times yapd had been turned on or off by
 * then, so whoever takes it in can tell it was said before yapd was turned
 * off, however late it's handed on.
 */
export interface Press {
  readonly press: number
  readonly turns: number
  /** When the shortcut was pressed, however late whoever gets ready for it gets to it. */
  readonly began: number
}

/** How many times yapd has been turned on or off by now, which each press keeps. */
export class Turns extends Context.Tag("yapd/Turns")<Turns, Effect.Effect<number>>() {}

/** Whether what was dictated is handed on at once, ahead of those before it still being heard, like "Mute." while yapd is on. */
export class Ahead extends Context.Tag("yapd/Ahead")<Ahead, (heard: string) => Effect.Effect<boolean>>() {}

export class Dictation extends Context.Tag("yapd/Dictation")<
  Dictation,
  {
    /** Each press of the shortcut that starts a dictation, as it starts. */
    readonly presses: Stream.Stream<Press>
    /**
     * What the user said, each time a dictation ends, in the order they said
     * it, but for what goes `Ahead`, with how many seconds of it was speech,
     * when they stopped talking, however long it took to hear, and the press
     * it began with: nothing when it came to nothing, like one cancelled or
     * one that failed, so whoever waited on it knows it's over.
     */
    readonly transcripts: Stream.Stream<Press & { readonly heard: string; readonly voiced: number; readonly at: number }>
    /** Drops every dictation not handed on yet, without a sound, like when yapd is turned off. */
    readonly drop: Effect.Effect<void>
  }
>() {}

/** A dictation left running, like when the user walked away, is dropped after this. */
const longest = "5 minutes"

/** Samples in each frame the microphone sends, 32 ms of 16 kHz. */
const frameLength = 512
/** Seconds in each frame. */
const perFrame = frameLength / 16000
/** Frames Whisper hears at once, just under its 30 seconds. */
const whole = Math.floor((29 * 16000) / frameLength)
/** Frames kept either side of speech, so no word is clipped. */
const margin = defaults.lead

export type Span = readonly [start: number, end: number]

/**
 * Splits a dictation, one flag per frame for whether it's speech, into windows
 * Whisper can take whole, each a few stretches of speech with the silence
 * between left out: Whisper fills long silence with words nobody said. Only a
 * stretch too long for one window on its own is cut.
 */
export const windows = (voiced: ReadonlyArray<boolean>, longest = whole, around = margin): Array<Array<Span>> => {
  const spans: Array<[number, number]> = []
  voiced.forEach((speech, frame) => {
    if (!speech) return
    const start = Math.max(0, frame - around)
    const end = Math.min(voiced.length, frame + 1 + around)
    const last = spans.at(-1)
    if (last !== undefined && start <= last[1]) last[1] = end
    else spans.push([start, end])
  })
  const packed: Array<Array<Span>> = []
  let length = 0
  for (const [start, end] of spans) {
    for (let from = start; from < end; ) {
      // At the last breath in the second half, if there is one, rather than mid-word.
      let to = Math.min(end, from + longest)
      const breath = to < end ? voiced.lastIndexOf(false, to - 1) : -1
      if (breath > from + longest / 2) to = breath
      const span: Span = [from, to]
      const size = to - from
      from = to
      if (packed.length > 0 && length + size <= longest) {
        packed.at(-1)!.push(span)
        length += size
      } else {
        packed.push([span])
        length = size
      }
    }
  }
  return packed
}

/** The frames of a window, as one stretch of audio. */
const gather = (frames: ReadonlyArray<Float32Array>, spans: ReadonlyArray<Span>) => {
  const audio = new Float32Array(spans.reduce((length, [start, end]) => length + (end - start) * frameLength, 0))
  let offset = 0
  for (const [start, end] of spans) {
    for (const frame of frames.slice(start, end)) {
      audio.set(frame, offset)
      offset += frame.length
    }
  }
  return audio.subarray(0, offset)
}

/** Two short notes, rising to start, rising higher once sent, falling when cancelled. */
const cues = {
  started: [
    [660, 0.07],
    [880, 0.09],
  ],
  sent: [
    [880, 0.07],
    [1320, 0.11],
  ],
  cancelled: [
    [660, 0.07],
    [440, 0.11],
  ],
} as const

type End = "Sent" | "Cancelled"

/** How a dictation ended, and when: the press that ended it, however long anything before it took. */
interface Ending {
  readonly end: End
  readonly at: number
}

/** What a dictation that came to nothing hands on. */
const silence = { text: "", voiced: 0 }

/**
 * Records the user from the shortcut to the next press, through the helper's
 * microphone, whose echo cancellation keeps yapd's own sounds out, and
 * transcribes it once sent. The speaker is theirs meanwhile: an update being
 * read stops, and it and any others are read afterwards.
 */
export const WhisperDictation = Layer.scoped(
  Dictation,
  Effect.gen(function* () {
    const shortcut = yield* Shortcut
    const audio = yield* Audio
    const vad = yield* Vad
    const transcriber = yield* DictationTranscriber
    const voice = yield* Voice
    const turns = yield* Turns
    const ahead = yield* Ahead
    const device = Floor.use(yield* Floor.Floor, audio)
    const scope = yield* Effect.scope
    /** Each with how many times dictations were dropped before it was sent, so one handed on just before isn't taken in after. */
    const transcripts = yield* PubSub.unbounded<Press & { readonly heard: string; readonly voiced: number; readonly at: number; readonly drops: number }>()
    /** Likewise each press that starts one. */
    const presses = yield* PubSub.unbounded<Press & { readonly drops: number }>()
    const dictations = yield* FiberSet.make()
    let drops = 0
    let pressed = 0
    /** Whether a dictation was heard since yapd started, which loaded the model for it. */
    let heardOnce = false

    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "yapd-dictation-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    )
    const sound = (name: string) => join(dir, `${name}.wav`)
    yield* Effect.promise(() => Promise.all(Object.entries(cues).map(([name, notes]) => Bun.write(sound(name), wav(tone(notes))))))

    /** Plays to the end, which also opens the microphone. A cue that won't play isn't worth stopping for. */
    const cue = (name: keyof typeof cues) =>
      audio.play(sound(name)).pipe(
        Effect.flatMap((playback) => playback.finished),
        Effect.scoped,
        Effect.ignore,
      )

    const say = (text: string) =>
      Effect.gen(function* () {
        const path = join(dir, `${crypto.randomUUID()}${extension}`)
        yield* voice.render(text, path).pipe(
          Effect.zipRight(
            audio.play(path).pipe(Effect.flatMap((playback) => playback.finished), Effect.scoped, device),
          ),
          Effect.ensuring(Effect.promise(() => rm(path, { force: true }))),
        )
      }).pipe(Effect.catchAll((error) => Effect.logWarning(`Could not say "${text}"`, error)))

    /** Ends a dictation from this side, unless the shortcut has moved on to the next one. */
    const cancel = (ended: Deferred.Deferred<Ending>) => Effect.suspend(() => (ending === ended ? shortcut.cancel : Effect.void))

    /** Each window on its own, since Whisper only hears 30 seconds. Empty when there was no speech. */
    const transcribe = (frames: ReadonlyArray<Float32Array>, voiced: ReadonlyArray<boolean>) =>
      Effect.gen(function* () {
        if (voiced.filter(Boolean).length < defaults.confirm) return ""
        const heard: Array<string> = []
        for (const spans of windows(voiced)) heard.push(yield* transcriber.transcribe(gather(frames, spans)))
        return heard.filter((text) => text !== "").join(" ")
      })

    /**
     * Logs how long a dictation sent at `at` took to hear, with none of its
     * words: in how many windows, how much of it was speech, how long after his
     * last word he pressed, and whether it was the first since the model loaded.
     */
    const timed = (voiced: ReadonlyArray<boolean>, at: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const count = voiced.filter(Boolean).length < defaults.confirm ? 0 : windows(voiced).length
        const last = voiced.lastIndexOf(true)
        const first = !heardOnce
        heardOnce = true
        yield* Effect.logInfo(
          `Dictation: ${count} ${count === 1 ? "window" : "windows"}, ${(voiced.filter(Boolean).length * perFrame).toFixed(1)} s of speech, ${
            last === -1 ? "no word" : `${((voiced.length - 1 - last) * perFrame).toFixed(1)} s from the last word to the press`
          }, heard in ${((now - at) / 1000).toFixed(1)} s${first ? ", first since load" : ""} ${dated(now)}`,
        )
      })

    /**
     * From the first sound until the microphone is off, holding the speaker and
     * microphone, so the next dictation waits for them rather than have this one
     * turn its microphone off. Nothing without a microphone.
     */
    const record = (ended: Deferred.Deferred<Ending>, scope: Scope.Scope) =>
      Effect.gen(function* () {
        yield* cue("started")
        const microphone = yield* audio.microphone
        if (Option.isNone(microphone)) return undefined
        yield* Effect.logInfo("Dictating")

        // Until the voice detector has loaded, everything counts as speech.
        const detect = yield* Effect.option(vad.make)
        const frames: Array<Float32Array> = []
        const voiced: Array<boolean> = []
        const pending = yield* Queue.unbounded<Option.Option<Float32Array>>()
        yield* Scope.addFinalizer(scope, Queue.shutdown(pending))
        // Detection can lag behind capture. It keeps its own turn after sending,
        // while the microphone is already free for the next dictation.
        const classified = yield* Stream.fromQueue(pending).pipe(
          Stream.takeWhile(Option.isSome),
          Stream.filterMap((frame) => frame),
          Stream.runForEach((frame) =>
            Option.match(detect, {
              onNone: () => Effect.succeed(1),
              onSome: (detect) => Effect.orElseSucceed(detect(frame), () => 1),
            }).pipe(Effect.map((probability) => void voiced.push(probability >= defaults.on))),
          ),
          Effect.forkIn(scope),
        )
        const capture = (waiting: Iterable<Float32Array>) =>
          Effect.sync(() => {
            for (const frame of waiting) {
              frames.push(frame)
              Queue.unsafeOffer(pending, Option.some(frame))
            }
          })
        // Once a chunk leaves the microphone queue, it belongs to the recording,
        // even if sending interrupts capture before the next chunk arrives.
        const recording = yield* Effect.uninterruptibleMask((restore) =>
          restore(Queue.takeBetween(microphone.value, 1, 64)).pipe(Effect.flatMap(capture)),
        ).pipe(
          Effect.forever,
          Effect.fork,
        )
        const sent = yield* Deferred.await(ended).pipe(Effect.timeoutOption(longest))
        // When it was said, which is what it can be about: the press that sent it, however long the voice detector took to load
        // or it then takes to hear, or now, for one that went on too long.
        const { end, at }: { readonly end: End | "Expired"; readonly at: number } = Option.isSome(sent)
          ? sent.value
          : { end: "Expired", at: yield* Clock.currentTimeMillis }
        yield* Fiber.interrupt(recording)
        if (end === "Sent") {
          // Also keep frames the helper had delivered before the capture fiber stopped.
          yield* Queue.takeAll(microphone.value).pipe(
            Effect.catchAllCause((cause) =>
              Queue.isShutdown(microphone.value).pipe(
                Effect.flatMap((shutdown) => (shutdown ? Effect.succeed(Chunk.empty<Float32Array>()) : Effect.failCause(cause))),
              ),
            ),
            Effect.flatMap(capture),
          )
          yield* Queue.offer(pending, Option.none())
        } else yield* Fiber.interrupt(classified)
        if (end === "Expired") yield* cancel(ended)
        if (end !== "Sent") {
          yield* cue("cancelled")
          return { end, heard: undefined, at }
        }
        // Transcribing starts as the cue plays rather than after it, which only says it was sent.
        const heard = yield* Fiber.join(classified).pipe(
          Effect.flatMap(() => Effect.map(transcribe(frames, voiced), (text) => ({ text, voiced: voiced.filter(Boolean).length * perFrame }))),
          Effect.tap(() => timed(voiced, at)),
          Effect.forkIn(scope),
        )
        yield* cue("sent")
        return { end, heard, at }
      }).pipe(Effect.scoped, device)

    /**
     * What a dictation came to, once recorded: the words, or nothing, after
     * saying why. One that failed came to nothing too, which is passed on like
     * the rest, so whoever waits on its press knows it's over.
     */
    const hear = (ended: Deferred.Deferred<Ending>) =>
      Effect.gen(function* () {
        const recorded = yield* record(ended, yield* Effect.scope)
        const nothing = { ...silence, at: recorded?.at ?? (yield* Clock.currentTimeMillis) }
        if (recorded === undefined) {
          yield* cancel(ended)
          return yield* Effect.as(say("I can't hear you, the microphone is off."), nothing)
        }
        if (recorded.end === "Expired") {
          yield* Effect.logInfo("Dictation dropped after five minutes")
          return yield* Effect.as(say("I stopped listening after five minutes, and dropped that."), nothing)
        }
        if (recorded.heard === undefined) return yield* Effect.as(Effect.logInfo("Dictation cancelled"), nothing)
        const heard = yield* Fiber.join(recorded.heard).pipe(
          Effect.tapError((error) => Effect.logWarning("Could not transcribe the dictation", error)),
          Effect.either,
        )
        if (Either.isLeft(heard)) {
          const error = heard.left
          if (error._tag === "TranscribeError") return yield* Effect.as(say("Sorry, I couldn't make that out."), nothing)
          // Without a model to hear it, saying it again at once wouldn't help, so they're told what would.
          return yield* Effect.as(
            say(
              error.loading
                ? "The model for dictation is still downloading. Try again in a minute."
                : "I couldn't load the model for dictation, so I didn't hear that. I'll try again the next time you dictate.",
            ),
            nothing,
          )
        }
        if (heard.right.text === "") return yield* Effect.as(say("I didn't catch anything."), nothing)
        return { ...heard.right, at: recorded.at }
      }).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("Dictation failed", cause).pipe(
                Effect.zipRight(cancel(ended)),
                Effect.zipRight(Effect.map(Clock.currentTimeMillis, (at) => ({ ...silence, at }))),
              ),
        ),
      )

    /**
     * `before` is done once the dictation before this one has been dealt with,
     * which a long one can be after a short one that followed it: what they
     * said is passed on in the order they said it, since one can build on
     * another. What goes `ahead`, like "Mute." while yapd is on, is passed on
     * at once, never waiting for those before it, which turning off then
     * drops; those after it still wait for them.
     */
    const dictate = (press: Press, ended: Deferred.Deferred<Ending>, before: Deferred.Deferred<void> | undefined, done: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        // While they talk, which is plenty of time.
        yield* Effect.forkIn(transcriber.prepare, scope)
        yield* Floor.take
        const heard = yield* hear(ended)
        const earlier = before === undefined ? Effect.void : Deferred.await(before)
        if (!(yield* ahead(heard.text))) yield* earlier
        yield* PubSub.publish(transcripts, { ...press, heard: heard.text, voiced: heard.voiced, at: heard.at, drops })
        yield* earlier
      }).pipe(
        Effect.ensuring(Deferred.succeed(done, undefined)),
        Effect.scoped,
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.void
            : Effect.logError("Dictation failed", cause).pipe(Effect.zipRight(cancel(ended))),
        ),
      )

    let ending: Deferred.Deferred<Ending> | undefined
    let last: Deferred.Deferred<void> | undefined
    yield* shortcut.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event._tag === "Started") {
            const press: Press = { press: ++pressed, turns: yield* turns, began: yield* Clock.currentTimeMillis }
            const ended = yield* Deferred.make<Ending>()
            const done = yield* Deferred.make<void>()
            const before = last
            ending = ended
            last = done
            yield* PubSub.publish(presses, { ...press, drops })
            return yield* FiberSet.run(dictations, dictate(press, ended, before, done))
          }
          if (ending !== undefined) yield* Deferred.succeed(ending, { end: event._tag, at: yield* Clock.currentTimeMillis })
          ending = undefined
        }),
      ),
      Effect.forkScoped,
    )

    return {
      presses: Stream.fromPubSub(presses).pipe(Stream.filterMap(({ drops: before, ...press }) => (before === drops ? Option.some(press) : Option.none()))),
      transcripts: Stream.fromPubSub(transcripts).pipe(
        Stream.filterMap(({ drops: before, ...transcript }) => (before === drops ? Option.some(transcript) : Option.none())),
      ),
      // Without waiting for them to stop, since nothing they do after can reach anyone.
      drop: Effect.suspend(() => {
        drops++
        return Effect.forEach([...dictations], Fiber.interruptFork, { discard: true })
      }),
    }
  }),
)
