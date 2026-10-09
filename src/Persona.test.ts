import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Deferred, Effect, Exit, Layer, Logger, LogLevel, Option, Random, Schema, TestClock, TestContext } from "effect"
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
  Effect.runSync(Effect.replicateEffect(Effect.tap(persona.onIt(), persona.said), times).pipe(Effect.withRandom(Random.make("yapd"))))

/** Where the clock of `next` was left, so it never goes back to before lines it picked. */
let later = 0

/**
 * What may be said for going ahead next, picked `times` times over, each once
 * those picked before have been let go, since they never played, and picked
 * the same way every run.
 */
const next = (persona: Context.Tag.Service<Persona.Persona>, times: number) =>
  Effect.runPromise(
    TestClock.setTime(Math.max(later, Date.now())).pipe(
      Effect.zipRight(Effect.replicateEffect(Effect.zipRight(TestClock.adjust("2 minutes"), persona.onIt()), times)),
      Effect.tap(() => Effect.map(TestClock.currentTimeMillis, (at) => (later = at))),
      Effect.map((lines) => new Set(lines)),
      Effect.withRandom(Random.make("yapd")),
      Effect.provide(TestContext.TestContext),
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
        Effect.zipLeft(Effect.tap(said.onIt(), said.said), Effect.tap(said.lines, ({ onIt }) => read.push(onIt))),
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
          const last = yield* Effect.tap(said.onIt(), said.said)
          // Picked, then never said, like when he carries on talking and the reply is worked out again.
          yield* said.onIt()
          return [last, yield* said.onIt()] as const
        }),
        200,
      ).pipe(Effect.withRandom(Random.make("yapd"))),
    )
    heard.forEach(([last, next]) => expect(next).not.toBe(last))
    // Lines that aren't his own, like the one for being queued, leave the last one he heard as it was.
    Effect.runSync(said.said(own[0]!).pipe(Effect.zipRight(said.said(jarvis.queued))))
    expect(await next(said, 40)).toEqual(new Set(own.slice(1)))
  })

  test("two replies that each pick a line before either plays get different ones, and play without the same one twice in a row", async () => {
    const { persona: said } = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    // Each picks the first it may, as both would by chance a third of the time if neither knew of the other.
    const [first, second] = Effect.runSync(Effect.all([said.onIt(), said.onIt()]).pipe(Effect.withRandom(Random.fixed([0]))))
    expect([first, second]).toEqual([own[0]!, own[1]!])
    Effect.runSync(Effect.forEach([first, second], said.said))
    const heard = Effect.runSync(
      Effect.replicateEffect(
        Effect.gen(function* () {
          const replies = yield* Effect.all([said.onIt(), said.onIt()])
          yield* Effect.forEach(replies, said.said)
          return replies
        }),
        200,
      ).pipe(Effect.withRandom(Random.make("yapd"))),
    ).flat()
    heard.forEach((line, index) => expect(line).not.toBe([second, ...heard][index]))
    expect(new Set(heard)).toEqual(new Set(own))
  })

  test("a line picked but never played is let go after two minutes, and only then may be picked again", async () => {
    const { persona: said } = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    const picked = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Math.max(later, Date.now()))
        const first = yield* said.onIt()
        yield* TestClock.adjust("1 minute")
        const meanwhile = yield* said.onIt()
        yield* TestClock.adjust("1 minute")
        return [first, meanwhile, yield* said.onIt()]
      }).pipe(Effect.withRandom(Random.fixed([0])), Effect.provide(TestContext.TestContext)),
    )
    // The second is still kept from coming up when the first is let go.
    expect(picked).toEqual([own[0]!, own[1]!, own[0]!])
  })

  test("with too few lines to keep clear of all those picked and heard, it's the line said in the same breath, then the latest, that's kept clear of", async () => {
    const two = await persona(undefined, jarvis, { YAPD_ON_IT: own.slice(0, 2).join("|") })
    const picked = Effect.runSync(
      Effect.gen(function* () {
        yield* two.persona.said(own[0]!)
        const first = yield* two.persona.onIt()
        return [first, yield* two.persona.onIt(), yield* two.persona.onIt(own[0])]
      }).pipe(Effect.withRandom(Random.fixed([0]))),
    )
    expect(picked).toEqual([own[1]!, own[0]!, own[1]!])
    // Picks that never play don't push out the one he heard last: with four, it stays clear of that one after three of them.
    const four = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    const unplayed = Effect.runSync(
      Effect.gen(function* () {
        yield* four.persona.said(own[0]!)
        yield* Effect.replicateEffect(four.persona.onIt(), 3)
        return yield* four.persona.onIt()
      }).pipe(Effect.withRandom(Random.fixed([0]))),
    )
    expect(unplayed).not.toBe(own[0]!)
    // With one of his own, it's said by every reply, however many pick it before it plays.
    const one = await persona(undefined, jarvis, { YAPD_ON_IT: own[0]! })
    expect(Effect.runSync(Effect.all([one.persona.onIt(), one.persona.onIt(), one.persona.onIt(own[0])]))).toEqual([own[0]!, own[0]!, own[0]!])
  })

  test("a second line for going ahead in the same breath is never the first, nor the one he heard last while there are lines enough", async () => {
    const { persona: said } = await persona(undefined, jarvis, { YAPD_ON_IT: own.join("|") })
    const picked = Effect.runSync(
      Effect.replicateEffect(
        Effect.gen(function* () {
          const last = yield* Effect.tap(said.onIt(), said.said)
          const first = yield* said.onIt()
          return [last, first, yield* said.onIt(first)] as const
        }),
        200,
      ).pipe(Effect.withRandom(Random.make("yapd"))),
    )
    picked.forEach(([last, first, second]) => {
      expect(second).not.toBe(first)
      expect(second).not.toBe(last)
    })
    expect(new Set(picked.map(([, , second]) => second))).toEqual(new Set(own))
    // With two, the one he heard last is said again rather than the same one twice in one breath.
    const two = await persona(undefined, jarvis, { YAPD_ON_IT: own.slice(0, 2).join("|") })
    Effect.runSync(two.persona.said(own[0]!))
    expect(new Set(Effect.runSync(Effect.replicateEffect(two.persona.onIt(own[1]), 20)))).toEqual(new Set([own[0]!]))
    // With one of his own, or none, there's only the one line to say.
    const one = await persona(undefined, jarvis, { YAPD_ON_IT: own[0]! })
    expect(Effect.runSync(one.persona.onIt(own[0]))).toBe(own[0]!)
    const none = await persona(undefined, jarvis)
    expect(Effect.runSync(none.persona.onIt(jarvis.onIt))).toBe(jarvis.onIt)
  })

  test("a line of his own counts as heard said with more after it, the longest that fits, and nothing else does", async () => {
    const mine = ["Right away, sir.", "Very good", "Very good, sir."]
    const { persona: said } = await persona(undefined, jarvis, { YAPD_ON_IT: mine.join("|") })
    /** What may be said for going ahead once `spoken` has been. */
    const after = (spoken: string) => {
      Effect.runSync(said.said(spoken))
      return next(said, 40)
    }
    expect(await after("Very good, sir. In yapd, on Fable, in a worktree.")).toEqual(new Set(["Right away, sir.", "Very good"]))
    expect(await after("Very good. I took that to mean the staging branch.")).toEqual(new Set(["Right away, sir.", "Very good, sir."]))
    // Not one of his, or not at the start: the last one he heard stays as it was.
    expect(await after("Very goodness, that was quick.")).toEqual(new Set(["Right away, sir.", "Very good, sir."]))
    expect(await after("I took that to mean staging. Right away, sir.")).toEqual(new Set(["Right away, sir.", "Very good, sir."]))
    expect(await after(" Right away, sir. ")).toEqual(new Set(["Very good", "Very good, sir."]))
  })

  test("what's said past an \"On it\" a model wrote anyway, addressing him or not, is all that's left of it", () => {
    const sir = { address: "sir" }
    expect(Persona.afterOnIt("On it, sir.", sir)).toBe("")
    expect(Persona.afterOnIt("on it sir!", sir)).toBe("")
    expect(Persona.afterOnIt("On it.", Persona.plain)).toBe("")
    expect(Persona.afterOnIt("On it, sir, in yapd, on Fable, in a worktree.", sir)).toBe("In yapd, on Fable, in a worktree.")
    expect(Persona.afterOnIt("On it, in yapd, on Fable, without a worktree.", Persona.plain)).toBe("In yapd, on Fable, without a worktree.")
    expect(Persona.afterOnIt("On it — I took that to mean the staging branch.", sir)).toBe("I took that to mean the staging branch.")
    // Addressing him while the lines don't say how yet, since they're still being written, or couldn't be.
    expect(Persona.afterOnIt("On it, sir.", Persona.plain)).toBe("")
    expect(Persona.afterOnIt("on it sir!", Persona.plain)).toBe("")
    expect(Persona.afterOnIt("On it, my lord.", Persona.plain)).toBe("")
    expect(Persona.afterOnIt("On it, sir, in yapd, on Fable", Persona.plain)).toBe("In yapd, on Fable")
    expect(Persona.afterOnIt("On it, boss, in yapd.", Persona.plain)).toBe("In yapd.")
    expect(Persona.afterOnIt("On it, ma'am. I took that to mean staging.", Persona.plain)).toBe("I took that to mean staging.")
    // Words of what's said past it stay, however short.
    expect(Persona.afterOnIt("On it. In yapd", Persona.plain)).toBe("In yapd")
    expect(Persona.afterOnIt("On it, I took that to mean staging.", Persona.plain)).toBe("I took that to mean staging.")
    // Only the usual ways of addressing someone go: any other words after it are what was said.
    expect(Persona.afterOnIt("On it, staging only.", Persona.plain)).toBe("Staging only.")
    expect(Persona.afterOnIt("On it, tests first.", Persona.plain)).toBe("Tests first.")
    expect(Persona.afterOnIt("On it, chief, staging only.", Persona.plain)).toBe("Staging only.")
    expect(Persona.afterOnIt("On it, in yapd.", Persona.plain)).toBe("In yapd.")
    expect(Persona.afterOnIt("On it, in yapd, on Fable.", Persona.plain)).toBe("In yapd, on Fable.")
    expect(Persona.afterOnIt("On it, on Fable.", sir)).toBe("On Fable.")
    // Anything else is as it was.
    expect(Persona.afterOnIt("On itself, sir, it's fine.", Persona.plain)).toBe("On itself, sir, it's fine.")
    expect(Persona.afterOnIt("On items like that, sir, I'd wait.", sir)).toBe("On items like that, sir, I'd wait.")
    expect(Persona.afterOnIt(" Consider it done, sir. ", sir)).toBe("Consider it done, sir.")
    expect(Persona.afterOnIt("yapd's on it, sir.", sir)).toBe("yapd's on it, sir.")
  })

  test("a line for going ahead with more after it is a sentence of its own", () => {
    expect(Persona.withOnIt("Right away, sir.", "In yapd, on Fable, in a worktree.")).toBe("Right away, sir. In yapd, on Fable, in a worktree.")
    expect(Persona.withOnIt(" Right away, sir ", "In yapd.")).toBe("Right away, sir. In yapd.")
    expect(Persona.withOnIt("On it!", "In yapd.")).toBe("On it! In yapd.")
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
