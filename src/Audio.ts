import type { Socket } from "bun"
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  type Queue,
  Runtime,
  Schema,
  type Scope,
} from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Config from "./Config.ts"
import * as Helper from "./Helper.ts"
import { run } from "./Process.ts"
import * as Shortcut from "./Shortcut.ts"

export class AudioError extends Data.TaggedError("AudioError")<{ readonly message: string; readonly cause?: unknown }> {}

export interface Playback {
  /** In seconds. */
  readonly duration: number
  /** Completes once it has played to the end. */
  readonly finished: Effect.Effect<void, AudioError>
  /** Stops it and returns how far it got, in seconds. */
  readonly stop: Effect.Effect<number>
  readonly volume: (level: number) => Effect.Effect<void>
}

export class Audio extends Context.Tag("yapd/Audio")<
  Audio,
  {
    /** Plays a file from `from` seconds in. Closing the scope stops it. */
    readonly play: (path: string, from?: number) => Effect.Effect<Playback, AudioError, Scope.Scope>
    /**
     * 32 ms frames of 16 kHz mono from the microphone while playing, with yapd's
     * own voice cancelled out, so none over its first seconds after the
     * microphone comes on, until that's learnt. None when there's no microphone
     * to listen to.
     */
    readonly microphone: Effect.Effect<Option.Option<Queue.Dequeue<Float32Array>>, never, Scope.Scope>
    /** Turns the microphone off until the next update. */
    readonly rest: Effect.Effect<void>
  }
>() {}

const afplay = (path: string) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const fiber = yield* Effect.forkScoped(run(["afplay", path]))
    return {
      duration: 0,
      finished: Fiber.join(fiber).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new AudioError({ message: "Could not play", cause })),
      ),
      stop: Fiber.interrupt(fiber).pipe(
        Effect.zipRight(Clock.currentTimeMillis),
        Effect.map((now) => (now - start) / 1000),
      ),
      volume: () => Effect.void,
    } satisfies Playback
  })

/** Plays with afplay and never listens. */
export const AfplayAudio = Layer.succeed(Audio, {
  play: afplay,
  microphone: Effect.succeed(Option.none()),
  rest: Effect.void,
})

