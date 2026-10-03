import { Cause, Chunk, Context, Deferred, Effect, Either, Fiber, FiberSet, Layer, Option, PubSub, Queue, Scope, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Audio } from "./Audio.ts"
import { defaults } from "./Endpointer.ts"
import * as Floor from "./Floor.ts"
import { Shortcut } from "./Shortcut.ts"
import { DictationTranscriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { extension, Voice } from "./Voice.ts"

// Dictating new work: the user presses the shortcut, talks for as long as they
// like, pausing to think, and presses it again to send. Updates wait meanwhile.
// It ends at what they said; what's done with it is up to whoever listens.

export class Dictation extends Context.Tag("yapd/Dictation")<
  Dictation,
  {
    /** What the user said, each time they send a dictation, in the order they said it. */
    readonly transcripts: Stream.Stream<string>
    /** Drops every dictation not handed on yet, without a sound, like when yapd is turned off. */
    readonly drop: Effect.Effect<void>
  }
>() {}

/** A dictation left running, like when the user walked away, is dropped after this. */
const longest = "5 minutes"

/** Samples in each frame the microphone sends, 32 ms of 16 kHz. */
const frameLength = 512
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

/** Kokoro's rate, which the helper already plays at. */
const rate = 24000
/** Well under yapd's voice. */
const level = 0.12
/** Each note fades in and out over this, so it doesn't click. */
const fade = 0.008

/** Soft sine notes, one after the other. */
export const tone = (notes: ReadonlyArray<readonly [frequency: number, seconds: number]>, sampleRate = rate) => {
  const parts = notes.map(([frequency, seconds]) => {
    const length = Math.round(seconds * sampleRate)
    const edge = Math.round(fade * sampleRate)
    return Float32Array.from({ length }, (_, i) => {
      const envelope = Math.min(1, i / edge, (length - 1 - i) / edge)
      return level * envelope * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
    })
  })
  const joined = new Float32Array(parts.reduce((length, part) => length + part.length, 0))
  parts.reduce((offset, part) => {
    joined.set(part, offset)
    return offset + part.length
  }, 0)
  return joined
}

/** 16-bit mono WAV. */
export const wav = (samples: Float32Array, sampleRate = rate) => {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset)
  text(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true))
  return bytes
}

type End = "Sent" | "Cancelled"

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
    const device = Floor.use(yield* Floor.Floor, audio)
    const scope = yield* Effect.scope
    /** Each with how many times dictations were dropped before it was sent, so one handed on just before isn't taken in after. */
    const transcripts = yield* PubSub.unbounded<{ readonly heard: string; readonly drops: number }>()
    const dictations = yield* FiberSet.make()
    let drops = 0

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
    const cancel = (ended: Deferred.Deferred<End>) => Effect.suspend(() => (ending === ended ? shortcut.cancel : Effect.void))

    /** Each window on its own, since Whisper only hears 30 seconds. Empty when there was no speech. */
    const transcribe = (frames: ReadonlyArray<Float32Array>, voiced: ReadonlyArray<boolean>) =>
      Effect.gen(function* () {
        if (voiced.filter(Boolean).length < defaults.confirm) return ""
        const heard: Array<string> = []
        for (const spans of windows(voiced)) heard.push(yield* transcriber.transcribe(gather(frames, spans)))
        return heard.filter((text) => text !== "").join(" ")
      })

    /**
     * From the first sound until the microphone is off, holding the speaker and
     * microphone, so the next dictation waits for them rather than have this one
     * turn its microphone off. Nothing without a microphone.
     */
    const record = (ended: Deferred.Deferred<End>, scope: Scope.Scope) =>
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
        const end = yield* Deferred.await(ended).pipe(
          Effect.timeoutTo({ duration: longest, onSuccess: (end): End | "Expired" => end, onTimeout: () => "Expired" }),
        )
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
        yield* cue(end === "Sent" ? "sent" : "cancelled")
        return { end, frames, voiced: Fiber.join(classified).pipe(Effect.as(voiced)) }
      }).pipe(Effect.scoped, device)

    /**
     * `before` is done once the dictation before this one has been dealt with,
     * which a long one can be after a short one that followed it: what they
     * said is passed on in the order they said it, since one can build on another.
     */
    const dictate = (ended: Deferred.Deferred<End>, before: Deferred.Deferred<void> | undefined, done: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        // While they talk, which is plenty of time.
        yield* Effect.forkIn(transcriber.prepare, scope)
        yield* Floor.take
        const recorded = yield* record(ended, yield* Effect.scope)
        if (recorded === undefined) {
          yield* cancel(ended)
          return yield* say("I can't hear you, the microphone is off.")
        }
        const { end, frames, voiced } = recorded
        if (end === "Expired") {
          yield* Effect.logInfo("Dictation dropped after five minutes")
          return yield* say("I stopped listening after five minutes, and dropped that.")
        }
        if (end === "Cancelled") return yield* Effect.logInfo("Dictation cancelled")
        const heard = yield* voiced.pipe(
          Effect.flatMap((voiced) => transcribe(frames, voiced)),
          Effect.tapError((error) => Effect.logWarning("Could not transcribe the dictation", error)),
          Effect.either,
        )
        if (Either.isLeft(heard)) {
          const error = heard.left
          if (error._tag === "TranscribeError") return yield* say("Sorry, I couldn't make that out.")
          // Without a model to hear it, saying it again at once wouldn't help, so they're told what would.
          return yield* say(
            error.loading
              ? "The model for dictation is still downloading. Try again in a minute."
              : "I couldn't load the model for dictation, so I didn't hear that. I'll try again the next time you dictate.",
          )
        }
        if (heard.right === "") return yield* say("I didn't catch anything.")
        if (before !== undefined) yield* Deferred.await(before)
        yield* PubSub.publish(transcripts, { heard: heard.right, drops })
      }).pipe(
        Effect.ensuring(Deferred.succeed(done, undefined)),
        Effect.scoped,
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.void
            : Effect.logError("Dictation failed", cause).pipe(Effect.zipRight(cancel(ended))),
        ),
      )

    let ending: Deferred.Deferred<End> | undefined
    let last: Deferred.Deferred<void> | undefined
    yield* shortcut.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event._tag === "Started") {
            const ended = yield* Deferred.make<End>()
            const done = yield* Deferred.make<void>()
            const before = last
            ending = ended
            last = done
            return yield* FiberSet.run(dictations, dictate(ended, before, done))
          }
          if (ending !== undefined) yield* Deferred.succeed(ending, event._tag)
          ending = undefined
        }),
      ),
      Effect.forkScoped,
    )

    return {
      transcripts: Stream.fromPubSub(transcripts).pipe(Stream.filterMap(({ heard, drops: before }) => before === drops ? Option.some(heard) : Option.none())),
      drop: Effect.suspend(() => {
        drops++
        return FiberSet.clear(dictations)
      }),
    }
  }),
)
