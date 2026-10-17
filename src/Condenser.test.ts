import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import * as Condenser from "./Condenser.ts"
import { Model, ModelError } from "./Model.ts"

/** A model that gives the answers in order. */
const scripted = (answers: ReadonlyArray<unknown>) => {
  const asked: Array<string> = []
  const layer = Layer.succeed(Model, {
    ask: (schema, prompt) =>
      Effect.suspend(() => {
        asked.push(prompt)
        return Schema.decodeUnknown(schema)(answers[asked.length - 1])
      }).pipe(Effect.mapError((cause) => new ModelError({ cause }))),
  })
  return layer
}

const condense = (answers: ReadonlyArray<unknown>, turn: Condenser.Turn) => {
  const layer = scripted(answers)
  return Effect.runPromise(
    Effect.flatMap(Condenser.Condenser, ({ condense }) => condense("yapd", turn)).pipe(Effect.provide(Condenser.ProviderCondenser.pipe(Layer.provide(layer)))),
  )
}

describe("Condenser headlines", () => {
  test("with no headline, the rest is all that's said, so nothing is left for more", async () => {
    const summary = await condense([{ priority: "done", headline: " ", more: "yapd's loader is fixed and the tests pass." }], {
      prompt: Option.none(),
      message: "Fixed the loader.",
    })
    expect(summary).toEqual({ priority: "done", spoken: "yapd's loader is fixed and the tests pass.", more: "" })
  })
})
