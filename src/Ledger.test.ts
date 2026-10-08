import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Ledger from "./Ledger.ts"

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
})
