import type { Subprocess } from "bun"
import { Cause, Clock, Context, Data, Deferred, Effect, Exit, Fiber, FiberId, Layer, Runtime, type Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as Path from "node:path"
import * as Config from "./Config.ts"
import { type ProcessError, run } from "./Process.ts"
import { TextSplitterStream } from "./vendor/kokoro/splitter.js"

/** Renders speech to an audio file ahead of time, so playback never waits on synthesis. */
export class Voice extends Context.Tag("yapd/Voice")<
  Voice,
  {
    readonly render: (text: string, path: string) => Effect.Effect<void, ProcessError>
    /**
     * Renders like `render`, with the first sentences ready to play early, in a
     * file of their own, while the rest renders. Both files are the caller's to
     * remove. Closing the scope before the whole is rendered gives it up, and
     * fails whatever of it is still awaited with a KokoroError.
     */
    readonly renderFirst?: (text: string, path: string) => Effect.Effect<Rendering, never, Scope.Scope>
  }
>() {}

/** A render whose start can play before the rest is ready. */
export interface Rendering<E = ProcessError | KokoroError> {
  /**
   * The file to start playing, as soon as there is one: the first sentences
   * alone when the text goes on after them, else the whole file.
   */
  readonly first: Effect.Effect<string, E>
  /**
   * Waits for the whole file, which starts exactly as the first part does,
   * sample for sample, so it plays on from where that one ends.
   */
  readonly whole: Effect.Effect<void, E>
}

/** File extension `render` writes. */
export const extension = ".wav"

export class KokoroError extends Data.TaggedError("KokoroError")<{ readonly cause: unknown }> {}

/**
 * Starts a render in the scope, with its first part early when `render` makes
 * one and calls `part` with its file. Without one, the whole is the first.
 */
const rendering =
  <E>(render: (text: string, path: string, part: (path: string) => void) => Effect.Effect<void, E>) =>
  (text: string, path: string) =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<string, E | KokoroError>()
      const whole = yield* Deferred.make<void, E | KokoroError>()
      const settle = (exit: Exit.Exit<void, E | KokoroError>) =>
        Effect.zipRight(Deferred.done(first, Exit.as(exit, path)), Deferred.done(whole, exit))
      // Whoever waits on it elsewhere, like the conversation playing its first part, hears it was given up as a
      // failure rather than an interruption of their own. Even when the scope closes before the render has started.
      const givenUp = Exit.fail(new KokoroError({ cause: "Given up" }))
      yield* Effect.addFinalizer(() => settle(givenUp))
      yield* render(text, path, (part) => Deferred.unsafeDone(first, Exit.succeed(part))).pipe(
        Effect.onExit((exit) => settle(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause) ? givenUp : exit)),
        Effect.forkScoped,
      )
      return { first: Deferred.await(first), whole: Deferred.await(whole) } satisfies Rendering<E | KokoroError>
    })

/** Renders with the first sentences early when the voice can, else the whole at once, which then plays first. */
export const early = (voice: Voice["Type"], text: string, path: string): Effect.Effect<Rendering, never, Scope.Scope> =>
  voice.renderFirst?.(text, path) ?? rendering(voice.render)(text, path)

/** Where Kokoro's model and voices come from. */
export const kokoroRepo = "onnx-community/Kokoro-82M-v1.0-ONNX"

/** Kokoro's voices, with samples. */
const voicesPage = "https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md"

/** The voices Kokoro has in English, which its first letter says: "a" is American and "b" British. */
export const voices: ReadonlySet<string> = new Set([
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily", "bm_george", "bm_lewis", "bm_daniel", "bm_fable",
])

const say = (text: string, path: string) => run(["say", "--data-format=LEI16@24000", "-o", path], { stdin: text })

/** Clauses, then words: where a sentence too long for Kokoro to read in one go breaks. */
const boundaries = [/(?<=[,;:])\s+/, /\s+/]

/**
 * The parts Kokoro reads, each in one go: the whole text when it fits, else
 * whole sentences, as many as fit together. Only a sentence too long on its own
 * breaks, at clauses, then words, since a cut sentence loses its intonation.
 */
export const split = <E>(text: string, fits: (text: string) => Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    // Nothing to say, which Kokoro would still render as a short sound.
    if (text.trim() === "") return []
    if (yield* fits(text)) return [text]
    const splitter = new TextSplitterStream()
    splitter.push(text)
    splitter.close()
    return yield* pack([...splitter], boundaries, fits)
  })

