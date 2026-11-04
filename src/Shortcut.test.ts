import { describe, expect, test } from "bun:test"
import { Effect, Either, Fiber, Option, Stream } from "effect"
import * as Shortcut from "./Shortcut.ts"

const parsed = (value: string) => Either.map(Shortcut.parse(value), Option.map(Shortcut.format))

/** Drives a controller through presses, returning what it told the helper and the events it made of them. */
const drive = (presses: ReadonlyArray<Shortcut.Key>, expected: number) =>
  Effect.gen(function* () {
    const sent: Array<object> = []
    const keys = { key: "space", modifiers: ["ctrl", "option", "cmd"] } as const
    const shortcut = yield* Shortcut.make(keys, (message) => sent.push(message), true)
    const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.service.events, expected)))
    // Lets the stream subscribe before anything is pressed.
    yield* Effect.yieldNow()
    yield* shortcut.greeted
    yield* shortcut.registered(true)
    for (const press of presses) yield* shortcut.pressed(press)
    const events = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
    return { sent, events: [...events].map((event) => event._tag) }
  })

describe("Shortcut", () => {
  test("reads a shortcut however it's spelled, and says what it can't read", () => {
    expect(parsed(" Command + Alt + Control + Space ")).toEqual(Either.right(Option.some("ctrl+option+cmd+space")))
    // A function key types nothing, so it can go without a modifier.
    expect(parsed("F13")).toEqual(Either.right(Option.some("f13")))
    expect(parsed(" None ")).toEqual(Either.right(Option.none()))
    expect(Either.isLeft(Shortcut.parse("shift+a"))).toBe(true)
  })

  test("starts on the first press, sends on the second and cancels on Escape, which the helper only holds meanwhile", async () => {
    const { sent, events } = await Effect.runPromise(drive(["shortcut", "shortcut", "shortcut", "escape", "escape"], 4))
    expect(events).toEqual(["Started", "Sent", "Started", "Cancelled"])
    expect(sent).toEqual([
      { type: "shortcut", key: "space", modifiers: ["ctrl", "option", "cmd"] },
      { type: "escape", on: true },
      { type: "escape", on: false },
      { type: "escape", on: true },
      { type: "escape", on: false, cancelled: true },
    ])
  })

  test("turning off cancels the identified physical capture even before recording setup finishes", async () => {
    const messages = await Effect.runPromise(Effect.gen(function* () {
      const messages: object[] = []
      const shortcut = yield* Shortcut.make({ key: "space", modifiers: ["ctrl"] }, (message) => messages.push(message), true)
      yield* shortcut.direct("shortcut", false, "phone", "physical-press")
      yield* shortcut.service.toggle(false)
      return messages
    }))
    expect(messages).toContainEqual({ type: "escape", on: false, deviceId: "phone", captureId: "physical-press", cancelled: true })
  })

  test("sends from this side only while dictating, and says whether a press from a phone starts one to send on a pause", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sent: Array<object> = []
        const shortcut = yield* Shortcut.make({ key: "space", modifiers: ["ctrl"] }, (message) => sent.push(message), true)
        const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.service.events, 3)))
        yield* Effect.yieldNow()
        yield* shortcut.service.send
        yield* shortcut.direct("shortcut", true)
        yield* shortcut.service.send
        yield* shortcut.service.send
        yield* shortcut.direct("shortcut")
        const events = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
        return { sent, events: [...events] }
      }),
    )
    expect(result.events).toEqual([{ _tag: "Started", onPause: true }, { _tag: "Sent" }, { _tag: "Started", onPause: false }])
    expect(result.sent).toEqual([
      { type: "escape", on: true },
      { type: "escape", on: false },
      { type: "escape", on: true },
    ])
  })

  test("holds no keys and starts nothing until it's on", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sent: Array<object> = []
        const shortcut = yield* Shortcut.make({ key: "space", modifiers: ["ctrl"] }, (message) => sent.push(message), false)
        const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.service.events, 1)))
        yield* Effect.yieldNow()
        yield* shortcut.greeted
        yield* shortcut.pressed("shortcut")
        yield* shortcut.service.toggle(true)
        yield* shortcut.registered(true)
        yield* shortcut.pressed("shortcut")
        yield* shortcut.pressed("shortcut")
        const events = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
        return { sent, events: [...events].map((event) => event._tag) }
      }),
    )
    expect(result.events).toEqual(["Started"])
    expect(result.sent).toEqual([
      { type: "shortcut" },
      { type: "shortcut", key: "space", modifiers: ["ctrl"] },
      { type: "escape", on: true },
      { type: "escape", on: false },
    ])
  })

  test("keeps the capture device through another device's send, auto-send, cancellation and disconnect", async () => {
    const events = await Effect.runPromise(Effect.gen(function* () {
      const shortcut = yield* Shortcut.make({ key: "space", modifiers: ["ctrl"] }, () => {}, true)
      const collected = yield* Effect.fork(Stream.runCollect(Stream.take(shortcut.service.events, 8)))
      yield* Effect.yieldNow()
      yield* shortcut.direct("shortcut", false, "phone", "physical-phone-press")
      yield* shortcut.pressed("shortcut", false, "mac", "another-physical-press")
      yield* shortcut.pressed("shortcut", true, "mac")
      yield* shortcut.service.send
      yield* shortcut.direct("shortcut", false, "second-phone")
      yield* shortcut.service.cancel
      yield* shortcut.direct("shortcut", false, "third-phone")
      yield* shortcut.departed("second-phone")
      yield* shortcut.departed("third-phone")
      return [...(yield* Fiber.join(collected).pipe(Effect.timeout("1 second")))]
    }))
    expect(events).toEqual([
      { _tag: "Started", onPause: false, deviceId: "phone", captureId: "physical-phone-press" },
      { _tag: "Sent", deviceId: "phone", captureId: "physical-phone-press" },
      { _tag: "Started", onPause: true, deviceId: "mac" },
      { _tag: "Sent", deviceId: "mac" },
      { _tag: "Started", onPause: false, deviceId: "second-phone" },
      { _tag: "Cancelled", deviceId: "second-phone" },
      { _tag: "Started", onPause: false, deviceId: "third-phone" },
      { _tag: "Cancelled", deviceId: "third-phone" },
    ])
  })
})
