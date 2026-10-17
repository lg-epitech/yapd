import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Layer, Option, PubSub, type Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { Audio, AudioError } from "./Audio.ts"
import { Ahead, Dictation, Turns, WhisperDictation, windows } from "./Dictation.ts"
import * as Floor from "./Floor.ts"
import * as Shortcut from "./Shortcut.ts"
import { DictationTranscriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { Voice } from "./Voice.ts"

/** One flag per frame from a picture of it: x is speech, . isn't. */
const frames = (picture: string) => [...picture].map((frame) => frame === "x")

/**
 * Runs a dictation against a shortcut and microphone the test drives, and a transcriber that hears `transcribed` in
 * turn. Audio plays as the helper does: one thing at a time, and one cut off by the next never finishing, only timing
 * out. Playing opens the microphone and resting closes it. yapd is on, so "Mute." goes ahead.
 */
const dictation = (
  transcribed: ReadonlyArray<string>,
  options: {
    /** Stands in for Whisper on the given call, counting from 0. */
    readonly transcribe?: (call: number) => Effect.Effect<string> | undefined
    /** Stands in for voice detection on the given frame, counting from 0. */
    readonly detect?: (call: number) => Effect.Effect<number> | undefined
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<Shortcut.Event>()
    const microphone = yield* PubSub.unbounded<Float32Array>()
    let playing = 0
    let open = false
    const said: Array<string> = []
    const heard: Array<number> = []
    const transcripts: Array<string> = []
    /** The presses dictations started with, as they started, and those their transcripts carry, in order. */
    const presses: Array<number> = []
    const ended: Array<number> = []
    /** When each transcript says it was said, in the order they were handed on. */
    const spoken: Array<number> = []
    const remaining = [...transcribed]
    let detected = 0
    const layer = WhisperDictation.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(Shortcut.Shortcut, {
            events: Stream.fromPubSub(events),
            cancel: PubSub.publish(events, { _tag: "Cancelled" as const }),
            toggle: () => Effect.void,
          }),
          Layer.succeed(Audio, {
            play: () =>
              Effect.sync(() => {
                const id = ++playing
                open = true
                return {
                  duration: 0,
                  confirmed: true,
                  finished: Effect.suspend(() => (playing === id ? Effect.void : Effect.never)).pipe(
                    Effect.timeoutFail({
                      duration: "10 seconds",
                      onTimeout: () => new AudioError({ message: "Playback never finished" }),
                    }),
                  ),
                  stop: Effect.succeed(0),
                  volume: () => Effect.void,
                }
              }),
            microphone: Effect.map(PubSub.subscribe(microphone), Option.some),
            echo: () => Effect.succeed(false),
            rest: Effect.sync(() => {
              playing++
              open = false
            }),
            warm: Effect.void,
            tick: Effect.void,
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
          Layer.succeed(Turns, Effect.succeed(1)),
          Layer.succeed(Ahead, (heard) => Effect.succeed(heard === "Mute.")),
          Floor.layer,
        ),
      ),
    )
    const context = yield* Layer.build(layer)
    yield* Effect.forkScoped(
      Stream.runForEach(Context.get(context, Dictation).transcripts, ({ press, heard, at }) =>
        Effect.sync(() => {
          transcripts.push(heard)
          spoken.push(at)
          ended.push(press)
        }),
      ),
    )
    yield* Effect.forkScoped(
      Stream.runForEach(Context.get(context, Dictation).presses, ({ press }) =>
        Effect.sync(() => {
          presses.push(press)
        }),
      ),
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
      said,
      heard,
      transcripts,
      presses,
      ended,
      spoken,
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
        const { press, talk, dictating, heard, transcripts } = yield* dictation(["Add a dictation mode to yapd."])
        yield* press("Started")
        const during = yield* dictating
        yield* talk(`${"x".repeat(20)}${".".repeat(100)}${"x".repeat(20)}`)
        yield* press("Sent")
        return { during, after: yield* dictating, heard, transcripts }
      }),
    )
    expect(result.during).toBe(1)
    expect(result.after).toBe(0)
    // One window, without the long pause: each stretch with the margin after or before it.
    expect(result.heard).toEqual([(30 + 30) * 512])
    expect(result.transcripts).toEqual(["Add a dictation mode to yapd."])
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

  test("drops dictations being recorded or transcribed without a sound, and hands neither on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, drop, said, transcripts, dictating, listening } = yield* dictation(["", "Second."], {
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
        return { said, transcripts, dictating: yield* dictating, listening: listening() }
      }),
    )
    expect(result.said).toEqual([])
    expect(result.transcripts).toEqual([])
    expect(result.dictating).toBe(0)
    expect(result.listening).toBe(false)
  })

  test("hands on what the user said in the order they said it, each with the press it began with", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, transcripts, presses, ended } = yield* dictation([], {
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
        return { during, transcripts, presses, ended }
      }),
    )
    expect(result.during).toEqual([])
    expect(result.transcripts).toEqual(["Fix the loader in yapd.", "Then do the same in std."])
    expect(result.presses).toEqual([1, 2])
    expect(result.ended).toEqual([1, 2])
  })

  test("hands on 'Mute.' at once, never waiting for one before it still being transcribed, and what follows it after that one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, transcripts, ended } = yield* dictation([], {
          // The first is long, so it's still being transcribed when "Mute." and the one after it are done.
          transcribe: (call) =>
            Effect.succeed(["Fix the loader in yapd.", "Mute.", "Then do the same in std."][call] ?? "").pipe(
              Effect.delay(call === 0 ? "10 seconds" : "0 seconds"),
            ),
        })
        const dictate = Effect.zipRight(press("Started"), talk("x".repeat(20))).pipe(Effect.zipRight(press("Sent")))
        yield* dictate
        yield* dictate
        yield* dictate
        const during = [...transcripts]
        yield* wait(10)
        return { during, transcripts, ended }
      }),
    )
    expect(result.during).toEqual(["Mute."])
    expect(result.transcripts).toEqual(["Mute.", "Fix the loader in yapd.", "Then do the same in std."])
    expect(result.ended).toEqual([2, 1, 3])
  })

  test("hands on each dictation as said when they stopped talking, however long the one before it took to hear", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, spoken } = yield* dictation([], {
          // The first takes five seconds to hear, so the second, sent a second in, is handed on only after it.
          transcribe: (call) => (call === 0 ? Effect.sleep("5 seconds").pipe(Effect.as("Which migration is running?")) : Effect.succeed("The second one.")),
        })
        const start = yield* TestClock.currentTimeMillis
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* wait(1)
        yield* press("Sent")
        yield* wait(5)
        return spoken.map((at) => at - start)
      }),
    )
    expect(result).toEqual([0, 1000])
  })

  test("drops the recording when the user cancels", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, heard, transcripts } = yield* dictation(["Never mind."])
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Cancelled")
        return { heard, transcripts }
      }),
    )
    expect(result.heard).toEqual([])
    // Handed on as nothing, so whoever waited on it knows it's over.
    expect(result.transcripts).toEqual([""])
  })

})
