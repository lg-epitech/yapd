import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Records from "./Records.ts"
import * as Store from "./Store.ts"
import type { Known } from "./Threads.ts"

const run = <A>(test: Effect.Effect<A, unknown, Store.Store>) =>
  Effect.runPromise(Effect.scoped(Effect.provideServiceEffect(test, Store.Store, Store.make(":memory:", Store.migrations))))

const known = (extra: Partial<Known>): Known => ({
  machine: "rosie",
  id: "t1",
  prompt: null,
  dictated: null,
  description: null,
  started: false,
  at: "2026-09-30T10:00:00.000Z",
  ...extra,
})

describe("Records", () => {
  test("fills in what's known about a thread and never replaces anything", () =>
    run(
      Effect.gen(function* () {
        const records = yield* Records.make
        yield* records.remember(known({ prompt: "Fix the retries.", started: true }))
        // The opening never changes, so a later reading of it, like the user's first message, doesn't take the place of the prompt yapd wrote.
        yield* records.remember(known({ prompt: "Fix the retries, please.", dictated: "fix retries", description: "Makes retries stop.", at: "2026-09-30T11:00:00.000Z" }))
        yield* records.remember(known({ machine: "rig", prompt: "Same id, other machine." }))
        const recalled = yield* records.recall("rosie", ["t1", "missing"])
        expect([...recalled.keys()]).toEqual(["t1"])
        expect(recalled.get("t1")).toEqual(
          known({ prompt: "Fix the retries.", dictated: "fix retries", description: "Makes retries stop.", started: true }),
        )
        expect((yield* records.recall("rosie", [])).size).toBe(0)
      }),
    ))
})
