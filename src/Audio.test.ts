import type { Socket } from "bun"
import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Deferred, Effect, Exit, Fiber, Option, Queue, Runtime, type Scope, Stream, TestClock, TestContext } from "effect"
import { Activity, Audio, native } from "./Audio.ts"
import * as Helper from "./Helper.ts"

interface Command {
  readonly type: string
  readonly id?: string
  readonly path?: string
}

/** The real socket protocol, with playback and microphone frames supplied by the test. */
const device = (delayPlaying = false, delayStopping = false) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const commands = yield* Queue.unbounded<Command>()
    const order: Array<string> = []
    /** What it was asked to play, by file name. */
    const played: Array<string> = []
    const sockets: Array<Socket<Helper.Decoder>> = []
    let connection: Socket<Helper.Decoder> | undefined
    let playing: string | undefined
    /** Whether its engine is running, which starts a new voice processor, and says so, when it isn't. */
    let running = false
    /** Whether the next playback's engine won't play anything, which it then gives up on: see `unrendered`. */
    let stalls = false
    const closed = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => sockets.forEach((socket) => socket.terminate())))
    const send = (event: object) => connection?.write(Helper.encode(event))
    const launch = (path: string) =>
      Effect.tryPromise({
        try: () =>
          Bun.connect<Helper.Decoder>({
            unix: path,
            socket: {
              open: (socket) => {
                socket.data = new Helper.Decoder()
                sockets.push(socket)
                connection = socket
                send({ type: "hello", permission: "authorized" })
              },
              data: (socket, data) => {
                for (const message of socket.data.push(data)) {
                  const command = JSON.parse(new TextDecoder().decode(message.payload)) as Command
                  order.push(command.type)
                  runSync(Queue.offer(commands, command))
                  if (command.type === "play") {
                    played.push(command.path?.split("/").at(-1) ?? "")
                    playing = command.id
                    if (!running) send({ type: "active", listening: true })
                    running = true
                    if (stalls) stalls = false
                    else if (!delayPlaying) send({ type: "playing", id: playing, duration: 10 })
                  } else if (command.type === "stop" && !delayStopping) {
                    send({ type: "stopped", ...(playing === undefined ? {} : { id: playing, at: 1 }) })
                    playing = undefined
                  } else if (command.type === "rest") {
                    playing = undefined
                    running = false
                  }
                }
              },
              close: () => {
                playing = undefined
                running = false
                Deferred.unsafeDone(closed, Exit.void)
              },
            },
          }),
        catch: (cause) => new Helper.HelperError({ message: "Could not connect the fake helper", cause }),
      })
    const context = yield* native(launch, () =>
      Effect.sync(() => {
        order.push("fallback")
        return { duration: 10, confirmed: false, finished: Effect.void, stop: Effect.succeed(10), volume: () => Effect.void }
      }),
    )
    const audio = Context.get(context, Audio)
    const next = (type: string) => Queue.take(commands).pipe(Effect.repeat({ until: (command) => command.type === type }))
    const frame = (value: number) => {
      const samples = new Float32Array(512).fill(value)
      const message = new Uint8Array(5 + samples.byteLength)
      message[0] = Helper.Kind.pcm
      new DataView(message.buffer).setUint32(1, samples.byteLength)
      message.set(new Uint8Array(samples.buffer), 5)
      connection?.write(message)
    }
    return {
      audio,
      activity: Context.get(context, Activity).changes,
      finish: Effect.sync(() => {
        if (playing !== undefined) send({ type: "finished", id: playing })
        playing = undefined
      }),
      next,
      order,
      played,
      closed: Deferred.await(closed),
      disconnect: Effect.sync(() => connection?.terminate()),
      inactive: Effect.sync(() => send({ type: "active", listening: false })),
      active: Effect.sync(() => send({ type: "active", listening: true })),
      frame: (value: number) => Effect.sync(() => frame(value)),
      acknowledge: Effect.sync(() => {
        if (playing !== undefined) send({ type: "playing", id: playing, duration: 10 })
      }),
      stall: Effect.sync(() => {
        stalls = true
      }),
      /** Gives up on the playback that stalled, resting as the helper does. */
      unrendered: Effect.sync(() => {
        send({ type: "rested" })
        if (playing !== undefined) send({ type: "failed", id: playing, message: "The audio engine started but didn't play anything" })
        playing = undefined
        running = false
      }),
    }
  })

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_SHORTCUT", "none"]]))),
      Effect.provide(TestContext.TestContext),
    ),
  )