/** Packs pieces into as few parts as fit, breaking any that don't at the next, finer boundary. */
const pack = <E>(
  pieces: ReadonlyArray<string>,
  [boundary, ...finer]: ReadonlyArray<RegExp>,
  fits: (text: string) => Effect.Effect<boolean, E>,
): Effect.Effect<Array<string>, E> =>
  Effect.gen(function* () {
    const parts: Array<string> = []
    for (const piece of pieces) {
      const last = parts.at(-1)
      if (last !== undefined && (yield* fits(`${last} ${piece}`))) parts[parts.length - 1] = `${last} ${piece}`
      else if (boundary === undefined || (yield* fits(piece))) parts.push(piece)
      else parts.push(...(yield* pack(piece.split(boundary), finer, fits)))
    }
    return parts
  })

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

/** A part as `join` places it: unless it's first, without the padding before it, and unless it's last, cut and faded. */
const place = (part: Float32Array, rate: number, first: boolean, last: boolean) => {
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
}

/**
 * Joins parts rendered separately as if read in one go: each part's trailing
 * quiet is cut to a sentence pause and faded out, and the padding before the
 * next one is dropped.
 */
export const join = (parts: ReadonlyArray<Float32Array>, rate: number) => {
  const pieces = parts.map((part, index) => place(part, rate, index === 0, index === parts.length - 1))
  const joined = new Float32Array(pieces.reduce((length, piece) => length + piece.length, 0))
  let offset = 0
  for (const piece of pieces) {
    joined.set(piece, offset)
    offset += piece.length
  }
  return joined
}

/** The start of what `join` makes with `part` first, which can play before the rest is rendered. */
export const head = (part: Float32Array, rate: number) => place(part, rate, true, false)

/** Words a first part has at least, when there are enough sentences, so it plays for longer than the rest takes to render. */
const enough = 6

const words = (text: string) => (text === "" ? 0 : text.split(/\s+/).length)

/**
 * Where a text splits so its start can play while the rest renders: after the
 * first whole sentences, about `enough` words of them, that Kokoro reads in one
 * go. None for a single sentence, or a first one too long to read in one go,
 * since a part never ends mid-sentence.
 */
export const opening = <E>(text: string, fits: (text: string) => Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    const splitter = new TextSplitterStream()
    splitter.push(text)
    splitter.close()
    const sentences = [...splitter]
    let first = ""
    let taken = 0
    // At least one sentence is left for the rest.
    while (taken < sentences.length - 1 && words(first) < enough) {
      const longer = first === "" ? sentences[taken]! : `${first} ${sentences[taken]}`
      if (!(yield* fits(longer))) break
      first = longer
      taken++
    }
    return taken === 0 ? undefined : { first, rest: sentences.slice(taken).join(" ") }
  })

/** What the daemon asks of the Kokoro process. */
export type Request =
  | {
      readonly type: "render"
      readonly id: number
      readonly text: string
      readonly path: string
      /** Where to save the first sentences on their own, as soon as they're rendered, when the text goes on after them. */
      readonly first?: string
    }
  /** It no longer needs that render. */
  | { readonly type: "cancel"; readonly id: number }

/** What the Kokoro process tells the daemon. */
export type Reply =
  /** It has the model and is setting it up, which shouldn't take long. */
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly device: string }
  /** It couldn't load, so there's no point asking it anything. */
  | { readonly type: "unavailable"; readonly reason: string }
  /** The first sentences of a render that asked for them are at `path`, as the whole will start. The whole follows. */
  | { readonly type: "part"; readonly id: number; readonly path: string }
  | { readonly type: "rendered"; readonly id: number }
  | { readonly type: "failed"; readonly id: number; readonly reason: string }
  /** It dropped a render the daemon gave up on, or finished it and removed the file. */
  | { readonly type: "cancelled"; readonly id: number }
  | { readonly type: "warning"; readonly message: string }

/** Where the Kokoro process runs the model. It takes the GPU when there is one. */
export type Device = "GPU" | "CPU"

/** A render the process was asked for. */
interface Asked {
  readonly finished: Deferred.Deferred<void, KokoroError>
  /** Hears where its first part is, when it asked for one. */
  readonly part?: (path: string) => void
}

