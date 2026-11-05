import type { Socket } from "bun"
import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Effect, Either, Exit, Fiber, Option, Queue, Runtime, Scope, Stream, TestClock, TestContext } from "effect"
import { Audio, type ClientSocket, Devices, native, router, wav } from "./Audio.ts"
import * as Helper from "./Helper.ts"
import { Shortcut } from "./Shortcut.ts"
import * as Wire from "./Wire.ts"
import { record } from "./v2/Capture.ts"

interface Command {
  readonly type: string
  readonly id?: string
  readonly on?: boolean
  readonly generation?: number
  readonly sequence?: number
  readonly rate?: number
  readonly audio?: string
}

/** The real socket protocol, with playback and microphone frames supplied by the test. */
const device = (delayPlaying = false, streaming = false) =>
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
                send({ type: "hello", permission: "authorized", streaming })
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
                  } else if (command.type === "stream-start") {
                    send({ type: "stream-ready", id: command.id, generation: command.generation, rate: command.rate, samples: 0, certainty: "rendered" })
                  } else if (command.type === "stream-cancel") {
                    send({ type: "stream-stopped", id: command.id, generation: command.generation, rate: 24000, samples: 0, certainty: "rendered" })
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
      say: (event: object) => Effect.sync(() => send(event)),
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
    hello: (streaming = false, captureBoundary = false, handsFree = false) => say({ type: "hello", permission: "authorized", client: { id, name: id, streaming, captureBoundary, handsFree } }),
    mac,
    frame: (value: number) => sockets.message(socket, Wire.pcm16(new Float32Array(Wire.samples).fill(value))),
    captured: (id: string, sequence: number, value: number) => say({ type: "capture-frame", id, sequence, encoding: "pcm16le", audio: Buffer.from(Wire.pcm16(new Float32Array(Wire.samples).fill(value)).subarray(1)).toString("base64") }),
    previewed: (id: string, sequence: number, value: number) => say({ type: "listen-frame", id, sequence, encoding: "pcm16le", audio: Buffer.from(Wire.pcm16(new Float32Array(Wire.samples).fill(value)).subarray(1)).toString("base64") }),
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
  test("native Stop reaches its separate interruption stream without pretending a dictation was sent", () => run(Effect.gen(function* () {
    const context = yield* router()
    const shortcut = Context.get(context, Shortcut)
    const interrupted = yield* Effect.fork(Stream.runHead(shortcut.interruptions!))
    const dictation = yield* Effect.fork(Stream.runHead(shortcut.events))
    yield* settle
    const phone = client(Option.getOrThrow(Context.get(context, Devices).sockets), "stop-phone")
    phone.hello()
    phone.say({ type: "pressed", key: "stop" })
    expect(yield* Fiber.join(interrupted)).toEqual(Option.some({ deviceId: "stop-phone" }))
    expect(Option.isNone(yield* Fiber.poll(dictation))).toBe(true)
  }), "ctrl+option+cmd+space"))

  test("shortcut events identify their starting device through a different device's Send and automatic Send", () => run(Effect.gen(function* () {
    const context = yield* router()
    const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
    const shortcut = Context.get(context, Shortcut)
    yield* shortcut.toggle(true)
    const events = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.events, 4)))
    yield* settle
    const phone = client(sockets, "capture-phone")
    const other = client(sockets, "other-phone")
    phone.hello()
    other.hello()
    phone.say({ type: "pressed", key: "shortcut", onPause: false })
    other.say({ type: "pressed", key: "shortcut", onPause: false })
    other.say({ type: "pressed", key: "shortcut", onPause: false })
    yield* shortcut.send
    expect([...(yield* Fiber.join(events))]).toEqual([
      { _tag: "Started", onPause: false, deviceId: "capture-phone" },
      { _tag: "Sent", deviceId: "capture-phone" },
      { _tag: "Started", onPause: false, deviceId: "other-phone" },
      { _tag: "Sent", deviceId: "other-phone" },
    ])
  }), "ctrl+option+cmd+space"))

  test("selects microphone input from its capture device and never falls back after disconnect", () => run(Effect.gen(function* () {
    const context = yield* router()
    const audio = Context.get(context, Audio)
    const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
    const phone = client(sockets, "capture-phone")
    const other = client(sockets, "other-phone")
    phone.hello()
    other.hello()
    phone.say({ type: "active", listening: true })
    other.say({ type: "active", listening: true })
    other.say({ type: "pressed", key: "shortcut", onPause: false })
    const capture = yield* audio.microphoneFor!("capture-phone")
    expect(Option.isSome(capture)).toBe(true)
    if (Option.isNone(capture)) return
    other.frame(0.75)
    expect(Option.isNone(yield* Queue.poll(capture.value))).toBe(true)
    phone.frame(0.25)
    expect((yield* Queue.take(capture.value))[0]).toBeCloseTo(0.25, 3)
    phone.leave()
    yield* settle
    expect(yield* Queue.isShutdown(capture.value)).toBe(true)
    const lost = yield* Effect.either(audio.microphoneFor!("capture-phone"))
    expect(Either.isLeft(lost) && lost.left.message).toContain("not connected")
  })))

  test("only losing the capture device cancels its dictation, and keeps that source on Cancelled", () => run(Effect.gen(function* () {
    const context = yield* router()
    const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
    const shortcut = Context.get(context, Shortcut)
    yield* shortcut.toggle(true)
    const events = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.events, 2)))
    yield* settle
    const phone = client(sockets, "capture-phone")
    const other = client(sockets, "other-phone")
    phone.hello()
    other.hello()
    phone.say({ type: "pressed", key: "shortcut", onPause: false })
    other.leave()
    yield* settle
    expect(Option.isNone(yield* Fiber.poll(events))).toBe(true)
    phone.leave()
    expect([...(yield* Fiber.join(events))]).toEqual([
      { _tag: "Started", onPause: false, deviceId: "capture-phone" },
      { _tag: "Cancelled", deviceId: "capture-phone" },
    ])
  }), "ctrl+option+cmd+space"))

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
        expect(phone.told("escape")).toEqual([{ type: "escape", on: true, deviceId: "phone" }])
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

