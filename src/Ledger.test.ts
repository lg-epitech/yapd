import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as Ledger from "./Ledger.ts"
import * as Store from "./Store.ts"

describe("Ledger", () => {
  test("preparing the same step twice gives one row", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger
        const step = (text: string) =>
          ledger.prepare({
            utterance: "u1",
            step: 0,
            kind: "message",
            machine: "Rosie",
            thread: "t-tezos",
            body: ({ messageId }) => ({ _tag: "Send", text, messageId, how: "now" }),
            message: true,
            digest: Ledger.digest(text),
          })
        // Worked out again, it may come out in other words, but it's the same step.
        const first = yield* step("Use the fee table from the Mina work.")
        const again = yield* step("Use the Mina fee table.")
        const open = yield* ledger.open(0)
        return { first, again, open }
      }).pipe(Effect.provide(Ledger.memory)),
    )
    expect(result.first).toMatchObject({ commandId: "yapd:u1:0", messageId: "yapd:u1:0:m", state: "prepared", fresh: true })
    expect(result.again).toMatchObject({ commandId: "yapd:u1:0", messageId: "yapd:u1:0:m", fresh: false })
    expect(result.again.body).toEqual({ _tag: "Send", text: "Use the fee table from the Mina work.", messageId: "yapd:u1:0:m", how: "now" })
    expect(result.open.map(({ commandId }) => commandId)).toEqual(["yapd:u1:0"])
  })

  test("a step taken to send again, or let be, is nothing a restart offers, even when yapd stops before it's settled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger.Ledger
        const step = (utterance: string) =>
          ledger.prepare({
            utterance,
            step: 0,
            kind: "message",
            machine: "Rosie",
            thread: "t-tezos",
            body: ({ messageId }) => ({ _tag: "Send", text: "Use the fee table.", messageId, how: "now" }),
            message: true,
          })
        yield* step("u1")
        yield* step("u2")
        // His yes to the first, and yapd stopping as it's sent; his no to the second, which never said what came of it.
        const taken = yield* ledger.resending("yapd:u1:0")
        yield* ledger.leave("yapd:u2:0", "He said no.")
        return { taken: Option.isSome(taken), open: yield* ledger.open(0), again: Option.isSome(yield* ledger.resending("yapd:u1:0")) }
      }).pipe(Effect.provide(Ledger.memory)),
    )
    expect(result).toEqual({ taken: true, open: [], again: false })
  })

  test("noting what came of a step tells one that's moved on since it was read from one yapd's database couldn't write", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        const ledger = Ledger.fromStore(store)
        const row = yield* ledger.prepare({
          utterance: "u1",
          step: 0,
          kind: "message",
          machine: "Rosie",
          thread: "t-tezos",
          body: ({ messageId }) => ({ _tag: "Send", text: "Use the fee table.", messageId, how: "now" }),
          message: true,
        })
        const noted = yield* ledger.settle(row.commandId, "unknown", { as: row })
        // As it was read before that, it's moved on since.
        const stale = yield* ledger.settle(row.commandId, "abandoned", { as: row })
        yield* store.transaction((database) => database.exec("PRAGMA query_only = ON"))
        const unwritten = yield* ledger.settle(row.commandId, "abandoned", { as: { state: "unknown", reason: null } })
        return { noted, stale, unwritten, state: Option.map(yield* ledger.get(row.commandId), ({ state }) => state) }
      }).pipe(Effect.scoped),
    )
    expect(result).toEqual({ noted: "noted", stale: "stale", unwritten: "unwritten", state: Option.some("unknown") })
  })
})
