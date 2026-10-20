import type { Socket } from "bun"
import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Effect, Either, Exit, Fiber, Option, Queue, Runtime, type Scope, Stream, TestClock, TestContext } from "effect"
import { Audio, type ClientSocket, Devices, native, router, wav } from "./Audio.ts"
import * as Helper from "./Helper.ts"
import { Shortcut } from "./Shortcut.ts"
import * as Wire from "./Wire.ts"

interface Command {
  readonly type: string
  readonly id?: string
  readonly on?: boolean
}

/** The real socket protocol, with playback and microphone frames supplied by the test. */
const device = (delayPlaying = false) =>
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
                  } else if (command.type === "stop") {
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
      context,
      finish: Effect.sync(() => {
        if (playing !== undefined) send({ type: "finished", id: playing })
        playing = undefined
      }),
      next,
      commands,
      order,
      disconnect: Effect.sync(() => connection?.terminate()),
      frame: (value: number) => Effect.sync(() => frame(value)),
      acknowledge: Effect.sync(() => {
        if (playing !== undefined) send({ type: "playing", id: playing, duration: 10 })
      }),
    }
  })

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, shortcut = "none", config: ReadonlyArray<readonly [string, string]> = []) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_SHORTCUT", shortcut], ...config]))),
      Effect.provide(TestContext.TestContext),
    ),
  )

/** A client on `/audio`, like a phone: what it was sent, and saying things to yapd as it would. */
const client = (sockets: NonNullable<Option.Option.Value<Devices["Type"]["sockets"]>>, id = "phone") => {
  const sent: Array<string | Uint8Array> = []
  // A method that needs its socket, as Bun's do.
  const socket = {
    shut: false as boolean,
    send: (data: string | Uint8Array) => void sent.push(data),
    close() {
      this.shut = true
    },
  } satisfies ClientSocket & { shut: boolean }
  const closed = () => socket.shut
  sockets.open(socket)
  const say = (message: object) => sockets.message(socket, JSON.stringify(message))
  /** As a Mac's client would say it, taking the shortcut's keys. */
  const mac = () => say({ type: "hello", permission: "authorized", client: { id, name: id, hotkeys: true } })
  return {
    sent,
    closed,
    say,
    hello: () => say({ type: "hello", permission: "authorized", client: { id, name: id } }),
    mac,
    frame: (value: number) => sockets.message(socket, Wire.pcm16(new Float32Array(Wire.samples).fill(value))),
    leave: () => sockets.close(socket),
    /** What it was told, as JSON, of a type. */
    told: (type: string) => sent.flatMap((data) => (typeof data === "string" ? [JSON.parse(data) as { readonly type: string; readonly [key: string]: unknown }] : [])).filter((message) => message.type === type),
  }
}

/** Lets what was forked get as far as it can without the clock. */
const settle = Effect.repeatN(Effect.yieldNow(), 20)

/** Stops what was forked, giving a client that never says it stopped as long as yapd waits for it. */
const drop = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    const stopping = yield* Effect.fork(Fiber.interrupt(fiber))
    yield* settle
    yield* TestClock.adjust("1 minute")
    yield* Fiber.join(stopping)
  })

/** A short WAV file to play, in a folder of its own. */
const sound = Effect.promise(async () => {
  const path = `${await Bun.$`mktemp -d`.text().then((dir) => dir.trim())}/line.wav`
  await Bun.write(path, wav(new Float32Array(2400)))
  return path
})

