import { env } from "@huggingface/transformers"
import { Context, Data, Effect, Layer, Schedule } from "effect"
import { KokoroTTS, type GenerateOptions } from "kokoro-js"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"
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

const repo = "onnx-community/Kokoro-82M-v1.0-ONNX"
const cache = join(env.cacheDir, repo)
const loaded = join(cache, ".yapd-loaded")

/**
 * transformers.js downloads straight into its cache, so a restart mid-download
 * leaves a partial model that every later start fails to load. Only a model
 * that loaded before is trusted; anything else downloads again.
 */
const load = Effect.gen(function* () {
  if (!(yield* Effect.promise(() => Bun.file(loaded).exists()))) {
    yield* Effect.promise(() => rm(cache, { recursive: true, force: true }))
  }
  const tts = yield* Effect.tryPromise({
    // fp32 is both the best quality and, on Apple silicon, faster than the quantized models.
    try: () => KokoroTTS.from_pretrained(repo, { dtype: "fp32", device: "cpu" }),
    catch: (cause) => new KokoroError({ cause }),
  })
  yield* Effect.promise(() => Bun.write(loaded, ""))
  return tts
})

const say = (text: string, path: string) => run(["say", "--data-format=LEI16@24000", "-o", path], { stdin: text })

/**
 * Kokoro 82M, run locally. The model downloads on first start and loads in the
 * background. If it can't load or render, updates fall back to `say`. The
 * effect needs ffmpeg; without it, updates play unprocessed.
 */
export const KokoroVoice = Layer.scoped(
  Voice,
  Effect.gen(function* () {
    const voice = yield* Config.voice
    const effect = yield* Config.effect

    const model = yield* Effect.cached(
      load.pipe(
        Effect.filterOrFail(
          (tts) => voice in tts.voices,
          () => new KokoroError({ cause: `Unknown voice "${voice}"` }),
        ),
        Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }),
        Effect.tap(() => Effect.logInfo(`Kokoro ready with voice ${voice}`)),
      ),
    )
    yield* Effect.forkScoped(model.pipe(Effect.ignore))

    // One render at a time: parallel runs just compete for the same cores.
    const lock = yield* Effect.makeSemaphore(1)

    const kokoro = (text: string, path: string) =>
      Effect.gen(function* () {
        const tts = yield* model
        const raw = effect === "none" ? path : `${path}.raw.wav`
        yield* Effect.tryPromise({
          try: async () => {
            const audio = await tts.generate(text, { voice: voice as NonNullable<GenerateOptions["voice"]> })
            await audio.save(raw)
          },
          catch: (cause) => new KokoroError({ cause }),
        }).pipe(Effect.timeout("30 seconds"), lock.withPermits(1))
        if (raw !== path) yield* applyEffect(raw, path)
      })

    const applyEffect = (raw: string, path: string) =>
      run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-af", effect, path]).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("Could not apply the effect, playing it unprocessed", error).pipe(
            Effect.zipRight(Effect.promise(() => rename(raw, path))),
          ),
        ),
        Effect.ensuring(Effect.promise(() => rm(raw, { force: true }))),
      )

    return {
      render: (text, path) =>
        kokoro(text, path).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Kokoro failed, using say", error).pipe(Effect.zipRight(say(text, path))),
          ),
        ),
    }
  }),
)

export const play = (path: string) => run(["afplay", path])

export const chime = play("/System/Library/Sounds/Tink.aiff")