interface Child {
  readonly process: Subprocess
  /** Settles once it has loaded Kokoro, or failed to. */
  readonly ready: Deferred.Deferred<void, KokoroError>
  readonly renders: Map<number, Asked>
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
    const scope = yield* Effect.scope
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
      const renders = new Map<number, Asked>()
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
          case "part":
            renders.get(reply.id)?.part?.(reply.path)
            return
          case "rendered": {
            const render = renders.get(reply.id)
            if (render !== undefined) Deferred.unsafeDone(render.finished, Exit.void)
            return
          }
          case "failed":
          case "cancelled": {
            const render = renders.get(reply.id)
            const cause = reply.type === "failed" ? reply.reason : "Cancelled"
            if (render !== undefined) Deferred.unsafeDone(render.finished, Exit.fail(new KokoroError({ cause })))
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
        for (const render of renders.values()) Deferred.unsafeDone(render.finished, Exit.fail(gone))
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

    const lock = yield* Effect.makeSemaphore(1)

    const tell = (child: Child, request: Request) =>
      Effect.sync(() => {
        try {
          child.process.send(request)
        } catch {
          // It stopped, which fails whatever waits on it.
        }
      })

    /**
     * Renders `text` to `path`. With `part`, the first sentences come early too,
     * in a file of their own that `part` hears about once it's there.
     */
    const render = (text: string, path: string, part?: (path: string) => void) =>
      Effect.gen(function* () {
        const child = yield* connection
        // Still loading, it carries on for the next update, and this one uses say.
        yield* Deferred.await(child.ready).pipe(
          Effect.timeoutFail({ duration: patience, onTimeout: () => new KokoroError({ cause: "Kokoro is still loading" }) }),
        )
        // One at a time, as the process renders them, so the time limit only counts its own render. One given up on
        // keeps its turn, and its time limit, until the process is done with it too, since it only stops between renders.
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(lock.take(1))
            // It may have stopped while this waited its turn.
            if (current !== child) {
              yield* lock.release(1)
              return yield* new KokoroError({ cause: "Kokoro's process stopped" })
            }
            const id = ++next
            const finished = yield* Deferred.make<void, KokoroError>()
            // Next to the whole, so it goes wherever that one goes.
            const first = part === undefined ? undefined : `${path}.first${extension}`
            let handed = false
            child.renders.set(id, {
              finished,
              ...(part === undefined
                ? {}
                : {
                    part: (file: string) => {
                      handed = true
                      part(file)
                    },
                  }),
            })
            yield* tell(child, { type: "render", id, text, path, ...(first === undefined ? {} : { first }) })
            let abandoned = false
            const remove = (files: ReadonlyArray<string | undefined>) =>
              Effect.promise(() => Promise.all(files.map((file) => (file === undefined ? undefined : rm(file, { force: true })))))
            const turn = yield* Deferred.await(finished).pipe(
              // The process may only hear it was given up on once it's done, busy as it is rendering, so its files are removed here.
              Effect.tap(() => (abandoned ? remove([path, first]) : Effect.void)),
              Effect.timeout("60 seconds"),
              Effect.catchTag("TimeoutException", () =>
                // It may be stuck, like on a wedged GPU, so the next render gets a new one.
                Effect.sync(() => {
                  leaveGpu()
                  child.stop()
                }).pipe(Effect.zipRight(Effect.fail(new KokoroError({ cause: "Kokoro's process didn't answer" })))),
              ),
              // A first part nobody heard about is nobody else's to remove, and nor is any file of one given up on,
              // since whoever gave up may have stopped before they heard where its part was.
              Effect.tapError(() => (abandoned ? remove([path, first]) : handed ? Effect.void : remove([first]))),
              Effect.ensuring(Effect.zipRight(Effect.sync(() => child.renders.delete(id)), lock.release(1))),
              Effect.interruptible,
              Effect.forkIn(scope),
            )
            return yield* restore(Fiber.join(turn)).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  abandoned = true
                }).pipe(Effect.zipRight(tell(child, { type: "cancel", id }))),
              ),
            )
          }),
        )
      })

    return { render, renderFirst: rendering(render) }
  })

/**
 * Kokoro, with `fallback` rendering whatever it fails to. Not once a first part
 * is out, since what the fallback makes of the whole wouldn't carry on from it.
 */
export const withFallback = (
  render: (text: string, path: string, part?: (path: string) => void) => Effect.Effect<void, KokoroError>,
  fallback: (text: string, path: string) => Effect.Effect<void, ProcessError>,
): Voice["Type"] => {
  const instead = (text: string, path: string) => (error: KokoroError) =>
    Effect.logWarning("Kokoro failed, using say", error).pipe(Effect.zipRight(fallback(text, path)))
  return {
    render: (text, path) => render(text, path).pipe(Effect.catchAll(instead(text, path))),
    renderFirst: rendering((text, path, part) => {
      let out = false
      return render(text, path, (file) => {
        out = true
        part(file)
      }).pipe(
        // Once its first part is out, what say makes of the whole wouldn't carry on from it, in another voice and pace.
        Effect.catchAll((error): Effect.Effect<void, KokoroError | ProcessError> => (out ? Effect.fail(error) : instead(text, path)(error))),
      )
    }),
  }
}

