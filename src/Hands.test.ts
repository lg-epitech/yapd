import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema, type Scope, TestClock, TestContext } from "effect"
import * as Hands from "./Hands.ts"
import * as Ledger from "./Ledger.ts"
import * as Persona from "./Persona.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as Server from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import type * as Threads from "./Threads.ts"

const now = Date.parse("2026-10-08T22:00:00.000Z")

const thread = (id: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId: "p-integration",
    title: "Migrate Tezos Integration",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "completed",
    latestRunCompletedAt: "2026-10-08T21:30:00.000Z",
    pendingRuntimeRequest: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T21:30:00.000Z",
    ...overrides,
  })

const tezos: Threads.Ref = { machine: "Rosie", id: "t-tezos" }

const lines: Persona.Lines = { ...Persona.plain, onIt: "On it, sir.", queued: "I'll get to it once the current task is done, sir.", address: "sir" }

/** How T3 Code answers a command: what it does to the thread, and what it says back. */
type Answer = (payload: Record<string, unknown>, bounded: Bounded) => Effect.Effect<unknown, Server.Trouble | Server.Refusal>

interface Bounded {
  runs: Array<{ id: string; status: string; ordinal: number; userMessageId?: string }>
  messages: Array<{ id: string; role: string; text: string; createdAt: string }>
  turnItems: Array<Record<string, unknown>>
}

/** Takes a message in as T3 Code does: a turn of its own on an idle thread, into the turn under way or behind it on a busy one. */
const takes =
  (intent: "steer" | "queued_turn" = "steer"): Answer =>
  (payload, bounded) =>
    Effect.sync(() => {
      if (payload.type === "message.dispatch") {
        const messageId = String(payload.messageId)
        const going = bounded.runs.some(({ status }) => status === "running")
        const queued = (payload.dispatchMode as { type: string }).type === "queue_after_active" || intent === "queued_turn"
        bounded.messages.push({ id: messageId, role: "user", text: String(payload.text), createdAt: "now" })
        if (!going || queued) {
          bounded.runs.push({ id: `run-${bounded.runs.length + 1}`, status: going ? "queued" : "running", ordinal: bounded.runs.length + 1, userMessageId: messageId })
        }
        if (!going || !queued) bounded.turnItems.push({ type: "user_message", messageId, inputIntent: going ? "steer" : "turn_start" })
      }
      if (payload.type === "queued-run.cancel") {
        const run = bounded.runs.find(({ id }) => id === payload.runId)
        if (run !== undefined) run.status = "cancelled"
      }
      return { sequence: 7 }
    })

