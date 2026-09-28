import { type AutomaticSpeechRecognitionPipeline, pipeline } from "@huggingface/transformers"
import { Context, Data, Effect, Layer } from "effect"
import * as Config from "./Config.ts"
import * as Hub from "./Hub.ts"

export class TranscribeError extends Data.TaggedError("TranscribeError")<{ readonly cause: unknown }> {}

export class Transcriber extends Context.Tag("yapd/Transcriber")<
  Transcriber,
  {
    /** 16 kHz mono in, words out. Empty when there were none. */
    readonly transcribe: (audio: Float32Array) => Effect.Effect<string, TranscribeError>
  }
>() {}

/** Whisper marks sounds that aren't words, like [BLANK_AUDIO] or (coughs). */
export const clean = (text: string) =>
  text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** Whisper, run locally. The model downloads on first start and loads in the background. */
export const WhisperTranscriber = Layer.scoped(
  Transcriber,
  Effect.gen(function* () {
    const repo = yield* Config.whisper
    const language = yield* Config.language
    const model = yield* Effect.cached(
      Hub.load(
        repo,
        // fp32 is the fastest on Apple silicon's CPU, as with Kokoro.
        () => pipeline("automatic-speech-recognition", repo, { dtype: "fp32", device: "cpu" }),
      ).pipe(
        Effect.tap(() => Effect.logInfo(`Whisper ready with ${repo}`)),
        Effect.tapError((error) => Effect.logWarning("Can't understand interruptions: Whisper didn't load", error)),
      ),
    )
    if (yield* Config.listen) yield* Effect.forkScoped(model.pipe(Effect.ignore))

    return {
      transcribe: (audio) =>
        model.pipe(
          Effect.flatMap((asr: AutomaticSpeechRecognitionPipeline) =>
            // Whisper doesn't detect the language here; left alone, it assumes English and translates.
            Effect.tryPromise(() => asr(audio, { language, task: "transcribe" })),
          ),
          Effect.map((output) => clean((Array.isArray(output) ? output : [output]).map(({ text }) => text).join(" "))),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => new TranscribeError({ cause })),
        ),
    }
  }),
)
