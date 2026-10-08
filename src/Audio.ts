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
  FiberSet,
  Layer,
  Option,
  PubSub,
  type Queue,
  Runtime,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
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
     * own voice cancelled out, so none over the first seconds it says after the
     * microphone comes on, until that's learnt. None when there's no microphone
     * to listen to.
     */
    readonly microphone: Effect.Effect<Option.Option<Queue.Dequeue<Float32Array>>, never, Scope.Scope>
    /** Turns the microphone off until the next update. */
    readonly rest: Effect.Effect<void>
    /**
     * Gets the speaker ready for something about to be said, since macOS takes
     * about a second to set it up from rest. Nothing when it's ready already.
     * Whoever calls it rests it again if nothing comes.
     */
    readonly warm: Effect.Effect<void>
  }
>() {}

/** What the speaker and microphone are doing. The microphone is open while yapd speaks too, so that wins. */
export type Doing = "idle" | "speaking" | "listening"

export class Activity extends Context.Tag("yapd/Activity")<
  Activity,
  {
    /** What they're doing, then each time it changes. */
    readonly changes: Stream.Stream<Doing>
  }
>() {}

/** Turns whether something plays and whether the microphone is open into what they're doing, for whoever watches. */
const reporter = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<Doing>("idle")
  const runSync = Runtime.runSync(yield* Effect.runtime<never>())
  let last: Doing = "idle"
  return {
    activity: { changes: ref.changes } satisfies Activity["Type"],
    report: (speaking: boolean, listening: boolean) => {
      const doing = speaking ? "speaking" : listening ? "listening" : "idle"
      if (doing === last) return
      last = doing
      runSync(SubscriptionRef.set(ref, doing))
    },
  }
})

/** Plays with afplay, counting each one as it starts and ends. */
const afplay = (playing: (count: 1 | -1) => void) => (path: string) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    playing(1)
    const fiber = yield* Effect.forkScoped(run(["afplay", path]).pipe(Effect.ensuring(Effect.sync(() => playing(-1)))))
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
export const AfplayAudio = Layer.effectContext(
  Effect.gen(function* () {
    const { activity, report } = yield* reporter
    let playing = 0
    const audio: Audio["Type"] = {
      play: afplay((count) => {
        playing += count
        report(playing > 0, false)
      }),
      microphone: Effect.succeed(Option.none()),
      rest: Effect.void,
      warm: Effect.void,
    }
    return Context.make(Audio, audio).pipe(Context.add(Activity, activity))
  }),
)

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

/** Twenty milliseconds of 16-bit mono silence at 24 kHz, as a WAV file. */
const quiet20ms = (() => {
  const samples = 480
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode("RIFF"), 0)
  view.setUint32(4, 36 + samples * 2, true)
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  bytes.set(new TextEncoder().encode("data"), 36)
  view.setUint32(40, samples * 2, true)
  return bytes
})()

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
 * Owns a native helper connection. Its launcher and fallback playback are
 * supplied separately, so the protocol can also run without an audio device.
 */
