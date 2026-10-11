import { describe, expect, test } from "bun:test"
import { Effect, Option, type Scope, Stream, TestClock, TestContext } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type * as Conversation from "./Conversation.ts"
import * as Journal from "./Journal.ts"
import * as Mutes from "./Mutes.ts"
import * as Store from "./Store.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** Lets the fibers catch up, since the clock only moves when told to. */
const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

const tezos = Mutes.key.thread({ machine: "Rosie", id: "t-tezos" })
const mina = Mutes.key.thread({ machine: "rig", id: "t-mina" })
const terminal = Mutes.key.session("Rosie", "claude:s-terminal")

/** An update from the hook of `session`, here unless it came from `host`, tied to `about` or known to be `owner`'s. */
const update = (session: string, extra: Partial<Pick<Conversation.Update, "about" | "owner">> = {}, host?: string): Conversation.Update => ({
  session,
  project: "yapd",
  turn: { prompt: Option.none(), message: "Done." },
  needsYou: false,
  spoken: "yapd. Done.",
  audio: "/tmp/a.wav",
  thread: { agent: "claude", session: session.replace(/^claude:/, ""), cwd: "/code/yapd", message: "Done.", origin: host === undefined ? {} : { host } },
  at: 0,
  ...extra,
})

describe("Mutes", () => {
  test("keys name the thread or the session, and come back the same through a URL", () => {
    expect(tezos).toBe("t3:Rosie:t-tezos")
    expect(terminal).toBe("session:Rosie:claude:s-terminal")
    for (const key of [tezos, mina, terminal, Mutes.key.session("rig", "codex:019a-77")]) {
      expect(Option.isSome(Mutes.parse(decodeURIComponent(encodeURIComponent(key))))).toBe(true)
    }
    expect(Mutes.parse(tezos)).toEqual(Option.some({ _tag: "Thread", ref: { machine: "Rosie", id: "t-tezos" } }))
    expect(Mutes.parse(terminal)).toEqual(Option.some({ _tag: "Session", machine: "Rosie", agent: "claude", session: "s-terminal" }))
    // Nothing yapd made: a mangled key, another agent, or none at all.
    for (const key of ["", "t3:Rosie", "t3::x", "session:Rosie:cursor:s", "thread:Rosie:t-tezos", "t3:Ro sie:x"]) expect(Mutes.parse(key)).toEqual(Option.none())
  })

  test("an update is muted by its thread, here or on another machine, and by its session unless T3 Code told of it", () => {
    const named = (host: string) => (host.toLowerCase() === hostname().toLowerCase() ? "Rosie" : host.split(".")[0]!)
    // Tied to its thread here.
    expect(Mutes.keysOf(update("claude:s-tezos", { about: { machine: "Rosie", id: "t-tezos" } }), named)).toEqual([tezos, "session:Rosie:claude:s-tezos"])
    // From rig, known to be its thread there.
    expect(Mutes.keysOf(update("claude:s-mina", { owner: { machine: "rig", id: "t-mina" } }, "rig.local"), named)).toEqual([mina, "session:rig:claude:s-mina"])
    // Tied to nothing, like a terminal session, from a hook older than origins.
    expect(Mutes.keysOf(update("claude:s-terminal"), named)).toEqual([terminal])
    // Told of by T3 Code, it has no session of its own.
    expect(Mutes.keysOf(update("finished:Rosie:t-tezos", { about: { machine: "Rosie", id: "t-tezos" } }), named)).toEqual([tezos])
  })

  test("mutes, unmutes and clears, matching any of an update's keys, and a mute for an hour ends on its own", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* Mutes.make(yield* Store.make(":memory:"))
        let changes = 0
        yield* Effect.forkScoped(Stream.runForEach(mutes.changes, () => Effect.sync(() => void changes++)))
        yield* flush
        const first = yield* mutes.mute({ key: tezos, called: "the Tezos migration", project: "integration" })
        const again = yield* mutes.mute({ key: tezos })
        const hour = yield* mutes.mute({ key: mina, ends: 60 * 60_000 })
        const either = yield* mutes.muted(["session:Rosie:claude:s-tezos", tezos])
        const neither = yield* mutes.muted([terminal])
        yield* TestClock.adjust("59 minutes")
        const before = (yield* mutes.list).map(({ key }) => key)
        yield* TestClock.adjust("1 minute")
        const after = (yield* mutes.list).map(({ key }) => key)
        const unmuted = yield* mutes.unmute(tezos)
        const unmutedAgain = yield* mutes.unmute(tezos)
        yield* mutes.mute({ key: tezos })
        yield* mutes.mute({ key: terminal })
        const cleared = (yield* mutes.clear).map(({ key }) => key)
        yield* flush
        return { first, again, hour, either, neither, before, after, unmuted, unmutedAgain, cleared, left: yield* mutes.list, changes }
      }),
    )
    expect(result.first).toBe(true)
    // Muted as it was already, nothing changes.
    expect(result.again).toBe(false)
    expect(result.hour).toBe(true)
    expect(result.either).toEqual(Option.some({ key: tezos, called: "the Tezos migration", project: "integration", at: 0 }))
    expect(result.neither).toEqual(Option.none())
    expect(result.before).toEqual([tezos, mina])
    expect(result.after).toEqual([tezos])
    expect(Option.map(result.unmuted, ({ key }) => key)).toEqual(Option.some(tezos))
    expect(result.unmutedAgain).toEqual(Option.none())
    expect(result.cleared).toEqual([tezos, terminal])
    expect(result.left).toEqual([])
    // Each change, the mute that ended on its own among them, and none for what changed nothing.
    expect(result.changes).toBe(7)
  })

  test("what's muted outlives a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "yapd-mutes-"))
    try {
      const path = join(root, "yapd.sqlite")
      await run(
        Effect.gen(function* () {
          const mutes = yield* Mutes.make(yield* Store.make(path))
          yield* mutes.mute({ key: tezos, called: "the Tezos migration", project: "integration" })
          yield* mutes.mute({ key: terminal, ends: 5_000 })
        }),
      )
      const kept = await run(Effect.flatMap(Effect.flatMap(Store.make(path), Mutes.make), (mutes) => mutes.list))
      expect(kept).toEqual([
        { key: terminal, at: 0, ends: 5_000 },
        { key: tezos, called: "the Tezos migration", project: "integration", at: 0 },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a session's mute moves to its thread at once, and a mute the thread has already is kept", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        const mutes = yield* Mutes.make(store)
        yield* mutes.mute({ key: terminal, called: "the Claude session in yapd" })
        yield* mutes.rekey(terminal, tezos)
        const moved = yield* mutes.list
        // The thread was muted for an hour already: that's kept, and the session's goes.
        yield* mutes.mute({ key: "session:Rosie:claude:s-other" })
        yield* mutes.mute({ key: mina, ends: 60 * 60_000 })
        yield* mutes.rekey("session:Rosie:claude:s-other", mina)
        // Nothing to move.
        yield* mutes.rekey("session:Rosie:claude:s-gone", tezos)
        const rows = yield* store.transaction((database) => database.query<{ key: string; ends_at: number | null }, []>("select key, ends_at from mutes order by key").all())
        return { moved, rows }
      }),
    )
    expect(result.moved).toEqual([{ key: tezos, called: "the Claude session in yapd", at: 0 }])
    expect(result.rows).toEqual([
      { key: tezos, ends_at: null },
      { key: mina, ends_at: 60 * 60_000 },
    ])
  })

  test("muting drops what of the thread waits to be said and notes it; taking it back undoes a mute, an unmute and a clear, never sending a thread anything", async () => {
    const result = await run(
      Effect.gen(function* () {
        const journal = Journal.fromStore(yield* Store.make(":memory:"))
        const mutes = yield* Mutes.make(yield* Store.make(":memory:"))
        const silenced: Array<ReadonlyArray<string>> = []
        // All a control has to go by: nothing to send a thread with.
        const controls = Mutes.controls({ mutes, journal, silence: (keys) => Effect.sync(() => void silenced.push(keys)) })
        const keys = Effect.map(mutes.list, (all) => all.map(({ key }) => key))
        const steps: Array<ReadonlyArray<string>> = []
        yield* controls.mute({ key: tezos, called: "the Tezos migration" }, 60 * 60_000)
        const already = yield* controls.mute({ key: tezos, called: "the Tezos migration" }, 60 * 60_000)
        steps.push(yield* keys)
        yield* controls.undo
        steps.push(yield* keys)
        yield* controls.undo
        steps.push(yield* keys)
        yield* controls.unmute(tezos)
        steps.push(yield* keys)
        yield* controls.undo
        steps.push(yield* keys)
        yield* controls.mute({ key: terminal })
        yield* controls.clear
        steps.push(yield* keys)
        yield* controls.undo
        steps.push(yield* keys)
        // Over two minutes on, it's no longer what's taken back.
        yield* TestClock.adjust("3 minutes")
        const late = yield* controls.undo
        const noted = (yield* journal.since(0, { kinds: ["action"] })).map(({ machine, thread, detail }) => ({ machine, thread, detail }))
        return { already, steps, late, silenced, noted, until: (yield* mutes.list).map(({ ends }) => ends) }
      }),
    )
    expect(result.already).toBe(false)
    expect(result.steps).toEqual([[tezos], [], [tezos], [], [tezos], [], [terminal, tezos]])
    // Put back, it's as it was, for an hour.
    expect(result.until).toEqual([undefined, 60 * 60_000])
    expect(result.late).toEqual(Option.none())
    // Each mute, as made or put back, drops what of it waits to be said.
    expect(result.silenced).toEqual([[tezos], [tezos], [tezos], [terminal], [tezos, terminal]])
    expect(result.noted[0]).toEqual({ machine: "Rosie", thread: "t-tezos", detail: { mute: tezos, until: "1970-01-01T01:00:00.000Z" } })
    expect(result.noted.map(({ detail }) => Object.keys(detail as object)[0])).toEqual(["mute", "undo", "undo", "unmute", "undo", "mute", "unmute", "undo"])
  })

  test("muting what he's on about is understood in so many words, with how long, and anything more is left to the model", () => {
    const heard = (said: string) => Option.getOrUndefined(Mutes.command(said))
    expect(heard("Mute it.")).toEqual({ how: "mute" })
    expect(heard("Jarvis, mute this one, please.")).toEqual({ how: "mute" })
    expect(heard("Silence that thread.")).toEqual({ how: "mute" })
    expect(heard("Mute it for an hour.")).toEqual({ how: "mute", minutes: 60 })
    expect(heard("Mute that for half an hour.")).toEqual({ how: "mute", minutes: 30 })
    expect(heard("Mute this for 20 minutes.")).toEqual({ how: "mute", minutes: 20 })
    expect(heard("Mute it for two hours.")).toEqual({ how: "mute", minutes: 120 })
    expect(heard("Mute it for forty-five minutes.")).toEqual({ how: "mute", minutes: 45 })
    expect(heard("Unmute it.")).toEqual({ how: "unmute" })
    expect(heard("Unmute everything.")).toEqual({ how: "clear" })
    expect(heard("Unmute them all.")).toEqual({ how: "clear" })
    for (const said of ["Mute.", "Mute the Tezos one.", "Mute it until tomorrow.", "Mute it for a while.", "Mute it for 0 minutes.", "Unmute it for an hour.", "Mute it and tell it to stop.", "Can you mute it?", "Quiet it."]) {
      expect(heard(said)).toBeUndefined()
    }
  })
})
