import { type AutomaticSpeechRecognitionPipeline, pipeline } from "@huggingface/transformers"
import { Cause, Context, Data, Deferred, type Duration, Effect, FiberId, Layer, Scope } from "effect"
import { rm } from "node:fs/promises"
import * as Config from "./Config.ts"
import * as Hub from "./Hub.ts"

export class TranscribeError extends Data.TaggedError("TranscribeError")<{ readonly cause: unknown }> {}

/** There was no model to hear it with. Saying it again won't help until there is. */
export class UnreadyError extends Data.TaggedError("UnreadyError")<{
  readonly cause: unknown
  /** Still loading, which the first time means downloading, rather than failed to. */
  readonly loading: boolean
}> {}

export class Transcriber extends Context.Tag("yapd/Transcriber")<
  Transcriber,
  {
    /**
     * 16 kHz mono in, words out. Empty when there were none. Whisper hears 30
     * seconds at most. With `terms`, like the options of a question he's
     * answering, it listens for those.
     */
    readonly transcribe: (audio: Float32Array, terms?: ReadonlyArray<string>) => Effect.Effect<string, TranscribeError>
  }
>() {}

/** Hears dictation, with a model of its own. */
export class DictationTranscriber extends Context.Tag("yapd/DictationTranscriber")<
  DictationTranscriber,
  {
    /** As for interruptions, except that the model may not be there yet: it only loads once the user first dictates. */
    readonly transcribe: (audio: Float32Array) => Effect.Effect<string, TranscribeError | UnreadyError>
    /** Loads the model, while they talk. */
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
    readonly convert_tokens_to_ids: (tokens: ReadonlyArray<string>) => ReadonlyArray<number | undefined>
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
  const [previous] = tokenizer.convert_tokens_to_ids(["<|startofprev|>"])
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

/**
 * What transformers.js reads of a Whisper model at fp32 on the CPU, found as it
 * finds it. The larger models keep their weights in files of their own, which
 * their config tells, and one loads without a generation config.
 */
export const files: Hub.Files = (get) =>
  Promise.all([
    get("preprocessor_config.json"),
    get("tokenizer.json"),
    get("tokenizer_config.json"),
    get("generation_config.json", true),
    get("config.json").then(async (path) => {
      // One that can't be read isn't kept, or it would be all there is to read at every start from then on.
      const config = await Bun.file(path)
        .json()
        .catch((cause: unknown) => rm(path, { force: true }).then(() => Promise.reject(cause)))
      const { "transformers.js_config": custom = {} } = config as { readonly "transformers.js_config"?: Custom }
      const external = { ...custom, ...custom.device_config?.cpu }.use_external_data_format ?? false
      const weights = ["encoder_model", "decoder_model_merged"].flatMap((name) => {
        const file = `${name}.onnx`
        const chunks = Number(typeof external === "object" ? (external[file] ?? external[name] ?? false) : external)
        return [file, ...Array.from({ length: chunks }, (_, chunk) => `${file}_data${chunk === 0 ? "" : `_${chunk}`}`)]
      })
      await Promise.all(weights.map((file) => get(`onnx/${file}`)))
    }),
  ])

/** What a model's config says of how transformers.js is to load it, as far as it changes which files that takes. */
interface Custom {
  /** Whether the weights are in files of their own, or in how many, for every model in the repo or for each. */
  readonly use_external_data_format?: boolean | number | Readonly<Record<string, boolean | number>>
  readonly device_config?: { readonly cpu?: Custom }
}

/**
 * Loads once, for everyone who asks while it does and after. A load that
 * failed isn't kept, unlike with `Effect.cached`: whoever asks next tries
 * again, since what kept a model from downloading has often passed by then.
 * It carries on when whoever asked has stopped waiting.
 */
export const once = <A, E>(load: Effect.Effect<A, E>): Effect.Effect<Effect.Effect<A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    let loading: Deferred.Deferred<A, E> | undefined
    return Effect.suspend(() => {
      if (loading !== undefined) return Deferred.await(loading)
      const started = Deferred.unsafeMake<A, E>(FiberId.none)
      loading = started
      const forget = Effect.sync(() => {
        if (loading === started) loading = undefined
      })
      return load.pipe(
        Effect.tapErrorCause(() => forget),
        Effect.intoDeferred(started),
        Effect.forkIn(scope),
        Effect.zipRight(Deferred.await(started)),
      )
    })
  })

const load = (repo: string, without: string) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    return yield* once(Hub.scopedLoad(
      repo,
      // fp32 is the fastest on Apple silicon's CPU, as with Kokoro. Only from what has downloaded, since what
      // transformers.js downloads can be left partway, in a cache that's trusted to hold nothing that is.
      () => pipeline("automatic-speech-recognition", repo, { dtype: "fp32", device: "cpu", local_files_only: true }),
      files,
    ).pipe(
      Scope.extend(scope),
      Effect.tap(() => Effect.logInfo(`Whisper ready with ${repo}`)),
      Effect.tapError((error) => Effect.logWarning(`${without}: Whisper didn't load`, error)),
    ))
  })

/** `patience` includes waiting for the model to load. `expected` is the vocabulary to listen for, if any, unless what's heard is given its own `terms`. */
const transcribe =
  (
    model: Effect.Effect<AutomaticSpeechRecognitionPipeline, Hub.LoadError>,
    language: string,
    patience: Duration.DurationInput,
    expected?: () => ReadonlyArray<string>,
  ) =>
  (audio: Float32Array, terms?: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      let ready = false
      const listening = terms !== undefined && terms.length > 0 ? () => terms : expected
      return model.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            ready = true
          }),
        ),
        Effect.flatMap((asr) =>
          Effect.gen(function* () {
            // Anything that goes wrong with the glossary, like it coming back changed, and it's heard without.
            const told =
              listening === undefined
                ? undefined
                : yield* Effect.tryPromise(() => prompted(asr, audio, language, listening())).pipe(
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
        Effect.mapError((cause) =>
          ready ? new TranscribeError({ cause }) : new UnreadyError({ cause, loading: Cause.isTimeoutException(cause) }),
        ),
      )
    })

/**
 * Whisper, run locally, for interruptions and for dictation, which share a
 * model when they're set to the same one. Both download at start, so that the
 * first dictation doesn't wait a minute for a gigabyte, but only the one for
 * interruptions loads then: the one for dictation takes over a gigabyte of
 * memory, which someone who never dictates shouldn't pay.
 */
export const WhisperTranscriber = Layer.scopedContext(
  Effect.gen(function* () {
    const language = yield* Config.language
    const repo = yield* Config.whisper
    const dictationRepo = yield* Config.dictationWhisper
    const model = yield* load(repo, "Can't understand interruptions")
    const dictation = dictationRepo === repo ? model : yield* load(dictationRepo, "Can't hear dictation")
    if (yield* Config.listen) {
      yield* Effect.forkScoped(model.pipe(Effect.ignore))
      // Left for the first dictation to try again when it fails.
      yield* Effect.forkScoped(
        Hub.cache(dictationRepo, files).pipe(
          Effect.catchAll((error) => Effect.logWarning(`Could not download ${dictationRepo} ahead of the first dictation`, error)),
        ),
      )
    }
    let expected: ReadonlyArray<string> = []
    const interruption = transcribe(model, language, "30 seconds")
    return Context.make(Transcriber, {
      transcribe: (audio, terms) => interruption(audio, terms).pipe(Effect.mapError(({ cause }) => new TranscribeError({ cause }))),
    }).pipe(
      Context.add(DictationTranscriber, {
        // Long enough for the model to finish downloading, when they dictate as soon as yapd starts.
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
