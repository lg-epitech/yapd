import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Deferred, Effect, Exit, Layer, Logger, LogLevel, Option, Random, Schema } from "effect"
import { Model, ModelError } from "./Model.ts"
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
  address: "sir",
}

/**
 * The lines yapd says in that style, from those kept in its database if any,
 * with a model that writes `written`, once they're ready or couldn't be
 * written, and the persona that says them. Also how often the model was
 * asked, what's kept afterwards, what was rendered ahead and the warnings
 * logged. `env` adds to the style, or with `style: false` there's none. With
 * `failing`, the model can't be reached.
 */
const persona = (
  kept: Persona.Lines | undefined,
  written: Persona.Lines,
  env: Record<string, string> = {},
  options: { style: boolean; failing?: boolean } = { style: true },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = Settings.fromStore(yield* Store.make(":memory:"))
        if (kept !== undefined) yield* settings.write("persona", JSON.stringify({ style, lines: kept }))
        let asked = 0
        const warmed: Array<string> = []
        const warnings: Array<string> = []
        const ready = yield* Deferred.make<void>()
        const mine = (env.YAPD_ON_IT ?? "").split("|").map((line) => line.trim())
        const built = yield* Layer.build(
          Persona.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Settings.Settings, settings),
                Layer.succeed(Warmth, {
                  warm: (lines) =>
                    Effect.sync(() => warmed.push(...lines)).pipe(
                      // His own lines are rendered on their own, so it's the rest that tells they're ready.
                      Effect.zipRight(lines.some((line) => !mine.includes(line)) ? Deferred.complete(ready, Effect.void) : Effect.void),
                    ),
                }),
                Layer.succeed(Model, {
                  ask: <A, I>(schema: Schema.Schema<A, I>) => {
                    asked++
                    return options.failing
                      ? Effect.fail(new ModelError({ cause: "The model can't be reached" }))
                      : Schema.decodeUnknown(schema)(written).pipe(Effect.orDie)
                  },
                }),
              ),
            ),
            Layer.provide(
              Layer.setConfigProvider(
                ConfigProvider.fromMap(new Map(Object.entries({ ...(options.style ? { YAPD_STYLE: style } : {}), ...env }))),
              ),
            ),
            Layer.provide(
              Logger.replace(
                Logger.defaultLogger,
                Logger.make(({ logLevel, message }) => {
                  if (logLevel !== LogLevel.Warning) return
                  warnings.push([message].flat().join(" "))
                  if (warnings.at(-1)!.startsWith("Could not write my usual lines")) Deferred.unsafeDone(ready, Exit.void)
                }),
              ),
            ),
          ),
        )
        yield* Deferred.await(ready)
        const said = Context.get(built, Persona.Persona)
        const lines = yield* said.lines
        const stored = Option.map(yield* settings.read("persona"), (stored) => JSON.parse(stored).lines as Persona.Lines)
        return { lines, asked, stored: Option.getOrUndefined(stored)!, warmed, warnings, persona: said }
      }),
    ),
  )

/** What's said for going ahead, `times` times over, each noted as said, picked the same way every run. */
const goingAhead = (persona: Context.Tag.Service<Persona.Persona>, times: number) =>
  Effect.runSync(Effect.replicateEffect(Effect.tap(persona.onIt, persona.said), times).pipe(Effect.withRandom(Random.make("yapd"))))

