import type { Socket as UnixSocket } from "bun"
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
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { readFileSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Config from "./Config.ts"
import * as Helper from "./Helper.ts"
import { run } from "./Process.ts"
import * as Shortcut from "./Shortcut.ts"
import * as Wav from "./Wav.ts"
import * as Wire from "./Wire.ts"

export class AudioError extends Data.TaggedError("AudioError")<{ readonly message: string; readonly cause?: unknown }> {}

export interface Playback {
  /** In seconds. */
  readonly duration: number
  /**
   * Whether it's known to be playing, as the audio helper says once it
   * starts. afplay can't say, so with it that's only known once `finished`
   * succeeds, since it may never have started at all.
   */
  readonly confirmed: boolean
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
     * own voice cancelled out once that's learnt: see `echo`. None when
     * there's no microphone to listen to.
     */
    readonly microphone: Effect.Effect<Option.Option<Queue.Dequeue<Float32Array>>, never, Scope.Scope>
    /**
     * Whether yapd's own voice may be in a frame from the microphone, so what
     * sounds like the user may be yapd: while it says its first seconds since
     * the microphone came on, before the echo cancellation has learnt its
     * voice. Told as the frame came in, so whoever listens knows even when
     * running behind.
     */
    readonly echo: (frame: Float32Array) => Effect.Effect<boolean>
    /** Turns the microphone off until the next update. */
    readonly rest: Effect.Effect<void>
    /**
     * Gets the speaker ready for something about to be said, since macOS takes
     * about a second to set it up from rest. Nothing when it's ready already.
     * Whoever calls it rests it again if nothing comes.
     */
    readonly warm: Effect.Effect<void>
    /**
     * A soft note, so he knows he was heard while what he said is worked
     * out: only while the microphone is open and nothing else plays, never
     * over a line, and never starting the helper. Whatever's played next
     * takes its place. It never counts as speaking.
     */
    readonly tick: Effect.Effect<void>
    /** When the helper last woke from rest, for how long a line waited on the speaker: none before it ever has, nor without it. */
    readonly woke?: Effect.Effect<Option.Option<Woke>>
    /**
     * Sends a file ahead to a device that's sent what it plays, once it's
     * likely to be played, so it's there by then: nothing on this Mac's own.
     */
    readonly prefetch?: (path: string) => Effect.Effect<void>
  }
>() {}

/** The helper waking from rest: when it was asked to play, and when it started playing, by the clock. */
export interface Woke {
  readonly asked: number
  readonly playing: number
}

/** What the speaker and microphone are doing. The microphone is open while yapd speaks too, so that wins. */
export type Doing = "idle" | "speaking" | "listening"

export class Activity extends Context.Tag("yapd/Activity")<
  Activity,
  {
    /** What they're doing, then each time it changes. */
    readonly changes: Stream.Stream<Doing>
  }
>() {}

/**
 * How long "speaking" holds once what plays ends, in milliseconds, so what
 * plays on from it right after, like the rest of a line from its first part,
 * doesn't have the menu's icon flicker.
 */
const between = 250

/** Turns whether something plays and whether the microphone is open into what they're doing, for whoever watches. */
const reporter = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<Doing>("idle")
  const runtime = yield* Effect.runtime<never>()
  const runSync = Runtime.runSync(runtime)
  const runFork = Runtime.runFork(runtime)
  let last: Doing = "idle"
  /** What it's doing once speaking is over, told only once nothing has played for a moment. */
  let after: { doing: Doing } | undefined
  const set = (doing: Doing) => {
    if (doing === last) return
    last = doing
    runSync(SubscriptionRef.set(ref, doing))
  }
  return {
    activity: { changes: ref.changes } satisfies Activity["Type"],
    report: (speaking: boolean, listening: boolean) => {
      const doing: Doing = speaking ? "speaking" : listening ? "listening" : "idle"
      if (after !== undefined) {
        // Playing again in that moment, it never stopped speaking.
        if (doing === "speaking") after = undefined
        else after.doing = doing
        return
      }
      if (doing === last) return
      if (last !== "speaking") return set(doing)
      const held = { doing }
      after = held
      runFork(
        Effect.sleep(between).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              if (after !== held) return
              after = undefined
              set(held.doing)
            }),
          ),
        ),
      )
    },
  }
})

/**
 * Plays with afplay, counting each one as it starts and ends. afplay plays a
 * file from its start, so from `from` it plays a copy of it from there,
 * removed once it's played.
 */
