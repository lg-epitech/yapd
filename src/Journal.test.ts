import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option, Stream } from "effect"
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
    expect(kept.claims.map(Option.isSome)).toEqual([true, false, false])
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

  test("what he heard can be noted as still to be heard, like a question put by to be asked again, and heard again after", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const asked = Option.getOrThrow(Option.flatten(yield* journal.claim({ at: 10, kind: "notice", key: "ask:rig:q9", said: "A question on Fee table checks on rig." })))
        yield* journal.markHeard([asked], 20)
        const heard = yield* journal.unheard(0, 12)
        yield* journal.markUnheard([asked])
        const putBy = yield* journal.unheard(0, 12)
        yield* journal.markHeard([asked], 30)
        return { heard, putBy, again: yield* journal.since(0) }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(found.heard).toEqual([])
    expect(found.putBy.map(({ key, heardAt }) => ({ key, heardAt }))).toEqual([{ key: "ask:rig:q9", heardAt: undefined }])
    expect(found.again.map(({ heardAt }) => heardAt)).toEqual([30])
  })

  test("tells of each update and notice as it's kept, and of a claim only when it kept one", async () => {
    const told = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* Journal.Journal
          const following = yield* Effect.fork(Stream.runCollect(Stream.take(journal.kept, 3)))
          // Let the stream start following before anything is kept.
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
          yield* journal.write({ at: 1, kind: "dictation", text: "What's going on?" })
          yield* journal.write({ at: 2, kind: "update", host: "rig.local", project: "yapd", thread: "claude:s1", said: "yapd. The tests pass." })
          yield* journal.claim({ at: 3, kind: "notice", key: "ask:Rosie:r1", machine: "Rosie", thread: "t-tezos", said: "The Tezos migration asks which network." })
          // Claimed again, nothing is kept, so nothing is told.
          yield* journal.claim({ at: 4, kind: "notice", key: "ask:Rosie:r1", machine: "Rosie", thread: "t-tezos", said: "Again." })
          yield* journal.write({ at: 5, kind: "answer", said: "Two running." })
          yield* journal.write({ at: 6, kind: "update", machine: "Rosie", thread: "t-tezos", said: "integration. Done." })
          return [...(yield* Fiber.join(following))]
        }),
      ).pipe(Effect.provide(Journal.memory)),
    )
    expect(told.map(({ at, kind, machine, said }) => ({ at, kind, machine, said }))).toEqual([
      { at: 2, kind: "update", machine: "rig", said: "yapd. The tests pass." },
      { at: 3, kind: "notice", machine: "Rosie", said: "The Tezos migration asks which network." },
      { at: 6, kind: "update", machine: "Rosie", said: "integration. Done." },
    ])
    // As it reads back, with the host it came from.
    expect(told[0]!.detail).toEqual({ host: "rig.local" })
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

  test("what was kept quiet, as his muting a thread does, is noted on its entry and told apart from the rest he hasn't heard", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal.Journal
        const loud = Option.getOrThrow(yield* journal.write({ at: 10, kind: "update", said: "Said.", detail: { priority: "done" } }))
        yield* journal.write({ at: 20, kind: "update", said: "Kept quiet.", detail: { priority: "done", muted: true } })
        const dropped = Option.getOrThrow(yield* journal.write({ at: 30, kind: "update", said: "Dropped once muted.", detail: { priority: "done", session: "claude:s1" } }))
        const bare = Option.getOrThrow(yield* journal.write({ at: 40, kind: "notice", said: "No detail." }))
        yield* journal.mute([dropped, bare])
        return {
          all: (yield* journal.unheard(0, 10)).map(({ said }) => said),
          quiet: (yield* journal.unheard(0, 10, true)).map(({ said, detail }) => ({ said, detail })),
          loud: (yield* journal.unheard(0, 10, false)).map(({ id }) => id),
          loudId: loud,
        }
      }).pipe(Effect.provide(Journal.memory)),
    )
    expect(found.all).toEqual(["Said.", "Kept quiet.", "Dropped once muted.", "No detail."])
    expect(found.quiet).toEqual([
      { said: "Kept quiet.", detail: { priority: "done", muted: true } },
      { said: "Dropped once muted.", detail: { priority: "done", session: "claude:s1", muted: true } },
      { said: "No detail.", detail: { muted: true } },
    ])
    expect(found.loud).toEqual([found.loudId])
  })
})