const Event = Schema.Union(
  Schema.Struct({ type: Schema.Literal("hello", "permission"), permission: Schema.String }),
  Schema.Struct({ type: Schema.Literal("active"), listening: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("playing"), id: Schema.String, duration: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("finished"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stopped"), id: Schema.optional(Schema.String), at: Schema.optional(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("failed"), id: Schema.String, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("shortcut"), registered: Schema.Boolean, message: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("pressed"), key: Schema.Literal("shortcut", "escape") }),
)
const decodeEvent = Schema.decodeUnknownOption(Schema.parseJson(Event))

interface Current {
  readonly id: string
  duration: number
  readonly started: Deferred.Deferred<number, AudioError>
  readonly finished: Deferred.Deferred<void, AudioError>
  stopped: Deferred.Deferred<number> | undefined
}

/** Ends a playback however it was waited on, so nothing waits forever. */
const settle = (current: Current, error: AudioError, at: number) => {
  Deferred.unsafeDone(current.started, Exit.fail(error))
  Deferred.unsafeDone(current.finished, Exit.fail(error))
  if (current.stopped !== undefined) Deferred.unsafeDone(current.stopped, Exit.succeed(at))
}

/**
 * How long yapd talks before the helper's echo cancellation has learnt its
 * voice. It starts over each time the helper starts listening, and until then
 * enough of yapd gets through to pass for the user talking over it.
 */
const learning = 3_000

const permissionLog = (permission: string) => {
  switch (permission) {
    case "authorized":
      return Effect.logInfo("Listening while speaking, so you can interrupt")
    case "undetermined":
      return Effect.logInfo("Asking for microphone access, so you can interrupt")
    default:
      return Effect.logWarning(
        "Microphone access is off, so you can't interrupt. Allow yapd in System Settings, Privacy & Security, Microphone",
      )
  }
}

/**
 * Plays and listens through the native helper, whose voice processing cancels
 * yapd's own voice out of the microphone, and which takes the shortcut. Starting
 * it asks for microphone access the first time. If it quits, the next update
 * starts it again, or right away for the shortcut, and plays with afplay if it can't.
 */
export const NativeAudio = Layer.scopedContext(
  Effect.gen(function* () {
    yield* Helper.build
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "yapd-audio-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    )
    const path = join(dir, "socket")
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const runFork = Runtime.runFork(runtime)
    const frames = yield* PubSub.sliding<Float32Array>(64)

    let connection: Socket<Helper.Decoder> | undefined
    let greeted: Deferred.Deferred<void> | undefined
    let current: Current | undefined
    let listening = false
    /** When the helper last started listening, which starts its echo cancellation over. */
    let listenedAt = Number.NEGATIVE_INFINITY
    let permission: string | undefined
    let closing = false
    /** What the socket hasn't taken yet; it's written out once it drains. */
    let unsent: Array<Uint8Array> = []

    const flush = () => {
      while (connection !== undefined && unsent.length > 0) {
        const next = unsent[0]!
        const written = connection.write(next)
        if (written < next.length) {
          unsent[0] = next.subarray(Math.max(0, written))
          return
        }
        unsent.shift()
      }
    }
    const send = (message: object) => {
      if (connection === undefined) return
      unsent.push(Helper.encode(message))
      if (unsent.length === 1) flush()
    }
    const keys = yield* Config.shortcut
    const shortcut = Option.isSome(keys) ? yield* Shortcut.make(keys.value, send) : undefined

    /** Whether yapd is talking while the echo cancellation is still learning its voice. */
    const echoing = () =>
      current !== undefined &&
      !runSync(Deferred.isDone(current.finished)) &&
      runSync(Clock.currentTimeMillis) - listenedAt < learning

    const receive = (message: Helper.Message) => {
      if (message.kind === Helper.Kind.pcm) {
        if (!echoing()) runSync(PubSub.publish(frames, new Float32Array(message.payload.buffer)))
        return
      }
      const event = decodeEvent(new TextDecoder().decode(message.payload))
      if (Option.isNone(event)) return
      switch (event.value.type) {
        case "hello":
        case "permission":
          if (greeted !== undefined) Deferred.unsafeDone(greeted, Exit.void)
          if (event.value.permission !== permission) runFork(permissionLog(event.value.permission))
          permission = event.value.permission
          if (event.value.type === "hello" && shortcut !== undefined) runSync(shortcut.greeted)
          return
        case "active":
          listening = event.value.listening
          listenedAt = runSync(Clock.currentTimeMillis)
          return
        case "playing":
          if (current?.id === event.value.id) Deferred.unsafeDone(current.started, Exit.succeed(event.value.duration))
          return
        case "failed":
          // Also after it started, when the helper couldn't carry on after a device change.
          if (current?.id === event.value.id) settle(current, new AudioError({ message: event.value.message }), 0)
          return
        case "finished":
          if (current?.id === event.value.id) Deferred.unsafeDone(current.finished, Exit.void)
          return
        case "stopped":
          // Without an id, nothing was playing anymore: it had just finished.
          if (current?.stopped !== undefined && (event.value.id === undefined || event.value.id === current.id)) {
            Deferred.unsafeDone(current.stopped, Exit.succeed(event.value.at ?? current.duration))
          }
          return
        case "error":
          runFork(Effect.logWarning(`Audio helper: ${event.value.message}`))
          return
        case "shortcut":
          if (shortcut !== undefined) runFork(shortcut.registered(event.value.registered, event.value.message))
          return
        case "pressed":
          if (shortcut !== undefined) runSync(shortcut.pressed(event.value.key))
      }
    }

    let quitAt = Number.NEGATIVE_INFINITY
    /** The shortcut needs a helper running, but one that keeps quitting waits for the next update. */
    const restart = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const again = shortcut !== undefined && now - quitAt > 60_000
      quitAt = now
      if (!again) return yield* Effect.logWarning("The audio helper quit, it starts again with the next update")
      yield* Effect.logWarning("The audio helper quit, starting it again for the shortcut")
      yield* connect.pipe(Effect.catchAll((error) => Effect.logWarning("Could not start the audio helper", error)))
    })

    const disconnected = () => {
      connection = undefined
      unsent = []
      listening = false
      if (current !== undefined) settle(current, new AudioError({ message: "The audio helper quit" }), 0)
      current = undefined
      if (shortcut !== undefined) runSync(shortcut.quit)
      if (!closing) runFork(restart)
    }

    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.listen<Helper.Decoder>({
            unix: path,
            socket: {
              open: (socket) => {
                socket.data = new Helper.Decoder()
                connection?.end()
                connection = socket
                unsent = []
              },
              data: (socket, chunk) => {
                if (socket !== connection) return
                for (const message of socket.data.push(chunk)) receive(message)
              },
              drain: (socket) => {
                if (socket === connection) flush()
              },
              close: (socket) => {
                if (socket === connection) disconnected()
              },
            },
          }),
        catch: (cause) => new Helper.HelperError({ message: "Could not listen for the audio helper", cause }),
      }),
      (listener) =>
        Effect.sync(() => {
          closing = true
          // The helper quits once its connection closes.
          connection?.end()
          listener.stop(true)
        }),
    )

    const lock = yield* Effect.makeSemaphore(1)
    let failedAt = Number.NEGATIVE_INFINITY
    const launch = Effect.gen(function* () {
      const hello = yield* Deferred.make<void>()
      greeted = hello
      yield* Helper.launch(path, true)
      yield* Deferred.await(hello).pipe(
        Effect.timeoutFail({
          duration: "10 seconds",
          onTimeout: () => new Helper.HelperError({ message: "The audio helper didn't start" }),
        }),
      )
    }).pipe(
      Effect.tapError(() =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          failedAt = now
        }),
      ),
    )
    const connect = Effect.gen(function* () {
      if (connection !== undefined) return
      // A helper that won't start would otherwise hold every update up for the whole timeout.
      if ((yield* Clock.currentTimeMillis) - failedAt < 60_000) {
        return yield* new Helper.HelperError({ message: "The audio helper didn't start a moment ago" })
      }
      yield* launch
    }).pipe(lock.withPermits(1))

    // Right away, so macOS asks for the microphone while the user is installing,
    // but in the background, so hooks are heard in the meantime.
    yield* connect.pipe(
      Effect.catchAll((error) => Effect.logWarning("Could not start the audio helper", error)),
      Effect.forkScoped,
    )

    const native = (file: string, from: number) =>
      Effect.gen(function* () {
        yield* connect.pipe(Effect.mapError((cause) => new AudioError({ message: cause.message, cause })))
        const playback: Current = {
          id: crypto.randomUUID(),
          duration: 0,
          started: yield* Deferred.make<number, AudioError>(),
          finished: yield* Deferred.make<void, AudioError>(),
          stopped: undefined,
        }
        current = playback
        send({ type: "play", id: playback.id, path: file, from })
        playback.duration = yield* Deferred.await(playback.started).pipe(
          Effect.timeoutFail({
            duration: "5 seconds",
            onTimeout: () => new AudioError({ message: "The audio helper didn't start playing" }),
          }),
        )

        const stop = Effect.gen(function* () {
          if (current !== playback || (yield* Deferred.isDone(playback.finished))) return playback.duration
          const stopped = yield* Deferred.make<number>()
          playback.stopped = stopped
          send({ type: "stop" })
          // Interruptible, or the timeout couldn't fire when this runs as a finalizer.
          const at = yield* Deferred.await(stopped).pipe(
            Effect.interruptible,
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => 0),
          )
          if (current === playback) current = undefined
          return at
        })
        yield* Effect.addFinalizer(() => stop)

        // Should the helper wedge, the update still ends.
        const deadline = Duration.seconds(Math.max(0, playback.duration - from) + 10)
        return {
          duration: playback.duration,
          finished: Deferred.await(playback.finished).pipe(
            Effect.timeoutFail({ duration: deadline, onTimeout: () => new AudioError({ message: "Playback never finished" }) }),
          ),
          stop,
          volume: (level: number) =>
            Effect.sync(() => {
              if (current === playback) send({ type: "volume", value: level })
            }),
        } satisfies Playback
      })

    const audio: Audio["Type"] = {
      play: (file, from = 0) =>
        native(file, from).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Playing with afplay, without listening", error).pipe(Effect.zipRight(afplay(file))),
          ),
        ),
      microphone: Effect.suspend(() =>
        listening ? Effect.map(PubSub.subscribe(frames), Option.some) : Effect.succeed(Option.none()),
      ),
      rest: Effect.sync(() => {
        send({ type: "rest" })
        listening = false
      }),
    }
    return Context.make(Audio, audio).pipe(Context.add(Shortcut.Shortcut, shortcut?.service ?? Shortcut.none))
  }),
)

