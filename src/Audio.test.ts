import type { Socket } from "bun"
import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Deferred, Effect, Exit, Fiber, Option, Queue, Runtime, type Scope, Stream, TestClock, TestContext } from "effect"
import { Activity, Audio, native } from "./Audio.ts"
import * as Helper from "./Helper.ts"

interface Command {
  readonly type: string
  readonly id?: string
}

/** The real socket protocol, with playback and microphone frames supplied by the test. */
const device = (delayPlaying = false, delayStopping = false) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const commands = yield* Queue.unbounded<Command>()
    const order: Array<string> = []
    const sockets: Array<Socket<Helper.Decoder>> = []
    let connection: Socket<Helper.Decoder> | undefined
    let playing: string | undefined
    /** Whether its engine is running, which starts a new voice processor, and says so, when it isn't. */
    let running = false
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
                    playing = command.id
                    if (!running) send({ type: "active", listening: true })
                    running = true
                    if (!delayPlaying) send({ type: "playing", id: playing, duration: 10 })
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
      closed: Deferred.await(closed),
      disconnect: Effect.sync(() => connection?.terminate()),
      inactive: Effect.sync(() => send({ type: "active", listening: false })),
      active: Effect.sync(() => send({ type: "active", listening: true })),
      frame: (value: number) => Effect.sync(() => frame(value)),
      acknowledge: Effect.sync(() => {
        if (playing !== undefined) send({ type: "playing", id: playing, duration: 10 })
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
        yield* until("listening")
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

  test("hears from yapd's first word, saying its own voice may be in that until it has played three seconds on a new voice processor", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
        yield* fake.audio.play("/tmp/fake.wav")
        const microphone = yield* fake.audio.microphone
        if (Option.isNone(microphone)) return expect(Option.isSome(microphone)).toBe(true)
        yield* fake.frame(0.5)
        yield* flush
        expect(yield* Queue.poll(microphone.value)).toEqual(Option.some(new Float32Array(512).fill(0.5)))
        expect(yield* fake.audio.echoing).toBe(true)
        yield* TestClock.adjust("2 seconds")
        expect(yield* fake.audio.echoing).toBe(true)
        yield* fake.finish
        yield* flush
        // Only what it plays teaches the echo cancellation its voice, however long the quiet after.
        yield* TestClock.adjust("1 minute")
        expect(yield* fake.audio.echoing).toBe(false)
        yield* fake.audio.play("/tmp/next.wav")
        expect(yield* fake.audio.echoing).toBe(true)
        yield* TestClock.adjust("1 second")
        expect(yield* fake.audio.echoing).toBe(false)
        // Once it has rested, the next voice processor starts over.
        yield* fake.audio.rest
        yield* fake.audio.play("/tmp/after.wav")
        expect(yield* fake.audio.echoing).toBe(true)
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
