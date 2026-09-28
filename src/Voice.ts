import { Context, Data, Effect, Layer } from "effect"
import { RawAudio } from "@huggingface/transformers"
import { KokoroTTS, TextSplitterStream, type GenerateOptions } from "kokoro-js"
import { rename, rm } from "node:fs/promises"
import * as Config from "./Config.ts"
import * as Hub from "./Hub.ts"
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

// fp32 is both the best quality and, on Apple silicon, faster than the quantized models.
const load = Hub.load(repo, () => KokoroTTS.from_pretrained(repo, { dtype: "fp32", device: "cpu" }))

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
        const parts = yield* Effect.forEach(split(text), (part) =>
          Effect.tryPromise({
            try: () => tts.generate(part, { voice: voice as NonNullable<GenerateOptions["voice"]> }),
            catch: (cause) => new KokoroError({ cause }),
          }).pipe(Effect.timeout("30 seconds")),
        ).pipe(lock.withPermits(1))
        const rate = parts[0]?.sampling_rate ?? 24000
        yield* Effect.tryPromise({
          try: () => new RawAudio(join(parts.map((part) => part.audio), rate), rate).save(raw),
          catch: (cause) => new KokoroError({ cause }),
        })
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
