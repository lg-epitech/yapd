import type { Subprocess } from "bun"
import { Clock, Context, Data, Deferred, Effect, Exit, Fiber, FiberId, Layer, Runtime } from "effect"
import { KokoroTTS, TextSplitterStream } from "kokoro-js"
import * as Config from "./Config.ts"
import { type ProcessError, run } from "./Process.ts"

/** Renders speech to an audio file ahead of time, so playback never waits on synthesis. */
export class Voice extends Context.Tag("yapd/Voice")<
  Voice,
  { readonly render: (text: string, path: string) => Effect.Effect<void, ProcessError> }
>() {}

/** File extension `render` writes. */
export const extension = ".wav"

export class KokoroError extends Data.TaggedError("KokoroError")<{ readonly cause: unknown }> {}

/** Kokoro's voices, with samples. */
const voices = "https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md"

const say = (text: string, path: string) => run(["say", "--data-format=LEI16@24000", "-o", path], { stdin: text })

/**
 * Longest text Kokoro renders at once, in characters. It reads at most 510
 * phoneme tokens and silently drops the rest; English takes up to about 1.6 a
 * character once numbers are spelled out.
 */
const longest = 250

const pack = (pieces: ReadonlyArray<string>, limit: number) =>
  pieces.reduce<Array<string>>((parts, piece) => {
    const last = parts.at(-1)
    if (last !== undefined && last.length + 1 + piece.length <= limit) parts[parts.length - 1] = `${last} ${piece}`
    else parts.push(piece)
    return parts
  }, [])

/** Packs pieces into as few parts as fit, splitting any that are too long at the next, finer boundary. */
const fit = (pieces: ReadonlyArray<string>, limit: number, boundaries: ReadonlyArray<RegExp>): Array<string> => {
  const [boundary, ...finer] = boundaries
  return pack(
    pieces.flatMap((piece) =>
      piece.length <= limit || boundary === undefined ? [piece] : fit(piece.split(boundary), limit, finer),
    ),
    limit,
  )
}

/** Whole sentences where possible, then clauses, then words, each part short enough for Kokoro to read all of it. */
export const split = (text: string, limit = longest) => {
  const splitter = new TextSplitterStream()
  splitter.push(text)
  return fit([...splitter], limit, [/(?<=[,;:])\s+/, /\s+/])
}

/** Louder than this is speech rather than the quiet Kokoro trails off into. */
const loud = 0.02
/** Quieter than this is the silence Kokoro pads each render with. */
const silent = 0.003
/** Quiet after a sentence, about what Kokoro leaves between sentences it reads in one go. */
const pause = 0.2
/** Fade at the end of each part, so the cut in its trailing quiet can't click. */
const fade = 0.05
/** Kept before the next part's first sound, so its onset stays whole. */
const lead = 0.01

/**
 * Joins parts rendered separately as if read in one go: each part's trailing
 * quiet is cut to a sentence pause and faded out, and the padding before the
 * next one is dropped.
 */
export const join = (parts: ReadonlyArray<Float32Array>, rate: number) => {
  const pieces = parts.map((part, index) => {
    const first = index === 0
    const last = index === parts.length - 1
    const start = first ? 0 : Math.max(0, part.findIndex((sample) => Math.abs(sample) >= silent) - Math.round(lead * rate))
    const end = last
      ? part.length
      : Math.min(part.length, part.findLastIndex((sample) => Math.abs(sample) >= loud) + 1 + Math.round(pause * rate))
    const piece = part.slice(start, end)
    if (!last) {
      const samples = Math.min(piece.length, Math.round(fade * rate))
      for (let i = 0; i < samples; i++) piece[piece.length - samples + i]! *= 1 - (i + 1) / samples
    }
    return piece
  })
  const joined = new Float32Array(pieces.reduce((length, piece) => length + piece.length, 0))
  let offset = 0
  for (const piece of pieces) {
    joined.set(piece, offset)
    offset += piece.length
  }
  return joined
}

/** What the daemon asks of the Kokoro process. */
export type Request =
  | { readonly type: "render"; readonly id: number; readonly text: string; readonly path: string }
  /** It no longer needs that render. */
  | { readonly type: "cancel"; readonly id: number }

/** What the Kokoro process tells the daemon. */
export type Reply =
  /** It has the model and is setting it up, which shouldn't take long. */
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly device: string }
  /** It couldn't load, so there's no point asking it anything. */
  | { readonly type: "unavailable"; readonly reason: string }
  | { readonly type: "rendered"; readonly id: number }
  | { readonly type: "failed"; readonly id: number; readonly reason: string }
  | { readonly type: "warning"; readonly message: string }

/** Where the Kokoro process runs the model. It takes the GPU when there is one. */
export type Device = "GPU" | "CPU"

interface Child {
  readonly process: Subprocess
  /** Settles once it has loaded Kokoro, or failed to. */
  readonly ready: Deferred.Deferred<void, KokoroError>
  readonly renders: Map<number, Deferred.Deferred<void, KokoroError>>
  /** Stops it, for a reason that isn't its fault. */
  readonly stop: () => void
}

/** How long an update waits for Kokoro to load, like on a first start while it downloads, before using say. */
const patience = "20 seconds"

/** How long setting the model up may take once it's downloaded. */
const setup = "60 seconds"

/**
 * Kokoro in its own process, src/Kokoro.ts, started with `command` right away,
 * and again by the next render after it stops, so the daemon only waits on it.
 * The process writes the file, effect included.
 */