describe("Native audio", () => {
  test("reports speaking while it plays, listening while only the microphone is open, and idle once it rests", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        const seen = yield* Queue.unbounded<string>()
        yield* fake.activity.pipe(Stream.runForEach((doing) => Queue.offer(seen, doing)), Effect.forkScoped)
        const until = (doing: string) => Queue.take(seen).pipe(Effect.repeat({ until: (seen) => seen === doing }))
        yield* until("idle")
        yield* fake.audio.play("/tmp/fake.wav")
        yield* until("speaking")
        yield* fake.finish
        // Only once nothing has played for a moment, as what plays on from it right after would.
        const later = Effect.forever(Effect.zipRight(Effect.promise(() => Bun.sleep(10)), TestClock.adjust("50 millis")))
        yield* until("listening").pipe(Effect.raceFirst(later))
        yield* fake.audio.rest
        yield* until("idle")
      }),
    ))

  for (const ending of ["disconnect", "rest"] as const) {
    test(`ends microphone subscribers on ${ending}, and a later playback gets a fresh microphone`, () =>
      run(
        Effect.gen(function* () {
          const fake = yield* device()
          yield* fake.audio.play("/tmp/fake.wav")
          const first = yield* fake.audio.microphone
          expect(Option.isSome(first)).toBe(true)
          if (Option.isNone(first)) return
          yield* ending === "rest" ? fake.audio.rest : fake[ending]
          yield* Queue.awaitShutdown(first.value)
          expect(Option.isNone(yield* fake.audio.microphone)).toBe(true)
          yield* fake.audio.play("/tmp/next.wav")
          const second = yield* fake.audio.microphone
          expect(Option.isSome(second)).toBe(true)
          if (Option.isNone(second)) return
          yield* TestClock.adjust("3 seconds")
          yield* fake.frame(0.5)
          expect(yield* Queue.take(second.value)).toEqual(new Float32Array(512).fill(0.5))
          expect(yield* Queue.isShutdown(first.value)).toBe(true)
        }),
      ),
    )
  }

  test("ends microphone subscribers when the helper rests itself on an engine that doesn't play, and a later playback gets a fresh microphone", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        const seen = yield* Queue.unbounded<string>()
        yield* fake.activity.pipe(Stream.runForEach((doing) => Queue.offer(seen, doing)), Effect.forkScoped)
        const until = (doing: string) => Queue.take(seen).pipe(Effect.repeat({ until: (seen) => seen === doing }))
        yield* fake.stall
        const playing = yield* Effect.fork(fake.audio.play("/tmp/cue.wav"))
        // Its engine started, which opened the microphone, a moment before it finds the engine doesn't play anything.
        yield* until("listening")
        const first = yield* fake.audio.microphone
        expect(Option.isSome(first)).toBe(true)
        if (Option.isNone(first)) return
        yield* fake.unrendered
        yield* Fiber.join(playing)
        expect(fake.order).toEqual(["play", "fallback"])
        // Played with the fallback, there's no microphone to listen to, rather than one that never hears anything.
        yield* Queue.awaitShutdown(first.value)
        expect(Option.isNone(yield* fake.audio.microphone)).toBe(true)
        yield* until("idle")
        yield* fake.audio.play("/tmp/next.wav")
        const second = yield* fake.audio.microphone
        expect(Option.isSome(second)).toBe(true)
        if (Option.isNone(second)) return
        yield* TestClock.adjust("3 seconds")
        yield* fake.frame(0.5)
        expect(yield* Queue.take(second.value)).toEqual(new Float32Array(512).fill(0.5))
      }),
    ))

  test("preserves microphone subscribers through device recovery and drops frames while inactive", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        yield* fake.audio.play("/tmp/fake.wav")
        const microphone = yield* fake.audio.microphone
        expect(Option.isSome(microphone)).toBe(true)
        if (Option.isNone(microphone)) return
        yield* TestClock.adjust("3 seconds")
        yield* fake.frame(0.5)
        expect(yield* Queue.take(microphone.value)).toEqual(new Float32Array(512).fill(0.5))

        yield* fake.inactive
        yield* fake.frame(0.9)
        yield* fake.active
        yield* fake.frame(0.7)
        expect(yield* Queue.take(microphone.value)).toEqual(new Float32Array(512).fill(0.7))
        expect(yield* Queue.isShutdown(microphone.value)).toBe(false)
      }),
    ))

  test("hears from yapd's first word, saying its own voice may be in what it hears until it has played three seconds on a new voice processor", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
        /** Whether yapd's voice may be in the next frame heard. */
        const hear = (microphone: Queue.Dequeue<Float32Array>) => Effect.flatMap(Queue.take(microphone), fake.audio.echo)
        yield* fake.audio.play("/tmp/fake.wav")
        const microphone = yield* fake.audio.microphone
        if (Option.isNone(microphone)) return expect(Option.isSome(microphone)).toBe(true)
        yield* fake.frame(0.5)
        yield* flush
        expect(yield* Queue.poll(microphone.value)).toEqual(Option.some(new Float32Array(512).fill(0.5)))
        yield* TestClock.adjust("2 seconds")
        yield* fake.frame(0.5)
        // Heard before it finished, though only looked at after.
        yield* fake.finish
        yield* flush
        expect(yield* hear(microphone.value)).toBe(true)
        // Once it has stopped talking, what comes in is taken for him.
        yield* fake.frame(0)
        yield* flush
        expect(yield* hear(microphone.value)).toBe(false)
        // Only what it plays teaches the echo cancellation its voice, however long the quiet after.
        yield* TestClock.adjust("1 minute")
        yield* fake.audio.play("/tmp/next.wav")
        yield* fake.frame(0)
        yield* flush
        expect(yield* hear(microphone.value)).toBe(true)
        yield* TestClock.adjust("1 second")
        yield* fake.frame(0)
        yield* flush
        expect(yield* hear(microphone.value)).toBe(false)
        // Once it has rested, the next voice processor starts over.
        yield* fake.audio.rest
        yield* fake.audio.play("/tmp/after.wav")
        yield* flush
        const next = yield* fake.audio.microphone
        if (Option.isNone(next)) return expect(Option.isSome(next)).toBe(true)
        yield* fake.frame(0)
        yield* flush
        expect(yield* hear(next.value)).toBe(true)
      }),
    ))

  test("the tick plays only while the microphone is open and nothing else plays: never over a line or the warm-up, never launching the helper; a line played right after it still finishes, and the tick never reads as speaking", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
        const seen: Array<string> = []
        yield* fake.activity.pipe(Stream.runForEach((doing) => Effect.sync(() => void seen.push(doing))), Effect.forkScoped)
        const tick = Effect.zipRight(fake.audio.tick, flush)
        /** Plays a line to the end, ticking as it plays, and lets go of it as a line said is let go of, then the moment speaking holds after it. */
        const line = (file: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const playback = yield* fake.audio.play(file)
              yield* tick
              yield* fake.finish
              yield* playback.finished
            }),
          ).pipe(Effect.zipRight(flush), Effect.zipRight(TestClock.adjust("250 millis")), Effect.zipRight(flush))
        // The microphone isn't open yet.
        yield* tick
        expect(fake.played).toEqual([])
        yield* line("first.wav")
        expect(fake.played).toEqual(["first.wav"])
        yield* tick
        expect(fake.played).toEqual(["first.wav", "tick.wav"])
        // Playing, it never reads as speaking.
        expect(seen.at(-1)).toBe("listening")
        // What's said next takes its place, and still finishes.
        yield* line("next.wav")
        expect(fake.played).toEqual(["first.wav", "tick.wav", "next.wav"])
        // Never over the warm-up, which opens the microphone as it plays.
        yield* fake.audio.rest
        yield* fake.audio.warm
        yield* flush
        yield* tick
        expect(fake.played).toEqual(["first.wav", "tick.wav", "next.wav", "silence.wav"])
        yield* fake.finish
        yield* flush
        yield* tick
        expect(fake.played).toEqual(["first.wav", "tick.wav", "next.wav", "silence.wav", "tick.wav"])
        // Nor once the helper quit, which it never starts for it.
        yield* fake.disconnect
        yield* fake.closed
        yield* tick
        expect(fake.played).toEqual(["first.wav", "tick.wav", "next.wav", "silence.wav", "tick.wav"])
        expect(seen.filter((doing) => doing === "speaking")).toHaveLength(2)
      }),
    ))

  test("stops a timed-out native startup before falling back, so a late helper cannot play over it", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device(true)
        const playing = yield* Effect.fork(fake.audio.play("/tmp/fake.wav"))
        yield* fake.next("play")
        yield* TestClock.adjust("5 seconds")
        yield* Fiber.join(playing)
        expect(fake.order).toEqual(["play", "stop", "fallback"])
        yield* fake.acknowledge
      }),
    ))

  test("stops a native startup interrupted before the helper acknowledges it", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device(true)
        const playing = yield* Effect.fork(fake.audio.play("/tmp/fake.wav"))
        yield* fake.next("play")
        yield* Fiber.interrupt(playing)
        expect(fake.order).toEqual(["play", "stop"])
      }),
    ))

  test("disconnects a helper that cannot acknowledge stopping before using the fallback", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device(true, true)
        const playing = yield* Effect.fork(fake.audio.play("/tmp/fake.wav"))
        yield* fake.next("play")
        yield* TestClock.adjust("5 seconds")
        yield* fake.next("stop")
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(playing)
        yield* fake.closed
        expect(fake.order).toEqual(["play", "stop", "fallback"])
      }),
    ))
})
