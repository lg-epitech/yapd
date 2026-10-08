import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Layer, Option, PubSub, type Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { basename } from "node:path"
import { Audio, AudioError } from "./Audio.ts"
import { Dictation, WhisperDictation, windows } from "./Dictation.ts"
import * as Floor from "./Floor.ts"
import * as Shortcut from "./Shortcut.ts"
import { DictationTranscriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { Voice } from "./Voice.ts"

/** One flag per frame from a picture of it: x is speech, . isn't. */
const frames = (picture: string) => [...picture].map((frame) => frame === "x")

/**
 * Runs a dictation against a shortcut and microphone the test drives, and a transcriber that hears `transcribed` in
 * turn. Audio plays as the helper does: one thing at a time, each taking `seconds`, and one cut off by the next never
 * finishing, only timing out. Playing opens the microphone and resting closes it.
 */
const dictation = (
  transcribed: ReadonlyArray<string>,
  options: {
    readonly microphone?: boolean
    readonly seconds?: number
    /** Stands in for Whisper on the given call, counting from 0. */
    readonly transcribe?: (call: number) => Effect.Effect<string> | undefined
    /** Stands in for voice detection on the given frame, counting from 0. */
    readonly detect?: (call: number) => Effect.Effect<number> | undefined
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<Shortcut.Event>()
    const microphone = yield* PubSub.unbounded<Float32Array>()
    const seconds = options.seconds ?? 0
    let playing = 0
    let open = false
    const cues: Array<string> = []
    const said: Array<string> = []
    const heard: Array<number> = []
    const transcripts: Array<string> = []
    const remaining = [...transcribed]
    let cancelled = 0
    let detected = 0
    const layer = WhisperDictation.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(Shortcut.Shortcut, {
            events: Stream.fromPubSub(events),
            cancel: Effect.sync(() => void cancelled++).pipe(Effect.zipRight(PubSub.publish(events, { _tag: "Cancelled" as const }))),
            toggle: () => Effect.void,
          }),
          Layer.succeed(Audio, {
            play: (path) =>
              Effect.sync(() => {
                if (["started.wav", "sent.wav", "cancelled.wav"].includes(basename(path))) cues.push(basename(path, ".wav"))
                const id = ++playing
                open = true
                const played = seconds === 0 ? Effect.void : Effect.sleep(`${seconds} seconds`)
                return {
                  duration: seconds,
                  finished: played.pipe(
                    Effect.zipRight(Effect.suspend(() => (playing === id ? Effect.void : Effect.never))),
                    Effect.timeoutFail({
                      duration: `${seconds + 10} seconds`,
                      onTimeout: () => new AudioError({ message: "Playback never finished" }),
                    }),
                  ),
                  stop: Effect.succeed(seconds),
                  volume: () => Effect.void,
                }
              }),
            microphone:
              options.microphone === false ? Effect.succeed(Option.none()) : Effect.map(PubSub.subscribe(microphone), Option.some),
            rest: Effect.sync(() => {
              playing++
              open = false
            }),
            warm: Effect.void,
          }),
          // Each frame holds the probability that it's speech.
          Layer.succeed(Vad, {
            make: Effect.succeed((frame: Float32Array) => Effect.suspend(() => options.detect?.(detected++) ?? Effect.succeed(frame[0]!))),
          }),
          Layer.succeed(DictationTranscriber, {
            transcribe: (audio) =>
              Effect.suspend(() => {
                heard.push(audio.length)
                return options.transcribe?.(heard.length - 1) ?? Effect.succeed(remaining.shift() ?? "")
              }),
            prepare: Effect.void,
          }),
          Layer.succeed(Voice, { render: (text) => Effect.sync(() => void said.push(text)) }),
          Floor.layer,
        ),
      ),
    )
    const context = yield* Layer.build(layer)
    yield* Effect.forkScoped(
      Stream.runForEach(Context.get(context, Dictation).transcripts, (text) => Effect.sync(() => void transcripts.push(text))),
    )
    const floor = Context.get(context, Floor.Floor)
    // Lets the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    yield* flush
    const press = (event: Shortcut.Event["_tag"]) => PubSub.publish(events, { _tag: event }).pipe(Effect.zipRight(flush))
    /** Only heard while the microphone is open. */
    const talk = (picture: string) =>
      Effect.suspend(() =>
        open
          ? PubSub.publishAll(
              microphone,
              [...picture].map((frame) => new Float32Array(512).fill(frame === "x" ? 0.9 : 0)),
            )
          : Effect.void,
      ).pipe(Effect.zipRight(flush))
    const wait = (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush))
    const dictating = STM.commit(TRef.get(floor.dictations))
    return {
      press,
      talk,
      wait,
      dictating,
      cues,
      said,
      heard,
      transcripts,
      cancelled: () => cancelled,
      listening: () => open,
      flush,
      drop: Context.get(context, Dictation).drop.pipe(Effect.zipRight(flush)),
    }
  })