/** Without the helper, nothing takes the shortcut. */
const noShortcut = (keys: Option.Option<Shortcut.Keys>, log: (keys: string) => Effect.Effect<void>) =>
  Layer.effect(
    Shortcut.Shortcut,
    Option.match(keys, { onNone: () => Effect.void, onSome: (set) => log(Shortcut.format(set)) }).pipe(
      Effect.as(Shortcut.none),
    ),
  )

/** The helper when listening is on and it builds, afplay and no shortcut otherwise. */
export const DeviceAudio = Layer.unwrapEffect(
  Effect.gen(function* () {
    // Read here too, so a shortcut it can't read stops the daemon rather than falling back to afplay.
    const keys = yield* Config.shortcut
    if (!(yield* Config.listen)) {
      return Layer.merge(
        AfplayAudio,
        noShortcut(keys, (text) =>
          Effect.logInfo(`${text} is off: dictating needs the microphone, which YAPD_LISTEN=false keeps closed`),
        ),
      )
    }
    return NativeAudio.pipe(
      Layer.catchAll((error) =>
        Layer.mergeAll(
          AfplayAudio,
          noShortcut(keys, (text) => Effect.logWarning(`${text} is off without the audio helper`)),
          Layer.effectDiscard(Effect.logWarning("Can't listen for interruptions", error)),
        ),
      ),
    )
  }),
)
