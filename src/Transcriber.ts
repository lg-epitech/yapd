import { type AutomaticSpeechRecognitionPipeline, pipeline } from "@huggingface/transformers"
import { Context, Data, type Duration, Effect, Layer } from "effect"
import * as Config from "./Config.ts"
import * as Hub from "./Hub.ts"

export class TranscribeError extends Data.TaggedError("TranscribeError")<{ readonly cause: unknown }> {}

export class Transcriber extends Context.Tag("yapd/Transcriber")<
  Transcriber,
  {
    /** 16 kHz mono in, words out. Empty when there were none. Whisper hears 30 seconds at most. */
    readonly transcribe: (audio: Float32Array) => Effect.Effect<string, TranscribeError>
  }
>() {}

/** Hears dictation, with a model of its own. */
export class DictationTranscriber extends Context.Tag("yapd/DictationTranscriber")<
  DictationTranscriber,
  Transcriber["Type"] & {
    /** Loads the model, which only happens once the user first dictates, while they talk. */
    readonly prepare: Effect.Effect<void>
  }
>() {}

/**
 * The words a dictation is likely to hold that Whisper wouldn't guess: the
 * projects, models and machines there are. It's told them before it listens,
 * which is what keeps "no worktree" from coming out as "on a work tree".
 */
export class Vocabulary extends Context.Tag("yapd/Vocabulary")<
  Vocabulary,
  { readonly expect: (terms: ReadonlyArray<string>) => Effect.Effect<void> }
>() {}

/** What dictation depends on hearing right, whatever else there is. They come first, so they're never the ones left out. */
const always = ["worktree", "no worktree", "in a worktree"]

/** Whisper takes 224 tokens of what came before at most, and every one of them is decoded again with each window. */
const most = 160

/** What Whisper is told came before: a list, which biases it towards the words without suggesting any were said. */
export const glossary = (terms: ReadonlyArray<string>, fits: (text: string) => boolean = () => true) => {
  const unique = [...new Set([...always, ...terms.map((term) => term.trim()).filter((term) => term !== "")])]
  let text = ` Glossary: ${unique.join(", ")}.`
  for (let kept = unique.length; !fits(text) && kept > always.length; kept--) text = ` Glossary: ${unique.slice(0, kept - 1).join(", ")}.`
  return text
}

/** What was heard, without what Whisper was told came before, which it gives back first. None if it isn't there to take off. */
export const heard = (text: string, told: string) => {
  const [whole, start] = [text.trim(), told.trim()]
  return whole.startsWith(start) ? whole.slice(start.length) : undefined
}

/** The parts of the pipeline that giving Whisper a glossary goes through, which it has no option for. */
interface Promptable {
  readonly tokenizer: {
    readonly encode: (text: string, options: { readonly add_special_tokens: boolean }) => ReadonlyArray<number>
    readonly model: { readonly convert_tokens_to_ids: (tokens: ReadonlyArray<string>) => ReadonlyArray<number | undefined> }
  }
  readonly model: {
    readonly generation_config: object
    readonly _retrieve_init_tokens: (config: object) => ReadonlyArray<number>
  }
}

/**
 * Transcribes with the glossary as what came before. Whisper's own way of
 * taking one isn't in transformers.js, but the tokens it starts from can be set.
 */
const prompted = async (asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array, language: string, terms: ReadonlyArray<string>) => {
  const { tokenizer, model } = asr as unknown as Promptable
  const [previous] = tokenizer.model.convert_tokens_to_ids(["<|startofprev|>"])
  if (previous === undefined) return undefined
  const told = glossary(terms, (text) => tokenizer.encode(text, { add_special_tokens: false }).length <= most)
  const start = model._retrieve_init_tokens({ ...model.generation_config, language, task: "transcribe" })
  const decoder_input_ids = [previous, ...tokenizer.encode(told, { add_special_tokens: false }), ...start]
  const output = await asr(audio, { decoder_input_ids } as object)
  return heard((Array.isArray(output) ? output : [output]).map(({ text }) => text).join(" "), told)
}

/** Whisper marks sounds that aren't words, like [BLANK_AUDIO] or (coughs). */
export const clean = (text: string) =>
  text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()

const load = (repo: string, without: string) =>
  Effect.cached(
    Hub.load(
      repo,
      // fp32 is the fastest on Apple silicon's CPU, as with Kokoro.
      () => pipeline("automatic-speech-recognition", repo, { dtype: "fp32", device: "cpu" }),
    ).pipe(
      Effect.tap(() => Effect.logInfo(`Whisper ready with ${repo}`)),
      Effect.tapError((error) => Effect.logWarning(`${without}: Whisper didn't load`, error)),
    ),
  )

/** `patience` includes waiting for the model to load. `expected` is the vocabulary to listen for, if any. */
const transcribe =
  (
    model: Effect.Effect<AutomaticSpeechRecognitionPipeline, Hub.LoadError>,
    language: string,
    patience: Duration.DurationInput,
    expected?: () => ReadonlyArray<string>,
  ) =>
  (audio: Float32Array) =>
    model.pipe(
      Effect.flatMap((asr) =>
        Effect.gen(function* () {
          // Anything that goes wrong with the glossary, like it coming back changed, and it's heard without.
          const told =
            expected === undefined
              ? undefined
              : yield* Effect.tryPromise(() => prompted(asr, audio, language, expected())).pipe(
                  Effect.catchAll((error) => Effect.logWarning("Could not give Whisper its glossary", error).pipe(Effect.as(undefined))),
                )
          if (told !== undefined) return told
          // Whisper doesn't detect the language here; left alone, it assumes English and translates.
          const output = yield* Effect.tryPromise(() => asr(audio, { language, task: "transcribe" }))
          return (Array.isArray(output) ? output : [output]).map(({ text }) => text).join(" ")
        }),
      ),
      Effect.map(clean),
      Effect.timeout(patience),
      Effect.mapError((cause) => new TranscribeError({ cause })),
    )

/**
 * Whisper, run locally, for interruptions and for dictation, which share a
 * model when they're set to the same one. Models download on first use, and
 * the one for interruptions loads in the background at start.
 */
export const WhisperTranscriber = Layer.scopedContext(
  Effect.gen(function* () {
    const language = yield* Config.language
    const repo = yield* Config.whisper
    const dictationRepo = yield* Config.dictationWhisper
    const model = yield* load(repo, "Can't understand interruptions")
    const dictation = dictationRepo === repo ? model : yield* load(dictationRepo, "Can't hear dictation")
    if (yield* Config.listen) yield* Effect.forkScoped(model.pipe(Effect.ignore))
    let expected: ReadonlyArray<string> = []
    return Context.make(Transcriber, { transcribe: transcribe(model, language, "30 seconds") }).pipe(
      Context.add(DictationTranscriber, {
        // Long enough for the model to download, the first time.
        transcribe: transcribe(dictation, language, "2 minutes", () => expected),
        prepare: Effect.ignore(dictation),
      }),
      Context.add(Vocabulary, {
        expect: (terms) =>
          Effect.sync(() => {
            expected = terms
          }),
      }),
    )
  }),
)
