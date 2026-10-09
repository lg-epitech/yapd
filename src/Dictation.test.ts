import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Layer, Option, PubSub, type Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { basename } from "node:path"
import { Audio, AudioError } from "./Audio.ts"
import { Dictation, Turns, WhisperDictation, windows } from "./Dictation.ts"
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
 * finishing, only timing out. Playing opens the microphone and resting closes it. yapd was turned on once before.
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
    /** How long whoever takes the transcripts in takes over the one a press began. */
    readonly consume?: (press: number) => Effect.Effect<void>
    /** What voice detection waits for before it's loaded, like its model on the first dictation. */
    readonly loading?: Effect.Effect<void>
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
    /** The presses dictations started with, as they started, and those their transcripts carry, in order. */
    const presses: Array<number> = []
    const ended: Array<number> = []
    /** When each transcript says it was said, in the order they were handed on. */
    const spoken: Array<number> = []
    /** When each press says the shortcut was pressed, as they started. */
    const began: Array<number> = []
    /** The same, each with how many times yapd had been turned on or off as it was pressed, as they carry it. */
    const turned = { pressed: [] as Array<readonly [number, number]>, ended: [] as Array<readonly [number, number]> }
    let turns = 1
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
                  confirmed: true,
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
            echoing: Effect.succeed(false),
            rest: Effect.sync(() => {
              playing++
              open = false
            }),
            warm: Effect.void,
          }),
          // Each frame holds the probability that it's speech.
          Layer.succeed(Vad, {
            make: Effect.zipRight(
              options.loading ?? Effect.void,
              Effect.succeed((frame: Float32Array) => Effect.suspend(() => options.detect?.(detected++) ?? Effect.succeed(frame[0]!))),
            ),
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
          Layer.succeed(Turns, Effect.sync(() => turns)),
          Floor.layer,
        ),
      ),
    )
    const context = yield* Layer.build(layer)
    yield* Effect.forkScoped(
      Stream.runForEach(Context.get(context, Dictation).transcripts, ({ press, turns, heard, at }) =>
        Effect.sync(() => {
          transcripts.push(heard)
          spoken.push(at)
          ended.push(press)
          turned.ended.push([press, turns])
        }).pipe(Effect.zipRight(options.consume?.(press) ?? Effect.void)),
      ),
    )
    yield* Effect.forkScoped(
      Stream.runForEach(Context.get(context, Dictation).presses, ({ press, turns, began: at }) =>
        Effect.sync(() => {
          presses.push(press)
          began.push(at)
          turned.pressed.push([press, turns])
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
      cues,
      said,
      heard,
      transcripts,
      presses,
      ended,
      spoken,
      began,
      turned,
      cancelled: () => cancelled,
      listening: () => open,
      flush,
      drop: Context.get(context, Dictation).drop.pipe(Effect.zipRight(flush)),
      /** yapd is turned off, which drops the dictations, and on again. */
      offAndOn: Context.get(context, Dictation).drop.pipe(
        Effect.zipRight(Effect.sync(() => void (turns += 2))),
        Effect.zipRight(flush),
      ),
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

  test("doesn't cancel the next dictation when an earlier one fails late, and hands the failed one on as nothing, with its own press", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, heard, transcripts, presses, ended, cancelled } = yield* dictation(["Second."], {
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
        return { heard, transcripts, presses, ended, cancelled: cancelled() }
      }),
    )
    expect(result.cancelled).toBe(0)
    expect(result.heard).toEqual([20 * 512, 40 * 512])
    expect(result.transcripts).toEqual(["", "Second."])
    expect(result.presses).toEqual([1, 2])
    expect(result.ended).toEqual([1, 2])
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

  test("hands on each dictation with how many times yapd had been turned on or off as it was pressed, however late", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>()
        const second = yield* Deferred.make<void>()
        const { press, talk, flush, offAndOn, turned } = yield* dictation(["First.", "Second.", "Third.", "Fourth."], {
          // Whoever takes them in is slow with the first two, so the third waits behind them.
          consume: (press) => (press === 1 ? Deferred.await(first) : press === 2 ? Deferred.await(second) : Effect.void),
        })
        const dictate = Effect.zipRight(press("Started"), talk("x".repeat(20))).pipe(Effect.zipRight(press("Sent")))
        yield* dictate
        yield* dictate
        yield* dictate
        yield* Deferred.succeed(first, undefined)
        yield* flush
        // yapd is turned off and on while the second is still being taken in, then he dictates again.
        yield* offAndOn
        yield* dictate
        yield* Deferred.succeed(second, undefined)
        yield* flush
        return turned
      }),
    )
    expect(result.pressed).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 3],
    ])
    // Whatever was said before yapd was turned off and is still handed on says so.
    expect(result.ended.at(-1)).toEqual([4, 3])
    expect(result.ended.slice(0, -1).every(([press, turns]) => press < 4 && turns === 1)).toBe(true)
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

  test("each press says when the shortcut was pressed, whenever it's got ready for", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { press, talk, wait, began } = yield* dictation(["First.", "Second."])
        const start = yield* TestClock.currentTimeMillis
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        yield* wait(3)
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* press("Sent")
        return began.map((at) => at - start)
      }),
    )
    expect(result).toEqual([0, 3000])
  })

  test("hands on a dictation as said when it was sent, though voice detection was still loading then", async () => {
    const result = await run(
      Effect.gen(function* () {
        const loaded = yield* Deferred.make<void>()
        const { press, talk, wait, flush, spoken } = yield* dictation(["The second one."], { loading: Deferred.await(loaded) })
        const start = yield* TestClock.currentTimeMillis
        yield* press("Started")
        yield* talk("x".repeat(20))
        yield* wait(1)
        yield* press("Sent")
        yield* wait(4)
        yield* Deferred.succeed(loaded, undefined)
        yield* flush
        return spoken.map((at) => at - start)
      }),
    )
    expect(result).toEqual([1000])
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
    // The second came to nothing, which is handed on too, after the first.
    expect(result.transcripts).toEqual(["First.", ""])
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
    // Handed on as nothing, so whoever waited on it knows it's over.
    expect(result.transcripts).toEqual([""])
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
    expect(result.transcripts).toEqual([""])
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