describe("Native audio", () => {
  test("ends microphone subscribers on disconnect, and a later playback gets a fresh microphone", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        yield* fake.audio.play("/tmp/fake.wav")
        const first = yield* fake.audio.microphone
        expect(Option.isSome(first)).toBe(true)
        if (Option.isNone(first)) return
        yield* fake.disconnect
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
})

describe("Devices", () => {
  test("plays on a client that connected, sending it the file first, and hears its microphone, until it goes", () =>
    run(
      Effect.gen(function* () {
        const context = yield* router()
        const audio = Context.get(context, Audio)
        const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
        const path = yield* sound
        // With nothing there, nothing waits for it.
        expect(Either.isLeft(yield* Effect.either(Effect.scoped(audio.play(path))))).toBe(true)
        const phone = client(sockets)
        phone.hello()
        const playing = yield* Effect.fork(audio.play(path))
        yield* settle
        const [file, play] = phone.sent
        expect(file instanceof Uint8Array && Wire.readFile(file)?.bytes.length).toBe(Bun.file(path).size)
        const told = typeof play === "string" ? JSON.parse(play) : undefined
        expect(told).toMatchObject({ type: "play", file: file instanceof Uint8Array ? Wire.readFile(file)?.id : "" })
        phone.say({ type: "active", listening: true })
        phone.say({ type: "playing", id: told.id, duration: 0.1 })
        const playback = yield* Fiber.join(playing)
        expect(playback.confirmed).toBe(true)
        const microphone = yield* audio.microphone
        if (Option.isNone(microphone)) return expect(Option.isSome(microphone)).toBe(true)
        phone.frame(0.25)
        expect((yield* Queue.take(microphone.value))[0]).toBeCloseTo(0.25, 3)
        // Gone while it played and someone listened, what it played never finishes, and nothing waits on it here, in the socket's callback.
        const listening = yield* Effect.fork(Queue.take(microphone.value))
        yield* settle
        phone.leave()
        yield* settle
        expect(yield* Fiber.await(listening)).toMatchObject({ _tag: "Failure" })
        expect(Either.isLeft(yield* Effect.either(playback.finished))).toBe(true)
        expect(yield* Queue.isShutdown(microphone.value)).toBe(true)
      }),
    ))

  test("the device last pressed on is in use, a phone's press needs no keys of its own, and the helper takes over once it's gone", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* device()
        const sockets = Option.getOrThrow(Context.get(fake.context, Devices).sockets)
        const shortcut = Context.get(fake.context, Shortcut)
        yield* shortcut.toggle(true)
        const events = yield* Effect.fork(Stream.runHead(shortcut.events))
        yield* settle
        const phone = client(sockets)
        phone.hello()
        // Connecting isn't using: the helper, there first, is still the one in use.
        yield* Effect.scoped(Effect.zipRight(Effect.fork(fake.audio.play("/tmp/first.wav")), fake.next("play")))
        expect(phone.told("play")).toHaveLength(0)
        phone.say({ type: "pressed", key: "shortcut" })
        expect(Option.map(yield* Fiber.join(events), ({ _tag }) => _tag)).toEqual(Option.some("Started"))
        // Whether a dictation is on is told to every device, the phone too.
        expect(phone.told("escape")).toEqual([{ type: "escape", on: true }])
        const path = yield* sound
        const playing = yield* Effect.fork(Effect.scoped(fake.audio.play(path)))
        yield* settle
        expect(phone.told("play")).toHaveLength(1)
        fake.order.length = 0
        // It never says it stopped, so it's let go of, and the dictation on it with it, which lets go of Escape on the Mac too.
        yield* drop(playing)
        expect(phone.closed()).toBe(true)
        yield* Queue.take(fake.commands).pipe(Effect.repeat({ until: (command) => command.type === "escape" && command.on === false }))
        phone.leave()
        fake.order.length = 0
        yield* Effect.scoped(Effect.zipRight(Effect.fork(fake.audio.play("/tmp/after.wav")), fake.next("play")))
        expect(fake.order).toContain("play")
      }),
      "ctrl+option+cmd+space",
    ))

  test("a Mac's shortcut sends on a pause unless YAPD_SEND_ON_PAUSE is false, and a phone's press says for itself", async () => {
    /** Whether each dictation started, the Mac's then the phone's, is sent on a pause. */
    const started = (phone: boolean, config: ReadonlyArray<readonly [string, string]> = []) =>
      run(
        Effect.gen(function* () {
          const context = yield* router()
          const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
          const shortcut = Context.get(context, Shortcut)
          yield* shortcut.toggle(true)
          const events = yield* Effect.fork(Stream.runCollect(Stream.take(Stream.filter(shortcut.events, ({ _tag }) => _tag === "Started"), 2)))
          yield* settle
          const mac = client(sockets, "mac")
          mac.mac()
          mac.say({ type: "shortcut", registered: true })
          mac.say({ type: "pressed", key: "shortcut" })
          mac.say({ type: "pressed", key: "shortcut" })
          const iphone = client(sockets)
          iphone.hello()
          iphone.say({ type: "pressed", key: "shortcut", onPause: phone })
          return [...(yield* Fiber.join(events))].map((event) => (event._tag === "Started" ? event.onPause : undefined))
        }),
        "ctrl+option+cmd+space",
        config,
      )
    expect(await started(false)).toEqual([true, false])
    expect(await started(true, [["YAPD_SEND_ON_PAUSE", "false"]])).toEqual([false, true])
  })

  test("a phone's stop ends what it's saying at once, broken off, and does nothing while nothing plays", () =>
    run(
      Effect.gen(function* () {
        const context = yield* router()
        const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
        const path = yield* sound
        const phone = client(sockets)
        phone.hello()
        phone.say({ type: "pressed", key: "stop" })
        const playing = yield* Effect.fork(Effect.scoped(Effect.flatMap(Context.get(context, Audio).play(path), (playback) => playback.finished)))
        yield* settle
        const id = phone.told("play")[0]?.id
        phone.say({ type: "playing", id, duration: 10 })
        yield* settle
        phone.say({ type: "pressed", key: "stop" })
        phone.say({ type: "stopped", id, at: 1 })
        const ended = yield* Fiber.await(playing)
        expect(Exit.isFailure(ended)).toBe(true)
        expect(phone.told("stop")).toHaveLength(1)
      }),
    ))

  test("a client connecting again as itself takes the place of the one before", () =>
    run(
      Effect.gen(function* () {
        const context = yield* router()
        const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
        const first = client(sockets)
        first.hello()
        const second = client(sockets)
        second.hello()
        expect(first.closed()).toBe(true)
        const path = yield* sound
        const playing = yield* Effect.fork(Effect.scoped(Context.get(context, Audio).play(path)))
        yield* settle
        expect(first.told("play")).toHaveLength(0)
        expect(second.told("play")).toHaveLength(1)
        // Stopped, it says so, and stays.
        const stopping = yield* Effect.fork(Fiber.interrupt(playing))
        yield* settle
        second.say({ type: "stopped", id: second.told("play")[0]?.id, at: 0 })
        yield* Fiber.join(stopping)
        // Played again, it's sent no file, since it has it.
        const again = yield* Effect.fork(Effect.scoped(Context.get(context, Audio).play(path)))
        yield* settle
        expect(second.told("play")).toHaveLength(2)
        expect(second.sent.filter((data) => data instanceof Uint8Array)).toHaveLength(1)
        yield* drop(again)
      }),
    ))

  test("until something's pressed, a Mac is in use before a phone that connected first, and a press on the phone takes over", () =>
    run(
      Effect.gen(function* () {
        const context = yield* router()
        const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
        const audio = Context.get(context, Audio)
        const path = yield* sound
        const phone = client(sockets, "phone")
        phone.hello()
        const rosie = client(sockets, "rosie")
        rosie.mac()
        const first = yield* Effect.fork(Effect.scoped(audio.play(path)))
        yield* settle
        expect([rosie.told("play").length, phone.told("play").length]).toEqual([1, 0])
        yield* drop(first)
        phone.say({ type: "pressed", key: "shortcut" })
        const next = yield* Effect.fork(Effect.scoped(audio.play(path)))
        yield* settle
        expect(phone.told("play")).toHaveLength(1)
        yield* drop(next)
      }),
    ))
})
