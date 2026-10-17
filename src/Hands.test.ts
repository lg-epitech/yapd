import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import * as Hands from "./Hands.ts"
import * as Journal from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as Server from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
import type * as Tunnel from "./Tunnel.ts"

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

/** How T3 Code answers a command: what it does to the thread, and what it says back. */
type Answer = (payload: Record<string, unknown>, bounded: Bounded) => Effect.Effect<unknown, Server.Trouble | Server.Refusal>

interface Bounded {
  runs: Array<{ id: string; status: string; ordinal: number; userMessageId?: string }>
  messages: Array<{ id: string; role: string; text: string; createdAt: string; runId?: string | null }>
  turnItems: Array<Record<string, unknown>>
}

/**
 * Takes a message in as T3 Code does: a turn of its own on an idle thread,
 * into the turn under way or behind it on a busy one. It steers or restarts
 * only a turn that's running, queues behind one getting going, and turns
 * down steering one that's waiting, or restarting one that isn't running.
 */
const takes =
  (): Answer =>
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
        const queued = (payload.dispatchMode as { type: string }).type === "queue_after_active" || into
        const message = { id: messageId, role: "user", text: String(payload.text), createdAt: "now" }
        bounded.messages.push(message)
        if (!going || queued) {
          bounded.runs.push({ id: `run-${bounded.runs.length + 1}`, status: going ? "queued" : "running", ordinal: bounded.runs.length + 1, userMessageId: messageId })
        }
        // Each in the run T3 Code names on it, the message and its item: the run of its own it started or waits in, or the one it was steered into.
        Object.assign(message, { runId: going && !queued ? active.id : bounded.runs.at(-1)?.id })
        if (!going || !queued) {
          bounded.turnItems.push({ type: "user_message", messageId, inputIntent: going ? "steer" : "turn_start", runId: going ? active.id : bounded.runs.at(-1)?.id })
        }
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
    const store = yield* Store.make(":memory:")
    const ledger = Ledger.fromStore(store)
    const bounded: Bounded = { runs: [...(given.runs ?? [])], messages: [], turnItems: [] }
    const dispatched: Array<Record<string, unknown>> = []
    let answer: Answer = takes()
    let current = given.thread ?? thread(tezos.id)
    let readable = true
    const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
      api: (<A, I>(path: string, schema: Schema.Schema<A, I>) => {
        if (!readable) return Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long." }))
        if (path.endsWith("/bounded")) return Schema.decodeUnknown(schema)({ projection: bounded }).pipe(Effect.orDie)
        return Schema.decodeUnknown(schema)({ snapshotSequence: 1, projection: bounded }).pipe(Effect.orDie)
      }) as Server.Transport["api"],
      call: (<A, I>(method: string, payload: Record<string, unknown>, schema: Schema.Schema<A, I>) =>
        method === "orchestration.dispatchCommand"
          ? Effect.suspend(() => {
              dispatched.push(payload)
              return answer(payload, bounded)
            }).pipe(Effect.flatMap((value) => Schema.decodeUnknown(schema)(value).pipe(Effect.orDie)))
          : Effect.die(`not expected: ${method}`)) as Server.Transport["call"],
      asset: () => Effect.die("not expected"),
    })
    const actions = T3Actions.make(reach)
    const threads: Parameters<typeof Hands.make>[0]["threads"] = {
      find: (ref) => Effect.sync(() => (ref.id === current.id ? Option.some(current) : Option.none())),
      actions: (machine) => (machine === "Rosie" ? Option.some(actions) : Option.none()),
      unseen: () => Effect.succeed(Option.none()),
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
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

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

  test("T3 Code's reasons are said without its ids, quoted or not, and about the work, never a session", () => {
    expect(
      [
        "Command yapd:u1:0 was previously rejected: Thread 'thr_01J9ABC' is archived.",
        "Thread not found: 850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
        "Active run run:thread:aaaf4547-528e-4031-8148-64e7a18d6540:ordinal:6 has ended.",
      ].map(Hands.plainly),
    ).toEqual(["That command was previously rejected: that thread is archived.", "Thread not found.", "The active run has ended."])
    // Names of things, like a model, are said as they are.
    expect(Hands.plainly("Model gpt-6-sol isn't available.")).toBe("Model gpt-6-sol isn't available.")
  })

  test("an unknown outcome not found is offered again, and yes uses the same ids, never new ones", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, again, answering, ids } = yield* hands()
        answering(() => Effect.fail(new Server.Trouble({ reason: "T3 Code is taking too long.", sent: true })))
        const outcome = yield* send("u1", "Use the fee table.")
        answering(takes())
        const resent = yield* again("yapd:u1:0")
        // Worked out again, or a second yes: nothing more goes.
        yield* send("u1", "Use the fee table.")
        yield* again("yapd:u1:0")
        return { outcome: outcome._tag, resent: resent._tag, ids: ids() }
      }),
    )
    expect(result.outcome).toBe("Unknown")
    expect(result.resent).toBe("Done")
    expect(result.ids).toEqual([
      ["yapd:u1:0", "yapd:u1:0:m"],
      ["yapd:u1:0", "yapd:u1:0:m"],
    ])
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
          said: said._tag,
          dispatched: dispatched.length,
        }
      }),
    )
    // The one more time it may go, which offers nothing more.
    expect(result.resent).toBe(false)
    expect(result.third).toBe("NotSent")
    expect(result.restart).toEqual([])
    expect(result.said).toBe("Refused")
    expect(result.dispatched).toBe(2)
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
          unconfirmed: unconfirmed.map(({ commandId }) => commandId),
          states: states.map(Option.getOrNull),
          restart: (yield* ledger.open(0)).map(({ commandId }) => commandId),
          dispatched: dispatched.length,
        }
      }),
    )
    expect(result.dispatched).toBe(0)
    expect(result.undelivered).toEqual(["yapd:u2:0"])
    // The stop that can't be confirmed, and the message too long ago to send again, are said so, never done again.
    expect(result.unconfirmed).toEqual(["yapd:u0:0", "yapd:u3:0"])
    // The old message stays as it may be, so the same words said again are asked about, but it isn't looked at again.
    expect(result.states).toEqual(["unknown", "sent", "unknown", "abandoned"])
    expect(result.restart).toEqual(["yapd:u2:0"])
  })

  test("the same message to a thread that hasn't answered since is confirmed, not dropped", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { send, dispatched } = yield* hands()
        yield* send("u1", "Use the fee table from the Mina work.")
        yield* TestClock.adjust("54 seconds")
        const twin = yield* send("u2", "use the fee table from the Mina work")
        const before = dispatched.length
        // He said yes: it goes, as a step of its own.
        const confirmed = yield* send("u3", "use the fee table from the Mina work", "now", true)
        return { asked: twin._tag, before, confirmed: confirmed._tag, ids: dispatched.map(({ commandId }) => commandId) }
      }),
    )
    expect(result.asked).toBe("Twin")
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

  test("a message for now to a thread whose turn is waiting, which T3 Code won't steer into, or waits on him for something, which steering in would drop, goes in its queue", async () => {
    const waiting = (pending: boolean, status = "waiting") =>
      run(
        Effect.gen(function* () {
          const asking = thread(tezos.id, {
            activeRunId: status === "waiting" ? null : "run-1",
            activityRunStatus: status,
            status,
            pendingRuntimeRequest: pending ? { id: "r1", kind: "command", createdAt: "2026-10-08T21:59:00.000Z" } : null,
          })
          const { send, dispatched } = yield* hands({ thread: asking, runs: [{ id: "run-1", status, ordinal: 1 }] })
          const outcome = yield* send("u1", "Use the Mina fee table.")
          return { outcome: outcome._tag === "Done" ? [outcome.how, outcome.waiting] : outcome._tag, dispatched }
        }),
      )
    const asked = await waiting(true)
    expect(asked.dispatched).toHaveLength(1)
    expect(asked.dispatched[0]).toMatchObject({ type: "message.dispatch", dispatchMode: { type: "queue_after_active" } })
    expect(asked.dispatched[0]).not.toHaveProperty("deliveryIntent")
    expect(asked.outcome).toEqual(["queued", "asked"])
    const finishing = await waiting(false)
    expect(finishing.outcome).toEqual(["queued", "finishing"])
    // As T3 Code shows a turn waiting on a question or an approval: still running, which a message steered in would cancel what it waits on.
    const running = await waiting(true, "running")
    expect(running.dispatched[0]).toMatchObject({ type: "message.dispatch", dispatchMode: { type: "queue_after_active" } })
    expect(running.dispatched[0]).not.toHaveProperty("deliveryIntent")
    expect(running.outcome).toEqual(["queued", "asked"])
  })

  test("a message in place of the turn under way stops it, holding its queue, then tells it once the live view shows it stopped, and never while it's still winding down", async () => {
    const running = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", status: "running" })
    /** The stop shows in the live view two seconds after T3 Code takes it, or never. */
    const restarting = (shows: boolean) =>
      run(
        Effect.gen(function* () {
          const { send, answering, becomes, dispatched } = yield* hands({ thread: running, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
          answering((payload, bounded) => {
            if (payload.type !== "run.interrupt") return takes()(payload, bounded)
            bounded.runs[0]!.status = "interrupted"
            return Effect.succeed({ sequence: 7 })
          })
          const sending = yield* Effect.fork(send("u1", "Drop that and fix the loader instead.", "restart"))
          yield* TestClock.adjust("2 seconds")
          if (shows) becomes(thread(tezos.id, { status: "interrupted" }))
          yield* TestClock.adjust("14 seconds")
          yield* Fiber.join(sending)
          return dispatched.map(({ type, commandId, holdQueue, deliveryIntent }) => [type, commandId, holdQueue ?? deliveryIntent])
        }),
      )
    expect(await restarting(true)).toEqual([
      ["run.interrupt", "yapd:u1:0", true],
      ["message.dispatch", "yapd:u1:1", "auto"],
    ])
    // Still busy fifteen seconds on, it isn't told, since it could still take it into the turn being stopped, or hold it in the queue.
    expect(await restarting(false)).toEqual([["run.interrupt", "yapd:u1:0", true]])
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
        // It worked and finished; "carry on" again, as he missed hearing it, is nothing to do.
        yield* TestClock.adjust("3 minutes")
        becomes(thread(tezos.id, { status: "completed" }))
        yield* act({ utterance: "u3", step: 0 }, { _tag: "Undo", to: Option.none(), carry: true })
        return {
          stopped: stopped._tag,
          carried: carried._tag,
          dispatched: dispatched.map(({ type, commandId, holdQueue, text }) => [type, commandId, holdQueue ?? text]),
        }
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

  test("guards: a restart leaves what this run did alone, and an archived thread is sent nothing", async () => {
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
        return { outcome: outcome._tag, dispatched: dispatched.length }
      }),
    )
    expect(archived).toEqual({ outcome: "Refused", dispatched: 0 })
  })

  test("a message to a thread waiting on a secret, or on a question asking him to type one in, is never sent, and one to a thread asking anything else goes", async () => {
    const asking = (id: string) => thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", pendingRuntimeRequest: { id, kind: "user_input", createdAt: "2026-10-08T21:59:00.000Z" } })
    const result = await run(
      Effect.gen(function* () {
        const { send, becomes, bounded, reads, dispatched } = yield* hands({ thread: asking("turn-item:secret-request:t-tezos:stripe"), runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        bounded.turnItems.push(
          { type: "secret_request", id: "turn-item:secret-request:t-tezos:stripe", status: "waiting", label: "Stripe API key" },
          { type: "user_input_request", status: "waiting", requestId: "q1", questions: [{ id: "key", header: "Question", question: "Paste your OpenAI API key." }] },
          { type: "user_input_request", status: "waiting", requestId: "q2", questions: [{ id: "net", header: "Network", question: "Which network first?", options: [{ label: "Mainnet" }] }] },
        )
        yield* send("u1", "The Stripe key is sk test four two.")
        becomes(asking("q1"))
        yield* send("u2", "The key is sk proj one two three.")
        // Unread, it may be a secret, so it's held back too.
        reads(false)
        yield* send("u3", "The key is sk proj one two three.")
        reads(true)
        becomes(asking("q2"))
        yield* send("u4", "Start with mainnet.")
        return dispatched.map(({ text }) => text)
      }),
    )
    expect(result).toEqual(["Start with mainnet."])
  })

  test("an answer to a question T3 Code takes as a message sends one string per part, and isn't sent with a required part missing", async () => {
    const asking = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", pendingRuntimeRequest: { id: "q1", kind: "user_input", createdAt: "2026-10-08T21:59:00.000Z" } })
    const result = await run(
      Effect.gen(function* () {
        const made = yield* hands({ thread: asking, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        // As Codex asks one in its reply, which T3 Code passes on as a message.
        made.bounded.turnItems.push({
          type: "user_input_request",
          status: "waiting",
          requestId: "q1",
          responseMode: "message",
          questions: [
            { id: "0", header: "Extras", question: "Which test extras should run?", options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }], multiSelect: true },
            { id: "1", header: "Notes", question: "Anything else?" },
          ],
        })
        // A required part missing, it isn't sent.
        yield* made.run({ utterance: "u1", step: 0 }, { _tag: "Reply", to: tezos, requestId: "q1", answers: { "0": ["Alpha", "Gamma"] }, said: Option.some("Alpha and Gamma") })
        yield* made.run(
          { utterance: "u2", step: 0 },
          { _tag: "Reply", to: tezos, requestId: "q1", answers: { "0": ["Alpha", "Gamma"], "1": "Nothing else." }, said: Option.none() },
        )
        return made.dispatched.map(({ answers }) => answers)
      }),
    )
    expect(result).toEqual([{ "0": "Alpha, Gamma", "1": "Nothing else." }])
  })

  test("his own words in one part are refused when they look like a secret, even when another part is an option he picked", async () => {
    const asking = thread(tezos.id, { activeRunId: "run-1", activityRunStatus: "running", pendingRuntimeRequest: { id: "q1", kind: "user_input", createdAt: "2026-10-08T21:59:00.000Z" } })
    const result = await run(
      Effect.gen(function* () {
        const made = yield* hands({ thread: asking, runs: [{ id: "run-1", status: "running", ordinal: 1 }] })
        made.bounded.turnItems.push({
          type: "user_input_request",
          status: "waiting",
          requestId: "q1",
          questions: [
            { id: "build", question: "Which build should I test?", options: [{ label: "Build 202510081" }, { label: "The latest" }] },
            { id: "shown", question: "What does the dialog show?" },
          ],
        })
        const reply = (utterance: string, answers: Readonly<Record<string, string>>) =>
          made.run({ utterance, step: 0 }, { _tag: "Reply", to: tezos, requestId: "q1", answers, said: Option.some("Build 202510081") })
        yield* reply("u1", { build: "Build 202510081", shown: "four two seven one nine three" })
        // An option he picked is never his own words, whatever it looks like.
        yield* reply("u2", { build: "Build 202510081", shown: "A warning about the fees." })
        return made.dispatched.map(({ answers }) => answers)
      }),
    )
    expect(result).toEqual([{ build: "Build 202510081", shown: "A warning about the fees." }])
  })
})

describe("Hands on another machine", () => {
  /** T3 Code on one machine, noting each command it's sent there by its id. */
  const t3 = (name: string, sent: Array<string>): T3Actions.Actions =>
    T3Actions.make(
      Effect.succeed({
        api: (<A, I>(_path: string, schema: Schema.Schema<A, I>) =>
          Schema.decodeUnknown(schema)({ projection: { runs: [], messages: [], turnItems: [] } }).pipe(Effect.orDie)) as Server.Transport["api"],
        call: (<A, I>(_method: string, payload: Record<string, unknown>, schema: Schema.Schema<A, I>) =>
          Effect.sync(() => void sent.push(`${name}: ${String(payload.commandId)}`)).pipe(
            Effect.zipRight(Schema.decodeUnknown(schema)({ sequence: 7 }).pipe(Effect.orDie)),
          )) as Server.Transport["call"],
        asset: () => Effect.die("not expected"),
      }),
    )

  const viewing = (...threads: ReadonlyArray<T3Live.Thread>): T3Live.View => ({
    projects: new Map(),
    threads: new Map(threads.map((thread) => [thread.id, thread])),
    sequence: 1,
    synced: true,
  })

  /** Hands over this machine's T3 Code and rig's, each with a thread under the same id, as nothing stops them having. */
  const both = (rig: { readonly view: Option.Option<T3Live.View>; readonly status: Tunnel.Status }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const store = yield* Store.make(":memory:")
      const ledger = Ledger.fromStore(store)
      const sent: Array<string> = []
      const threads = yield* Threads.make({
        machine: "Rosie",
        live: { view: Effect.succeed(Option.some(viewing(thread(tezos.id)))), changes: Stream.never },
        actions: Option.some(t3("Rosie", sent)),
        others: [{ machine: "rig", live: { view: Effect.succeed(rig.view), changes: Stream.never }, actions: t3("rig", sent), status: Effect.succeed(rig.status) }],
        journal: Journal.fromStore(store),
        store,
      })
      return { hands: Hands.make({ threads, ledger }), ledger, sent }
    })

  const onRig: Threads.Ref = { machine: "rig", id: tezos.id }

  test("a message for a thread on rig goes to rig's T3 Code, never this machine's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { hands, ledger, sent } = yield* both({ view: Option.some(viewing(thread(tezos.id))), status: { _tag: "Up" } })
        const outcome = yield* hands.run({ utterance: "u1", step: 0 }, { _tag: "Message", to: onRig, text: "Add a test.", how: "now" })
        return { outcome: outcome._tag, sent, machine: Option.map(yield* ledger.get("yapd:u1:0"), ({ machine }) => machine) }
      }),
    )
    expect(result).toEqual({ outcome: "Done", sent: ["rig: yapd:u1:0"], machine: Option.some("rig") })
  })

  test("each machine's restart looks at its own steps, and this one's at those on a machine no longer followed, never rig's", () => {
    const followed = ["Rosie", "rig"]
    const mine = Hands.whose("Rosie", "Rosie", followed)
    const rigs = Hands.whose("rig", "Rosie", followed)
    expect(["Rosie", "rig", "laptop"].map(mine)).toEqual([true, false, true])
    expect(["Rosie", "rig", "laptop"].map(rigs)).toEqual([false, true, false])
  })

  test("a restart looks at rig's steps once rig's T3 Code catches up, however long it's away, where this one's gives up after a while", async () => {
    const result = await run(
      Effect.gen(function* () {
        const looked: Array<string> = []
        const hands = {
          reconcileOn: (on: (machine: string) => boolean) =>
            Effect.sync((): Hands.Reconciled => {
              looked.push(...["Rosie", "rig"].filter(on))
              return { undelivered: [], unconfirmed: [], readying: Effect.succeed([]) }
            }),
        }
        let up = false
        const view = Effect.sync(() => (up ? Option.some({}) : Option.none()))
        const followed = ["Rosie", "rig"]
        // Asked about once a minute, so an hour goes by quickly.
        const rig = yield* Effect.fork(Hands.lookBack(hands, view, "rig", "Rosie", followed, "1 minute"))
        const mine = yield* Effect.fork(Effect.flip(Hands.lookBack(hands, view, "Rosie", "Rosie", followed, "1 minute")))
        // Rig asleep for an hour, and T3 Code here closed all along.
        yield* TestClock.adjust("1 hour")
        up = true
        yield* TestClock.adjust("1 minute")
        yield* Fiber.join(rig)
        return { mine: yield* Fiber.join(mine), looked }
      }),
    )
    expect(result).toEqual({ mine: "T3 Code didn't catch up in time", looked: ["rig"] })
  })
})