export const kokoro = (command: ReadonlyArray<string>, voice: string, effect: string) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runFork = Runtime.runFork(runtime)
    const now = () => Runtime.runSync(runtime)(Clock.currentTimeMillis)
    let current: Child | undefined
    let failedAt = Number.NEGATIVE_INFINITY
    let next = 0
    /** Until a process on the GPU crashes or hangs, which one on the CPU is less likely to. */
    let device: Device = "GPU"
    const leaveGpu = () => {
      if (device === "CPU") return
      device = "CPU"
      runFork(Effect.logWarning("Kokoro's process stopped or hung on the GPU, so it runs on the CPU from now on"))
    }

    const start = Effect.gen(function* () {
      const ready = Deferred.unsafeMake<void, KokoroError>(FiberId.none)
      const renders = new Map<number, Deferred.Deferred<void, KokoroError>>()
      let loaded = false
      let stopped = false
      let deadline: Fiber.RuntimeFiber<void> | undefined
      const stop = () => {
        stopped = true
        child.kill()
      }
      const receive = (reply: Reply) => {
        switch (reply.type) {
          case "loading":
            // One that hangs here, like on a wedged GPU, would never answer.
            deadline = runFork(
              Effect.sleep(setup).pipe(
                Effect.zipRight(
                  Effect.sync(() => {
                    if (loaded) return
                    failedAt = now()
                    leaveGpu()
                    stop()
                  }),
                ),
              ),
            )
            return
          case "ready":
            loaded = true
            Deferred.unsafeDone(ready, Exit.void)
            runFork(Effect.logInfo(`Kokoro ready with voice ${voice}, on the ${reply.device}`))
            return
          case "unavailable":
            failedAt = now()
            Deferred.unsafeDone(ready, Exit.fail(new KokoroError({ cause: reply.reason })))
            stop()
            return
          case "rendered": {
            const render = renders.get(reply.id)
            if (render !== undefined) Deferred.unsafeDone(render, Exit.void)
            return
          }
          case "failed": {
            const render = renders.get(reply.id)
            if (render !== undefined) Deferred.unsafeDone(render, Exit.fail(new KokoroError({ cause: reply.reason })))
            return
          }
          case "warning":
            runFork(Effect.logWarning(reply.message))
        }
      }
      const child = yield* Effect.try({
        try: () =>
          Bun.spawn([...command, voice, effect, device], {
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
            ipc: (reply: Reply) => receive(reply),
          }),
        catch: (cause) => new KokoroError({ cause }),
      })
      const started: Child = { process: child, ready, renders, stop }
      void child.exited.then(() => {
        if (current === started) current = undefined
        if (deadline !== undefined) runFork(Fiber.interrupt(deadline))
        // It crashed while loading or rendering. Most likely the GPU, which the next one then leaves alone,
        // and a crash while loading would only happen again, so the next minute goes straight to say.
        if (!stopped && (!loaded || renders.size > 0)) {
          leaveGpu()
          if (!loaded) failedAt = now()
        }
        const gone = new KokoroError({ cause: "Kokoro's process stopped" })
        Deferred.unsafeDone(ready, Exit.fail(gone))
        for (const render of renders.values()) Deferred.unsafeDone(render, Exit.fail(gone))
      })
      current = started
      return started
    })

    const connection = Effect.suspend(() => {
      if (current !== undefined) return Effect.succeed(current)
      // One that won't load would only hold each update up before it falls back anyway.
      return now() - failedAt < 60_000 ? Effect.fail(new KokoroError({ cause: "Kokoro couldn't load a moment ago" })) : start
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => current?.stop()))
    // So the first update doesn't wait for it to load.
    yield* connection.pipe(Effect.ignore)

    const tell = (child: Child, request: Request) =>
      Effect.sync(() => {
        try {
          child.process.send(request)
        } catch {
          // It stopped, which fails whatever waits on it.
        }
      })

    const render = (text: string, path: string) =>
      Effect.gen(function* () {
        const child = yield* connection
        // Still loading, it carries on for the next update, and this one uses say.
        yield* Deferred.await(child.ready).pipe(
          Effect.timeoutFail({ duration: patience, onTimeout: () => new KokoroError({ cause: "Kokoro is still loading" }) }),
        )
        const id = ++next
        const rendered = yield* Deferred.make<void, KokoroError>()
        child.renders.set(id, rendered)
        yield* tell(child, { type: "render", id, text, path })
        yield* Deferred.await(rendered).pipe(
          Effect.timeout("60 seconds"),
          Effect.catchTag("TimeoutException", () =>
            // It may be stuck, like on a wedged GPU, so the next render gets a new one.
            Effect.sync(() => {
              leaveGpu()
              child.stop()
            }).pipe(Effect.zipRight(Effect.fail(new KokoroError({ cause: "Kokoro's process didn't answer" })))),
          ),
          Effect.onInterrupt(() => tell(child, { type: "cancel", id })),
          Effect.ensuring(Effect.sync(() => child.renders.delete(id))),
        )
      })

    return { render }
  })

/**
 * Kokoro 82M, run locally, on the GPU when it can. The model downloads on first
 * start and loads in the background. If it can't load or render, updates fall
 * back to `say`. The effect needs ffmpeg; without it, updates play unprocessed.
 */
export const KokoroVoice = Layer.scoped(
  Voice,
  Effect.gen(function* () {
    const name = yield* Config.voice
    // Kokoro's voices don't need the model, and a name it doesn't have won't start working later.
    if (!(name in KokoroTTS.prototype.voices)) {
      yield* Effect.logWarning(`Kokoro has no voice "${name}", so yapd uses say. Pick one from ${voices}`)
      return { render: say }
    }
    const voice = yield* kokoro([process.execPath, `${import.meta.dir}/Kokoro.ts`], name, yield* Config.effect)
    return {
      render: (text, path) =>
        voice.render(text, path).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Kokoro failed, using say", error).pipe(Effect.zipRight(say(text, path))),
          ),
        ),
    }
  }),
)
