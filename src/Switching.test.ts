import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Switching from "./Switching.ts"

/** A yapd that starts `on`, noting what each part did, in order. */
const made = (on: boolean) => {
  let power = { on }
  const done: Array<string> = []
  const note = (what: string) => Effect.sync(() => void done.push(what))
  const turn = Switching.switcher({
    power: Effect.sync(() => power),
    drop: note("drop"),
    turn: (next) =>
      Effect.sync(() => {
        done.push(next ? "on" : "off")
        power = { on: next }
      }),
    shortcut: note("shortcut"),
    back: note("back"),
  })
  return { turn, done }
}

describe("Switching yapd on and off", () => {
  test("starting on, as the daemon already is, drops nothing he asks: only the shortcut and what's said on coming back", () => {
    const { turn, done } = made(true)
    Effect.runSync(turn(true))
    expect(done).toEqual(["shortcut", "back"])
  })

  test("a second on, or a second off, drops nothing either", () => {
    const { turn, done } = made(true)
    Effect.runSync(turn(true))
    Effect.runSync(turn(false))
    Effect.runSync(turn(false))
    expect(done).toEqual(["shortcut", "back", "shortcut", "drop", "off", "shortcut"])
  })

  test("really switching drops what's under way before the daemon turns, both ways", () => {
    const { turn, done } = made(false)
    Effect.runSync(turn(true))
    Effect.runSync(turn(false))
    expect(done).toEqual(["drop", "on", "shortcut", "back", "shortcut", "drop", "off"])
  })
})
