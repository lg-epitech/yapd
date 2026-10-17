import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Deferred, Effect, Layer, Option, Random, Schema } from "effect"
import { Model } from "./Model.ts"
import * as Persona from "./Persona.ts"
import * as Settings from "./Settings.ts"
import * as Store from "./Store.ts"
import { Warmth } from "./Voice.ts"

const style = "Like Jarvis: dry, brief, calls me sir."

const jarvis: Persona.Lines = {
  onIt: "On it, sir.",
  queued: "Noted, sir. I'll see to it shortly.",
  misheard: "Pardon, sir. I missed that.",
  checking: "One moment, sir.",
  leaving: "I'll leave that there, sir.",
  cantTell: "I couldn't make out which one you meant, sir.",
  stopped: "Stopped, sir.",
  again: "Shall I send it again?",
  carrying: "Carrying on, sir.",
  approved: "Approved, sir.",
  declined: "Declined, sir.",
  onScreen: "It's on your screen, sir.",
  address: "sir",
}

/**
 * The lines yapd says in that style, from those kept in its database if any,
 * with a model that writes `written`, once they're ready, and the persona that
 * says them. Also how often the model was asked and what's kept afterwards.
 * `env` adds to the style.
 */
const persona = (
  kept: Persona.Lines | undefined,
  written: Persona.Lines,
  env: Record<string, string> = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = Settings.fromStore(yield* Store.make(":memory:"))
        if (kept !== undefined) yield* settings.write("persona", JSON.stringify({ style, lines: kept }))
        let asked = 0
        const ready = yield* Deferred.make<void>()
        const mine = (env.YAPD_ON_IT ?? "").split("|").map((line) => line.trim())
        const built = yield* Layer.build(
          Persona.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Settings.Settings, settings),
                Layer.succeed(Warmth, {
                  // His own lines are rendered on their own, so it's the rest that tells they're ready.
                  warm: (lines) => (lines.some((line) => !mine.includes(line)) ? Deferred.complete(ready, Effect.void) : Effect.void),
                }),
                Layer.succeed(Model, {
                  ask: <A, I>(schema: Schema.Schema<A, I>) => {
                    asked++
                    return Schema.decodeUnknown(schema)(written).pipe(Effect.orDie)
                  },
                }),
              ),
            ),
            Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries({ YAPD_STYLE: style, ...env }))))),
          ),
        )
        yield* Deferred.await(ready)
        const said = Context.get(built, Persona.Persona)
        const lines = yield* said.lines
        const stored = Option.map(yield* settings.read("persona"), (stored) => JSON.parse(stored).lines as Persona.Lines)
        return { lines, asked, stored: Option.getOrUndefined(stored)!, persona: said }
      }),
    ),
  )

const own = ["Right away, sir.", "Very good, sir.", "Consider it done, sir.", "Very well, sir."]

describe("Persona", () => {
  test("a line said instead of asking never asks: kept ones that do are written again, and one that still does is said plainly", async () => {
    const result = await persona(
      { ...jarvis, cantTell: "Which thread, sir? The clues are rather thin." },
      { ...jarvis, cantTell: "Which one, sir?", leaving: "I'll let that one go, sir." },
    )
    expect(result.asked).toBe(1)
    expect(result.lines.cantTell).toBe("I couldn't tell which one you meant, sir.")
    expect(result.stored.cantTell).toBe("I couldn't tell which one you meant, sir.")
  })

  test("asking whether to send something again always asks: kept lines where it doesn't are written again, and one that still doesn't is asked plainly", async () => {
    const result = await persona({ ...jarvis, again: "I can send it again." }, { ...jarvis, again: "I could always send it again." })
    expect(result.asked).toBe(1)
    expect(result.lines.again).toBe("Send it again?")
    expect(result.stored.again).toBe("Send it again?")
  })

  test("never says the same line for going ahead twice in a row, however often the lines are read in between", async () => {
    const { persona: said } = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    const read: Array<string> = []
    const lines = Effect.runSync(
      Effect.replicateEffect(
        Effect.zipLeft(Effect.tap(said.onIt(), said.said), Effect.tap(said.lines, ({ onIt }) => read.push(onIt))),
        200,
      ).pipe(Effect.withRandom(Random.make("yapd"))),
    )
    expect(new Set(read)).toEqual(new Set(["Right away, sir."]))
    lines.forEach((line, index) => expect(line).not.toBe(lines[index - 1]))
    expect(new Set(lines)).toEqual(new Set(own))
  })

  test("what's said past an \"On it\" a model wrote anyway, addressing him or not, is all that's left of it", () => {
    const sir = { address: "sir" }
    expect(Persona.afterOnIt("On it, sir.", sir)).toBe("")
    expect(Persona.afterOnIt("On it, sir, in yapd, on Fable, in a worktree.", sir)).toBe("In yapd, on Fable, in a worktree.")
    // Only the usual ways of addressing someone go: any other words after it are what was said.
    expect(Persona.afterOnIt("On it, staging only.", Persona.plain)).toBe("Staging only.")
    // Nor one of them that goes on into the sentence.
    expect(Persona.afterOnIt("On it, master branch only.", Persona.plain)).toBe("Master branch only.")
    // Anything else is as it was.
    expect(Persona.afterOnIt("On itself, sir, it's fine.", Persona.plain)).toBe("On itself, sir, it's fine.")
    expect(Persona.afterOnIt("yapd's on it, sir.", sir)).toBe("yapd's on it, sir.")
  })
})