/** Hands over a ledger of its own and a T3 Code that answers as the test says, keeping what it was sent. */
const hands = (given: { readonly thread?: T3Live.Thread; readonly runs?: Bounded["runs"]; readonly started?: number } = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const ledger = Ledger.fromStore(yield* Store.make(":memory:"))
    const bounded: Bounded = { runs: [...(given.runs ?? [])], messages: [], turnItems: [] }
    const dispatched: Array<Record<string, unknown>> = []
    let answer: Answer = takes()
    let current = given.thread ?? thread(tezos.id)
    let readable = true
    const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
      api: (<A, I>(_: string, schema: Schema.Schema<A, I>) =>
        readable
          ? Schema.decodeUnknown(schema)({ projection: bounded }).pipe(Effect.orDie)
          : Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long." }))) as Server.Transport["api"],
      call: (<A, I>(method: string, payload: Record<string, unknown>, schema: Schema.Schema<A, I>) =>
        method === "orchestration.dispatchCommand"
          ? Effect.suspend(() => {
              dispatched.push(payload)
              return answer(payload, bounded)
            }).pipe(Effect.flatMap((value) => Schema.decodeUnknown(schema)(value).pipe(Effect.orDie)))
          : Effect.die(`not expected: ${method}`)) as Server.Transport["call"],
    })
    const actions = T3Actions.make(reach)
    const made = Hands.make({
      threads: {
        find: (ref) => Effect.sync(() => (ref.id === current.id ? Option.some(current) : Option.none())),
        actions: (machine) => (machine === "Rosie" ? Option.some(actions) : Option.none()),
      },
      ledger,
      ...(given.started === undefined ? {} : { started: given.started }),
    })
    const send = (utterance: string, text: string, how: T3Actions.When = "now", twice = false) =>
      made.run({ utterance, step: 0 }, { _tag: "Message", to: tezos, text, how }, { twice })
    return {
      ...made,
      ledger,
      bounded,
      dispatched,
      send,
      answering: (next: Answer) => {
        answer = next
      },
      becomes: (next: T3Live.Thread) => {
        current = next
      },
      /** Whether T3 Code answers reads of the thread, or times out. */
      reads: (ok: boolean) => {
        readable = ok
      },
      /** The ids each dispatch went under. */
      ids: () => dispatched.map(({ commandId, messageId }) => [commandId, messageId]),
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

const refusal = new Server.Refusal({ tag: "OrchestrationV2DispatchCommandError", message: "Thread t-tezos can't take messages while its provider is offline." })

describe("Hands", () => {
  test("a step settled three times by settle is dispatched once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, dispatched } = yield* hands()
        // Worked out three times as he carried on talking, each time acted on.
        const outcomes = [yield* send("u1", "Use the fee table from the Mina work."), yield* send("u1", "Use the Mina fee table."), yield* send("u1", "Use the fee table.")]
        return { outcomes: outcomes.map(({ _tag }) => _tag), dispatched: dispatched.length }
      }),
    )
    expect(result).toEqual({ outcomes: ["Done", "Done", "Done"], dispatched: 1 })
  })

  test("a refused command is said with T3 Code's reason and never sent again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, dispatched } = yield* hands()
        answering(() => Effect.fail(refusal))
        const outcome = yield* send("u1", "Use the fee table.")
        const told = outcome._tag === "Refused" ? Hands.failed({ _tag: "Message", to: tezos, text: "", how: "now" }, outcome, lines, Option.none()) : outcome._tag
        answering(takes())
        // Neither worked out again, nor on a yes to sending it again.
        yield* send("u1", "Use the fee table.")
        const resent = yield* again("yapd:u1:0")
        return { told, resent: resent._tag, dispatched: dispatched.length }
      }),
    )
    expect(result.told).toBe("That didn't go through, sir: that thread can't take messages while its provider is offline.")
    expect(result.resent).toBe("Refused")
    expect(result.dispatched).toBe(1)
  })

  test("T3 Code's reasons are said without its ids, quoted or not, and about the work, never a session", () => {
    expect(
      [
        "Command yapd:u1:0 was previously rejected: Thread 'thr_01J9ABC' is archived.",
        "No active provider session for thread abc123.",
        "The agent session has ended.",
        "Thread not found: 850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
        "Run run_7f3a9c2b is not interruptible.",
      ].map(Hands.plainly),
    ).toEqual([
      "That command was previously rejected: that thread is archived.",
      "Nothing running for that thread.",
      "The work has ended.",
      "Thread not found.",
      "That run is not interruptible.",
    ])
    // Names of things, like a model, are said as they are.
    expect(Hands.plainly("Model gpt-6-sol isn't available.")).toBe("Model gpt-6-sol isn't available.")
  })

  test("a request that never left is said as not sent, and yes sends it again under the same ids", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, ids } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code isn't answering." })))
        const outcome = yield* send("u1", "Use the fee table.")
        const told = outcome._tag === "NotSent" ? Hands.failed({ _tag: "Message", to: tezos, text: "", how: "now" }, outcome, lines, Option.none()) : outcome._tag
        answering(takes())
        const resent = yield* again("yapd:u1:0")
        // Once more is all: a second yes sends nothing.
        const third = yield* again("yapd:u1:0")
        return { told, resent: resent._tag, third: third._tag, ids: ids() }
      }),
    )
    expect(result.told).toBe("That didn't get there, sir: T3 Code isn't answering. Send it again?")
    expect(result.resent).toBe("Done")
    expect(result.third).toBe("Done")
    expect(result.ids).toEqual([
      ["yapd:u1:0", "yapd:u1:0:m"],
      ["yapd:u1:0", "yapd:u1:0:m"],
    ])
  })

  test("an unknown outcome found in the thread is said once as done", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, answering, dispatched, ledger } = yield* hands()
        // T3 Code took it, and the answer was lost on the way back.
        answering((payload, bounded) => Effect.zipRight(takes()(payload, bounded), Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true }))))
        const outcome = yield* send("u1", "Use the fee table.")
        const row = yield* ledger.get("yapd:u1:0")
        return { outcome, dispatched: dispatched.length, state: Option.map(row, ({ state }) => state) }
      }),
    )
    expect(result.outcome).toEqual({ _tag: "Done", how: "now", to: tezos })
    expect(Hands.done({ _tag: "Message", to: tezos, text: "", how: "now" }, "now", lines, Option.none())).toBe("On it, sir.")
    expect(result.dispatched).toBe(1)
    expect(result.state).toEqual(Option.some("sent"))
  })

  test("an unknown outcome not found is offered again, and yes uses the same ids, never new ones", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, ids } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        const outcome = yield* send("u1", "Use the fee table.")
        const told = outcome._tag === "Unknown" ? Hands.failed({ _tag: "Message", to: tezos, text: "", how: "now" }, outcome, lines, Option.none()) : outcome._tag
        answering(takes())
        const resent = yield* again("yapd:u1:0")
        // Worked out again, or a second yes: nothing more goes.
        yield* send("u1", "Use the fee table.")
        yield* again("yapd:u1:0")
        return { told, resent: resent._tag, ids: ids() }
      }),
    )
    expect(result.told).toBe("I couldn't confirm it got there, sir. Send it again?")
    expect(result.resent).toBe("Done")
    expect(result.ids).toEqual([
      ["yapd:u1:0", "yapd:u1:0:m"],
      ["yapd:u1:0", "yapd:u1:0:m"],
    ])
  })

  test("an unknown outcome whose offer wasn't taken up is asked about again, under its own ids, when the same words are said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, leave, answering, becomes, ids, ledger } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        yield* send("u1", "Use the fee table.")
        // He said no to sending it again.
        yield* leave("yapd:u1:0", "He said no.")
        const restart = yield* ledger.open(0)
        yield* TestClock.adjust("3 minutes")
        // The thread has finished a turn since, which would let a message that went go again.
        becomes(thread(tezos.id, { latestRunCompletedAt: new Date(now + 60_000).toISOString() }))
        answering(takes())
        const twin = yield* send("u2", "Use the fee table.")
        const resent = twin._tag === "Twin" ? yield* again(twin.row.commandId) : twin
        return { restart, twin: twin._tag === "Twin" ? [twin.row.commandId, twin.row.state] : twin._tag, resent: resent._tag, ids: ids() }
      }),
    )
    // Never offered again on its own, after a restart either.
    expect(result.restart).toEqual([])
    expect(result.twin).toEqual(["yapd:u1:0", "unknown"])
    expect(result.resent).toBe("Done")
    expect(result.ids).toEqual([
      ["yapd:u1:0", "yapd:u1:0:m"],
      ["yapd:u1:0", "yapd:u1:0:m"],
    ])
  })

  test("a message that may not have got there, found there when the same words are said, is one that went", async () => {
    const twice = (answeredSince: boolean) =>
      run(
        Effect.gen(function* () {
          const { send, answering, becomes, bounded, ledger, dispatched } = yield* hands()
          answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
          yield* send("u1", "Use the fee table.")
          // It got there late.
          bounded.messages.push({ id: "yapd:u1:0:m", role: "user", text: "Use the fee table.", createdAt: "now" })
          yield* TestClock.adjust("1 minute")
          if (answeredSince) becomes(thread(tezos.id, { latestRunCompletedAt: new Date(now + 30_000).toISOString() }))
          answering(takes())
          const second = yield* send("u2", "Use the fee table.")
          const first = yield* ledger.get("yapd:u1:0")
          return { second: second._tag === "Twin" ? [second._tag, second.row.state] : [second._tag], first: Option.map(first, ({ state }) => state), dispatched: dispatched.length }
        }),
      )
    expect(await twice(false)).toEqual({ second: ["Twin", "sent"], first: Option.some("sent"), dispatched: 1 })
    // A thread that's said something since takes it again.
    expect(await twice(true)).toEqual({ second: ["Done"], first: Option.some("sent"), dispatched: 2 })
  })

  test("a message sent once more that still can't be confirmed is never sent a third time", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, dispatched, ledger } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        yield* send("u1", "Use the fee table.")
        const resent = yield* again("yapd:u1:0")
        answering(takes())
        const third = yield* again("yapd:u1:0")
        const restart = yield* ledger.open(0)
        yield* TestClock.adjust("2 minutes")
        // Said again in the same words, it isn't risked either.
        const said = yield* send("u2", "Use the fee table.")
        return {
          resent: resent._tag === "Unknown" ? Option.isSome(resent.again) : resent._tag,
          third: third._tag,
          restart,
          said: said._tag === "Refused" ? said.reason : said._tag,
          dispatched: dispatched.length,
        }
      }),
    )
    // The one more time it may go, which offers nothing more.
    expect(result.resent).toBe(false)
    expect(result.third).toBe("NotSent")
    expect(result.restart).toEqual([])
    expect(result.said).toBe("I couldn't confirm either of the last two got there, so I won't risk sending it a third time.")
    expect(result.dispatched).toBe(2)
  })

  test("sending once more what never left, when that never leaves either, isn't sending it again: said again, it's offered under its own ids, and goes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, ids } = yield* hands()
        // T3 Code is restarting, the first time and when he says yes.
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code isn't answering." })))
        yield* send("u1", "Use the fee table.")
        const resent = yield* again("yapd:u1:0")
        // It's back a minute on, and he says it again.
        answering(takes())
        yield* TestClock.adjust("1 minute")
        const said = yield* send("u2", "Use the fee table.")
        const yes = said._tag === "Twin" ? yield* again(said.row.commandId) : said
        return { resent: resent._tag === "NotSent" ? [resent.reason, Option.isSome(resent.again)] : resent._tag, said: said._tag, yes: yes._tag, ids: ids() }
      }),
    )
    expect(result.resent).toEqual(["T3 Code isn't answering.", false])
    expect(result.said).toBe("Twin")
    expect(result.yes).toBe("Done")
    expect(new Set(result.ids.map((pair) => pair.join(" ")))).toEqual(new Set(["yapd:u1:0 yapd:u1:0:m"]))
  })

  test("a message taken back while it was still queued is new again when said again, whether or not T3 Code still shows it", async () => {
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    const withdrawn = (forgotten: boolean) =>
      run(
        Effect.gen(function* () {
          const { send, run: act, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
          yield* send("u1", "When it's done, open a PR.", "after")
          yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
          if (forgotten) {
            bounded.runs.splice(1)
            bounded.messages.splice(0)
          }
          yield* TestClock.adjust("1 minute")
          const again = yield* send("u3", "When it's done, open a PR.", "after")
          return { again: again._tag, dispatched: dispatched.map(({ type }) => type) }
        }),
      )
    for (const forgotten of [false, true]) {
      expect(await withdrawn(forgotten)).toEqual({ again: "Done", dispatched: ["message.dispatch", "queued-run.cancel", "message.dispatch"] })
    }
  })

  test("asking to send again says sir once, however the line to ask it was written", () => {
    const unknown: Hands.Outcome = { _tag: "Unknown", reason: "T3 Code is taking too long.", again: Option.some("yapd:u1:0") }
    for (const again of ["Shall I send it again, sir?", "Sir, shall I send it again?"]) {
      const styled = { ...lines, again }
      expect(Hands.failed({ _tag: "Message", to: tezos, text: "", how: "now" }, unknown, styled, Option.none())).toBe("I couldn't confirm it got there, sir. Shall I send it again?")
      expect(Hands.lost(styled, Option.none())).toBe("Before I restarted, I couldn't confirm your message got there, sir. Shall I send it again?")
    }
  })

  test("a restart checks open rows and never dispatches", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { reconcile, ledger, bounded, dispatched } = yield* hands({ runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        const prepare = (utterance: string, kind: Ledger.Kind) =>
          ledger.prepare({
            utterance,
            step: 0,
            kind,
            machine: "Rosie",
            thread: tezos.id,
            body: ({ messageId }) => (kind === "message" ? { _tag: "Send", text: "Use the fee table.", messageId, how: "now" } : { _tag: "Stop" }),
            message: kind === "message",
          })
        // Long gone by the time yapd came back.
        yield* prepare("u0", "message")
        yield* TestClock.adjust("20 minutes")
        // One that got there before yapd stopped, one that didn't, and a stop it can't vouch for.
        yield* prepare("u1", "message")
        bounded.messages.push({ id: "yapd:u1:0:m", role: "user", text: "Use the fee table.", createdAt: "now" })
        yield* prepare("u2", "message")
        yield* prepare("u3", "stop")
        const { undelivered, unconfirmed } = yield* reconcile
        const states = yield* Effect.forEach(["u0", "u1", "u2", "u3"], (utterance) => Effect.map(ledger.get(`yapd:${utterance}:0`), Option.map(({ state }) => state)))
        return {
          undelivered: undelivered.map(({ commandId }) => commandId),
          unconfirmed: unconfirmed.map((row) => [row.commandId, Hands.unsure(row, lines, Option.some("Migrate Tezos Integration"))]),
          states: states.map(Option.getOrNull),
          dispatched: dispatched.length,
        }
      }),
    )
    expect(result.dispatched).toBe(0)
    expect(result.undelivered).toEqual(["yapd:u2:0"])
    // The stop that can't be confirmed is said so, never done again.
    expect(result.unconfirmed).toEqual([["yapd:u3:0", "Before I restarted, I couldn't confirm Migrate Tezos Integration stopped, sir."]])
    expect(result.states).toEqual(["abandoned", "sent", "unknown", "abandoned"])
  })

  test("a different message to the same thread goes straight through", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, dispatched } = yield* hands()
        const first = yield* send("u1", "Use the fee table from the Mina work.")
        yield* TestClock.adjust("30 seconds")
        const second = yield* send("u2", "Also add a test for the rounding.")
        return { outcomes: [first._tag, second._tag], dispatched: dispatched.length }
      }),
    )
    expect(result).toEqual({ outcomes: ["Done", "Done"], dispatched: 2 })
  })

  test("the same message to a thread that hasn't answered since is confirmed, not dropped", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, dispatched } = yield* hands()
        yield* send("u1", "Use the fee table from the Mina work.")
        yield* TestClock.adjust("54 seconds")
        const twin = yield* send("u2", "use the fee table from the Mina work")
        const asked = twin._tag === "Twin" ? Hands.twice(twin.row.at, now + 54_000, lines, Option.none()) : twin._tag
        const before = dispatched.length
        // He said yes: it goes, as a step of its own.
        const confirmed = yield* send("u3", "use the fee table from the Mina work", "now", true)
        return { asked, before, confirmed: confirmed._tag, ids: dispatched.map(({ commandId }) => commandId) }
      }),
    )
    expect(result.asked).toBe("I sent that a minute ago, sir. Again?")
    expect(result.before).toBe(1)
    expect(result.confirmed).toBe("Done")
    expect(result.ids).toEqual(["yapd:u1:0", "yapd:u3:0"])
  })

  test("a second yes after the thread asked something new goes straight through", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, becomes, dispatched } = yield* hands()
        yield* send("u1", "Yes.")
        yield* TestClock.adjust("40 seconds")
        // It finished that turn and asked something new.
        becomes(
          thread(tezos.id, {
            latestRunCompletedAt: new Date(now + 30_000).toISOString(),
            pendingRuntimeRequest: { id: "r2", kind: "user_input", createdAt: new Date(now + 31_000).toISOString() },
          }),
        )
        const second = yield* send("u2", "Yes.")
        return { second: second._tag, dispatched: dispatched.length }
      }),
    )
    expect(result).toEqual({ second: "Done", dispatched: 2 })
  })

  test("the same words are asked about while the run they started, or wait in, hasn't answered, whatever other runs do, and go once it has", async () => {
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    const ended = (at: number, overrides: Record<string, unknown> = {}) => thread(tezos.id, { latestRunCompletedAt: new Date(at).toISOString(), ...overrides })
    const queued = await run(
      Effect.gen(function* () {
        const { send, becomes, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        // The turn it waited behind ended a minute on, and its own run started.
        yield* TestClock.adjust("90 seconds")
        bounded.runs[0]!.status = "completed"
        bounded.runs[1]!.status = "running"
        becomes(ended(now + 60_000, { activeRunId: "run-2", activityRunStatus: "running", status: "running" }))
        const waiting = yield* send("u2", "When it's done, open a PR.", "after")
        // Its own run has answered since.
        yield* TestClock.adjust("2 minutes")
        bounded.runs[1]!.status = "completed"
        becomes(ended(now + 200_000))
        const answered = yield* send("u3", "When it's done, open a PR.", "after")
        return { waiting: waiting._tag, answered: answered._tag, dispatched: dispatched.map(({ commandId }) => commandId) }
      }),
    )
    expect(queued).toEqual({ waiting: "Twin", answered: "Done", dispatched: ["yapd:u1:0", "yapd:u3:0"] })
    const restarted = await run(
      Effect.gen(function* () {
        const { send, answering, becomes, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        // T3 Code stops the turn under way, which ends it, and starts one of its own.
        answering((payload, bounded) =>
          Effect.sync(() => {
            bounded.runs[0]!.status = "interrupted"
            bounded.runs.push({ id: "run-2", status: "running", ordinal: 2, userMessageId: String(payload.messageId) })
            return { sequence: 7 }
          }),
        )
        yield* send("u1", "Drop that and use the fee table.", "restart")
        yield* TestClock.adjust("5 seconds")
        becomes(ended(now + 1000, { activeRunId: "run-2", activityRunStatus: "running", status: "running" }))
        const again = yield* send("u2", "Drop that and use the fee table.", "restart")
        return { again: again._tag, dispatched: dispatched.length }
      }),
    )
    expect(restarted).toEqual({ again: "Twin", dispatched: 1 })
  })

  test("the same words are asked about while they still wait in the queue, once the turn ahead asks something, or when the thread can't be read", async () => {
    const busy = (overrides: Record<string, unknown> = {}) => thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running", ...overrides })
    const twice = (meanwhile: (helpers: Effect.Effect.Success<ReturnType<typeof hands>>) => void) =>
      run(
        Effect.gen(function* () {
          const helpers = yield* hands({ thread: busy(), runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
          yield* helpers.send("u1", "When it's done, open a PR.", "after")
          yield* TestClock.adjust("1 minute")
          meanwhile(helpers)
          const again = yield* helpers.send("u2", "When it's done, open a PR.", "after")
          return { again: again._tag, dispatched: helpers.dispatched.length }
        }),
      )
    // Still waiting behind the turn under way.
    expect(await twice(() => {})).toEqual({ again: "Twin", dispatched: 1 })
    // The turn ahead of it asks something, which isn't its answer.
    expect(await twice(({ becomes }) => becomes(busy({ pendingRuntimeRequest: { id: "r2", kind: "approval", createdAt: new Date(now + 30_000).toISOString() } })))).toEqual({
      again: "Twin",
      dispatched: 1,
    })
    // A turn ended since, but the thread can't be read to tell whether it was its own.
    expect(
      await twice(({ becomes, reads }) => {
        reads(false)
        becomes(busy({ latestRunCompletedAt: new Date(now + 30_000).toISOString() }))
      }),
    ).toEqual({ again: "Twin", dispatched: 1 })
  })

  test("a message to a busy thread says whether it was steered or queued, as T3 Code did", async () => {
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    const sent = (intent: "steer" | "queued_turn") =>
      run(
        Effect.gen(function* () {
          const { send, answering, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
          answering(takes(intent))
          const outcome = yield* send("u1", "Also make sure it doesn't touch the Swift helper.")
          const how = outcome._tag === "Done" ? outcome.how : "now"
          return { how, said: Hands.done({ _tag: "Message", to: tezos, text: "", how: "now" }, how, lines, Option.none()), dispatched }
        }),
      )
    const steered = await sent("steer")
    expect(steered.how).toBe("steered")
    expect(steered.said).toBe("On it, sir.")
    // As the app sends it: into the turn under way when the provider can take it.
    expect(steered.dispatched[0]).toMatchObject({ dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" })
    const queued = await sent("queued_turn")
    expect(queued.how).toBe("queued")
    expect(queued.said).toBe("I'll get to it once the current task is done, sir.")
  })

  test("after-it's-done messages are queued in T3 Code, never held by yapd", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { send, dispatched, ledger } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        const outcome = yield* send("u1", "When it's done, open a PR.", "after")
        return { outcome, dispatched, held: yield* ledger.open(0) }
      }),
    )
    // Sent at once, for T3 Code to hold: nothing waits in yapd.
    expect(result.dispatched).toHaveLength(1)
    expect(result.dispatched[0]).toMatchObject({ type: "message.dispatch", dispatchMode: { type: "queue_after_active" } })
    expect(result.dispatched[0]).not.toHaveProperty("deliveryIntent")
    expect(result.outcome).toEqual({ _tag: "Done", how: "queued", to: tezos })
    expect(result.held).toEqual([])
  })

  test("scratch that withdraws a message still in the queue, and only offers to have one already read ignored", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { send, run: act, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        const withdrawn = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        yield* send("u3", "Also make sure it doesn't touch the Swift helper.")
        const read = yield* act({ utterance: "u4", step: 0 }, { _tag: "Undo", to: Option.some(tezos), carry: false })
        return { withdrawn: withdrawn._tag, read: read._tag === "Read" ? read.row.commandId : read._tag, dispatched }
      }),
    )
    expect(result.withdrawn).toBe("Done")
    // The run the queued message waited in, and nothing for the one it had read.
    expect(result.dispatched.map(({ type, runId }) => [type, runId])).toEqual([
      ["message.dispatch", undefined],
      ["queued-run.cancel", "run-2"],
      ["message.dispatch", undefined],
    ])
    expect(result.read).toBe("yapd:u3:0")
  })

  test("scratch that is done only once T3 Code shows the run cancelled, and a message not there yet is said as maybe still coming", async () => {
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    // The turn under way ended as the cancel went out, so the queued message started instead, and the answer was lost.
    const started = await run(
      Effect.gen(function* () {
        const { send, run: act, answering, ledger, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        answering((payload, bounded) =>
          Effect.suspend(() => {
            bounded.runs[0]!.status = "completed"
            bounded.runs[1]!.status = "running"
            return Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true }))
          }),
        )
        const withdrawn = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        const message = yield* ledger.get("yapd:u1:0")
        answering(takes())
        const again = yield* send("u3", "When it's done, open a PR.", "after")
        return { withdrawn: withdrawn._tag, message: Option.map(message, ({ state }) => state), again: again._tag, dispatched: dispatched.length }
      }),
    )
    expect(started.withdrawn).toBe("Unknown")
    expect(Hands.failed({ _tag: "Undo", to: Option.none(), carry: false }, { _tag: "Unknown", reason: "", again: Option.none() }, lines, Option.none())).toBe(
      "I couldn't confirm it was withdrawn, sir.",
    )
    // It's being read, so it's still the message that went, which the same words are asked about.
    expect(started.message).toEqual(Option.some("sent"))
    expect(started.again).toBe("Twin")
    expect(started.dispatched).toBe(2)
    const unsure = await run(
      Effect.gen(function* () {
        const { send, run: act, answering, ledger, dispatched } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        yield* send("u1", "Use the fee table.")
        const withdrawn = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        const told = withdrawn._tag === "Refused" ? Hands.failed({ _tag: "Undo", to: Option.none(), carry: false }, withdrawn, lines, Option.none()) : withdrawn._tag
        const message = yield* ledger.get("yapd:u1:0")
        return { told, message: Option.map(message, ({ state }) => state), restart: yield* ledger.open(0), dispatched: dispatched.length }
      }),
    )
    expect(unsure.told).toBe("I couldn't take that back, sir: it wasn't in the thread yet when I looked, so it may still get there.")
    expect(unsure.message).toEqual(Option.some("unknown"))
    expect(unsure.restart).toEqual([])
    expect(unsure.dispatched).toBe(1)
  })

  test("scratch that is about the last thing done, never a message before it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { send, run: act, ledger, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        yield* TestClock.adjust("30 seconds")
        // New work started since, which is what he means.
        yield* ledger.prepare({ utterance: "u2", step: 0, kind: "start", machine: "Rosie", thread: "t-new", body: () => ({}), message: true })
        yield* ledger.settle("yapd:u2:0", "sent")
        const scratched = yield* act({ utterance: "u3", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        return { scratched: scratched._tag === "Refused" ? scratched.reason : scratched._tag, dispatched: dispatched.map(({ type }) => type) }
      }),
    )
    expect(result.scratched).toBe("Starting work can't be taken back yet.")
    expect(result.dispatched).toEqual(["message.dispatch"])
  })

  test("carry on lets go of the queue the stop held, then asks it to pick up where it left off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { run: act, becomes, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        const stopped = yield* act({ utterance: "u1", step: 0 }, { _tag: "Stop", to: tezos })
        bounded.runs[0]!.status = "interrupted"
        becomes(thread(tezos.id, { status: "interrupted" }))
        const carried = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true })
        // It worked and finished; "carry on" again, as he missed hearing it, is nothing to do.
        yield* TestClock.adjust("3 minutes")
        becomes(thread(tezos.id, { status: "completed" }))
        const twice = yield* act({ utterance: "u3", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true })
        const carry = { _tag: "Undo", to: Option.none(), carry: true } as const
        return {
          stopped: stopped._tag,
          carried: carried._tag,
          twice: twice._tag === "Refused" ? Hands.failed(carry, twice, lines, Option.none()) : twice._tag,
          dispatched: dispatched.map(({ type, commandId, holdQueue, text }) => [type, commandId, holdQueue ?? text]),
        }
      }),
    )
    expect(result.stopped).toBe("Done")
    expect(result.carried).toBe("Done")
    // Said as what it is, never as something that went wrong.
    expect(result.twice).toBe("I've already let it carry on, sir.")
    expect(result.dispatched).toEqual([
      ["run.interrupt", "yapd:u1:0", true],
      ["queue.resume", "yapd:u2:0", undefined],
      ["message.dispatch", "yapd:u2:1", Hands.carryOn],
    ])
  })

  test("guards: a restart leaves what this run did alone, an archived thread is sent nothing, a busy one isn't told to carry on, and a read message isn't cancelled", async () => {
    const restarted = await run(
      Effect.gen(function* () {
        // yapd started between the two.
        const { reconcile, ledger, dispatched } = yield* hands({ started: now + 30_000 })
        const prepare = (utterance: string) =>
          ledger.prepare({
            utterance,
            step: 0,
            kind: "message",
            machine: "Rosie",
            thread: tezos.id,
            body: ({ messageId }) => ({ _tag: "Send", text: "Use the fee table.", messageId, how: "now" }),
            message: true,
          })
        yield* prepare("u-before")
        yield* TestClock.adjust("1 minute")
        yield* prepare("u-since")
        const { undelivered } = yield* reconcile
        const since = yield* ledger.get("yapd:u-since:0")
        return { undelivered: undelivered.map(({ commandId }) => commandId), since: Option.map(since, ({ state }) => state), dispatched: dispatched.length }
      }),
    )
    expect(restarted).toEqual({ undelivered: ["yapd:u-before:0"], since: Option.some("prepared"), dispatched: 0 })
    const archived = await run(
      Effect.gen(function* () {
        const { send, dispatched } = yield* hands({ thread: thread(tezos.id, { archivedAt: "2026-10-08T21:45:00.000Z" }) })
        const outcome = yield* send("u1", "Use the fee table.")
        return { outcome: outcome._tag === "Refused" ? outcome.reason : outcome._tag, dispatched: dispatched.length }
      }),
    )
    expect(archived).toEqual({ outcome: "It's been archived.", dispatched: 0 })
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    const working = await run(
      Effect.gen(function* () {
        const { run: act, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* act({ utterance: "u1", step: 0 }, { _tag: "Stop", to: tezos })
        // He set it going again himself before saying carry on.
        const carry = { _tag: "Undo", to: Option.none(), carry: true } as const
        const carried = yield* act({ utterance: "u2", step: 0 }, carry)
        return {
          carried: carried._tag === "Refused" ? Hands.failed(carry, carried, lines, Option.some("Migrate Tezos Integration")) : carried._tag,
          dispatched: dispatched.map(({ type }) => type),
        }
      }),
    )
    expect(working).toEqual({ carried: "Migrate Tezos Integration is already back at work, sir.", dispatched: ["run.interrupt"] })
    const read = await run(
      Effect.gen(function* () {
        // Sent to an idle thread, it started a turn of its own at once.
        const { send, run: act, dispatched } = yield* hands()
        yield* send("u1", "Use the fee table.")
        const scratched = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        return { scratched: scratched._tag, dispatched: dispatched.map(({ type }) => type) }
      }),
    )
    expect(read).toEqual({ scratched: "Read", dispatched: ["message.dispatch"] })
    const subagent = await run(
      Effect.gen(function* () {
        const { send, dispatched } = yield* hands({ thread: thread(tezos.id, { lineage: { parentThreadId: "t-parent", relationshipToParent: "subagent" } }) })
        const outcome = yield* send("u1", "Use the fee table.")
        return { outcome: outcome._tag, dispatched: dispatched.length }
      }),
    )
    expect(subagent).toEqual({ outcome: "Refused", dispatched: 0 })
    const late = await run(
      Effect.gen(function* () {
        const { send, run: act, becomes, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        // A stop worked out again under the same step is the one stop.
        const stops = [yield* act({ utterance: "u1", step: 0 }, { _tag: "Stop", to: tezos }), yield* act({ utterance: "u1", step: 0 }, { _tag: "Stop", to: tezos })]
        bounded.runs[0]!.status = "interrupted"
        becomes(thread(tezos.id, { status: "interrupted" }))
        yield* TestClock.adjust("11 minutes")
        const carried = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true })
        becomes(busy)
        bounded.runs.push({ id: "run-2", status: "running", ordinal: 2 })
        yield* send("u3", "When it's done, open a PR.", "after")
        yield* TestClock.adjust("3 minutes")
        const scratched = yield* act({ utterance: "u4", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        return { stops: stops.map(({ _tag }) => _tag), carried: carried._tag, scratched: scratched._tag, dispatched: dispatched.map(({ type }) => type) }
      }),
    )
    // Carrying on and taking back are only for what was just done.
    expect(late).toEqual({ stops: ["Done", "Done"], carried: "Refused", scratched: "Refused", dispatched: ["run.interrupt", "message.dispatch"] })
  })

  test("the same words go straight through once the thread asked something new, after ten minutes, or after they were turned down", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, becomes, answering, dispatched } = yield* hands()
        yield* send("u1", "Yes.")
        // It asked something new in the turn the first started, which hasn't ended.
        yield* TestClock.adjust("40 seconds")
        becomes(thread(tezos.id, { pendingRuntimeRequest: { id: "r2", kind: "user_input", createdAt: new Date(now + 30_000).toISOString() } }))
        const asked = yield* send("u2", "Yes.")
        becomes(thread(tezos.id))
        yield* send("u3", "Use the fee table.")
        yield* TestClock.adjust("11 minutes")
        const later = yield* send("u4", "Use the fee table.")
        answering(() => Effect.fail(refusal))
        yield* send("u5", "Open a PR.")
        answering(takes())
        const refused = yield* send("u6", "Open a PR.")
        return { outcomes: [asked._tag, later._tag, refused._tag], dispatched: dispatched.map(({ commandId }) => commandId) }
      }),
    )
    expect(result.outcomes).toEqual(["Done", "Done", "Done"])
    expect(result.dispatched).toEqual(["yapd:u1:0", "yapd:u2:0", "yapd:u3:0", "yapd:u4:0", "yapd:u5:0", "yapd:u6:0"])
  })
})
