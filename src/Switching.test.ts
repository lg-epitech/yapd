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
  return { turn: switcher.turn, done }
}

describe("Switching yapd on and off", () => {
  test("a second on, or a second off, drops nothing", () => {
    const { turn, done } = made(true)
    Effect.runSync(turn(true))
    Effect.runSync(turn(false))
    Effect.runSync(turn(false))
    expect(done).toEqual(["shortcut", "back", "shortcut", "dictations", "drop", "off", "shortcut"])
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
          const transcripts = yield* Queue.unbounded<{ readonly heard: string }>()
          const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
          yield* Effect.forkScoped(
            Switching.dictations(Stream.fromQueue(transcripts), Effect.succeed({ on: true }), ({ heard }) =>
              Effect.gen(function* () {
                handed.push(heard)
                if (heard === "What's Tezos doing?") yield* Deferred.await(thinking)
                done.push(heard)
              }),
            ),
          )
          yield* Queue.offerAll(transcripts, ["What's Tezos doing?", "Tell it to merge.", "Mute."].map((heard) => ({ heard })))
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

  test("only 'Mute.' while yapd is on goes ahead of what he dictated before it, never 'unmute' or 'turn on' while it's off", () => {
    const ahead = (heard: string, on: boolean) => Effect.runSync(Switching.urgent(heard, Effect.succeed({ on })))
    expect(["Mute."].map((heard) => ahead(heard, true))).toEqual([true])
    expect(["Mute.", "Unmute."].map((heard) => ahead(heard, false))).toEqual([false, false])
    expect(["Mute it.", "Mute?"].map((heard) => ahead(heard, true))).toEqual([false, false])
  })
})
