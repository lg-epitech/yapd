import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Queue, Stream } from "effect"
import * as Switching from "./Switching.ts"

/** A yapd that starts `on`, noting what each part did, in order. */
const made = (on: boolean) => {
  let power = { on, turns: 0 }
  const done: Array<string> = []
  const note = (what: string) => Effect.sync(() => void done.push(what))
  const switcher = Switching.switcher({
    power: Effect.sync(() => power),
    dictations: note("dictations"),
    drop: note("drop"),
    turn: (next) =>
      Effect.sync(() => {
        done.push(next ? "on" : "off")
        power = { on: next, turns: power.turns + 1 }
      }),
    shortcut: note("shortcut"),
    back: note("back"),
  })
  return { turn: switcher.turn, turns: switcher.turns, done }
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
    expect(done).toEqual(["shortcut", "back", "shortcut", "dictations", "drop", "off", "shortcut"])
  })

  test("really switching drops what's under way before the daemon turns, both ways", () => {
    const { turn, done } = made(false)
    Effect.runSync(turn(true))
    Effect.runSync(turn(false))
    expect(done).toEqual(["dictations", "drop", "on", "shortcut", "back", "shortcut", "dictations", "drop", "off"])
  })

  test("turned on by 'unmute', a dictation he pressed for right after is kept, and taken for one made once yapd is on", () => {
    const { turn, turns, done } = made(false)
    // He pressed for "unmute" as press 4, then again as press 5, before it was heard, so both were made while yapd was off.
    Effect.runSync(turn(true, 4))
    expect(done).toEqual(["drop", "on", "shortcut", "back"])
    expect([turns(5, 0), turns(4, 0), turns(3, 0), turns(6, 1)]).toEqual([1, 0, 0, 1])
    // Turned off and on from the menu since, it's still taken as made before then, so it's said before yapd was turned off, as ever.
    Effect.runSync(turn(false))
    Effect.runSync(turn(true))
    expect(turns(5, 0)).toBe(1)
    expect(done.slice(4)).toEqual(["shortcut", "dictations", "drop", "off", "dictations", "drop", "on", "shortcut", "back"])
  })
})

describe("Handing on what he dictates", () => {
  test("'Mute.' is handed on at once, never waiting behind one still being worked out; the rest go one at a time, in the order he said them", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handed: Array<string> = []
          const done: Array<string> = []
          const thinking = yield* Deferred.make<void>()
          const transcripts = yield* Queue.unbounded<string>()
          const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
          yield* Effect.forkScoped(
            Switching.dictations(
              Stream.fromQueue(transcripts),
              (heard) => Effect.succeed(heard === "Mute."),
              (heard) =>
                Effect.gen(function* () {
                  handed.push(heard)
                  if (heard === "What's Tezos doing?") yield* Deferred.await(thinking)
                  done.push(heard)
                }),
            ),
          )
          yield* Queue.offerAll(transcripts, ["What's Tezos doing?", "Tell it to merge.", "Mute."])
          yield* flush
          const meanwhile = { handed: [...handed], done: [...done] }
          yield* Deferred.succeed(thinking, undefined)
          yield* flush
          return { meanwhile, handed, done }
        }),
      ),
    )
    expect(result.meanwhile).toEqual({ handed: ["What's Tezos doing?", "Mute."], done: ["Mute."] })
    expect(result.handed).toEqual(["What's Tezos doing?", "Mute.", "Tell it to merge."])
    expect(result.done).toEqual(["Mute.", "What's Tezos doing?", "Tell it to merge."])
  })
})