const run = <A>(test: Effect.Effect<A, never, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Dictation", () => {
  test("fits what the user said into windows Whisper hears whole, without the silence in between", () => {
    const margin = windows(frames("..xx....xx.."), 30, 1)
    expect(margin).toEqual([[[1, 5], [7, 11]]])
    expect(windows(frames("......"), 30, 1)).toEqual([])
    const several = windows(frames("xxxx..xxxx..xxxx"), 8, 0)
    expect(several).toEqual([[[0, 4], [6, 10]], [[12, 16]]])
    // Talk too long for one window is cut at a breath, or where the window ends when there's none.
    expect(windows(frames("xxxxxx.xxxxx"), 8, 0)).toEqual([[[0, 6]], [[7, 12]]])
    expect(windows(frames("xxxxxxxxxxxx"), 8, 0)).toEqual([[[0, 8]], [[8, 12]]])
  })

  test("records until the user sends, then hands on what they said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, dictating, cues, heard, transcripts } = yield* dictation(["Add a dictation mode to yapd."])
        yield* press("Started")
        const during = yield* dictating
        yield* talk(`${"x".repeat(20)}${".".repeat(100)}${"x".repeat(20)}`)
        yield* press("Sent")
        return { during, after: yield* dictating, cues, heard, transcripts }
      }),
    )
    expect(result.during).toBe(1)
    expect(result.after).toBe(0)
    expect(result.cues).toEqual(["started", "sent"])
    // One window, without the long pause: each stretch with the margin after or before it.
    expect(result.heard).toEqual([(30 + 30) * 512])
    expect(result.transcripts).toEqual(["Add a dictation mode to yapd."])
  })

  test("lets go of the microphone before the next dictation takes it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, cues, heard } = yield* dictation(["First.", "Second."], { seconds: 0.2 })
        yield* press("Started")
        yield* wait(0.2)
        yield* talk("x".repeat(20))
        yield* press("Sent")
        // Again, before the first one's closing cue has played.
        yield* press("Started")
        yield* wait(0.2)
        yield* wait(0.2)
        yield* talk("x".repeat(20))
        // Long enough for a cue that was cut off to give up.
        yield* wait(11)
        yield* talk("x".repeat(20))
        yield* press("Sent")
        yield* wait(0.2)
        return { cues, heard }
      }),
    )
    expect(result.cues).toEqual(["started", "sent", "started", "sent"])
    // All of what was said in the second, however long the first took to let go.
    expect(result.heard).toEqual([20 * 512, 40 * 512])
  })

  test("keeps every captured frame when the user sends while voice detection is still running", async () => {
    const result = await run(
      Effect.gen(function* () {
        const detecting = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const { press, talk, flush, heard, transcripts, said, listening } = yield* dictation(["Second request.", "Keep the whole request."], {
          detect: (call) =>
            call === 0 ? Deferred.succeed(detecting, undefined).pipe(Effect.zipRight(Deferred.await(finish)), Effect.as(0.9)) : undefined,
        })
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* Deferred.await(detecting)
        yield* press("Sent")
        const during = { listening: listening(), transcripts: [...transcripts], said: [...said] }
        // Detection still owns the first recording, while the next one can listen and transcribe.
        yield* press("Started")
        yield* talk("x".repeat(12))
        yield* press("Sent")
        expect(transcripts).toEqual([])
        yield* Deferred.succeed(finish, undefined)
        yield* flush
        return { during, heard, transcripts, said }
      }),
    )
    expect(result.during).toEqual({ listening: false, transcripts: [], said: [] })
    expect(result.heard).toEqual([12 * 512, 20 * 512])
    expect(result.transcripts).toEqual(["Keep the whole request.", "Second request."])
    expect(result.said).toEqual([])
  })

  test("doesn't cancel the next dictation when an earlier one fails late", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, heard, transcripts, cancelled } = yield* dictation(["Second."], {
          transcribe: (call) => (call === 0 ? Effect.sleep("1 second").pipe(Effect.zipRight(Effect.die("Whisper crashed"))) : undefined),
        })
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        yield* press("Started")
        yield* talk("x".repeat(20))
        // The first one fails while the second records.
        yield* wait(1)
        yield* talk("x".repeat(20))
        yield* press("Sent")
        return { heard, transcripts, cancelled: cancelled() }
      }),
    )
    expect(result.cancelled).toBe(0)
    expect(result.heard).toEqual([20 * 512, 40 * 512])
    expect(result.transcripts).toEqual(["Second."])
  })

  test("drops dictations being recorded or transcribed without a sound, and hands neither on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, drop, cues, said, transcripts, dictating, listening } = yield* dictation(["", "Second."], {
          transcribe: (call) => (call === 0 ? Effect.sleep("5 seconds").pipe(Effect.as("")) : undefined),
        })
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        // The first is being transcribed, and would say it didn't catch anything, as the second records.
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* drop
        yield* wait(10)
        return { cues, said, transcripts, dictating: yield* dictating, listening: listening() }
      }),
    )
    expect(result.cues).toEqual(["started", "sent", "started"])
    expect(result.said).toEqual([])
    expect(result.transcripts).toEqual([])
    expect(result.dictating).toBe(0)
    expect(result.listening).toBe(false)
  })

  test("hands on what the user said in the order they said it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, transcripts } = yield* dictation([], {
          // The first is long, so it's still being transcribed when the second is done.
          transcribe: (call) => (call === 0 ? Effect.sleep("5 seconds").pipe(Effect.as("Fix the loader in yapd.")) : Effect.succeed("Then do the same in std.")),
        })
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        const during = [...transcripts]
        yield* wait(5)
        return { during, transcripts }
      }),
    )
    expect(result.during).toEqual([])
    expect(result.transcripts).toEqual(["Fix the loader in yapd.", "Then do the same in std."])
  })

  test("turns the microphone off after saying something, while an earlier dictation is still transcribed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, said, transcripts, listening } = yield* dictation(["First."], {
          transcribe: (call) => (call === 0 ? Effect.sleep("5 seconds").pipe(Effect.as("First.")) : undefined),
        })
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        yield* press("Started")
        yield* talk(".".repeat(50))
        yield* press("Sent")
        const during = listening()
        yield* wait(5)
        return { said, transcripts, during, after: listening() }
      }),
    )
    expect(result.said).toEqual(["I didn't catch anything."])
    expect(result.during).toBe(false)
    expect(result.after).toBe(false)
    expect(result.transcripts).toEqual(["First."])
  })

  test("drops the recording when the user cancels", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, cues, heard, transcripts } = yield* dictation(["Never mind."])
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Cancelled")
        return { cues, heard, transcripts }
      }),
    )
    expect(result.cues).toEqual(["started", "cancelled"])
    expect(result.heard).toEqual([])
    expect(result.transcripts).toEqual([])
  })

  test("drops a dictation left running, and says so", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { talk, press, flush, cues, said, transcripts, cancelled, dictating } = yield* dictation(["Hello?"])
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* TestClock.adjust("5 minutes")
        yield* flush
        return { cues, said, transcripts, cancelled: cancelled(), after: yield* dictating }
      }),
    )
    expect(result.cancelled).toBe(1)
    expect(result.cues).toEqual(["started", "cancelled"])
    expect(result.said).toEqual(["I stopped listening after five minutes, and dropped that."])
    expect(result.transcripts).toEqual([])
    expect(result.after).toBe(0)
  })

  test("stops at once without a microphone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, said, cancelled } = yield* dictation([], { microphone: false })
        yield* press("Started")
        return { said, cancelled: cancelled() }
      }),
    )
    expect(result.cancelled).toBe(1)
    expect(result.said).toEqual(["I can't hear you, the microphone is off."])
  })
})
