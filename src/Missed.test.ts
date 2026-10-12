import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import * as Journal from "./Journal.ts"
import * as Missed from "./Missed.ts"

const hour = 60 * 60_000
const day = 24 * hour
const now = 30 * day
const nowhere = { threads: [], away: [] }

const gathered = (write: (journal: Journal.Journal["Type"]) => Effect.Effect<void>, spoke = now - hour) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal.Journal
      yield* write(journal)
      const missed = yield* Missed.gather(journal, { now, spoke, coming: [], desk: nowhere })
      return { since: missed.since, off: missed.off, said: missed.groups.flatMap(({ rows }) => rows.map(({ said }) => said)).toSorted() }
    }).pipe(Effect.provide(Journal.memory)),
  )

const switched = (journal: Journal.Journal["Type"], at: number, on: boolean) => Effect.asVoid(journal.write({ at, kind: "action", detail: { on } }))
const update = (journal: Journal.Journal["Type"], at: number, said: string, detail: Record<string, unknown>) =>
  Effect.asVoid(journal.write({ at, kind: "update", machine: "Rosie", thread: "t-tezos", project: "integration", said, detail }))

describe("Missed", () => {
  test("a catch-up looks back a day, or to when he turned yapd off when that's longer, a week at most", () => {
    expect(Missed.since(now)).toBe(now - day)
    expect(Missed.since(now, now - hour)).toBe(now - day)
    expect(Missed.since(now, now - 3 * day)).toBe(now - 3 * day)
    expect(Missed.since(now, now - 10 * day)).toBe(now - 7 * day)
  })

  test("when he last had yapd off runs from the first off to the first on after, whatever was asked for again", () => {
    const row = (at: number, on: boolean) => ({ id: at, at, kind: "action", detail: { on } }) as unknown as Journal.Kept
    // Newest first, as the journal keeps them.
    expect(Missed.off([row(50, true), row(40, true), row(30, false), row(20, false), row(10, true)])).toEqual({ from: 20, to: 40, before: 10 })
    expect(Missed.off([row(30, false), row(20, false)])).toEqual({ from: 20 })
    expect(Missed.off([row(10, true)])).toBeUndefined()
  })

  test("what came in while yapd was off over a weekend counts, though he turned it off and on for a moment since", async () => {
    const result = await gathered((journal) =>
      Effect.gen(function* () {
        yield* switched(journal, now - 64 * hour, false)
        yield* update(journal, now - 50 * hour, "Which network first?", { priority: "needs-you", held: "off" })
        yield* journal.write({ at: now - 40 * hour, kind: "notice", machine: "Rosie", thread: "t-tezos", key: "fail:Rosie:r1", said: "The loader failed.", detail: { failure: "provider_error" } })
        yield* update(journal, now - 30 * hour, "Distribox copied the EU bucket.", { priority: "done", held: "off" })
        yield* update(journal, now - 26 * hour, "The fee table is in.", { priority: "done", audible: true, held: "off" })
        // Held for focus, or cut off, before the day: gone by now, as ever.
        yield* update(journal, now - 30 * hour, "Pass 6 is running.", { priority: "progress", held: "focus" })
        yield* update(journal, now - 30 * hour, "Cut off long ago.", { priority: "done" })
        yield* switched(journal, now - 4 * hour, true)
        yield* switched(journal, now - 2 * hour, false)
        yield* switched(journal, now - 1 * hour, true)
        // Asked for on again from the API.
        yield* switched(journal, now - 0.5 * hour, true)
      }),
    )
    expect(result.said).toEqual(["Distribox copied the EU bucket.", "The fee table is in.", "The loader failed.", "Which network first?"])
    expect(result.since).toBe(now - 50 * hour)
    expect(result.off).toEqual({ from: now - 2 * hour, to: now - hour })
  })

  test("what was waiting, being read or summed up as he turned yapd off counts days later, though it was kept a moment before the off", async () => {
    const result = await gathered((journal) =>
      Effect.gen(function* () {
        yield* update(journal, now - 72 * hour - 2000, "The Tezos importer tests pass.", { priority: "done", held: "off", heldAt: now - 72 * hour - 20 })
        yield* update(journal, now - 72 * hour - 1000, "Distribox copied the EU bucket.", { priority: "done", held: "off" })
        yield* switched(journal, now - 72 * hour, false)
        // A second off from the API.
        yield* switched(journal, now - 48 * hour, false)
        yield* update(journal, now - 30 * hour, "Distribox deployed.", { priority: "done", held: "off" })
      }),
    )
    expect(result.said).toEqual(["Distribox copied the EU bucket.", "Distribox deployed.", "The Tezos importer tests pass."])
    expect(result.off).toEqual({ from: now - 72 * hour })
  })

  test("nothing older than a week counts, kept while off or not", async () => {
    const result = await gathered((journal) =>
      Effect.gen(function* () {
        yield* switched(journal, now - 9 * day, false)
        yield* update(journal, now - 8 * day, "Too old.", { priority: "needs-you", held: "off" })
        yield* update(journal, now - 6 * day, "Still in the week.", { priority: "done", held: "off" })
      }),
    )
    expect(result.said).toEqual(["Still in the week."])
  })

  test("a row given away as coming isn't missed", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const id = Option.getOrThrow(yield* journal.write({ at: now - hour, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Being read.", detail: { priority: "done" } }))
        const missed = yield* Missed.gather(journal, { now, spoke: now - 2 * hour, coming: [id], desk: nowhere })
        return missed.groups.length
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(result).toBe(0)
  })
})