const own = ["Right away, sir.", "Very good, sir.", "Consider it done, sir.", "Very well, sir."]

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

  test("his own lines for going ahead replace the written one, and the model still writes the rest, kept as written", async () => {
    const result = await persona(undefined, jarvis, { YAPD_ON_IT: ` ${own.join(" | ")} ||` })
    expect(result.asked).toBe(1)
    expect(result.lines).toEqual({ ...jarvis, onIt: "Right away, sir." })
    expect(new Set(goingAhead(result.persona, 40))).toEqual(new Set(own))
    expect(result.stored).toEqual(jarvis)
  })

  test("never says the same line for going ahead twice in a row, however often the lines are read in between", async () => {
    const { persona: said } = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    const read: Array<string> = []
    const lines = Effect.runSync(
      Effect.replicateEffect(
        Effect.zipLeft(Effect.tap(said.onIt, said.said), Effect.tap(said.lines, ({ onIt }) => read.push(onIt))),
        200,
      ).pipe(Effect.withRandom(Random.make("yapd"))),
    )
    expect(new Set(read)).toEqual(new Set(["Right away, sir."]))
    lines.forEach((line, index) => expect(line).not.toBe(lines[index - 1]))
    expect(new Set(lines)).toEqual(new Set(own))
  })

  test("a line picked for a reply that's then dropped, queued or fails doesn't count as the last one he heard", async () => {
    const { persona: said } = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    const heard = Effect.runSync(
      Effect.replicateEffect(
        Effect.gen(function* () {
          const last = yield* Effect.tap(said.onIt, said.said)
          // Picked, then never said, like when he carries on talking and the reply is worked out again.
          yield* said.onIt
          return [last, yield* said.onIt] as const
        }),
        200,
      ).pipe(Effect.withRandom(Random.make("yapd"))),
    )
    heard.forEach(([last, next]) => expect(next).not.toBe(last))
    // Lines that aren't his own, like the one for being queued, leave the last one he heard as it was.
    Effect.runSync(said.said(own[0]!).pipe(Effect.zipRight(said.said(jarvis.queued))))
    expect(new Set(Effect.runSync(Effect.replicateEffect(said.onIt, 40)))).toEqual(new Set(own.slice(1)))
  })

  test("renders all his own lines ahead, and not the written one they replace", async () => {
    const result = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    expect(result.warmed).toEqual(expect.arrayContaining([...own, jarvis.queued, jarvis.cantTell]))
    expect(result.warmed).not.toContain("On it, sir.")
    const plainly = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") }, { style: false })
    expect(plainly.lines).toEqual({ ...Persona.plain, onIt: "Right away, sir." })
    expect(plainly.warmed).toEqual(expect.arrayContaining([...own, Persona.plain.queued]))
    expect(plainly.asked).toBe(0)
  })

  test("renders his own lines ahead even when the rest can't be written, since they don't need the model", async () => {
    const result = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") }, { style: true, failing: true })
    expect(result.asked).toBe(1)
    expect(result.lines).toEqual({ ...Persona.plain, onIt: "Right away, sir." })
    expect(result.warmed).toEqual(own)
  })

  test("without lines of his own, the written one is said every time", async () => {
    const result = await persona(undefined, jarvis)
    expect(result.lines).toEqual(jarvis)
    expect(goingAhead(result.persona, 5)).toEqual(Array(5).fill("On it, sir."))
    expect(result.warmed).toEqual(Persona.sayable(jarvis))
    const plainly = await persona(undefined, jarvis, {}, { style: false })
    expect(goingAhead(plainly.persona, 2)).toEqual(["On it.", "On it."])
  })

  test("a line of his own that asks is never said, with a warning, and the written one stands in if they all do", async () => {
    const result = await persona(undefined, jarvis, { YAPD_ON_IT: "Right away, sir.|Shall I, sir?|Very well, sir." })
    expect(new Set(goingAhead(result.persona, 40))).toEqual(new Set(["Right away, sir.", "Very well, sir."]))
    expect(result.warmed).not.toContain("Shall I, sir?")
    expect(result.warnings.join("\n")).toContain("Shall I, sir?")
    const asking = await persona(undefined, jarvis, { YAPD_ON_IT: "Shall I, sir?" })
    expect(goingAhead(asking.persona, 3)).toEqual(Array(3).fill("On it, sir."))
    expect(asking.lines.onIt).toBe("On it, sir.")
  })

  test("a single line of his own is said every time", async () => {
    const result = await persona(undefined, jarvis, { YAPD_ON_IT: "Right away, sir." })
    expect(goingAhead(result.persona, 3)).toEqual(Array(3).fill("Right away, sir."))
  })
})
