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
const hands = (given: { readonly thread?: T3Live.Thread; readonly runs?: Bounded["runs"] } = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const ledger = Ledger.fromStore(yield* Store.make(":memory:"))
    const bounded: Bounded = { runs: [...(given.runs ?? [])], messages: [], turnItems: [] }
    const dispatched: Array<Record<string, unknown>> = []
    let answer: Answer = takes()
    let current = given.thread ?? thread(tezos.id)
    const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
      api: (<A, I>(_: string, schema: Schema.Schema<A, I>) => Schema.decodeUnknown(schema)({ projection: bounded }).pipe(Effect.orDie)) as Server.Transport["api"],
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
        const undelivered = yield* reconcile
        const states = yield* Effect.forEach(["u0", "u1", "u2", "u3"], (utterance) => Effect.map(ledger.get(`yapd:${utterance}:0`), Option.map(({ state }) => state)))
        return { undelivered: undelivered.map(({ commandId }) => commandId), states: states.map(Option.getOrNull), dispatched: dispatched.length }
      }),
    )
    expect(result.dispatched).toBe(0)
    expect(result.undelivered).toEqual(["yapd:u2:0"])
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

  test("carry on lets go of the queue the stop held, then asks it to pick up where it left off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { run: act, becomes, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        const stopped = yield* act({ utterance: "u1", step: 0 }, { _tag: "Stop", to: tezos })
        bounded.runs[0]!.status = "interrupted"
        becomes(thread(tezos.id, { status: "interrupted" }))
        const carried = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true })
        return { stopped: stopped._tag, carried: carried._tag, dispatched: dispatched.map(({ type, commandId, holdQueue, text }) => [type, commandId, holdQueue ?? text]) }
      }),
    )
    expect(result.stopped).toBe("Done")
    expect(result.carried).toBe("Done")
    expect(result.dispatched).toEqual([
      ["run.interrupt", "yapd:u1:0", true],
      ["queue.resume", "yapd:u2:0", undefined],
      ["message.dispatch", "yapd:u2:1", Hands.carryOn],
    ])
  })
})
