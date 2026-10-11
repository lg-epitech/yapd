import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import * as Condenser from "./Condenser.ts"
import { Model, ModelError } from "./Model.ts"

/** A model that gives the answers in order, and keeps what it was asked. */
const scripted = (answers: ReadonlyArray<unknown>) => {
  const asked: Array<string> = []
  const layer = Layer.succeed(Model, {
    ask: (schema, prompt) =>
      Effect.suspend(() => {
        asked.push(prompt)
        return Schema.decodeUnknown(schema)(answers[asked.length - 1])
      }).pipe(Effect.mapError((cause) => new ModelError({ cause }))),
  })
  return { asked, layer }
}

const condense = (answers: ReadonlyArray<unknown>, turn: Condenser.Turn) => {
  const { asked, layer } = scripted(answers)
  return Effect.runPromise(
    Effect.flatMap(Condenser.Condenser, ({ condense }) => condense("yapd", turn)).pipe(Effect.provide(Condenser.ProviderCondenser.pipe(Layer.provide(layer)))),
  ).then((summary) => ({ summary, asked }))
}

describe("Condenser headlines", () => {
  test("asks for a headline of at most fifteen words that carries any question, the rest apart, and progress told from news by what was said last", () => {
    const prompt = Condenser.prompt(
      "yapd",
      { prompt: Option.some("Keep the review going."), message: "Review pass 7 is running.", previous: { said: "yapd. Review pass 6 found nothing new.", ago: 12.4 } },
      Option.none(),
    )
    expect(Condenser.headlineWords).toBe(15)
    expect(prompt).toContain(`"headline":\n- At most 15 words, one sentence. The outcome first. If the agent asks a question or needs a decision, the headline carries it in full`)
    expect(prompt).toContain(`"more":\n- The rest worth hearing if they ask for more, at most 45 words, or "" when the headline says it all. Never repeat the headline.`)
    expect(prompt).toContain(`"progress" if the work carries on by itself and this only says how it's going`)
    expect(prompt).toContain("Never a result, finished work, an answer to the user's prompt, a failure, or the end of the work.")
    expect(prompt).toContain("What you last said about this work, 12 min ago: «yapd. Review pass 6 found nothing new.»")
    // Still the agent's words last, after what was said of the work before.
    expect(prompt.endsWith("Agent's message:\nReview pass 7 is running.")).toBe(true)
    expect(Condenser.prompt("yapd", { prompt: Option.none(), message: "Done." }, Option.none())).not.toContain("What you last said")
  })

  test("a headline and the rest come back as the summary's line and what's said for more, each in English", async () => {
    const { summary, asked } = await condense(
      [
        { priority: "progress", headline: "  yapd's review pass 7 is running.  ", more: "Il reste deux commentaires à traiter." },
        { spoken: "Two comments are left." },
      ],
      { prompt: Option.none(), message: "Review pass 7 is running. Two comments left." },
    )
    expect(summary).toEqual({ priority: "progress", spoken: "yapd's review pass 7 is running.", more: "Two comments are left." })
    // The headline was English already; only the rest was asked to be translated.
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain("Il reste deux commentaires à traiter.")
  })

  test("with no headline, the rest is all that's said, so nothing is left for more", async () => {
    const { summary } = await condense([{ priority: "done", headline: " ", more: "yapd's loader is fixed and the tests pass." }], {
      prompt: Option.none(),
      message: "Fixed the loader.",
    })
    expect(summary).toEqual({ priority: "done", spoken: "yapd's loader is fixed and the tests pass.", more: "" })
  })
})