/** Lines this short are kept once rendered: acknowledgements, questions, notices. */
const brief = 160

/**
 * Keeps what's rendered of short lines, the ones yapd says again and again
 * like "On it.", so saying them again is a copy rather than a render. The
 * newest `most` are kept, in `dir`. One rendered for someone who stopped
 * waiting is still kept, for whoever asks next.
 */
export const remembering = (voice: Voice["Type"], dir: string, most = 64) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const kept = new Map<string, Deferred.Deferred<string, ProcessError>>()
    const forget = (text: string, entry: Deferred.Deferred<string, ProcessError>) =>
      Effect.suspend(() => {
        if (kept.get(text) !== entry) return Effect.void
        kept.delete(text)
        // Its file goes once it's there, which may be after a render that's still under way.
        return Deferred.await(entry).pipe(
          Effect.flatMap((file) => Effect.promise(() => rm(file, { force: true }))),
          Effect.ignore,
          // Stoppable even when let go of while a line is being kept, so it never holds shutdown up.
          Effect.interruptible,
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      })

    /**
     * The line's entry, rendering it if there's none. All at once, so a caller
     * stopped halfway can't leave an entry behind that nothing will ever render.
     */
    const claim = (text: string) =>
      Effect.gen(function* () {
        const found = kept.get(text)
        if (found !== undefined) {
          // Last, as the most recently used.
          kept.delete(text)
          kept.set(text, found)
          return found
        }
        const made = yield* Deferred.make<string, ProcessError>()
        // Kept before it renders, so a render that fails at once finds it to forget.
        kept.set(text, made)
        const file = `${dir}/${crypto.randomUUID()}${extension}`
        yield* voice.render(text, file).pipe(
          Effect.as(file),
          // Whatever it wrote before it failed is of no use.
          Effect.onError(() => Effect.zipRight(Effect.promise(() => rm(file, { force: true })), forget(text, made))),
          Effect.intoDeferred(made),
          Effect.interruptible,
          Effect.forkIn(scope),
        )
        while (kept.size > most) yield* forget(...kept.entries().next().value!)
        return made
      }).pipe(Effect.uninterruptible)

    const render = (text: string, path: string) =>
      Effect.gen(function* () {
        if (text.length > brief) return yield* voice.render(text, path)
        const file = yield* Deferred.await(yield* claim(text))
        yield* Effect.tryPromise(() => Bun.write(path, Bun.file(file))).pipe(
          Effect.catchAll(() => voice.render(text, path)),
        )
      })

    return {
      render,
      /** A short line is copied whole, quicker than any first part of it would render. */
      renderFirst: (text: string, path: string) => (text.length > brief ? early(voice, text, path) : rendering(render)(text, path)),
      /** Renders lines ahead of time, so even the first time they're said is instant. */
      warm: (lines: ReadonlyArray<string>) =>
        Effect.forEach(
          lines,
          (text) => {
            const path = `${dir}/warm-${crypto.randomUUID()}${extension}`
            return render(text, path).pipe(Effect.ensuring(Effect.promise(() => rm(path, { force: true }))), Effect.ignore)
          },
          { discard: true },
        ),
    }
  })

/** Renders lines ahead of time, so they play at once the first time too. */
export class Warmth extends Context.Tag("yapd/Warmth")<
  Warmth,
  { readonly warm: (lines: ReadonlyArray<string>) => Effect.Effect<void> }
>() {}

/**
 * Kokoro 82M, run locally, on the GPU when it can. The model downloads on first
 * start and loads in the background. If it can't load or render, updates fall
 * back to `say`. The effect needs ffmpeg; without it, updates play unprocessed.
 */
export const KokoroVoice = Layer.scopedContext(
  Effect.gen(function* () {
    const name = yield* Config.voice
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(Path.join(tmpdir(), "yapd-voice-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    )
    // Kokoro's voices don't need the model, and a name it doesn't have won't start working later.
    const plain: Voice["Type"] = voices.has(name)
      ? withFallback((yield* kokoro([process.execPath, `${import.meta.dir}/Kokoro.ts`], name, yield* Config.effect)).render, say)
      : yield* Effect.as(Effect.logWarning(`Kokoro has no voice "${name}", so yapd uses say. Pick one from ${voicesPage}`), {
          render: say,
        })
    const kept = yield* remembering(plain, dir)
    return Context.make(Voice, { render: kept.render, renderFirst: kept.renderFirst }).pipe(Context.add(Warmth, { warm: kept.warm }))
  }),
)