const afplay = (playing: (count: 1 | -1) => void) => (path: string, from = 0) =>
  Effect.gen(function* () {
    // Not one it can read, it's played all the same, of a length it can't tell.
    const duration = yield* Wav.duration(path).pipe(Effect.orElseSucceed(() => 0))
    const file = from > 0 ? join(tmpdir(), `yapd-from-${crypto.randomUUID()}.wav`) : path
    const removed = Effect.promise(() => rm(file, { force: true }))
    if (from > 0) {
      yield* Effect.acquireRelease(
        Wav.slice(path, from, file).pipe(Effect.mapError((cause) => new AudioError({ message: "Could not play it from where it's asked", cause }))),
        () => removed,
      )
    }
    const start = yield* Clock.currentTimeMillis
    playing(1)
    const fiber = yield* Effect.forkScoped(
      run(["afplay", file]).pipe(
        Effect.ensuring(Effect.sync(() => playing(-1))),
        Effect.ensuring(from > 0 ? removed : Effect.void),
      ),
    )
    return {
      duration,
      confirmed: false,
      finished: Fiber.join(fiber).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new AudioError({ message: "Could not play", cause })),
      ),
      // How far into the file it got, as the helper counts it.
      stop: Fiber.interrupt(fiber).pipe(
        Effect.zipRight(Clock.currentTimeMillis),
        Effect.map((now) => {
          const at = from + (now - start) / 1000
          return duration > 0 ? Math.min(duration, at) : at
        }),
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
      echo: () => Effect.succeed(false),
      rest: Effect.void,
      warm: Effect.void,
      tick: Effect.void,
    }
    // Nothing joins it, and what's opened is opened here.
    const devices: Devices["Type"] = {
      sockets: Option.none(),
      open: (url) => run(["open", url]).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
    }
    return Context.make(Audio, audio).pipe(Context.add(Activity, activity), Context.add(Devices, devices))
  }),
)

