import { describe, expect, test } from "bun:test"
import { Clock, Effect, Fiber, Option, Schema, type Scope, TestClock, TestContext } from "effect"
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

/**
 * Takes a message in as T3 Code does: a turn of its own on an idle thread,
 * into the turn under way or behind it on a busy one. It steers or restarts
 * only a turn that's running, queues behind one getting going, and turns
 * down steering one that's waiting, or restarting one that isn't running.
 */
const takes =
  (intent: "steer" | "queued_turn" = "steer"): Answer =>
  (payload, bounded) =>
    Effect.suspend(() => {
      if (payload.type === "message.dispatch") {
        const messageId = String(payload.messageId)
        const active = bounded.runs.find(({ status }) => ["preparing", "starting", "running", "waiting"].includes(status))
        const going = active !== undefined
        const into = (payload.dispatchMode as { type: string }).type === "start_immediately" && active !== undefined && active.status !== "running"
        if (into && (payload.deliveryIntent === "restart" || (payload.deliveryIntent === "auto" && active.status === "waiting"))) {
          return Effect.fail(new Server.Refusal({ tag: "OrchestrationV2DispatchCommandError", message: `Target run ${active.id} is ${active.status} and cannot be steered.` }))
        }
        const queued = (payload.dispatchMode as { type: string }).type === "queue_after_active" || intent === "queued_turn" || into
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
      return Effect.succeed({ sequence: 7 })
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
    const threads: Parameters<typeof Hands.make>[0]["threads"] = {
      find: (ref) => Effect.sync(() => (ref.id === current.id ? Option.some(current) : Option.none())),
      actions: (machine) => (machine === "Rosie" ? Option.some(actions) : Option.none()),
    }
    const made = Hands.make({ threads, ledger, ...(given.started === undefined ? {} : { started: given.started }) })
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
      /** Hands as yapd has them once it's restarted at `at`, over the same ledger and T3 Code. */
      restarted: (at: number) => Hands.make({ threads, ledger, started: at }),
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
        "Run run_7f3a9c2b was cancelled.",
        "Target run 0193f2c4-7d1e-7a3b-9c5d-2e8f6a1b4c7d is starting and cannot be steered.",
        // As T3 Code said it live, for a turn busy only in the background.
        "No running provider turn found for active run run:thread:aaaf4547-528e-4031-8148-64e7a18d6540:ordinal:6",
        "Active run run:thread:aaaf4547-528e-4031-8148-64e7a18d6540:ordinal:6 has ended.",
        // T3 Code's word for a stop that came just after the run ended.
        "Run run:thread:aaaf4547-528e-4031-8148-64e7a18d6540:ordinal:6 is not interruptible.",
      ].map(Hands.plainly),
    ).toEqual([
      "That command was previously rejected: that thread is archived.",
      "Nothing running for that thread.",
      "The work has ended.",
      "Thread not found.",
      "That run was cancelled.",
      "It isn't at a point where it can take that yet.",
      "It isn't at a point where it can take that yet.",
      "The active run has ended.",
      "It isn't doing anything right now.",
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

  test("a message T3 Code takes and never answers for is given up on fifteen seconds on, though the step can't be cut short, and offered again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, answering, ledger, dispatched } = yield* hands()
        // T3 Code takes it and never answers, as it can stop answering on a socket without saying why, given up on as yapd's own requests are.
        answering(() => Server.patiently(Effect.never, "15 seconds", () => new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        // On its own, so a step that never ends can't hold up the test's own end.
        const sending = yield* Effect.forkDaemon(send("u1", "Use the Mina fee table."))
        while (dispatched.length === 0) yield* Effect.promise(() => Bun.sleep(5))
        yield* Effect.promise(() => Bun.sleep(5))
        yield* TestClock.adjust("15 seconds")
        for (let tries = 0; tries < 100 && Option.isNone(yield* Fiber.poll(sending)); tries++) yield* Effect.promise(() => Bun.sleep(5))
        const ended = yield* Fiber.poll(sending)
        if (Option.isNone(ended)) return "still waiting"
        const outcome = yield* ended.value
        const row = yield* ledger.get("yapd:u1:0")
        return {
          told: outcome._tag === "Unknown" ? Hands.failed({ _tag: "Message", to: tezos, text: "", how: "now" }, outcome, lines, Option.none()) : outcome._tag,
          state: Option.map(row, ({ state }) => state),
        }
      }),
    )
    expect(result).toEqual({ told: "I couldn't confirm it got there, sir. Send it again?", state: Option.some("unknown") })
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

  test("a yes to sending again while the thread can't be found sends nothing, and leaves it to be offered under its own ids when the same words are said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, becomes, ids } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        yield* send("u1", "Use the fee table.")
        // T3 Code's view lost the thread for a moment as he said yes.
        becomes(thread("t-other"))
        const refused = yield* again("yapd:u1:0")
        becomes(thread(tezos.id))
        answering(takes())
        yield* TestClock.adjust("1 minute")
        const said = yield* send("u2", "Use the fee table.")
        const yes = said._tag === "Twin" ? yield* again(said.row.commandId) : said
        return {
          refused: refused._tag === "Refused" ? refused.reason : refused._tag,
          said: said._tag === "Twin" ? [said.row.commandId, said.row.state] : said._tag,
          yes: yes._tag,
          ids: ids(),
        }
      }),
    )
    expect(result.refused).toBe("I can't find it among your threads right now.")
    // Never "I won't risk sending it a third time": it only went once.
    expect(result.said).toEqual(["yapd:u1:0", "unknown"])
    expect(result.yes).toBe("Done")
    expect(result.ids).toEqual([
      ["yapd:u1:0", "yapd:u1:0:m"],
      ["yapd:u1:0", "yapd:u1:0:m"],
    ])
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
        const called = Option.some("Migrate Tezos Integration")
        return {
          undelivered: undelivered.map(({ commandId }) => commandId),
          unconfirmed: unconfirmed.map((row) => [
            row.commandId,
            row.kind === "message" ? Hands.unoffered(lines, called, row.reason ?? "") : Hands.unsure(row, lines, called, row.reason ?? undefined),
          ]),
          states: states.map(Option.getOrNull),
          restart: (yield* ledger.open(0)).map(({ commandId }) => commandId),
          dispatched: dispatched.length,
        }
      }),
    )
    expect(result.dispatched).toBe(0)
    expect(result.undelivered).toEqual(["yapd:u2:0"])
    // The stop that can't be confirmed, and the message too long ago to send again, are said so, never done again.
    expect(result.unconfirmed).toEqual([
      ["yapd:u0:0", "Before I restarted, I couldn't confirm your message to Migrate Tezos Integration got there, sir, and it's too long ago to send it again now."],
      ["yapd:u3:0", "Before I restarted, I couldn't confirm Migrate Tezos Integration stopped, sir."],
    ])
    // The old message stays as it may be, so the same words said again are asked about, but it isn't looked at again.
    expect(result.states).toEqual(["unknown", "sent", "unknown", "abandoned"])
    expect(result.restart).toEqual(["yapd:u2:0"])
  })

  test("a turn stopped to be told something in its place, or let go of its queue to be asked to carry on, that yapd restarted before telling is said once after the restart, and never told", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { send, run: act, answering, becomes, ledger, dispatched, restarted } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        answering((payload, bounded) => {
          if (payload.type !== "run.interrupt") return takes()(payload, bounded)
          bounded.runs[0]!.status = "interrupted"
          return Effect.succeed({ sequence: 7 })
        })
        // yapd stops while it waits for the stop to show.
        const sending = yield* Effect.fork(send("u1", "Drop that and fix the loader instead.", "restart"))
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.interrupt(sending)
        becomes(thread(tezos.id, { status: "interrupted" }))
        // Then, back, it stops once the queue is let go of, before asking it to carry on.
        let looked = 0
        const stalls = Effect.suspend(() => (++looked === 1 ? Effect.succeed(true) : Effect.never))
        const carrying = yield* Effect.fork(act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true }, { wanted: stalls }))
        yield* TestClock.adjust("1 second")
        yield* Fiber.interrupt(carrying)
        // Neither a plain stop, nor one whose message went, is anything to say.
        for (const [utterance, then] of [["u3", undefined], ["u4", "Use the fee table."]] as const) {
          yield* ledger.prepare({ utterance, step: 0, kind: "stop", machine: "Rosie", thread: tezos.id, body: () => ({ _tag: "Stop", ...(then === undefined ? {} : { then }) }), message: false })
          yield* ledger.settle(`yapd:${utterance}:0`, "sent")
        }
        yield* ledger.prepare({
          utterance: "u4",
          step: 1,
          kind: "message",
          machine: "Rosie",
          thread: tezos.id,
          body: ({ messageId }) => ({ _tag: "Send", text: "Use the fee table.", messageId, how: "now" }),
          message: true,
        })
        yield* ledger.settle("yapd:u4:1", "sent")
        // Nor is one that wasn't asked to carry on since yapd was turned off as its queue was let go of, which was said then.
        let on = true
        answering((payload, bounded) => {
          if (payload.type === "queue.resume") on = false
          return takes()(payload, bounded)
        })
        const off = yield* act({ utterance: "u5", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true }, { wanted: Effect.sync(() => on) })
        yield* TestClock.adjust("1 minute")
        const back = restarted(now + 3 * 60_000)
        const first = yield* back.reconcile
        const second = yield* back.reconcile
        const called = Option.some("Migrate Tezos Integration")
        return {
          said: first.unconfirmed.map((row) => [row.commandId, Hands.unsure(row, lines, called, row.reason ?? undefined)]),
          undelivered: first.undelivered.length,
          again: second.unconfirmed.length,
          off: off._tag === "NotSent" ? off.reason : off._tag,
          dispatched: dispatched.map(({ type, commandId }) => [type, commandId]),
        }
      }),
    )
    expect(result).toEqual({
      said: [
        ["yapd:u1:0", "Before I restarted, I stopped Migrate Tezos Integration, sir, but didn't get to tell it what to do instead."],
        ["yapd:u2:0", "Before I restarted, I let Migrate Tezos Integration go again, sir, but didn't get to ask it to carry on."],
      ],
      undelivered: 0,
      again: 0,
      off: Hands.switchedOff,
      dispatched: [
        ["run.interrupt", "yapd:u1:0"],
        ["queue.resume", "yapd:u2:0"],
        ["queue.resume", "yapd:u5:0"],
      ],
    })
  })

  test("a restart says what it couldn't look for, on a machine it can't reach or a thread it can't read, and new work it can't find, and sends nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { reconcile, ledger, reads, dispatched } = yield* hands()
        const prepare = (utterance: string, kind: Ledger.Kind, machine = "Rosie") =>
          ledger.prepare({
            utterance,
            step: 0,
            kind,
            machine,
            thread: kind === "start" ? "t-new" : tezos.id,
            body: ({ messageId }) => (kind === "message" ? { _tag: "Send", text: "Use the fee table.", messageId, how: "now" } : {}),
            message: kind !== "stop",
          })
        yield* prepare("u1", "message", "rig")
        yield* prepare("u2", "message")
        yield* prepare("u3", "start")
        yield* TestClock.adjust("1 minute")
        reads(false)
        const { undelivered, unconfirmed } = yield* reconcile
        return {
          undelivered: undelivered.length,
          unconfirmed: unconfirmed.map(({ commandId, reason }) => [commandId, reason]),
          restart: yield* ledger.open(0),
          dispatched: dispatched.length,
        }
      }),
    )
    expect(result.unconfirmed).toEqual([
      ["yapd:u1:0", "I can't reach the threads on rig right now."],
      ["yapd:u2:0", "I couldn't look for it just now: T3 Code is taking too long."],
      ["yapd:u3:0", Hands.unconfirmable],
    ])
    expect(Hands.unoffered(lines, Option.none(), "I couldn't look for it just now: T3 Code is taking too long.")).toBe(
      "Before I restarted, I couldn't confirm your message got there, sir, and I couldn't look for it just now: T3 Code is taking too long.",
    )
    expect(Hands.unsure({ kind: "start", body: {} }, lines, Option.none())).toBe("Before I restarted, I couldn't confirm the new work you asked for started, sir.")
    expect(result.undelivered).toBe(0)
    // Said once, never looked at again by a restart.
    expect(result.restart).toEqual([])
    expect(result.dispatched).toBe(0)
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
        // T3 Code stops the turn under way, which ends it, as the live view shows, and the message starts one of its own.
        answering((payload, bounded) =>
          Effect.sync(() => {
            if (payload.type === "run.interrupt") {
              bounded.runs[0]!.status = "interrupted"
              becomes(thread(tezos.id, { status: "interrupted" }))
            } else bounded.runs.push({ id: "run-2", status: "running", ordinal: 2, userMessageId: String(payload.messageId) })
            return { sequence: 7 }
          }),
        )
        yield* send("u1", "Drop that and use the fee table.", "restart")
        yield* TestClock.adjust("5 seconds")
        becomes(ended(now + 1000, { activeRunId: "run-2", activityRunStatus: "running", status: "running" }))
        const again = yield* send("u2", "Drop that and use the fee table.", "restart")
        return { again: again._tag, dispatched: dispatched.map(({ type }) => type) }
      }),
    )
    expect(restarted).toEqual({ again: "Twin", dispatched: ["run.interrupt", "message.dispatch"] })
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

  test("a queued message he took out himself, which T3 Code still shows cancelled, is withdrawn, so the same words go as new", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { send, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        // He took it out of the queue in T3 Code's app, which still shows its run, cancelled, and the message.
        bounded.runs[1]!.status = "cancelled"
        yield* TestClock.adjust("1 minute")
        const again = yield* send("u2", "When it's done, open a PR.", "after")
        return { again: again._tag, dispatched: dispatched.map(({ commandId }) => commandId) }
      }),
    )
    expect(result).toEqual({ again: "Done", dispatched: ["yapd:u1:0", "yapd:u2:0"] })
  })

  test("a queued message he promoted to steer in T3 Code's app is still the message that went, so the same words are asked about", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { send, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        // He pressed Steer on it: T3 Code cancels the run it waited in, and steers it into the turn under way.
        bounded.runs[1]!.status = "cancelled"
        bounded.turnItems.push({ type: "user_message", messageId: "yapd:u1:0:m", inputIntent: "promoted_queued_to_steer" })
        yield* TestClock.adjust("1 minute")
        const again = yield* send("u2", "When it's done, open a PR.", "after")
        return { again: again._tag, dispatched: dispatched.length }
      }),
    )
    expect(result).toEqual({ again: "Twin", dispatched: 1 })
  })

  test("the same words are asked about until the thread answers after they went in, which a resend makes later than they were first written down", async () => {
    const busy = (runId: string, ended: number) =>
      thread(tezos.id, { activeRunId: runId, activityRunStatus: "running", status: "running", latestRunCompletedAt: new Date(ended).toISOString() })
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, becomes, bounded, dispatched } = yield* hands({ thread: busy("run-1", now - 60_000), runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        // It went, T3 Code didn't answer, and it isn't in the thread.
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        yield* send("u1", "Use the fee table.")
        // The turn under way ended, and another began, before he said yes.
        yield* TestClock.adjust("30 seconds")
        bounded.runs[0]!.status = "completed"
        bounded.runs.push({ id: "run-2", status: "running", ordinal: 2 })
        becomes(busy("run-2", now + 30_000))
        yield* TestClock.adjust("10 seconds")
        // Taken in now, as T3 Code notes, into the turn under way.
        answering((payload, bounded) =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.sync(() => {
              bounded.messages.push({ id: String(payload.messageId), role: "user", text: String(payload.text), createdAt: new Date(at).toISOString() })
              bounded.turnItems.push({ type: "user_message", messageId: payload.messageId, inputIntent: "steer" })
              return { sequence: 8 }
            }),
          ),
        )
        const resent = yield* again("yapd:u1:0")
        yield* TestClock.adjust("20 seconds")
        const said = yield* send("u2", "Use the fee table.")
        return { resent: resent._tag, said: said._tag, dispatched: dispatched.map(({ commandId }) => commandId) }
      }),
    )
    expect(result).toEqual({ resent: "Done", said: "Twin", dispatched: ["yapd:u1:0", "yapd:u1:0"] })
  })

  test("a message steered into the turn under way that the thread's read no longer reaches back to is still asked about, since only one in the queue can be taken out", async () => {
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    const result = await run(
      Effect.gen(function* () {
        const { send, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        const first = yield* send("u1", "Also make sure it doesn't touch the Swift helper.")
        // The long turn it went into pushes it out of what T3 Code reads back.
        bounded.messages.splice(0)
        bounded.turnItems.splice(0)
        yield* TestClock.adjust("1 minute")
        const again = yield* send("u2", "Also make sure it doesn't touch the Swift helper.")
        return { first: first._tag === "Done" ? first.how : first._tag, again: again._tag, dispatched: dispatched.length }
      }),
    )
    expect(result).toEqual({ first: "steered", again: "Twin", dispatched: 1 })
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

  test("a message for now to a thread whose turn is waiting, which T3 Code won't steer into, goes in its queue, and he's told why", async () => {
    const waiting = (pending: boolean) =>
      run(
        Effect.gen(function* () {
          const asking = thread(tezos.id, {
            activeRunId: null,
            activityRunStatus: "waiting",
            status: "waiting",
            pendingRuntimeRequest: pending ? { id: "r1", kind: "command", createdAt: "2026-10-08T21:59:00.000Z" } : null,
          })
          const { send, dispatched } = yield* hands({ thread: asking, runs: [{ id: "run-1", status: "waiting", ordinal: 1 }] })
          const outcome = yield* send("u1", "Use the Mina fee table.")
          const said = outcome._tag === "Done" ? Hands.done({ _tag: "Message", to: tezos, text: "", how: "now" }, outcome.how, lines, Option.some("Migrate Tezos Integration"), outcome) : outcome._tag
          return { outcome: outcome._tag === "Done" ? [outcome.how, outcome.waiting] : outcome._tag, said, dispatched }
        }),
      )
    const asked = await waiting(true)
    expect(asked.dispatched).toHaveLength(1)
    expect(asked.dispatched[0]).toMatchObject({ type: "message.dispatch", dispatchMode: { type: "queue_after_active" } })
    expect(asked.dispatched[0]).not.toHaveProperty("deliveryIntent")
    expect(asked.outcome).toEqual(["queued", "asked"])
    expect(asked.said).toBe("Migrate Tezos Integration is waiting on you for something, sir, so that will go once it's dealt with.")
    const finishing = await waiting(false)
    expect(finishing.outcome).toEqual(["queued", "finishing"])
    expect(finishing.said).toBe("Migrate Tezos Integration is finishing something off, sir, so that will go once it's done.")
  })

  test("a yes to sending again a message for now, once the thread is waiting on him, sends it behind the turn under the same ids, and he's told why", async () => {
    const asking = thread(tezos.id, {
      activeRunId: null,
      activityRunStatus: "waiting",
      status: "waiting",
      pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: "2026-10-08T21:59:00.000Z" },
    })
    const resent = (sent: boolean) =>
      run(
        Effect.gen(function* () {
          const { send, again, answering, becomes, bounded, dispatched } = yield* hands()
          // T3 Code isn't answering as he says it, so it never left, or may not have got there.
          answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code isn't answering.", ...(sent ? { sent: true } : {}) })))
          yield* send("u1", "Use the Mina fee table.")
          // By the time he says yes, its turn is waiting on him for an approval.
          becomes(asking)
          bounded.runs.push({ id: "run-1", status: "waiting", ordinal: 1 })
          answering(takes())
          const outcome = yield* again("yapd:u1:0")
          return {
            said:
              outcome._tag === "Done"
                ? Hands.done({ _tag: "Message", to: tezos, text: "", how: "now" }, outcome.how, lines, Option.none(), outcome)
                : outcome._tag === "Refused" || outcome._tag === "NotSent" || outcome._tag === "Unknown"
                  ? Hands.failed({ _tag: "Message", to: tezos, text: "", how: "now" }, outcome, lines, Option.none())
                  : outcome._tag,
            dispatched: dispatched.map(({ commandId, messageId, dispatchMode }) => [commandId, messageId, (dispatchMode as { type: string }).type]),
          }
        }),
      )
    for (const sent of [false, true]) {
      expect(await resent(sent)).toEqual({
        said: "It's waiting on you for something, sir, so that will go once it's dealt with.",
        dispatched: [
          ["yapd:u1:0", "yapd:u1:0:m", "start_immediately"],
          ["yapd:u1:0", "yapd:u1:0:m", "queue_after_active"],
        ],
      })
    }
  })

  test("a yes to sending again in place of the turn under way a message told to a turn once it was stopped goes as it first went, at once, which is how that's sent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, dispatched } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        yield* send("u1", "Fix the loader instead.")
        answering(takes())
        const outcome = yield* again("yapd:u1:0", { how: "restart" })
        return { outcome: outcome._tag, dispatched: dispatched.map(({ commandId, deliveryIntent }) => [commandId, deliveryIntent]) }
      }),
    )
    expect(result).toEqual({ outcome: "Done", dispatched: [["yapd:u1:0", "auto"], ["yapd:u1:0", "auto"]] })
  })

  test("a message in place of the turn under way stops it, holding its queue, then tells it at once once the live view shows it stopped, whatever the turn was doing, and never asks T3 Code to restart it", async () => {
    const at = (status: string, overrides: Record<string, unknown> = {}) =>
      thread(tezos.id, { activeRunId: status === "waiting" ? null : "run-1", activityRunStatus: status, status, ...overrides })
    /** The stop shows in the live view two seconds after T3 Code takes it, unless `shows` is false; `answer` is how it takes the message. */
    const restarting = (first: T3Live.Thread, shows = true, answer: Answer = takes()) =>
      run(
        Effect.gen(function* () {
          const going = first.activityRunStatus !== undefined
          const { send, answering, becomes, dispatched } = yield* hands({ thread: first, runs: going ? [{ id: "run-1", status: first.activityRunStatus ?? "", ordinal: 1 }] : [] })
          answering((payload, bounded) => {
            if (payload.type !== "run.interrupt") return answer(payload, bounded)
            bounded.runs[0]!.status = "interrupted"
            return Effect.succeed({ sequence: 7 })
          })
          const sending = yield* Effect.fork(send("u1", "Drop that and fix the loader instead.", "restart"))
          yield* TestClock.adjust("2 seconds")
          if (shows) becomes(thread(tezos.id, { status: "interrupted" }))
          yield* TestClock.adjust("14 seconds")
          const outcome = yield* Fiber.join(sending)
          const act: Hands.Act = { _tag: "Message", to: tezos, text: "", how: "restart" }
          return {
            said: outcome._tag === "Done" ? Hands.done(act, outcome.how, lines, Option.none(), outcome) : outcome._tag === "NotSent" ? Hands.failed(act, outcome, lines, Option.none()) : outcome._tag,
            dispatched: dispatched.map(({ type, commandId, holdQueue, deliveryIntent }) => [type, commandId, holdQueue ?? deliveryIntent]),
          }
        }),
      )
    const asked = at("waiting", { pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: "2026-10-08T21:59:00.000Z" } })
    for (const first of [at("running"), at("starting"), asked]) {
      expect(await restarting(first)).toEqual({
        said: "Stopped it, sir, and told it.",
        dispatched: [
          ["run.interrupt", "yapd:u1:0", true],
          ["message.dispatch", "yapd:u1:1", "auto"],
        ],
      })
    }
    // Doing nothing, it's just told.
    expect(await restarting(thread(tezos.id))).toEqual({ said: "On it, sir.", dispatched: [["message.dispatch", "yapd:u1:0", "auto"]] })
    // Still busy fifteen seconds on, it isn't told, since it could still take it into the turn being stopped, or hold it in the queue.
    expect(await restarting(at("running"), false)).toEqual({
      said: "I stopped it, sir, but couldn't tell it yet: it was still winding down fifteen seconds later.",
      dispatched: [["run.interrupt", "yapd:u1:0", true]],
    })
    // Put in the queue all the same, he's told it waits there.
    const queues: Answer = (payload, bounded) =>
      Effect.sync(() => {
        bounded.runs.push({ id: "run-2", status: "queued", ordinal: 2, userMessageId: String(payload.messageId) })
        return { sequence: 8 }
      })
    expect((await restarting(at("running"), true, queues)).said).toBe("Stopped it, sir, but that's held in its queue till you say carry on.")
  })

  test("a message in place of the turn under way worked out again is the stop and the message it was, whatever came of them, and nothing goes twice", async () => {
    const twice = (shows: boolean) =>
      run(
        Effect.gen(function* () {
          const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
          const { send, answering, becomes, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
          answering((payload, bounded) => {
            if (payload.type !== "run.interrupt") return takes()(payload, bounded)
            bounded.runs[0]!.status = "interrupted"
            return Effect.succeed({ sequence: 7 })
          })
          const sending = yield* Effect.fork(send("u1", "Drop that and fix the loader instead.", "restart"))
          yield* TestClock.adjust("2 seconds")
          if (shows) becomes(thread(tezos.id, { status: "interrupted" }))
          yield* TestClock.adjust("14 seconds")
          const first = yield* Fiber.join(sending)
          // Worked out again as he carried on talking.
          const again = yield* send("u1", "Drop that and fix the loader instead.", "restart")
          const what = (outcome: Hands.Outcome) =>
            outcome._tag === "Done" ? [outcome._tag, outcome.how, outcome.stopped] : "reason" in outcome ? [outcome._tag, outcome.reason, outcome.stopped] : [outcome._tag]
          return { first: what(first), again: what(again), dispatched: dispatched.map(({ type, commandId }) => [type, commandId]) }
        }),
      )
    expect(await twice(true)).toEqual({
      first: ["Done", "now", true],
      again: ["Done", "now", true],
      dispatched: [
        ["run.interrupt", "yapd:u1:0"],
        ["message.dispatch", "yapd:u1:1"],
      ],
    })
    // Not told, it's the same reason again, never told on the second go.
    const winding = ["NotSent", "It was still winding down fifteen seconds later.", true]
    expect(await twice(false)).toEqual({ first: winding, again: winding, dispatched: [["run.interrupt", "yapd:u1:0"]] })
  })

  test("a turn that ended just before it was stopped to be told something in its place is told at once, whether yapd's look or T3 Code finds it ended", async () => {
    const ended = (by: "look" | "T3 Code") =>
      run(
        Effect.gen(function* () {
          // The live view still has it finishing off, but its run has ended by the time the stop looks, or just after, by the time T3 Code takes it.
          const finishing = thread(tezos.id, { activeRunId: null, activityRunStatus: "waiting", status: "waiting" })
          const { send, answering, dispatched } = yield* hands({ thread: finishing, runs: [{ id: "run-1", status: by === "look" ? "completed" : "waiting", ordinal: 1 }] })
          answering((payload, bounded) => {
            if (payload.type !== "run.interrupt") return takes()(payload, bounded)
            bounded.runs[0]!.status = "completed"
            return Effect.fail(new Server.Refusal({ tag: "OrchestrationV2DispatchCommandError", message: "Run run:thread:t-tezos:ordinal:1 is not interruptible." }))
          })
          const outcome = yield* send("u1", "Drop that and fix the loader instead.", "restart")
          return {
            outcome: outcome._tag === "Done" ? [outcome.how, outcome.stopped] : outcome._tag,
            said: outcome._tag === "Done" ? Hands.done({ _tag: "Message", to: tezos, text: "", how: "restart" }, outcome.how, lines, Option.none(), outcome) : "",
            dispatched: dispatched.map(({ type, commandId }) => [type, commandId]),
          }
        }),
      )
    expect(await ended("look")).toEqual({ outcome: ["now", "ended"], said: "On it, sir.", dispatched: [["message.dispatch", "yapd:u1:1"]] })
    expect(await ended("T3 Code")).toEqual({
      outcome: ["now", "ended"],
      said: "On it, sir.",
      dispatched: [
        ["run.interrupt", "yapd:u1:0"],
        ["message.dispatch", "yapd:u1:1"],
      ],
    })
  })

  test("a turn that ended just before it was stopped to be told something in its place isn't told once yapd was turned off since he said it, and why is said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const finishing = thread(tezos.id, { activeRunId: null, activityRunStatus: "waiting", status: "waiting" })
        const { run: act, answering, dispatched } = yield* hands({ thread: finishing, runs: [{ id: "run-1", status: "waiting", ordinal: 1 }] })
        let on = true
        // yapd is turned off and on as T3 Code finds the run ended just before the stop.
        answering((payload, bounded) => {
          if (payload.type !== "run.interrupt") return takes()(payload, bounded)
          on = false
          bounded.runs[0]!.status = "completed"
          return Effect.fail(new Server.Refusal({ tag: "OrchestrationV2DispatchCommandError", message: "Run run-1 is not interruptible." }))
        })
        const message: Hands.Act = { _tag: "Message", to: tezos, text: "Drop that and fix the loader instead.", how: "restart" }
        const outcome = yield* act({ utterance: "u1", step: 0 }, message, { wanted: Effect.sync(() => on) })
        return {
          outcome: outcome._tag === "NotSent" ? [outcome.reason, outcome.stopped] : outcome._tag,
          dispatched: dispatched.map(({ type, commandId }) => [type, commandId]),
        }
      }),
    )
    expect(result).toEqual({ outcome: [Hands.switchedOff, "ended"], dispatched: [["run.interrupt", "yapd:u1:0"]] })
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

  test("a message taken out of the queue is gone from the thread, as T3 Code drops it: scratch that whose answer was lost is withdrawn, and one he took out himself goes again as new", async () => {
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    /** T3 Code taking a message out of the queue: neither it nor the run it waited in shows any more. */
    const drops = (bounded: Bounded, messageId: string) => {
      bounded.runs = bounded.runs.filter(({ userMessageId }) => userMessageId !== messageId)
      bounded.messages = bounded.messages.filter(({ id }) => id !== messageId)
    }
    const result = await run(
      Effect.gen(function* () {
        const { send, run: act, answering, bounded, ledger, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        // Done, but the answer to the cancel was lost.
        answering((_, bounded) =>
          Effect.suspend(() => {
            drops(bounded, "yapd:u1:0:m")
            return Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true }))
          }),
        )
        const scratched = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        const message = yield* ledger.get("yapd:u1:0")
        answering(takes())
        // Then one he took out of the queue himself, in T3 Code's app.
        yield* send("u3", "Also add a changelog entry.", "after")
        drops(bounded, "yapd:u3:0:m")
        yield* TestClock.adjust("1 minute")
        const again = yield* send("u4", "Also add a changelog entry.", "after")
        return {
          scratched: scratched._tag,
          message: Option.map(message, ({ state, reason }) => [state, reason]),
          again: again._tag,
          dispatched: dispatched.map(({ type }) => type),
        }
      }),
    )
    expect(result.scratched).toBe("Done")
    expect(result.message).toEqual(Option.some(["abandoned", Ledger.withdrawn]))
    expect(result.again).toBe("Done")
    expect(result.dispatched).toEqual(["message.dispatch", "queued-run.cancel", "message.dispatch", "message.dispatch"])
  })

  test("scratch that whose answer was lost, for a message he steered into the turn under way meanwhile, isn't taken as withdrawn, so the same words are still asked about", async () => {
    const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    const result = await run(
      Effect.gen(function* () {
        const { send, run: act, answering, ledger, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* send("u1", "When it's done, open a PR.", "after")
        // He pressed Steer on it in T3 Code's app just then, which cancels the run it waited in and steers it in, and the answer to the cancel was lost.
        answering((_, bounded) =>
          Effect.suspend(() => {
            bounded.runs[1]!.status = "cancelled"
            bounded.turnItems.push({ type: "user_message", messageId: "yapd:u1:0:m", inputIntent: "promoted_queued_to_steer" })
            return Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true }))
          }),
        )
        const scratched = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: false })
        const message = yield* ledger.get("yapd:u1:0")
        answering(takes())
        yield* TestClock.adjust("1 minute")
        const again = yield* send("u3", "When it's done, open a PR.", "after")
        return { scratched: scratched._tag, message: Option.map(message, ({ state }) => state), again: again._tag, dispatched: dispatched.map(({ type }) => type) }
      }),
    )
    expect(result).toEqual({ scratched: "Unknown", message: Option.some("sent"), again: "Twin", dispatched: ["message.dispatch", "queued-run.cancel"] })
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

  test("carry on, once what a stopped turn was told in its place waits in the queue the stop held, lets go of the queue, and never asks it to pick up what it was told to drop", async () => {
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { send, run: act, answering, becomes, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        // Stopped, with a message queued behind it that the stop held, so T3 Code puts what it's told in its place in the queue too.
        answering((payload, bounded) =>
          Effect.sync(() => {
            if (payload.type === "run.interrupt") {
              bounded.runs[0]!.status = "interrupted"
              becomes(thread(tezos.id, { status: "interrupted" }))
            } else if (payload.type === "message.dispatch") bounded.runs.push({ id: "run-2", status: "queued", ordinal: 2, userMessageId: String(payload.messageId) })
            return { sequence: 7 }
          }),
        )
        const instead = yield* send("u1", "Drop that and fix the loader instead.", "restart")
        const carried = yield* act({ utterance: "u2", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true })
        const said = (outcome: Hands.Outcome, act: Hands.Act) => (outcome._tag === "Done" ? Hands.done(act, outcome.how, lines, Option.none(), outcome) : outcome._tag)
        return {
          instead: said(instead, { _tag: "Message", to: tezos, text: "", how: "restart" }),
          carried: said(carried, { _tag: "Undo", to: Option.none(), carry: true }),
          dispatched: dispatched.map(({ type, commandId }) => [type, commandId]),
        }
      }),
    )
    expect(result).toEqual({
      instead: "Stopped it, sir, but that's held in its queue till you say carry on.",
      carried: "Carrying on.",
      dispatched: [
        ["run.interrupt", "yapd:u1:0"],
        ["message.dispatch", "yapd:u1:1"],
        ["queue.resume", "yapd:u2:0"],
      ],
    })
  })

  test("carry on said again once the word to carry on may not have got there sends nothing under new ids, and offers it again under its own", async () => {
    const carry = { _tag: "Undo", to: Option.none(), carry: true } as const
    const result = await run(
      Effect.gen(function* () {
        const busy = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
        const { run: act, again, answering, becomes, bounded, dispatched } = yield* hands({ thread: busy, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        yield* act({ utterance: "u1", step: 0 }, { _tag: "Stop", to: tezos })
        bounded.runs[0]!.status = "interrupted"
        becomes(thread(tezos.id, { status: "interrupted" }))
        // The queue is let go of, and the word to carry on goes, but T3 Code doesn't answer for it, and it isn't in the thread.
        answering((payload, bounded) =>
          payload.type === "message.dispatch" ? Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })) : takes()(payload, bounded),
        )
        const first = yield* act({ utterance: "u2", step: 0 }, carry)
        yield* TestClock.adjust("30 seconds")
        answering(takes())
        const second = yield* act({ utterance: "u3", step: 0 }, carry)
        const yes = second._tag === "Twin" ? yield* again(second.row.commandId) : second
        // Once it's carrying on, saying so again is nothing to do.
        const third = yield* act({ utterance: "u4", step: 0 }, carry)
        return {
          first: first._tag === "Unknown" ? Hands.failed(carry, first, lines, Option.none()) : first._tag,
          second: second._tag === "Twin" ? second.row.commandId : second._tag,
          yes: yes._tag,
          third: third._tag === "Refused" ? Hands.failed(carry, third, lines, Option.none()) : third._tag,
          dispatched: dispatched.map(({ type, commandId }) => [type, commandId]),
        }
      }),
    )
    expect(result.first).toBe("I couldn't confirm it got the word to carry on, sir. Send it again?")
    expect(result.second).toBe("yapd:u2:1")
    expect(result.yes).toBe("Done")
    expect(result.third).toBe("I've already let it carry on, sir.")
    expect(result.dispatched).toEqual([
      ["run.interrupt", "yapd:u1:0"],
      ["queue.resume", "yapd:u2:0"],
      ["message.dispatch", "yapd:u2:1"],
      ["message.dispatch", "yapd:u2:1"],
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
