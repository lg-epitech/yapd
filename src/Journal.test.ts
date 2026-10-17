import { describe, expect, test } from "bun:test"
import { Clock, Effect, Option } from "effect"
import * as Journal from "./Journal.ts"

describe("Journal", () => {
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
    expect(kept.claims.map(Option.isSome)).toEqual([true, false, false])
    expect(kept.rows.map(({ at }) => at)).toEqual([1])
  })

  test("gives each thread's newest update or notice within the window, newest first", async () => {
    const latest = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        yield* journal.write({ at: 1, kind: "update", machine: "Rosie", thread: "t-old", said: "Too old." })
        yield* journal.write({ at: 10, kind: "update", machine: "Rosie", thread: "t-tezos", said: "First." })
        yield* journal.write({ at: 20, kind: "update", machine: "rig", thread: "t-tezos", said: "Rig's, the same id." })
        yield* journal.write({ at: 30, kind: "notice", machine: "Rosie", thread: "t-tezos", said: "It asks something." })
        yield* journal.write({ at: 40, kind: "answer", machine: "Rosie", thread: "t-mina", said: "Not an update." })
        yield* journal.write({ at: 50, kind: "update", machine: "Rosie", thread: "claude:s1", said: "A session." })
        yield* journal.write({ at: 60, kind: "update", said: "No thread at all." })
        // A failure told at 70, then an update of the turn before it, kept only now since summing it up took a while: the failure is newer.
        yield* journal.write({ at: 70, kind: "notice", machine: "Rosie", thread: "t-mina", said: "The Mina thread failed." })
        yield* journal.write({ at: 65, kind: "update", machine: "Rosie", thread: "t-mina", said: "integration. Halfway." })
        return { all: yield* journal.latest(5, 10), two: yield* journal.latest(5, 2) }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(latest.all.map(({ machine, thread, said }) => `${machine} ${thread}: ${said}`)).toEqual([
      "Rosie t-mina: The Mina thread failed.",
      "Rosie claude:s1: A session.",
      "Rosie t-tezos: It asks something.",
      "rig t-tezos: Rig's, the same id.",
    ])
    expect(latest.two.map(({ at }) => at)).toEqual([70, 50])
  })

  test("news of the same work leaves only progress held for later out of date, never what focus held of it, and what's held late counts from then", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const progress = Option.getOrThrow(yield* journal.write({ at: 10, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Pass 7 is running.", detail: { held: "progress" } }))
        const done = Option.getOrThrow(yield* journal.write({ at: 20, kind: "update", machine: "Rosie", thread: "t-tezos", said: "The fee table is in.", detail: { held: "focus" } }))
        const newer = Option.getOrThrow(yield* journal.write({ at: 30, kind: "update", machine: "Rosie", thread: "t-tezos", said: "Should I merge it?" }))
        yield* journal.outdated(newer, "claude:s-tezos", { machine: "Rosie", id: "t-tezos" }, 40)
        // Waiting to be said as focus began, long after it came.
        const waiting = Option.getOrThrow(yield* journal.write({ at: 50, kind: "update", thread: "t-mina", said: "Mina's tickets are open." }))
        const since = (yield* Clock.currentTimeMillis) - 1
        yield* journal.hold([waiting], "focus")
        return { held: (yield* journal.held(0)).map(({ id }) => id), late: (yield* journal.held(since)).map(({ id }) => id), ids: { progress, done, waiting } }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(kept.held).toEqual([kept.ids.done, kept.ids.waiting])
    expect(kept.late).toEqual([kept.ids.waiting])
  })

  test("what he missed keeps what was never read out whatever he said since, what was cut off only since he spoke, and never an agent's question or what he heard", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const id = (written: Option.Option<number>) => Option.getOrThrow(written)
        const off = id(yield* journal.write({ at: 10, kind: "update", thread: "t-dist", said: "Distribox migrated.", detail: { held: "off" } }))
        const muted = id(yield* journal.write({ at: 11, kind: "update", thread: "t-docs", said: "Docs swept.", detail: { muted: true } }))
        const failed = id(yield* journal.write({ at: 12, kind: "notice", thread: "t-dist", key: "fail:Rosie:r1", said: "Distribox failed.", detail: { failure: "provider_error" } }))
        // An agent's question waits on him in T3 Code, and is asked, never caught up on.
        yield* journal.write({ at: 13, kind: "notice", thread: "t-dist", key: "ask:Rosie:q1", said: "Distribox asks which table.", detail: { request: "Question" } })
        // Cut off before he last spoke, and after.
        yield* journal.write({ at: 14, kind: "update", thread: "t-tez", said: "Tezos cut off early." })
        const late = id(yield* journal.write({ at: 30, kind: "update", thread: "t-tez", said: "Tezos cut off late." }))
        const heard = id(yield* journal.write({ at: 31, kind: "update", thread: "t-tez", said: "Tezos heard." }))
        yield* journal.markHeard([heard], 32)
        // Too old for the window.
        yield* journal.write({ at: 5, kind: "update", thread: "t-old", said: "Long ago.", detail: { held: "off" } })
        return { missed: (yield* journal.missed(10, 20)).map(({ id }) => id), ids: [off, muted, failed, late] }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(kept.missed).toEqual(kept.ids)
  })

  test("what he missed reaches back further for what came in while yapd was off, what needs him and what he's to hear whatever he muted, but not for the rest", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const said = (rows: ReadonlyArray<Journal.Kept>) => rows.map(({ said }) => said)
        yield* journal.write({ at: 5, kind: "update", thread: "t-dist", said: "Kept while off.", detail: { held: "off" } })
        yield* journal.write({ at: 6, kind: "notice", thread: "t-dist", key: "fail:Rosie:r1", said: "Distribox failed.", detail: { failure: "provider_error" } })
        yield* journal.write({ at: 7, kind: "update", thread: "t-tez", said: "Which network?", detail: { priority: "needs-you", held: "focus" } })
        yield* journal.write({ at: 8, kind: "update", thread: "t-tez", said: "The answer to his message.", detail: { audible: true, muted: true } })
        yield* journal.write({ at: 9, kind: "update", thread: "t-tez", said: "Held for focus.", detail: { held: "focus" } })
        yield* journal.write({ at: 2, kind: "update", thread: "t-old", said: "Too long ago.", detail: { held: "off" } })
        return { window: said(yield* journal.missed(10, 20)), further: said(yield* journal.missed(10, 20, 500, 3)) }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(kept).toEqual({ window: [], further: ["Kept while off.", "Distribox failed.", "Which network?", "The answer to his message."] })
  })

  test("an update that takes the place of another about the same turn is the one read and counted, and hearing it hears that one too, never the other way round", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const write = (at: number, said: string, detail: Record<string, unknown>) =>
          Effect.map(journal.write({ at, kind: "update", machine: "Rosie", thread: "t-tezos", said, detail }), Option.getOrThrow)
        // Held for focus in its hook's place, then its Stop, come late, held as yapd was off.
        const first = yield* write(10, "Pass 7 is done.", { priority: "done", held: "focus" })
        const second = yield* write(20, "Pass 7 is done.", { priority: "done", held: "off", replaces: first })
        // Another turn, kept before the field was, reads as it always did.
        const other = yield* write(30, "The docs are swept.", { priority: "done", held: "off" })
        const said = (rows: ReadonlyArray<Journal.Kept>) => rows.map(({ id }) => id)
        const read = {
          unheard: said(yield* journal.unheard(0, 10)),
          held: said(yield* journal.held(0)),
          digest: said(yield* journal.held(0, 200, { except: ["off"] })),
          missed: said(yield* journal.missed(0, 0)),
        }
        // Hearing the one it replaced alone leaves the newer unheard.
        yield* journal.markHeard([first], 40)
        const alone = (yield* journal.rows([second])).map(({ heardAt }) => heardAt)
        yield* journal.markUnheard([first])
        yield* journal.markHeard([second], 50)
        return { first, second, other, read, alone, heard: (yield* journal.rows([first, second, other])).map(({ heardAt }) => heardAt) }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(kept.read).toEqual({ unheard: [kept.second, kept.other], held: [kept.second, kept.other], digest: [], missed: [kept.second, kept.other] })
    expect(kept.alone).toEqual([undefined])
    expect(kept.heard).toEqual([50, 50, undefined])
  })
})
