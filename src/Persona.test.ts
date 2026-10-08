import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Deferred, Effect, Layer, Option, Schema } from "effect"
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
  address: "sir",
}

/**
 * The lines yapd says in that style, from those kept in its database if any,
 * with a model that writes `written`, once they're ready. Also how often the
 * model was asked, and what's kept afterwards.
 */
const persona = (kept: Persona.Lines | undefined, written: Persona.Lines) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = Settings.fromStore(yield* Store.make(":memory:"))
        if (kept !== undefined) yield* settings.write("persona", JSON.stringify({ style, lines: kept }))
        let asked = 0
        const ready = yield* Deferred.make<void>()
        const built = yield* Layer.build(
          Persona.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Settings.Settings, settings),
                Layer.succeed(Warmth, { warm: () => Deferred.complete(ready, Effect.void).pipe(Effect.asVoid) }),
                Layer.succeed(Model, {
                  ask: <A, I>(schema: Schema.Schema<A, I>) => {
                    asked++
                    return Schema.decodeUnknown(schema)(written).pipe(Effect.orDie)
                  },
                }),
              ),
            ),
            Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_STYLE", style]])))),
          ),
        )
        yield* Deferred.await(ready)
        const lines = yield* Context.get(built, Persona.Persona).lines
        const stored = Option.getOrThrow(yield* settings.read("persona"))
        return { lines, asked, stored: JSON.parse(stored).lines as Persona.Lines }
      }),
    ),
  )

describe("Persona", () => {
  test("a line said instead of asking never asks: kept ones that do are written again, and one that still does is said plainly", async () => {
    const result = await persona(
      { ...jarvis, cantTell: "Which thread, sir? The clues are rather thin." },
      { ...jarvis, cantTell: "Which one, sir?", leaving: "I'll let that one go, sir." },
    )
    expect(result.asked).toBe(1)
    expect(result.lines.cantTell).toBe("I couldn't tell which one you meant, sir.")
    expect(result.lines.leaving).toBe("I'll let that one go, sir.")
    expect(result.stored.cantTell).toBe("I couldn't tell which one you meant, sir.")
  })

  test("saying a thread stopped or carries on never asks either, while asking to send again still does", async () => {
    const result = await persona({ ...jarvis, stopped: "Shall I stop it, sir?" }, { ...jarvis, carrying: "Carry on, sir?", again: "Shall I send it again?" })
    expect(result.asked).toBe(1)
    expect(result.lines.stopped).toBe("Stopped, sir.")
    expect(result.lines.carrying).toBe("Carrying on, sir.")
    expect(result.lines.again).toBe("Shall I send it again?")
  })

  test("asking whether to send something again always asks: kept lines where it doesn't are written again, and one that still doesn't is asked plainly", async () => {
    const result = await persona({ ...jarvis, again: "I can send it again." }, { ...jarvis, again: "I could always send it again." })
    expect(result.asked).toBe(1)
    expect(result.lines.again).toBe("Send it again?")
    expect(result.stored.again).toBe("Send it again?")
    expect(result.lines.stopped).toBe("Stopped, sir.")
  })

  test("how he's addressed is kept without marks, so a line said in its place doesn't ask, and isn't written again at the next start", async () => {
    const first = await persona(undefined, { ...jarvis, address: "sir?", cantTell: "Which one, sir?" })
    expect(first.lines.address).toBe("sir")
    expect(first.lines.cantTell).toBe("I couldn't tell which one you meant, sir.")
    const next = await persona(first.stored, Persona.plain)
    expect(next.asked).toBe(0)
    expect(next.lines).toEqual(first.lines)
  })

  test("lines kept for the same style that ask nothing are used as they are, without asking the model again", async () => {
    const result = await persona({ ...jarvis, misheard: "Pardon, sir. Could you say that again?" }, Persona.plain)
    expect(result.asked).toBe(0)
    expect(result.lines).toEqual({ ...jarvis, misheard: "Pardon, sir. Could you say that again?" })
  })
})
