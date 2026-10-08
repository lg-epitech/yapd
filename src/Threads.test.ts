import { describe, expect, test } from "bun:test"
import { Clock, Effect, Option, Schema, Stream, TestClock, TestContext } from "effect"
import * as Brain from "./Brain.ts"
import * as Journal from "./Journal.ts"
import * as Persona from "./Persona.ts"
import * as Store from "./Store.ts"
import type * as T3Actions from "./T3Actions.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"

const now = Date.parse("2026-10-08T22:00:00.000Z")

const thread = (id: string, title: string, updatedAt: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId: "p",
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  })

const viewing = (...threads: ReadonlyArray<T3Live.Thread>): T3Live.View => ({
  projects: new Map([["p", { id: "p", title: "integration", workspaceRoot: "/code/integration" }]]),
  threads: new Map(threads.map((thread) => [thread.id, thread])),
  sequence: 1,
  synced: true,
})

describe("Threads", () => {
  test("puts threads whose titles have his words up front, however speech spelt them, and the rest of the month's by name", () => {
    const busy = Array.from({ length: 40 }, (_, index) =>
      thread(`busy-${index}`, `Busy work number ${index}`, `2026-10-08T${String(10 + (index % 10)).padStart(2, "0")}:00:00.000Z`),
    )
    const tickets = thread("tickets", "Open Mina SSV2 Bug Tickets", "2026-09-30T16:00:00.000Z")
    const wallet = thread("wallet", "Confirm Mina Wallet Migration", "2026-10-05T18:00:00.000Z")
    const old = thread("old", "Something from the summer", "2026-07-01T00:00:00.000Z")
    const view: T3Live.View = {
      projects: new Map([["p", { id: "p", title: "integration", workspaceRoot: "/code/integration" }]]),
      threads: new Map([...busy, tickets, wallet, old].map((thread) => [thread.id, thread])),
      sequence: 1,
      synced: true,
    }
    const listed = Threads.shortlist({
      machine: "Rosie",
      view,
      focus: Option.none(),
      pending: [],
      heard: "Can you please tell me what's the status on MiNAS SV2?",
      most: 30,
      more: 120,
      started: new Map(),
      said: new Map(),
      now,
    })
    // Its title has both his words, as Whisper spelt them, so it's among those seen in full.
    expect(listed.find(({ ref }) => ref.id === "tickets")).toMatchObject({ handle: "t1", brief: false })
    // One word in common isn't enough to move it up, but it's still there by name.
    expect(listed.find(({ ref }) => ref.id === "wallet")?.brief).toBe(true)
    // Older than a month, it's left out.
    expect(listed.some(({ ref }) => ref.id === "old")).toBe(false)
    expect(listed.filter(({ brief }) => !brief)).toHaveLength(30)
  })

  test("words too common to tell threads apart, like \"status\", \"still\" or \"need\", never count as a title's", () => {
    const running = thread("running", "Refactor auth middleware", "2026-10-08T20:00:00.000Z", { activeRunId: "run-1" })
    const first = (heard: string, title: string) => {
      const view = viewing(thread("titled", title, "2026-10-01T10:00:00.000Z"), running)
      const listed = Threads.shortlist({ machine: "Rosie", view, focus: Option.none(), pending: [], heard, most: 30, started: new Map(), said: new Map(), now })
      return { first: listed[0]?.ref.id, entitled: Threads.entitled(heard, view) }
    }
    // Only "billing" tells it apart, which isn't enough to put it ahead of what's running.
    expect(first("What's the status of the billing export?", "Status page for billing")).toEqual({ first: "running", entitled: [] })
    expect(first("I still need the billing done.", "Need billing export")).toEqual({ first: "running", entitled: [] })
    expect(first("Will it look at the billing?", "Look at billing, it will")).toEqual({ first: "running", entitled: [] })
    // Two words that do, and it is.
    expect(first("What's the status of the billing export?", "Need billing export")).toEqual({ first: "titled", entitled: ["titled"] })
  })

  test("usage read hours ago is read again before it's said, and said as of then without what has reset since when T3 Code can't answer", async () => {
    const nine = Date.parse("2026-10-08T09:00:00.000Z")
    const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    // Its five-hour window resets when it says, and its weekly one in three days.
    const reading = (session: number, resetsAt: string): T3Actions.Usage => [
      {
        provider: "Claude",
        windows: [
          { kind: "session", label: "Session", minutes: 300, usedPercent: session, resetsAt },
          { kind: "weekly", label: "Weekly", minutes: 10080, usedPercent: 40, resetsAt: "2026-10-11T09:00:00.000Z" },
        ],
      },
    ]
    const said = await Effect.gen(function* () {
      yield* TestClock.setTime(nine)
      const store = yield* Store.make(":memory:")
      let answer: Effect.Effect<T3Actions.Usage, Error> = Effect.succeed(reading(95, "2026-10-08T13:00:00.000Z"))
      const threads = yield* Threads.make({
        machine: "Rosie",
        live: { view: Effect.succeed(Option.none()), changes: Stream.never },
        actions: Option.some({ usage: Effect.suspend(() => answer) } as unknown as T3Actions.Actions),
        others: [],
        journal: Journal.fromStore(store),
        store,
      })
      const usage = Effect.flatMap(Effect.zip(threads.usage, Clock.currentTimeMillis), ([usage, now]) =>
        Effect.succeed(Brain.used(usage, "how's my usage", Persona.plain, now)),
      )
      const first = yield* usage
      // Its token expires, and six hours go by.
      answer = Effect.fail(new Error("token expired"))
      yield* TestClock.adjust("6 hours")
      const dated = yield* usage
      // It answers again, which is waited for rather than the morning's said.
      answer = Effect.succeed(reading(10, "2026-10-08T20:00:00.000Z"))
      yield* TestClock.adjust("6 minutes")
      return { first, dated, again: yield* usage }
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise)
    expect(said.first).toStartWith("Claude is at 95 percent of its five-hour window, resetting at ")
    expect(said.dated).toStartWith(`As of ${time(nine)}, Claude was at 40 percent of its weekly window, resetting `)
    // The five-hour window reset at one, two hours ago.
    expect(said.dated).not.toContain("95 percent")
    expect(said.again).toStartWith("Claude is at 10 percent of its five-hour window, resetting ")
  })

  test("calls a thread by its title when what yapd once noted about it is too long to say", () => {
    const at = Date.parse("2026-10-01T00:00:00.000Z")
    const long =
      "In integration, review the process used for the Mina migration and begin work on the Tezos migration in the main checkout."
    expect(Threads.called("Migrate Tezos Integration", long, "integration", at, now)).toBe("Migrate Tezos Integration")
    expect(Threads.called("Migrate Tezos Integration", "the Tezos migration", "integration", at, now)).toBe("the Tezos migration")
  })
})
