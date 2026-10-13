import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Queue, Stream } from "effect"
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