const Event = Schema.Union(
  Schema.Struct({ type: Schema.Literal("hello", "permission"), permission: Schema.String }),
  Schema.Struct({ type: Schema.Literal("active"), listening: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("rested") }),
  Schema.Struct({ type: Schema.Literal("playing"), id: Schema.String, duration: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("finished"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stopped"), id: Schema.optional(Schema.String), at: Schema.optional(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("failed"), id: Schema.String, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("shortcut"), registered: Schema.Boolean, message: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("pressed"), key: Schema.Literal("shortcut", "escape"), onPause: Schema.optional(Schema.Boolean) }),
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

/** One short, soft note, like a tap, that he was heard. */
const tap = wav(tone([[1000, 0.06]]))

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


/** What carries messages to and from one device: the helper's socket, or a client's connection to yapd. */
export interface Link {
  /** Sends a message, after whatever was sent before it. */
  readonly send: (message: object) => void
  /** Drops the connection at once, for a device that stopped answering. */
  readonly terminate: () => void
  /** Sends ahead a file it's likely to be told to play, to a device that's sent what it plays rather than reading it here. */
  readonly prefetch?: (path: string) => void
}

/** What a device tells the audio it's part of, besides what it plays and hears. */
export interface Owner {
  /** It said hello, so it holds no keys yet. */
  readonly greeted: () => void
  /** How taking the shortcut's keys went. */
  readonly registered: (ok: boolean, message?: string) => void
  /** `onPause` when a dictation it starts is to be sent once he stops talking. */
  readonly pressed: (key: Shortcut.Key, onPause?: boolean) => void
  /** What it plays, or whether it listens, may have changed. */
  readonly changed: () => void
  /** Its link went, and with it whatever it played and heard. */
  readonly lost: () => void
}

/** How long a device has to start playing, and to say it stopped: longer across the network. */
export interface Patience {
  readonly start: Duration.DurationInput
  readonly stop: Duration.DurationInput
}

/** For the helper, on this machine. */
const nearby: Patience = { start: "5 seconds", stop: "2 seconds" }

/** For a client, whose files may cross the world before they play. */
export const remote: Patience = { start: "15 seconds", stop: "5 seconds" }

/** What gets a device's speaker ready, and the note that he was heard, played as any file is. */
export interface Cues {
  readonly silence: string
  readonly tick: string
}

/** One device's speaker and microphone, through whatever link it has now. */
export interface Device {
  /** Its link from now on, in place of any it had. */
  readonly attach: (link: Link) => void
  /** That link went, ending whatever it played and heard: nothing when it's no longer the link it has. */
  readonly detach: (link: Link) => void
  /** One of the helper's messages, as JSON. */
  readonly event: (text: string) => void
  /** A frame from its microphone. */
  readonly frame: (frame: Float32Array) => void
  readonly linked: () => boolean
  /** Done by the next hello its link says. */
  readonly hello: Effect.Effect<Deferred.Deferred<void>>
  readonly speaking: () => boolean
  readonly listening: () => boolean
  /** Sends it a message as it is, like the shortcut's keys. */
  readonly send: (message: object) => void
  /** Played and heard here, failing at once while it has no link. */
  readonly audio: Audio["Type"]
}

/**
 * The helper's side of the protocol for one device, whatever carries it: what
 * it plays and whether it listens, as it says, and its microphone. What has
 * to do with the shortcut it hands to `owner`, which the device is part of.
 */
export const device = (
  owner: Owner,
  cues: Cues,
  options: {
    readonly patience?: Patience
    /** What a playback fails with when its link goes. */
    readonly gone?: string
    /** Says what it said of the microphone. */
    readonly permission?: (permission: string) => Effect.Effect<void>
    /** What its errors are said as, in the log. */
    readonly name?: string
  } = {},
) =>
  Effect.gen(function* () {
    const patience = options.patience ?? nearby
    const gone = options.gone ?? "The audio helper quit"
    const said = options.permission ?? permissionLog
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const runFork = yield* FiberSet.makeRuntime<never>()
    let frames: PubSub.PubSub<Float32Array> | undefined
    let link: Link | undefined
    let greeted: Deferred.Deferred<void> | undefined
    let current: Current | undefined
    /** The silence played to get the speaker ready, while it plays. It's nobody's playback. */
    let warming: string | undefined
    /** The note that he was heard, while it plays. Nobody's playback either, and never speaking. */
    let ticking: string | undefined
    let listening = false
    /** How long the echo cancellation has heard yapd for, in what it played to the end or stopped. */
    let heard = 0
    /** When what the helper is playing started, if it's playing. */
    let playingSince: number | undefined
    /** Whether it has played since it last rested, and when it was asked to play while it was resting, until it does. */
    let awake = false
    let waking: number | undefined
    let woke: Woke | undefined
    /** The frames yapd's own voice may be in, as they came in. */
    const echoes = new WeakSet<Float32Array>()
    let permission: string | undefined

    /** Detaches the old microphone immediately, and lets its listeners finish. */
    const endMicrophone = () => {
      const previous = frames
      frames = undefined
      listening = false
      return previous === undefined ? Effect.void : PubSub.shutdown(previous)
    }
    yield* Effect.addFinalizer(() => Effect.suspend(endMicrophone))

    const send = (message: object) => link?.send(message)
    const now = () => runSync(Clock.currentTimeMillis)
    /** The helper went quiet, so the echo cancellation heard yapd until now. */
    const quiet = () => {
      if (playingSince !== undefined) heard += now() - playingSince
      playingSince = undefined
    }
    /** It rested, or quit, so whatever's played next wakes it. */
    const asleep = () => {
      awake = false
      waking = undefined
    }
    /** Asked to play something while it rests, which wakes it. */
    const wake = () => {
      if (!awake) waking ??= now()
    }

    const frame = (samples: Float32Array) => {
      if (!listening || frames === undefined) return
      // Passed on even while yapd's own voice may be in it, which whoever listens tells from the user by what's said.
      // Whether it may is told now, in order with what the helper says it played, since they may be running behind.
      if (playingSince !== undefined && heard + now() - playingSince < learning) echoes.add(samples)
      runSync(PubSub.publish(frames, samples))
    }

    const handle = (text: string) => {
      const event = decodeEvent(text)
      if (Option.isNone(event)) return
      switch (event.value.type) {
        case "hello":
        case "permission":
          if (greeted !== undefined) Deferred.unsafeDone(greeted, Exit.void)
          if (event.value.permission !== permission) runFork(said(event.value.permission))
          permission = event.value.permission
          if (event.value.type === "hello") owner.greeted()
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
        case "rested":
          // It rested of its own accord, on an engine that didn't play anything, as `rest` asks it to. Said
          // before that playback fails, so whoever then asks for the microphone hears it's off rather than
          // listening to one that will never hear anything. An older helper never says.
          quiet()
          asleep()
          runFork(endMicrophone())
          return
        case "playing":
          // Awake now, whatever it plays, its warm-up silence too.
          if (waking !== undefined) woke = { asked: waking, playing: now() }
          waking = undefined
          awake = true
          // Silence, or a note so soft it's never taken for yapd talking, which neither speaks nor teaches the echo cancellation anything.
          if (event.value.id === warming || event.value.id === ticking) return
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
          if (event.value.id === ticking) {
            ticking = undefined
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
          if (event.value.id === ticking) {
            ticking = undefined
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
          if (event.value.id !== undefined && event.value.id === ticking) {
            ticking = undefined
            return
          }
          quiet()
          // Without an id, nothing was playing anymore: it had just finished.
          if (current?.stopped !== undefined && (event.value.id === undefined || event.value.id === current.id)) {
            Deferred.unsafeDone(current.stopped, Exit.succeed(event.value.at ?? current.duration))
          }
          return
        case "error":
          runFork(Effect.logWarning(`${options.name ?? "Audio helper"}: ${event.value.message}`))
          return
        case "shortcut":
          // In order with the presses that follow, which only count once it's said.
          owner.registered(event.value.registered, event.value.message)
          return
        case "pressed":
          owner.pressed(event.value.key, event.value.onPause)
      }
    }

    const detach = (was: Link) => {
      if (was !== link) return
      link = undefined
      warming = undefined
      ticking = undefined
      runFork(endMicrophone())
      quiet()
      asleep()
      if (current !== undefined) settle(current, new AudioError({ message: gone }), 0)
      current = undefined
      owner.lost()
    }

    const play = (file: string, from: number) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (link === undefined) return yield* new AudioError({ message: gone })
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
            const at = yield* Deferred.await(stopped).pipe(Effect.interruptible, Effect.timeoutOption(patience.stop))
            // A helper that cannot acknowledge stopping must not recover later
            // and play over the fallback, or whoever takes the device next.
            if (Option.isNone(at) && current === playback) {
              const was = link
              was?.terminate()
              if (was !== undefined) detach(was)
            }
            if (current === playback) current = undefined
            return Option.getOrElse(at, () => 0)
          })
          current = playback
          // It replaces the silence, or the note, if that's still playing.
          warming = undefined
          ticking = undefined
          yield* Effect.addFinalizer(() => stop)
          wake()
          send({ type: "play", id: playback.id, path: file, from })
          playback.duration = yield* restore(
            Deferred.await(playback.started).pipe(
              Effect.timeoutFail({
                duration: patience.start,
                onTimeout: () => new AudioError({ message: "The audio helper didn't start playing" }),
              }),
            ),
          ).pipe(Effect.onError(() => stop))

          // Should the helper wedge, the update still ends.
          const deadline = Duration.seconds(Math.max(0, playback.duration - from) + 10)
          return {
            duration: playback.duration,
            confirmed: true,
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

    const audio: Audio["Type"] = {
      play: (file, from = 0) => play(file, from),
      microphone: Effect.suspend(() =>
        listening && frames !== undefined ? Effect.map(PubSub.subscribe(frames), Option.some) : Effect.succeed(Option.none()),
      ),
      echo: (frame) => Effect.sync(() => echoes.has(frame)),
      // Playing anything sets the helper up, so it plays a moment's silence. It isn't heard, and isn't waited for.
      warm: Effect.sync(() => {
        if (link === undefined || listening || current !== undefined || warming !== undefined) return
        warming = crypto.randomUUID()
        wake()
        send({ type: "play", id: warming, path: cues.silence, from: 0 })
      }),
      // Over a line, the helper would stop it without a word, leaving it never to finish: so only while nothing plays.
      tick: Effect.sync(() => {
        if (link === undefined || !listening || current !== undefined || warming !== undefined || ticking !== undefined) return
        ticking = crypto.randomUUID()
        send({ type: "play", id: ticking, path: cues.tick, from: 0 })
      }),
      rest: Effect.suspend(() => {
        warming = undefined
        ticking = undefined
        send({ type: "rest" })
        // It stops whatever it's playing without saying so.
        quiet()
        asleep()
        const ended = endMicrophone()
        owner.changed()
        return ended
      }),
      woke: Effect.sync(() => Option.fromNullable(woke)),
      prefetch: (path) => Effect.sync(() => link?.prefetch?.(path)),
    }

    return {
      attach: (next) => {
        link = next
      },
      detach,
      event: (text) => {
        handle(text)
        owner.changed()
      },
      frame,
      linked: () => link !== undefined,
      hello: Effect.flatMap(Deferred.make<void>(), (hello) =>
        Effect.sync(() => {
          greeted = hello
          return hello
        }),
      ),
      speaking: () => playingSince !== undefined,
      listening: () => listening,
      send,
      audio,
    } satisfies Device
  })

/** One of the devices yapd plays through and hears from: this Mac's own, or a client's. */
export interface Speaker {
  readonly id: string
  /** What it's called in the log. */
  readonly name: string
  readonly audio: Audio["Type"]
  /** Whether it can take the shortcut's keys, which only a Mac's helper can. */
  readonly hotkeys: boolean
  /** Sends it a message as it is, like the shortcut's keys, or that a dictation began or ended. */
  readonly send: (message: object) => void
  /** Opens an address on it, when it can. */
  readonly open?: (url: string) => Effect.Effect<void, unknown>
  readonly speaking: () => boolean
  readonly listening: () => boolean
}

/** The part of a client's WebSocket yapd uses. */
export interface ClientSocket {
  readonly send: (data: string | Uint8Array) => unknown
  readonly close: () => void
  readonly terminate?: () => void
}

/** What a client connected to `/audio` says, until it closes. */
export interface Sockets {
  readonly open: (socket: ClientSocket) => void
  readonly message: (socket: ClientSocket, data: string | Uint8Array) => void
  readonly close: (socket: ClientSocket) => void
}

/** The devices beyond this Mac's own: clients that connect to yapd, and opening things on whichever is in use. */
export class Devices extends Context.Tag("yapd/Devices")<
  Devices,
  {
    /** Takes in clients on `/audio`. None while yapd plays with afplay, which no client can join. */
    readonly sockets: Option.Option<Sockets>
    /** Opens an address on the device in use, when it can, and says whether it did. */
    readonly open: (url: string) => Effect.Effect<boolean>
  }
>() {}

/** What a client says first, as the helper's hello, with who it is and what it can do. */
const Hello = Schema.parseJson(
  Schema.Struct({
    type: Schema.Literal("hello"),
    client: Schema.Struct({
      /** The same every time it connects, so it's known again. */
      id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
      name: Schema.String.pipe(Schema.maxLength(100)),
      /** Whether it takes the shortcut's keys, like a Mac's helper. */
      hotkeys: Schema.optional(Schema.Boolean),
      /** Whether it opens addresses, like a pull request, when asked. */
      opens: Schema.optional(Schema.Boolean),
    }),
  }),
)
const decodeHello = Schema.decodeUnknownOption(Hello)

/** How many files a client keeps that yapd sent it, the latest it used. */
const kept = 16

/** A client's link: what it's told to play by path here, it's sent first, once, and told to forget once it's one too many. */
const clientLink = (socket: ClientSocket): Link => {
  /** By the file's path, size and time of change, so a file written again is sent again, oldest first. */
  const sent = new Map<string, string>()
  const ship = (path: string): string | undefined => {
    try {
      const stat = statSync(path)
      const key = `${path}\n${stat.size}\n${stat.mtimeMs}`
      const known = sent.get(key)
      if (known !== undefined) {
        sent.delete(key)
        sent.set(key, known)
        return known
      }
      const id = crypto.randomUUID()
      socket.send(Wire.file(id, readFileSync(path)))
      sent.set(key, id)
      for (const [oldest, file] of sent) {
        if (sent.size <= kept) break
        sent.delete(oldest)
        socket.send(JSON.stringify({ type: "forget", file }))
      }
      return id
    } catch {
      return undefined
    }
  }
  return {
    send: (message) => {
      if ("type" in message && message.type === "play" && "path" in message && typeof message.path === "string") {
        const { path, ...play } = message
        // One it can't be sent, it's told to play as nothing, which it says it can't.
        socket.send(JSON.stringify({ ...play, file: ship(path) ?? "" }))
        return
      }
      socket.send(JSON.stringify(message))
    },
    terminate: () => (socket.terminate === undefined ? socket.close() : socket.terminate()),
    prefetch: (path) => void ship(path),
  }
}

/**
 * Plays through the device in use, and hears from it: the one last pressed on,
 * or the first there. This Mac's own helper, when there's `local`, is always
 * there. Clients join over `/audio`, and leave as they disconnect. What
 * started playing on one stays with it until it ends, wherever the next is
 * played. The shortcut is one for all of them: a Mac's helper takes its keys,
 * and a device with none, like a phone's button, presses it all the same.
 */
export const router = <E = never, R = never>(local?: (owner: Owner, cues: Cues, keepsKeys: boolean) => Effect.Effect<Speaker, E, R>) =>
  Effect.gen(function* () {
    const { activity, report } = yield* reporter
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const runFork = Runtime.runFork(runtime)
    const dir = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "yapd-cues-")),
        catch: (cause) => new Helper.HelperError({ message: "Could not prepare the audio's warm-up and tick", cause }),
      }),
      (dir) => Effect.tryPromise(() => rm(dir, { recursive: true, force: true })).pipe(
        Effect.catchAll((error) => Effect.logWarning("Could not remove the audio's warm-up and tick", error)),
      ),
    )
    const cues: Cues = { silence: join(dir, "silence.wav"), tick: join(dir, "tick.wav") }
    yield* Effect.tryPromise({
      try: () => Promise.all([Bun.write(cues.silence, quiet20ms), Bun.write(cues.tick, tap)]),
      catch: (cause) => new Helper.HelperError({ message: "Could not prepare the audio's warm-up and tick", cause }),
    })
    /** Each device there, with when it came, oldest first. */
    const joined: Array<{ readonly speaker: Speaker; readonly at: number }> = []
    /** When each was last pressed on, by its id, kept while it's away, so it's the one in use again once it's back. */
    const used = new Map<string, number>()
    const now = () => runSync(Clock.currentTimeMillis)
    /**
     * The one pressed on last; of those not pressed on since yapd started, a
     * Mac, with the shortcut, before a phone, which only takes over once it's
     * pressed, whichever reconnected first after a restart; then the first there.
     */
    const inUse = (): Speaker | undefined => {
      let best: { readonly speaker: Speaker; readonly used: number; readonly at: number } | undefined
      for (const { speaker, at } of joined) {
        const last = used.get(speaker.id) ?? Number.NEGATIVE_INFINITY
        const better =
          best === undefined ||
          last > best.used ||
          (last === best.used && speaker.hotkeys !== best.speaker.hotkeys ? speaker.hotkeys : last === best.used && at < best.at)
        if (better) best = { speaker, used: last, at }
      }
      return best?.speaker
    }
    /** The shortcut's keys go to the devices that can take them, and whether a dictation is on to every one. */
    const broadcast = (message: object) => {
      const keys = "type" in message && message.type === "shortcut"
      for (const { speaker } of joined) if (!keys || speaker.hotkeys) speaker.send(message)
    }
    const keys = yield* Config.shortcut
    // Taken once yapd knows whether it's on, which it may have been turned off before it stopped.
    const shortcut = Option.isSome(keys) ? yield* Shortcut.make(keys.value, broadcast, false) : undefined
    const changed = () => report(joined.some(({ speaker }) => speaker.speaking()), joined.some(({ speaker }) => speaker.listening()))
    const owner = (id: string, hotkeys: boolean, name = id): Owner => ({
      greeted: () => {
        if (shortcut !== undefined && hotkeys) runSync(shortcut.greeted)
      },
      registered: (ok, message) => {
        if (shortcut !== undefined) runSync(shortcut.registered(ok, message))
      },
      pressed: (key, onPause) => {
        if (id !== "local") runFork(Effect.logInfo(`${name} pressed ${key === "shortcut" ? "the shortcut" : "Escape"}`))
        used.set(id, now())
        if (shortcut !== undefined) runSync(hotkeys ? shortcut.pressed(key, onPause) : shortcut.direct(key, onPause))
      },
      changed,
      // Whatever was being dictated on the device in use goes with it.
      lost: () => {
        if (shortcut !== undefined && inUse()?.id === id) runSync(shortcut.quit)
        changed()
      },
    })
    if (local !== undefined) {
      joined.push({ speaker: yield* local(owner("local", true), cues, shortcut !== undefined), at: Number.NEGATIVE_INFINITY })
    }

    const audio: Audio["Type"] = {
      play: (file, from) =>
        Effect.suspend(() => {
          const speaker = inUse()
          return speaker === undefined ? Effect.fail(new AudioError({ message: "There's nothing to play on: no device is connected" })) : speaker.audio.play(file, from)
        }),
      microphone: Effect.suspend(() => inUse()?.audio.microphone ?? Effect.succeed(Option.none())),
      // Only the device that heard a frame ever marks it.
      echo: (frame) => Effect.map(Effect.forEach(joined, ({ speaker }) => speaker.audio.echo(frame)), (marked) => marked.some(Boolean)),
      // Every one, since one that played before the one in use changed may still be listening.
      rest: Effect.suspend(() => Effect.forEach([...joined], ({ speaker }) => speaker.audio.rest, { discard: true })),
      warm: Effect.suspend(() => inUse()?.audio.warm ?? Effect.void),
      tick: Effect.suspend(() => inUse()?.audio.tick ?? Effect.void),
      woke: Effect.suspend(() => inUse()?.audio.woke ?? Effect.succeedNone),
      prefetch: (path) => Effect.suspend(() => inUse()?.audio.prefetch?.(path) ?? Effect.void),
    }

    /** Each client's socket, with its device once it has said hello, and what closes along with it. */
    const clients = new Map<ClientSocket, { readonly link: Link; device?: Device; speaker?: Speaker; scope?: Scope.CloseableScope }>()
    /** Lets a client go, ending what it played and heard, and anything its device started. */
    const leave = (socket: ClientSocket) => {
      const client = clients.get(socket)
      if (client === undefined) return
      clients.delete(socket)
      client.device?.detach(client.link)
      const at = joined.findIndex(({ speaker }) => speaker === client.speaker)
      if (at >= 0) joined.splice(at, 1)
      // Closing it waits for what its device had running, which can't be done here, in the socket's own callback.
      if (client.scope !== undefined) runFork(Scope.close(client.scope, Exit.void))
      changed()
    }
    /** A client that said hello, which takes the place of one it had connected as before. */
    const enlist = (socket: ClientSocket, client: { readonly link: Link }, hello: typeof Hello.Type["client"]) => {
      for (const [other, known] of clients) {
        if (other !== socket && known.speaker?.id === hello.id) {
          leave(other)
          other.close()
        }
      }
      const scope = runSync(Scope.make())
      const made = runSync(
        device(owner(hello.id, hello.hotkeys === true, hello.name), cues, {
          patience: remote,
          gone: `${hello.name} went away`,
          name: hello.name,
          permission: (permission) => Effect.logInfo(`${hello.name} ${permission === "authorized" ? "can hear you" : `can't hear you: its microphone access is ${permission}`}`),
        }).pipe(Scope.extend(scope)),
      )
      made.attach(client.link)
      const speaker: Speaker = {
        id: hello.id,
        name: hello.name,
        audio: made.audio,
        hotkeys: hello.hotkeys === true,
        send: made.send,
        ...(hello.opens === true ? { open: (url: string) => Effect.sync(() => made.send({ type: "open", url })) } : {}),
        speaking: made.speaking,
        listening: made.listening,
      }
      clients.set(socket, { ...client, device: made, speaker, scope })
      joined.push({ speaker, at: now() })
      runSync(Effect.logInfo(`${hello.name} connected`))
      return made
    }
    const sockets: Sockets = {
      open: (socket) => {
        clients.set(socket, { link: clientLink(socket) })
      },
      message: (socket, data) => {
        const client = clients.get(socket)
        if (client === undefined) return
        if (typeof data !== "string") {
          const frame = Wire.microphone(data)
          if (frame !== undefined) client.device?.frame(frame)
          return
        }
        if (client.device !== undefined) return client.device.event(data)
        // Nothing counts until it says who it is.
        const hello = decodeHello(data)
        if (Option.isSome(hello)) enlist(socket, client, hello.value.client).event(data)
      },
      close: (socket) => {
        const name = clients.get(socket)?.speaker?.name
        leave(socket)
        if (name !== undefined) runSync(Effect.logInfo(`${name} disconnected`))
      },
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const socket of [...clients.keys()]) {
          leave(socket)
          socket.close()
        }
      }),
    )

    const devices: Devices["Type"] = {
      sockets: Option.some(sockets),
      open: (url) =>
        Effect.suspend(() => {
          const open = inUse()?.open
          return open === undefined ? Effect.succeed(false) : Effect.as(open(url), true)
        }).pipe(Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not open it", error), false))),
    }

    return Context.make(Audio, audio).pipe(
      Context.add(Shortcut.Shortcut, shortcut?.service ?? Shortcut.none),
      Context.add(Activity, activity),
      Context.add(Devices, devices),
    )
  })