describe("Device capture boundaries", () => {
  test("native failure, overflow and disconnect wake an active recording without Send", () => run(Effect.gen(function* () {
    for (const problem of ["native", "overflow", "disconnect"] as const) {
      const context = yield* router()
      const audio = Context.get(context, Audio)
      const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
      const phone = client(sockets, `failed-${problem}`)
      phone.hello(true, true)
      let cancelled = 0, sent = 0
      const errors: string[] = []
      const pending = yield* Effect.fork(record({ id: "failed-capture", deviceId: `failed-${problem}`, audio,
        runtime: { start: () => {}, push: () => {}, send: async () => { sent++; return undefined }, cancel: () => { cancelled++ } },
        onError: (error) => { errors.push(String(error)) },
      }))
      yield* settle
      phone.say({ type: "capture-ready", id: "failed-capture" })
      const recording = yield* Fiber.join(pending)
      if (problem === "native") phone.say({ type: "capture-error", id: "failed-capture", message: "Native conversion failed" })
      else if (problem === "disconnect") phone.leave()
      else {
        for (let i = 0; i < 513; i++) phone.captured("failed-capture", i, 0.1)
        phone.say({ type: "capture-finished", id: "failed-capture" })
      }
      yield* settle
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(problem === "native" ? "Native conversion failed" : problem === "overflow" ? "overflowed" : "went away")
      expect(cancelled).toBeGreaterThan(0)
      expect(sent).toBe(0)
      const reconnected = problem === "disconnect" ? client(sockets, `failed-${problem}`) : phone
      if (problem === "disconnect") reconnected.hello(true, true)
      const retry = yield* Effect.fork(audio.captureFor!(`failed-${problem}`, "retry"))
      yield* settle
      reconnected.say({ type: "capture-ready", id: "retry" })
      const next = yield* Fiber.join(retry)
      reconnected.captured("retry", 0, 0.25)
      const finish = yield* Effect.fork(next.finish)
      yield* settle
      reconnected.say({ type: "capture-finished", id: "retry" })
      expect((yield* Fiber.join(finish)).samples).toBe(512)
      yield* recording.cancel
    }
  })))

  const open = Effect.gen(function* () {
    const context = yield* router()
    const audio = Context.get(context, Audio)
    const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
    const phone = client(sockets, "capture-phone")
    phone.hello(true, true)
    const pending = yield* Effect.fork(audio.captureFor!("capture-phone", "physical-press"))
    yield* settle
    expect(phone.told("capture-start")).toEqual([{ type: "capture-start", id: "physical-press" }])
    // Legacy delivery before ready is excluded; native replays its bounded physical-press FIFO after ready.
    phone.frame(0.9)
    phone.say({ type: "capture-ready", id: "physical-press" })
    return { audio, phone, sockets, capture: yield* Fiber.join(pending) }
  })

  test("keeps the final queued negation through an ordered native boundary without losing or doubling pre-start frames", () => run(Effect.gen(function* () {
    const { phone, capture } = yield* open
    phone.captured("physical-press", 0, 0.25)
    const consumed = yield* Queue.take(capture.frames)
    phone.captured("physical-press", 1, -0.5)
    const final = yield* Effect.fork(capture.finish)
    yield* settle
    expect(phone.told("capture-finish")).toEqual([{ type: "capture-finish", id: "physical-press" }])
    phone.say({ type: "capture-finished", id: "older-press" })
    yield* settle
    expect(Option.isNone(yield* Fiber.poll(final))).toBe(true)
    // Another pending physical capture cannot bleed its frames into this ending.
    phone.captured("newer-press", 0, 1)
    phone.frame(1)
    phone.captured("physical-press", 2, 0.75)
    phone.say({ type: "capture-finished", id: "physical-press" })
    const end = yield* Fiber.join(final)
    expect(end.samples).toBe(1536)
    expect(consumed[0]).toBeCloseTo(0.25, 3)
    expect(end.frames.map((frame) => frame[0])).toEqual([expect.closeTo(-0.5, 3), expect.closeTo(0.75, 3)])
    expect(consumed.length + end.frames.reduce((total, frame) => total + frame.length, 0)).toBe(end.samples)
    phone.captured("physical-press", 3, 1)
    expect(Option.isNone(yield* Queue.poll(capture.frames))).toBe(true)
  })))

  test("bounded capture overflow fails finalization visibly instead of truncating an utterance", () => run(Effect.gen(function* () {
    const { phone, capture } = yield* open
    for (let i = 0; i < 513; i++) phone.captured("physical-press", i, 0.1)
    const result = yield* Effect.either(capture.finish)
    expect(Either.isLeft(result) && result.left.message).toContain("overflowed")
    expect(phone.told("capture-cancel")).toHaveLength(1)
    phone.say({ type: "capture-finished", id: "physical-press" })
  })))

  test("out-of-order capture frames fail closed instead of silently dropping a word", () => run(Effect.gen(function* () {
    const { phone, capture } = yield* open
    phone.captured("physical-press", 1, 0.25)
    const result = yield* Effect.either(capture.finish)
    expect(Either.isLeft(result) && result.left.message).toContain("out of order")
    phone.say({ type: "capture-finished", id: "physical-press" })
  })))

  test("old clients reject V2 capture clearly and a disconnect cannot acknowledge a complete recording", () => run(Effect.gen(function* () {
    const { audio, phone, sockets, capture } = yield* open
    const ending = yield* Effect.fork(Effect.either(capture.finish))
    yield* settle
    phone.leave()
    expect(Either.isLeft(yield* Fiber.join(ending))).toBe(true)
    const legacy = client(sockets, "old-phone")
    legacy.hello()
    const missing = yield* Effect.either(audio.captureFor!("old-phone", "new"))
    expect(Either.isLeft(missing) && missing.left.message).toContain("update its client")
  })))
})