export const native = (
  launchHelper: (path: string) => Effect.Effect<unknown, Helper.HelperError>,
  fallback?: Audio["Type"]["play"],
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "yapd-audio-")),
        catch: (cause) => new Helper.HelperError({ message: "Could not prepare the audio helper's socket directory", cause }),
      }),
      (dir) => Effect.tryPromise(() => rm(dir, { recursive: true, force: true })).pipe(
        Effect.catchAll((error) => Effect.logWarning("Could not remove the audio helper's socket directory", error)),
      ),
    )
    const path = join(dir, "socket")
    const silence = join(dir, "silence.wav")
    yield* Effect.tryPromise({
      try: () => Bun.write(silence, quiet20ms),
      catch: (cause) => new Helper.HelperError({ message: "Could not prepare the audio helper's warm-up", cause }),
    })
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const runFork = yield* FiberSet.makeRuntime<never>()
    let frames: PubSub.PubSub<Float32Array> | undefined

    let connection: Socket<Helper.Decoder> | undefined
    let greeted: Deferred.Deferred<void> | undefined
    let current: Current | undefined
    /** The silence played to get the speaker ready, while it plays. It's nobody's playback. */
    let warming: string | undefined
    let listening = false
    /** How long the echo cancellation has heard yapd for, in what it played to the end or stopped. */
    let heard = 0
    /** When what the helper is playing started, if it's playing. */
    let playingSince: number | undefined
    let permission: string | undefined
    let closing = false
    /** What the socket hasn't taken yet; it's written out once it drains. */
    let unsent: Array<Uint8Array> = []
    const { activity, report } = yield* reporter
    let afplaying = 0
    /** Called after anything that changes what plays or whether the microphone is open. */
    const reportActivity = () => report(playingSince !== undefined || afplaying > 0, listening)
    const fallbackPlay =
      fallback ??
      afplay((count) => {
        afplaying += count
        reportActivity()
      })

    /** Detaches the old microphone immediately, and lets its listeners finish. */
    const endMicrophone = () => {
      const previous = frames
      frames = undefined
      listening = false
      return previous === undefined ? Effect.void : PubSub.shutdown(previous)
    }

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
    // Taken once yapd knows whether it's on, which it may have been turned off before it stopped.
    const shortcut = Option.isSome(keys) ? yield* Shortcut.make(keys.value, send, false) : undefined

    const now = () => runSync(Clock.currentTimeMillis)
    /** The helper went quiet, so the echo cancellation heard yapd until now. */
    const quiet = () => {
      if (playingSince !== undefined) heard += now() - playingSince
      playingSince = undefined
    }
    /** Whether yapd is talking while the echo cancellation is still learning its voice. */
    const echoing = () => playingSince !== undefined && heard + now() - playingSince < learning

    const receive = (message: Helper.Message) => {
      if (message.kind === Helper.Kind.pcm) {
        if (listening && frames !== undefined && !echoing()) runSync(PubSub.publish(frames, new Float32Array(message.payload.buffer)))
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
          // It started listening, which starts the echo cancellation over.
          // Device recovery can temporarily lose the microphone. Keep existing
          // subscriptions so they receive frames when the helper recovers it.
          listening = event.value.listening
          if (listening && frames === undefined) frames = runSync(PubSub.sliding<Float32Array>(64))
          heard = 0
          playingSince = undefined
          return
        case "playing":
          // Silence, which neither speaks nor teaches the echo cancellation anything.
          if (event.value.id === warming) return
          // Playing something new stops what it played before without saying so.
          quiet()
          playingSince = now()
          if (current?.id === event.value.id) Deferred.unsafeDone(current.started, Exit.succeed(event.value.duration))
          return
        case "failed":
          if (event.value.id === warming) {
            warming = undefined
            return
          }
          quiet()
          // Also after it started, when the helper couldn't carry on after a device change.
          if (current?.id === event.value.id) settle(current, new AudioError({ message: event.value.message }), 0)
          return
        case "finished":
          if (event.value.id === warming) {
            warming = undefined
            return
          }
          quiet()
          if (current?.id === event.value.id) Deferred.unsafeDone(current.finished, Exit.void)
          return
        case "stopped":
          if (event.value.id !== undefined && event.value.id === warming) {
            warming = undefined
            return
          }
          quiet()
          // Without an id, nothing was playing anymore: it had just finished.
          if (current?.stopped !== undefined && (event.value.id === undefined || event.value.id === current.id)) {
            Deferred.unsafeDone(current.stopped, Exit.succeed(event.value.at ?? current.duration))
          }
          return
        case "error":
          runFork(Effect.logWarning(`Audio helper: ${event.value.message}`))
          return
        case "shortcut":
          // In order with the presses that follow, which only count once it's said.
          if (shortcut !== undefined) runSync(shortcut.registered(event.value.registered, event.value.message))
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
      warming = undefined
      unsent = []
      runFork(endMicrophone())
      quiet()
      if (current !== undefined) settle(current, new AudioError({ message: "The audio helper quit" }), 0)
      current = undefined
      if (shortcut !== undefined) runSync(shortcut.quit)
      reportActivity()
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
                reportActivity()
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
        }).pipe(Effect.zipRight(Effect.suspend(endMicrophone))),
    )

    const lock = yield* Effect.makeSemaphore(1)
    let failedAt = Number.NEGATIVE_INFINITY
    const launch = Effect.gen(function* () {
      const hello = yield* Deferred.make<void>()
      greeted = hello
      yield* launchHelper(path)
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

    const play = (file: string, from: number) =>
      Effect.gen(function* () {
        yield* connect.pipe(Effect.mapError((cause) => new AudioError({ message: cause.message, cause })))
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const playback: Current = {
              id: crypto.randomUUID(),
              duration: 0,
              started: yield* Deferred.make<number, AudioError>(),
              finished: yield* Deferred.make<void, AudioError>(),
              stopped: undefined,
            }
            const stop = Effect.gen(function* () {
              if (current !== playback) return playback.duration
              if (yield* Deferred.isDone(playback.finished)) {
                current = undefined
                return playback.duration
              }
              const stopped = yield* Deferred.make<number>()
              playback.stopped = stopped
              send({ type: "stop" })
              // Interruptible, or the timeout couldn't fire when this runs as a finalizer.
              const at = yield* Deferred.await(stopped).pipe(Effect.interruptible, Effect.timeoutOption("2 seconds"))
              // A helper that cannot acknowledge stopping must not recover later
              // and play over the fallback, or whoever takes the device next.
              if (Option.isNone(at) && current === playback) {
                const socket = connection
                socket?.terminate()
                if (socket !== undefined && connection === socket) disconnected()
              }
              if (current === playback) current = undefined
              return Option.getOrElse(at, () => 0)
            })
            current = playback
            // It replaces the silence, if that's still playing.
            warming = undefined
            yield* Effect.addFinalizer(() => stop)
            send({ type: "play", id: playback.id, path: file, from })
            playback.duration = yield* restore(
              Deferred.await(playback.started).pipe(
                Effect.timeoutFail({
                  duration: "5 seconds",
                  onTimeout: () => new AudioError({ message: "The audio helper didn't start playing" }),
                }),
              ),
            ).pipe(Effect.onError(() => stop))

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
          }),
        )
      })

    const audio: Audio["Type"] = {
      play: (file, from = 0) =>
        play(file, from).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Playing with afplay, without listening", error).pipe(Effect.zipRight(fallbackPlay(file, from))),
          ),
        ),
      microphone: Effect.suspend(() =>
        listening && frames !== undefined ? Effect.map(PubSub.subscribe(frames), Option.some) : Effect.succeed(Option.none()),
      ),
      // Playing anything sets the helper up, so it plays a moment's silence. It isn't heard, and isn't waited for.
      warm: Effect.sync(() => {
        if (connection === undefined || listening || current !== undefined || warming !== undefined) return
        warming = crypto.randomUUID()
        send({ type: "play", id: warming, path: silence, from: 0 })
      }),
      rest: Effect.suspend(() => {
        warming = undefined
        send({ type: "rest" })
        // It stops whatever it's playing without saying so.
        quiet()
        const ended = endMicrophone()
        reportActivity()
        return ended
      }),
    }
    return Context.make(Audio, audio).pipe(
      Context.add(Shortcut.Shortcut, shortcut?.service ?? Shortcut.none),
      Context.add(Activity, activity),
    )
  })

/**
 * Plays and listens through the native helper, whose voice processing cancels
 * yapd's own voice out of the microphone, and which takes the shortcut. Starting
 * it asks for microphone access the first time. If it quits, the next update
 * starts it again, or right away for the shortcut, and plays with afplay if it can't.
 */
export const NativeAudio = Layer.scopedContext(
  Effect.zipRight(Helper.build, native((path) => Helper.launch(path, true))),
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
