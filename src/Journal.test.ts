import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
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

  test("pages through what it kept, newest written first, each page picking up where the last left off", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        // Written in this order, though what the last is about happened first.
        for (const [at, kind] of [[10, "update"], [20, "answer"], [30, "update"], [40, "dictation"], [50, "answer"], [60, "update"], [5, "update"]] as const) {
          yield* journal.write({ at, kind, said: `At ${at}.` })
        }
        const first = yield* journal.page({ most: 3 })
        const second = yield* journal.page({ most: 3, before: first.at(-1)!.id })
        const third = yield* journal.page({ most: 3, before: second.at(-1)!.id })
        return {
          pages: [first, second, third].map((page) => page.map(({ at }) => at)),
          answers: (yield* journal.page({ most: 10, kinds: ["answer", "dictation"] })).map(({ at }) => at),
        }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(kept.pages).toEqual([[5, 60, 50], [40, 30, 20], [10]])
    expect(kept.answers).toEqual([50, 40, 20])
  })

  test("a key is kept once, however often it's claimed", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const claims = [
          yield* journal.claim({ at: 1, kind: "notice", key: "ask:Rosie:r1", said: "The Tezos migration asks which network to start with." }),
          yield* journal.claim({ at: 2, kind: "notice", key: "ask:Rosie:r1", said: "The Tezos migration asks which network to start with." }),
          yield* journal.claim({ at: 3, kind: "notice", key: "ask:Rosie:r1" }),
        ]
        return { claims, rows: yield* journal.since(0) }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(kept.claims).toEqual([true, false, false])
    expect(kept.rows.map(({ at }) => at)).toEqual([1])
  })

  test("what was said for an entry can be noted as other words, like those played in its place", async () => {
    const said = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const answer = Option.getOrThrow(yield* journal.write({ at: 10, kind: "answer", said: "It's on your screen. One running.", detail: { question: false } }))
        yield* journal.write({ at: 20, kind: "answer", said: "It's on your screen. Two running." })
        yield* journal.reword(answer, "One running, sir.")
        return (yield* journal.since(0)).map(({ said, detail }) => ({ said, detail }))
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(said).toEqual([
      { said: "One running, sir.", detail: { question: false } },
      { said: "It's on your screen. Two running.", detail: undefined },
    ])
  })

  test("an update counts as heard once it has played or been answered", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const played = Option.getOrThrow(yield* journal.write({ at: 10, kind: "update", project: "yapd", said: "The tests pass." }))
        const answered = Option.getOrThrow(yield* journal.write({ at: 20, kind: "update", project: "std", said: "Which database, sir?" }))
        yield* journal.write({ at: 30, kind: "update", project: "integration", said: "The migration is in." })
        const before = yield* journal.unheard(0, 12)
        // Played to the end, then replied to: both were heard, and noting it again keeps the first time.
        yield* journal.markHeard([played], 40)
        yield* journal.markHeard([answered], 50)
        yield* journal.markHeard([played], 60)
        return { before, after: yield* journal.unheard(0, 12), last: yield* journal.lastHeard }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(found.before.map(({ at }) => at)).toEqual([10, 20, 30])
    expect(found.after.map(({ at }) => at)).toEqual([30])
    expect(Option.map(found.last, ({ heardAt, project }) => ({ heardAt, project }))).toEqual(Option.some({ heardAt: 50, project: "std" }))
  })
})