describe("Mac listening preview", () => {
  test("never activates a phone and publishes the exact selected device policy", () => run(Effect.gen(function* () {
    const context = yield* router()
    const audio = Context.get(context, Audio)
    const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
    const selection = yield* Effect.fork(Stream.runCollect(Stream.take(audio.listeningDevice!, 3)))
    yield* settle
    const mac = client(sockets, "mac")
    mac.hello(true, true, true)
    yield* settle
    const phone = client(sockets, "phone")
    phone.hello(true, true, false)
    phone.say({ type: "pressed", key: "shortcut", onPause: false })
    expect([...(yield* Fiber.join(selection))]).toEqual([Option.none(), Option.some({ deviceId: "mac", handsFree: true }), Option.some({ deviceId: "phone", handsFree: false })])
    expect(Either.isLeft(yield* Effect.either(audio.listenFor!("phone")))).toBe(true)
    expect(phone.told("listen-start")).toHaveLength(0)
  })))

  test("promotes an exact retained prefix while preview and capture frames keep independent ordered clocks", () => run(Effect.gen(function* () {
    const context = yield* router()
    const audio = Context.get(context, Audio)
    const mac = client(Option.getOrThrow(Context.get(context, Devices).sockets), "mac")
    mac.hello(true, true, true)
    const listenerScope = yield* Scope.make()
    const opening = yield* Effect.fork(audio.listenFor!("mac").pipe(Scope.extend(listenerScope)))
    yield* settle
    const id = String(mac.told("listen-start")[0]!.id)
    mac.say({ type: "listen-ready", id })
    const listener = yield* Fiber.join(opening)
    mac.previewed(id, 0, 0.1); mac.previewed(id, 1, 0.25)
    const captureScope = yield* Scope.make()
    const promoting = yield* Effect.fork(listener.promote("barge-in", 1).pipe(Scope.extend(captureScope)))
    yield* settle
    expect(mac.told("capture-promote")).toEqual([{ type: "capture-promote", id: "barge-in", listenerId: id, fromSequence: 1 }])
    mac.previewed(id, 2, -0.5)
    mac.say({ type: "capture-ready", id: "barge-in" })
    mac.captured("barge-in", 0, 0.25); mac.captured("barge-in", 1, -0.5)
    const capture = yield* Fiber.join(promoting)
    const ending = yield* Effect.fork(capture.finish)
    yield* settle
    mac.say({ type: "capture-finished", id: "barge-in" })
    const end = yield* Fiber.join(ending)
    expect(end.frames.map((frame) => frame[0])).toEqual([expect.closeTo(0.25, 3), expect.closeTo(-0.5, 3)])
    expect(end.samples).toBe(1024)
    yield* Scope.close(captureScope, Exit.void)
    mac.previewed(id, 3, 0.75)
    const preview = yield* Queue.takeAll(listener.frames)
    expect([...preview].map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3])
    const closing = yield* Effect.fork(Scope.close(listenerScope, Exit.void))
    yield* settle
    expect(mac.told("listen-cancel")).toEqual([{ type: "listen-cancel", id }])
    mac.say({ type: "listen-finished", id })
    yield* Fiber.join(closing)
  })))

  test("pins listening to its Mac through focus changes, then fails instead of rerouting on disconnect", () => run(Effect.gen(function* () {
    const context = yield* router()
    const audio = Context.get(context, Audio)
    const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
    const mac = client(sockets, "first-mac")
    mac.hello(true, true, true)
    const scope = yield* Scope.make()
    const opening = yield* Effect.fork(audio.listenFor!("first-mac").pipe(Scope.extend(scope)))
    yield* settle
    const id = String(mac.told("listen-start")[0]!.id)
    mac.say({ type: "listen-ready", id })
    const listener = yield* Fiber.join(opening)
    const other = client(sockets, "second-mac")
    other.hello(true, true, true)
    other.say({ type: "pressed", key: "shortcut" })
    other.previewed(id, 0, 1)
    expect(Option.isNone(yield* Queue.poll(listener.frames))).toBe(true)
    mac.previewed(id, 0, 0.5)
    expect((yield* Queue.take(listener.frames)).frame[0]).toBeCloseTo(0.5, 3)
    mac.leave(); yield* settle
    expect(yield* Queue.isShutdown(listener.frames)).toBe(true)
    expect(Either.isLeft(yield* Effect.either(listener.promote("late", 0)))).toBe(true)
    expect(other.told("listen-start")).toHaveLength(0)
    yield* Scope.close(scope, Exit.void)
  })))

  test("preview overflow closes its queue and makes promotion unavailable", () => run(Effect.gen(function* () {
    const context = yield* router()
    const audio = Context.get(context, Audio)
    const mac = client(Option.getOrThrow(Context.get(context, Devices).sockets), "mac")
    mac.hello(true, true, true)
    const scope = yield* Scope.make()
    const opening = yield* Effect.fork(audio.listenFor!("mac").pipe(Scope.extend(scope)))
    yield* settle
    const id = String(mac.told("listen-start")[0]!.id)
    mac.say({ type: "listen-ready", id })
    const listener = yield* Fiber.join(opening)
    for (let i = 0; i < 129; i++) mac.previewed(id, i, 0.1)
    yield* settle
    expect(yield* Queue.isShutdown(listener.frames)).toBe(true)
    const result = yield* Effect.either(listener.promote("truncated", 1))
    expect(Either.isLeft(result) && result.left.message).toContain("overflowed")
    expect(mac.told("listen-cancel")).toHaveLength(1)
    yield* Scope.close(scope, Exit.void)
  })))
})