/**
 * This Mac's own speaker and microphone, through the native helper, whose voice
 * processing cancels yapd's own voice out of the microphone, and which takes
 * the shortcut's keys. Its launcher and fallback playback are supplied
 * separately, so the protocol can also run without an audio device.
 */
const helper = (
  launchHelper: (path: string) => Effect.Effect<unknown, Helper.HelperError>,
  fallback: Audio["Type"]["play"] | undefined,
  owner: Owner,
  cues: Cues,
  keepsKeys: boolean,
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
    const runFork = yield* FiberSet.makeRuntime<never>()
    let closing = false
    let afplaying = 0
    let quitAt = Number.NEGATIVE_INFINITY

    /** The shortcut needs a helper running, but one that keeps quitting waits for the next update. */
    const restart: Effect.Effect<void> = Effect.suspend(() =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const again = keepsKeys && now - quitAt > 60_000
        quitAt = now
        if (!again) return yield* Effect.logWarning("The audio helper quit, it starts again with the next update")
        yield* Effect.logWarning("The audio helper quit, starting it again for the shortcut")
        yield* connect.pipe(Effect.catchAll((error) => Effect.logWarning("Could not start the audio helper", error)))
      }),
    )
    const own = yield* device(
      {
        ...owner,
        lost: () => {
          owner.lost()
          if (!closing) runFork(restart)
        },
      },
      cues,
    )
    const fallbackPlay =
      fallback ??
      afplay((count) => {
        afplaying += count
        owner.changed()
      })

    interface Connected {
      readonly decoder: Helper.Decoder
      readonly link: Link
      /** Writes out what the socket hasn't taken yet, once it drains. */
      readonly flush: () => void
    }
    let connection: UnixSocket<Connected> | undefined
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.listen<Connected>({
            unix: path,
            socket: {
              open: (socket) => {
                let unsent: Array<Uint8Array> = []
                const flush = () => {
                  while (unsent.length > 0) {
                    const next = unsent[0]!
                    const written = socket.write(next)
                    if (written < next.length) {
                      unsent[0] = next.subarray(Math.max(0, written))
                      return
                    }
                    unsent.shift()
                  }
                }
                const link: Link = {
                  send: (message) => {
                    unsent.push(Helper.encode(message))
                    if (unsent.length === 1) flush()
                  },
                  terminate: () => {
                    unsent = []
                    socket.terminate()
                  },
                }
                socket.data = { decoder: new Helper.Decoder(), link, flush }
                connection?.end()
                connection = socket
                own.attach(link)
              },
              data: (socket, chunk) => {
                if (socket !== connection) return
                for (const message of socket.data.decoder.push(chunk)) {
                  if (message.kind === Helper.Kind.pcm) own.frame(new Float32Array(message.payload.buffer))
                  else own.event(new TextDecoder().decode(message.payload))
                }
                owner.changed()
              },
              drain: (socket) => {
                if (socket === connection) socket.data.flush()
              },
              close: (socket) => {
                if (socket !== connection) return
                connection = undefined
                own.detach(socket.data.link)
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
      const hello = yield* own.hello
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
      if (own.linked()) return
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

    const audio: Audio["Type"] = {
      play: (file, from = 0) =>
        connect.pipe(
          Effect.mapError((cause) => new AudioError({ message: cause.message, cause })),
          Effect.zipRight(own.audio.play(file, from)),
          Effect.catchAll((error) =>
            Effect.logWarning("Playing with afplay, without listening", error).pipe(Effect.zipRight(fallbackPlay(file, from))),
          ),
        ),
      microphone: own.audio.microphone,
      echo: own.audio.echo,
      warm: own.audio.warm,
      // Not over afplay either, which nothing would tell to stop for it.
      tick: Effect.suspend(() => (afplaying > 0 ? Effect.void : own.audio.tick)),
      rest: own.audio.rest,
      woke: own.audio.woke ?? Effect.succeedNone,
    }
    return {
      id: "local",
      name: "this Mac",
      audio,
      hotkeys: true,
      send: own.send,
      open: (url) => run(["open", url]),
      speaking: () => own.speaking() || afplaying > 0,
      listening: own.listening,
    } satisfies Speaker
  })

/**
 * Plays and hears through this Mac's native helper, and through any client
 * that connects, whichever is in use. Its launcher and fallback playback are
 * supplied separately, so the protocol can also run without an audio device.
 */
export const native = (
  launchHelper: (path: string) => Effect.Effect<unknown, Helper.HelperError>,
  fallback?: Audio["Type"]["play"],
) => router((owner, cues, keepsKeys) => helper(launchHelper, fallback, owner, cues, keepsKeys))

/**
 * Plays and listens through the native helper, whose voice processing cancels
 * yapd's own voice out of the microphone, and which takes the shortcut. Starting
 * it asks for microphone access the first time. If it quits, the next update
 * starts it again, or right away for the shortcut, and plays with afplay if it can't.
 */
export const NativeAudio = Layer.scopedContext(
  Effect.zipRight(Helper.build, native((path) => Helper.launch(path, true))),
)

/** Away from a Mac, yapd plays and hears only through the clients that connect to it. */
export const ClientAudio = Layer.scopedContext(router())

/** Without the helper, nothing takes the shortcut. */
const noShortcut = (keys: Option.Option<Shortcut.Keys>, log: (keys: string) => Effect.Effect<void>) =>
  Layer.effect(
    Shortcut.Shortcut,
    Option.match(keys, { onNone: () => Effect.void, onSome: (set) => log(Shortcut.format(set)) }).pipe(
      Effect.as(Shortcut.none),
    ),
  )

/** On a Mac, the helper when listening is on and it builds, afplay and no shortcut otherwise. Elsewhere, clients only. */
export const DeviceAudio = Layer.unwrapEffect(
  Effect.gen(function* () {
    // Read here too, so a shortcut it can't read stops the daemon rather than falling back to afplay.
    const keys = yield* Config.shortcut
    if (process.platform !== "darwin") return ClientAudio
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
