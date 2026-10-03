import { describe, expect, test } from "bun:test"
import { Effect, Either, Fiber, Option, Stream } from "effect"
import * as Shortcut from "./Shortcut.ts"

const parsed = (value: string) => Either.map(Shortcut.parse(value), Option.map(Shortcut.format))

/** Drives a controller through presses, returning what it told the helper and the events it made of them. */
const drive = (presses: ReadonlyArray<Shortcut.Key | "quit">, expected: number) =>
  Effect.gen(function* () {
    const sent: Array<object> = []
    const keys = { key: "space", modifiers: ["ctrl", "option", "cmd"] } as const
    const shortcut = yield* Shortcut.make(keys, (message) => sent.push(message))
    const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.service.events, expected)))
    // Lets the stream subscribe before anything is pressed.
    yield* Effect.yieldNow()
    yield* shortcut.greeted
    for (const press of presses) yield* press === "quit" ? shortcut.quit : shortcut.pressed(press)
    const events = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
    return { sent, events: [...events].map((event) => event._tag) }
  })

describe("Shortcut", () => {
  test("reads a shortcut however it's spelled, and says what it can't read", () => {
    expect(parsed(" Command + Alt + Control + Space ")).toEqual(Either.right(Option.some("ctrl+option+cmd+space")))
    expect(parsed("cmd+enter")).toEqual(Either.right(Option.some("cmd+return")))
    // A function key types nothing, so it can go without a modifier.
    expect(parsed("F13")).toEqual(Either.right(Option.some("f13")))
    expect(parsed(" None ")).toEqual(Either.right(Option.none()))
    const why = (value: string) => Either.getLeft(Shortcut.parse(value)).pipe(Option.getOrUndefined)
    expect(why("hyper+space")).toContain(`"hyper" isn't ctrl, option, cmd or shift`)
    expect(why("ctrl+escape")).toContain("Escape is how a dictation is cancelled")
    expect(why("shift+a")).toContain("it needs ctrl, option or cmd")
  })

  test("starts on the first press, sends on the second and cancels on Escape, which the helper only holds meanwhile", async () => {
    const { sent, events } = await Effect.runPromise(drive(["shortcut", "shortcut", "shortcut", "escape", "escape"], 4))
    expect(events).toEqual(["Started", "Sent", "Started", "Cancelled"])
    expect(sent).toEqual([
      { type: "shortcut", key: "space", modifiers: ["ctrl", "option", "cmd"] },
      { type: "escape", on: true },
      { type: "escape", on: false },
      { type: "escape", on: true },
      { type: "escape", on: false },
    ])
  })

  test("ends a dictation from the daemon's side as if the user pressed Escape", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sent: Array<object> = []
        const shortcut = yield* Shortcut.make({ key: "space", modifiers: ["ctrl"] }, (message) => sent.push(message))
        const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.service.events, 2)))
        yield* Effect.yieldNow()
        yield* shortcut.service.cancel
        yield* shortcut.pressed("shortcut")
        yield* shortcut.service.cancel
        const events = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
        return { sent, events: [...events].map((event) => event._tag) }
      }),
    )
    expect(result.events).toEqual(["Started", "Cancelled"])
    expect(result.sent).toEqual([
      { type: "escape", on: true },
      { type: "escape", on: false },
    ])
  })

  test("cancels a dictation when the helper quits, which lets go of Escape itself", async () => {
    const { sent, events } = await Effect.runPromise(drive(["shortcut", "quit", "quit", "shortcut"], 3))
    expect(events).toEqual(["Started", "Cancelled", "Started"])
    expect(sent.slice(1)).toEqual([
      { type: "escape", on: true },
      { type: "escape", on: true },
    ])
  })

  test("lets go of the keys while off, and of whatever was pressed before, then takes them again once on, even in a new helper", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sent: Array<object> = []
        const shortcut = yield* Shortcut.make({ key: "space", modifiers: ["ctrl"] }, (message) => sent.push(message))
        const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.service.events, 2)))
        yield* Effect.yieldNow()
        // Let go of before anyone hears of it.
        yield* shortcut.pressed("shortcut")
        yield* shortcut.service.toggle(false)
        yield* shortcut.service.toggle(false)
        // On its way from the helper as the keys were let go of.
        yield* shortcut.pressed("shortcut")
        yield* shortcut.greeted
        yield* shortcut.service.toggle(true)
        yield* shortcut.pressed("shortcut")
        yield* shortcut.pressed("shortcut")
        const events = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
        return { sent, events: [...events].map((event) => event._tag) }
      }),
    )
    expect(result.events).toEqual(["Started", "Sent"])
    expect(result.sent).toEqual([
      { type: "escape", on: true },
      { type: "shortcut" },
      { type: "escape", on: false },
      { type: "shortcut" },
      { type: "shortcut", key: "space", modifiers: ["ctrl"] },
      { type: "escape", on: true },
      { type: "escape", on: false },
    ])
  })
})