describe("Streamed device audio", () => {
  const opened = Effect.gen(function* () {
    const context = yield* router()
    const sockets = Option.getOrThrow(Context.get(context, Devices).sockets)
    const audio = Context.get(context, Audio)
    const phone = client(sockets, "stream-phone")
    phone.hello(true)
    return { audio, phone, sockets }
  })
  const start = (audio: Audio["Type"], phone: ReturnType<typeof client>, generation = 1) => Effect.gen(function* () {
    const request = { id: "spoken-answer", generation, rate: 16000 as const }
    const pending = yield* Effect.fork(audio.stream!(request))
    yield* settle
    expect(phone.told("stream-start").at(-1)).toMatchObject({ ...request, format: "pcm16le", channels: 1 })
    phone.say({ type: "stream-ready", ...request, samples: 0, certainty: "rendered" })
    return yield* Fiber.join(pending)
  })
  const receipt = (phone: ReturnType<typeof client>, type: string, samples: number, generation = 1, certainty = "rendered") =>
    phone.say({ type, id: "spoken-answer", generation, rate: 16000, samples, certainty })
  const chunks = (phone: ReturnType<typeof client>) => phone.sent.flatMap((message) => {
    const chunk = typeof message === "string" ? undefined : Wire.readStream(message)
    return chunk === undefined ? [] : [chunk]
  })

  test("the real helper socket carries ordered PCM and generation end remains pending until device drain", () => run(Effect.gen(function* () {
    const fake = yield* device(false, true)
    const request = { id: "socket-answer", generation: 2, rate: 24000 as const }
    const playback = yield* fake.audio.stream!(request)
    const pcm = new Uint8Array([0, 128, 255, 127, 1, 0, 2, 0])
    yield* playback.write(pcm)
    const chunk = yield* fake.next("stream-chunk")
    expect(chunk).toMatchObject({ id: request.id, generation: 2, sequence: 0 })
    expect(chunk.audio && Buffer.from(chunk.audio, "base64")).toEqual(Buffer.from(pcm))
    const ending = yield* Effect.fork(playback.end)
    const end = yield* fake.next("stream-end")
    expect(end.sequence).toBe(1)
    expect(Option.isNone(yield* Fiber.poll(ending))).toBe(true)
    yield* fake.say({ type: "stream-progress", ...request, samples: 4, certainty: "rendered" })
    yield* settle
    expect(Option.isNone(yield* Fiber.poll(ending))).toBe(true)
    yield* fake.say({ type: "stream-finished", ...request, samples: 4, certainty: "rendered" })
    yield* Fiber.join(ending)
  })))

  test("negotiates capability and rejects legacy clients without sending a stream command", () => run(Effect.gen(function* () {
    const context = yield* router()
    const audio = Context.get(context, Audio)
    const phone = client(Option.getOrThrow(Context.get(context, Devices).sockets))
    phone.hello()
    const result = yield* Effect.either(audio.stream!({ id: "legacy", generation: 1, rate: 24000 }))
    expect(Either.isLeft(result) && result.left.message).toContain("update its client")
    expect(phone.told("stream-start")).toHaveLength(0)
  })))

  test("streams ordered bounded PCM chunks and only finishes after a rendered drain receipt", () => run(Effect.gen(function* () {
    const { audio, phone } = yield* opened
    const playback = yield* start(audio, phone)
    const pcm = Uint8Array.from({ length: 70000 }, (_, i) => i % 251)
    yield* playback.write(pcm)
    const sent = chunks(phone)
    expect(sent.map((chunk) => chunk.sequence)).toEqual([0, 1, 2])
    expect(sent.every((chunk) => chunk.generation === 1 && chunk.pcm.length <= Wire.streamSamples * 2)).toBe(true)
    expect([...Buffer.concat(sent.map((chunk) => chunk.pcm))]).toEqual([...pcm])
    const ending = yield* Effect.fork(playback.end)
    yield* settle
    expect(phone.told("stream-end")).toEqual([{ type: "stream-end", id: "spoken-answer", generation: 1, sequence: 3 }])
    expect(Option.isNone(yield* Fiber.poll(ending))).toBe(true)
    receipt(phone, "stream-progress", 35000)
    yield* settle
    expect(Option.isNone(yield* Fiber.poll(ending))).toBe(true)
    receipt(phone, "stream-finished", 35000)
    yield* Fiber.join(ending)
  })))

  test("pins a stream to its starting device when another device takes focus", () => run(Effect.gen(function* () {
    const { audio, phone, sockets } = yield* opened
    const playback = yield* start(audio, phone)
    const other = client(sockets, "other-phone")
    other.hello(true)
    other.say({ type: "pressed", key: "shortcut", onPause: false })
    yield* playback.write(new Uint8Array([1, 0, 2, 0]))
    expect(chunks(phone)).toHaveLength(1)
    expect(chunks(other)).toHaveLength(0)
    const ending = yield* Effect.fork(playback.end)
    yield* settle
    receipt(other, "stream-finished", 2)
    yield* settle
    expect(Option.isNone(yield* Fiber.poll(ending))).toBe(true)
    receipt(phone, "stream-finished", 2)
    yield* Fiber.join(ending)
  })))

  test("opens speech on the originating device after focus changed and fails if that origin is gone", () => run(Effect.gen(function* () {
    const { audio, phone, sockets } = yield* opened
    const other = client(sockets, "other-phone")
    other.hello(true)
    other.say({ type: "pressed", key: "shortcut", onPause: false })
    const request = { id: "spoken-answer", generation: 1, rate: 16000 as const, deviceId: "stream-phone" }
    const opening = yield* Effect.fork(audio.stream!(request))
    yield* settle
    expect(phone.told("stream-start")).toHaveLength(1)
    expect(other.told("stream-start")).toHaveLength(0)
    receipt(phone, "stream-ready", 0)
    const playback = yield* Fiber.join(opening)
    const ending = yield* Effect.fork(playback.end)
    yield* settle
    receipt(phone, "stream-finished", 0)
    yield* Fiber.join(ending)
    phone.leave()
    const result = yield* Effect.either(audio.stream!({ ...request, generation: 2 }))
    expect(Either.isLeft(result) && result.left.message).toContain("originating device stream-phone is not connected")
    expect(other.told("stream-start")).toHaveLength(0)
  })))

  test("stops with device position, rejects late generation receipts and cannot write to a closed stream", () => run(Effect.gen(function* () {
    const { audio, phone } = yield* opened
    const first = yield* start(audio, phone)
    yield* first.write(new Uint8Array([0, 0, 0, 0]))
    const stopping = yield* Effect.fork(first.stop)
    yield* settle
    expect(phone.told("stream-cancel")).toHaveLength(1)
    receipt(phone, "stream-stopped", 1, 1, "estimated")
    expect(yield* Fiber.join(stopping)).toEqual({ samples: 1, rate: 16000, certainty: "estimated" })
    expect(Either.isLeft(yield* Effect.either(first.write(new Uint8Array([0, 0]))))).toBe(true)
    const second = yield* start(audio, phone, 2)
    yield* second.write(new Uint8Array([0, 0]))
    const ending = yield* Effect.fork(second.end)
    yield* settle
    receipt(phone, "stream-finished", 2, 1)
    yield* settle
    expect(Option.isNone(yield* Fiber.poll(ending))).toBe(true)
    receipt(phone, "stream-finished", 1, 2)
    yield* Fiber.join(ending)
  })))

  test("applies device-rendered backpressure and fails visibly when a bounded buffer stalls", () => run(Effect.gen(function* () {
    const { audio, phone } = yield* opened
    const playback = yield* start(audio, phone)
    const writing = yield* Effect.fork(Effect.either(playback.write(new Uint8Array(140000))))
    yield* settle
    expect(chunks(phone)).toHaveLength(3)
    expect(Option.isNone(yield* Fiber.poll(writing))).toBe(true)
    yield* TestClock.adjust("11 seconds")
    const result = yield* Fiber.join(writing)
    expect(Either.isLeft(result) && result.left.message).toContain("bounded buffer")
    expect(Either.isLeft(yield* Effect.either(playback.write(new Uint8Array([0, 0]))))).toBe(true)
    expect(chunks(phone)).toHaveLength(3)
    yield* audio.rest
  })))

  test("rendered progress releases write credit and generation end still waits for all samples", () => run(Effect.gen(function* () {
    const { audio, phone } = yield* opened
    const playback = yield* start(audio, phone)
    const writing = yield* Effect.fork(playback.write(new Uint8Array(140000)))
    yield* settle
    expect(chunks(phone)).toHaveLength(3)
    receipt(phone, "stream-progress", Wire.streamSamples)
    yield* Fiber.join(writing)
    expect(chunks(phone)).toHaveLength(5)
    const ending = yield* Effect.fork(playback.end)
    yield* settle
    receipt(phone, "stream-finished", 70000)
    yield* Fiber.join(ending)
  })))

  test("disconnect ends the old stream and reconnect does not accept its late completion", () => run(Effect.gen(function* () {
    const { audio, phone, sockets } = yield* opened
    const old = yield* start(audio, phone)
    yield* old.write(new Uint8Array([0, 0]))
    const ending = yield* Effect.fork(Effect.either(old.end))
    yield* settle
    phone.leave()
    expect(Either.isLeft(yield* Fiber.join(ending))).toBe(true)
    const replacement = client(sockets, "stream-phone")
    replacement.hello(true)
    const next = yield* start(audio, replacement, 2)
    const done = yield* Effect.fork(next.end)
    yield* settle
    receipt(phone, "stream-finished", 1, 1)
    yield* settle
    expect(Option.isNone(yield* Fiber.poll(done))).toBe(true)
    receipt(replacement, "stream-finished", 0, 2)
    yield* Fiber.join(done)
  })))

  test("disconnect while stopping resolves promptly with unknown position rather than waiting for an impossible receipt", () => run(Effect.gen(function* () {
    const { audio, phone } = yield* opened
    const playback = yield* start(audio, phone)
    yield* playback.write(new Uint8Array([0, 0]))
    const stopping = yield* Effect.fork(playback.stop)
    yield* settle
    phone.leave()
    expect(yield* Fiber.join(stopping)).toEqual({ samples: 0, rate: 16000, certainty: "unknown" })
  })))

  test("rejects a device completion before generation ends instead of treating queued audio as heard", () => run(Effect.gen(function* () {
    const { audio, phone } = yield* opened
    const playback = yield* start(audio, phone)
    yield* playback.write(new Uint8Array([0, 0]))
    receipt(phone, "stream-finished", 1)
    const result = yield* Effect.either(playback.end)
    expect(Either.isLeft(result) && result.left.message).toContain("before the audio stream drained")
    expect(phone.told("stream-cancel")).toHaveLength(1)
  })))
})
