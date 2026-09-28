import { AutoModel, type PreTrainedModel, Tensor } from "@huggingface/transformers"
import { Context, Data, Effect, Layer } from "effect"
import * as Config from "./Config.ts"
import * as Hub from "./Hub.ts"

export class VadError extends Data.TaggedError("VadError")<{ readonly cause: unknown }> {}

/** How likely each 32 ms frame of 16 kHz audio is speech. */
export class Vad extends Context.Tag("yapd/Vad")<
  Vad,
  {
    /** A detector for one stretch of listening. It remembers the frames before, so feed them in order. */
    readonly make: Effect.Effect<(frame: Float32Array) => Effect.Effect<number, VadError>, VadError>
  }
>() {}

const repo = "onnx-community/silero-vad"

/** Silero VAD, run locally. It's tiny and takes a fraction of a millisecond per frame. */
export const SileroVad = Layer.scoped(
  Vad,
  Effect.gen(function* () {
    let loaded: PreTrainedModel | undefined
    const model = Hub.load(repo, () =>
      // It isn't a transformers architecture, so it loads as a bare ONNX model.
      AutoModel.from_pretrained(repo, { config: { model_type: "custom" } as never, dtype: "fp32" }),
    ).pipe(
      Effect.tap((silero) =>
        Effect.sync(() => {
          loaded = silero
        }),
      ),
      Effect.catchAll((error) => Effect.logWarning("Can't hear interruptions: the voice detector didn't load", error)),
    )
    if (yield* Config.listen) yield* Effect.forkScoped(model)
    const rate = new Tensor("int64", BigInt64Array.from([16000n]), [])

    return {
      // Until it has loaded, updates just play rather than wait for it.
      make: Effect.suspend(() => {
        const silero = loaded
        if (silero === undefined) return Effect.fail(new VadError({ cause: "The voice detector hasn't loaded" }))
        let state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128])
        return Effect.succeed((frame: Float32Array) =>
          Effect.tryPromise({
            try: async () => {
              const input = new Tensor("float32", frame, [1, frame.length])
              const { output, stateN } = await silero({ input, sr: rate, state })
              state = stateN
              return (output as Tensor).data[0] as number
            },
            catch: (cause) => new VadError({ cause }),
          }),
        )
      }),
    }
  }),
)
