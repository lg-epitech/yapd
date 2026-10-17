import { describe, expect, test } from "bun:test"
import { type Duration, Effect, Option, type Scope, TestClock, TestContext } from "effect"
import * as Journal from "./Journal.ts"
import * as Modes from "./Modes.ts"
import * as Settings from "./Settings.ts"
import * as Store from "./Store.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** Lets the fibers catch up, since the clock only moves when told to. */
const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
const wait = (duration: Duration.DurationInput) => Effect.zipRight(TestClock.adjust(duration), flush)

const minute = 60_000
const day = 24 * 60 * minute

/** A database of its own, with its settings and journal. */
const kept = Effect.map(Store.make(":memory:"), (store) => ({ settings: Settings.fromStore(store), journal: Journal.fromStore(store) }))

/**
 * The modes running over that database, with yapd `on` and quiet for as long
 * as `idle` says, noting what it held, the digests it gave and the rundowns
 * it offered: looked at every minute unless said, since every step of the
 * test clock takes a little real time.
 */
const running = (
  database: Effect.Effect.Success<typeof kept>,
  given: { on?: () => boolean; idle?: () => Option.Option<number>; look?: Duration.DurationInput } = {},
) =>
  Effect.gen(function* () {
    const modes = yield* Modes.make(database)
    const held: Array<Modes.Hold> = []
    const digests: Array<ReadonlyArray<string>> = []
    const offered: Array<readonly [number, Modes.Hold]> = []
    yield* Modes.run(modes, {
      ...database,
      power: Effect.sync(() => ({ on: given.on?.() ?? true, turns: 0 })),
      idle: Effect.sync(() => given.idle?.() ?? Option.some(10 * minute)),
      hold: (why) => Effect.sync(() => void held.push(why)),
      // Said, so he's briefed on what it covers, as the assistant does.
      digest: (rows, at) => Effect.zipRight(Effect.sync(() => void digests.push(rows.map(({ said }) => said ?? ""))), modes.briefed(at)),
      rundown: (count, was) => Effect.sync(() => void offered.push([count, was])),
    }, given.look ?? "1 minute")
    yield* flush
    return { modes, held, digests, offered }
  })

/** An update held for later, as the daemon keeps one. */
const holding = (journal: Journal.Journal["Type"], at: number, said: string, why: Journal.Held = "progress") =>
  journal.write({ at, kind: "update", thread: `t-${said}`, said, detail: { held: why } })

describe("Modes", () => {
  test("a mode and how much is said survive a restart, focus an hour by default and quiet until the morning", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(day)
        const database = yield* kept
        const first = yield* Modes.make(database)
        yield* first.set("focus")
        yield* first.setDetail("full")
        const again = yield* Modes.make(database)
        const focus = yield* again.current
        const holds = yield* again.holding
        yield* again.set("quiet")
        const quiet = (yield* (yield* Modes.make(database)).current).mode
        // A time already gone, or more than a day off, is the default.
        yield* again.set("focus", day - minute)
        const gone = (yield* again.current).mode.until
        yield* again.set("focus", day + 2 * day)
        const far = (yield* again.current).mode.until
        yield* again.set("focus", day + 2 * 60 * minute)
        const asked = (yield* again.current).mode.until
        return { focus, holds, quiet, gone, far, asked }
      }),
    )
    expect(result.focus).toEqual({ mode: { mode: "focus", until: day + 60 * minute, since: day }, detail: "full" })
    expect(result.holds).toEqual(Option.some("focus"))
    // Going quiet from focus, what focus held is still counted from when it began.
    expect(result.quiet).toEqual({ mode: "quiet", until: Modes.morning(day), since: day })
    expect(new Date(Modes.morning(day)).getHours()).toBe(8)
    expect(result.gone).toBe(day + 60 * minute)
    expect(result.far).toBe(day + 60 * minute)
    expect(result.asked).toBe(day + 2 * 60 * minute)
  })

  test("focus holds what waits as it begins, and once its time is up goes back to normal and offers the rundown once, but only while yapd is on", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(day)
        const database = yield* kept
        let on = true
        const { modes, held, offered } = yield* running(database, { on: () => on })
        yield* modes.set("focus")
        yield* flush
        yield* holding(database.journal, day + 10 * minute, "The Mina tickets are open.", "focus")
        yield* holding(database.journal, day + 20 * minute, "Pass 7 is running.", "focus")
        yield* wait("59 minutes")
        const before = { mode: (yield* modes.current).mode.mode, offered: [...offered] }
        yield* wait("1 minute")
        const after = { mode: (yield* modes.current).mode.mode, offered: [...offered] }
        // Off as quiet ends, it ends without a word.
        on = false
        yield* modes.set("quiet", day + 80 * minute)
        yield* holding(database.journal, day + 70 * minute, "std's cache is fixed.", "quiet")
        yield* wait("21 minutes")
        return { before, after, off: { mode: (yield* modes.current).mode.mode, offered: [...offered] }, held }
      }),
    )
    expect(result.before).toEqual({ mode: "focus", offered: [] })
    expect(result.after).toEqual({ mode: "normal", offered: [[2, "focus"]] })
    expect(result.off).toEqual({ mode: "normal", offered: [[2, "focus"]] })
    expect(result.held).toEqual(["focus", "quiet"])
  })

  test("the digest waits for a minute of quiet and three held or one held twenty minutes, comes at most every twenty minutes, and never in focus or quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(day)
        const database = yield* kept
        let idle = Option.some(10 * minute)
        const { modes, digests } = yield* running(database, { idle: () => idle, look: "15 seconds" })
        const { journal } = database
        yield* holding(journal, day, "One.")
        yield* holding(journal, day, "Two.")
        yield* wait("15 seconds")
        const two = digests.length
        yield* holding(journal, day + 15_000, "Three.")
        // Not while anything's being said, or for less than a minute after.
        idle = Option.none()
        yield* wait("15 seconds")
        idle = Option.some(30_000)
        yield* wait("15 seconds")
        const busy = digests.length
        idle = Option.some(10 * minute)
        yield* wait("15 seconds")
        const first = [...digests]
        // What comes after waits twenty minutes from the last.
        for (const said of ["Four.", "Five.", "Six."]) yield* holding(journal, day + 2 * minute, said)
        yield* wait("10 minutes")
        const soon = digests.length
        yield* wait("10 minutes")
        const second = digests.at(-1)
        // In focus, never; back to normal, one held twenty minutes is enough.
        yield* modes.set("focus")
        yield* holding(journal, day + 25 * minute, "Seven.")
        yield* wait("30 minutes")
        const focused = digests.length
        yield* modes.set("normal")
        yield* wait("15 seconds")
        return { two, busy, first, soon, second, focused, last: digests.at(-1), count: digests.length }
      }),
    )
    expect(result.two).toBe(0)
    expect(result.busy).toBe(0)
    expect(result.first).toEqual([["One.", "Two.", "Three."]])
    expect(result.soon).toBe(1)
    expect(result.second).toEqual(["Four.", "Five.", "Six."])
    expect(result.focused).toBe(2)
    expect(result.last).toEqual(["Seven."])
    expect(result.count).toBe(3)
  })
})
