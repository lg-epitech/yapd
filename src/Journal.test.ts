import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Journal from "./Journal.ts"

describe("Journal", () => {
  test("gives back what it kept since a time, oldest first, of the kinds asked for", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        yield* journal.write({ at: 1, kind: "update", project: "yapd", said: "Too old." })
        yield* journal.write({ at: 10, kind: "update", project: "yapd", said: "The tests pass.", detail: { priority: "done" } })
        yield* journal.write({ at: 20, kind: "reply", said: "On it.", text: "Merge it." })
        yield* journal.write({ at: 30, kind: "started", project: "std", text: "Fix the cache." })
        return {
          all: yield* journal.since(5),
          some: yield* journal.since(5, { kinds: ["update", "started"] }),
          latest: yield* journal.since(0, { most: 1 }),
        }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(kept.all.map(({ at }) => at)).toEqual([10, 20, 30])
    expect(kept.all[0]).toMatchObject({ kind: "update", project: "yapd", said: "The tests pass.", detail: { priority: "done" } })
    expect(kept.some.map(({ kind }) => kind)).toEqual(["update", "started"])
    expect(kept.latest.map(({ at }) => at)).toEqual([30])
  })
})
