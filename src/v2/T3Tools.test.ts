import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as Hands from "../Hands.ts"
import * as Launcher from "../Launcher.ts"
import * as Ledger from "../Ledger.ts"
import * as Store from "../Store.ts"
import * as T3Actions from "../T3Actions.ts"
import * as Server from "../T3CodeServer.ts"
import * as T3Live from "../T3Live.ts"
import * as Threads from "../Threads.ts"
import { createT3Tools, type T3ToolOptions } from "./T3Tools.ts"
import { SupersededError, type ToolContext } from "./Types.ts"

const to: Threads.Ref = { machine: "rig", id: "thread-asr" }
const target = { machine: to.machine, threadId: to.id }
const currentThread = () => Schema.decodeUnknownSync(T3Live.Thread)({
  id: to.id, projectId: "project-asr", title: "French ASR tests",
  modelSelection: { instanceId: "codex", model: "configured-model" },
  status: "completed", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
})

const context = (overrides: Partial<ToolContext> = {}): ToolContext => {
  let made: ToolContext
  made = {
    conversationId: "conversation", turnId: "turn-1", revision: 1, invocationId: crypto.randomUUID(),
    userText: "Run only the French tests; do not merge.", source: "voice", signal: new AbortController().signal,
    focus: to, isCurrent: () => true, canWrite: () => true,
    assertCurrent: () => { if (!made.isCurrent()) throw new SupersededError() },
    waitForWrite: async () => { if (!made.canWrite()) throw new SupersededError() },
    ...overrides,
  }
  return made
}

interface Projection {
  runs: Array<{ id: string; status: string; ordinal: number; userMessageId?: string; queueHeld?: boolean }>
  messages: Array<{ id: string; role: string; text: string; createdAt: string; runId?: string }>
  turnItems: Array<Record<string, unknown>>
  runtimeRequests: Array<{ id: string; status: string }>
}

const fixture = (store: Store.Store["Type"]) => {
  const ledger = Ledger.fromStore(store)
  let thread = currentThread()
  const projection: Projection = { runs: [], messages: [], turnItems: [], runtimeRequests: [] }
  const commands: Array<Record<string, unknown>> = []
  const launches: Array<Launcher.Request> = []
  let failure: Server.Trouble | Server.Refusal | undefined
  let beforeDispatch: ((payload: Record<string, unknown>) => void) | undefined
  let launchFailure: Launcher.LaunchError | undefined
  let readFailure = false

  const transport: Server.Transport = {
    api: (<A, I>(_path: string, schema: Schema.Schema<A, I>) => readFailure
      ? Effect.fail(new Server.Trouble({ reason: "Thread cannot be read." }))
      : Schema.decodeUnknown(schema)({ projection }).pipe(Effect.orDie)) as Server.Transport["api"],
    call: (<A, I>(method: string, payload: Record<string, unknown>, schema: Schema.Schema<A, I>) => Effect.suspend(() => {
      if (method === "orchestration.searchThreads") return Schema.decodeUnknown(schema)({ matches: [{
        threadId: to.id, projectId: "project-asr", source: "message", snippet: "French recognition tests", messageCreatedAt: null,
      }] }).pipe(Effect.orDie)
      if (method !== "orchestration.dispatchCommand") return Effect.die(`Unexpected method ${method}`)
      commands.push(payload)
      beforeDispatch?.(payload)
      if (failure !== undefined) return Effect.fail(failure)
      if (payload.type === "message.dispatch") {
        const runId = `run-${projection.runs.length + 1}`
        const queued = (payload.dispatchMode as { type: string }).type === "queue_after_active"
        projection.messages.push({ id: String(payload.messageId), role: "user", text: String(payload.text), createdAt: new Date().toISOString(), runId })
        projection.runs.push({ id: runId, status: queued ? "queued" : "running", ordinal: projection.runs.length + 1, userMessageId: String(payload.messageId) })
        projection.turnItems.push({ type: "user_message", messageId: payload.messageId, inputIntent: queued ? "queued_turn" : "turn_start", runId })
      }
      if (payload.type === "runtime-request.respond") {
        const pending = projection.runtimeRequests.find(({ id }) => id === payload.requestId)
        if (pending !== undefined) pending.status = "resolved"
        thread = { ...thread, pendingRuntimeRequest: null }
      }
      if (payload.type === "run.interrupt") {
        const stopped = projection.runs.find(({ id }) => id === payload.runId)
        if (stopped !== undefined) stopped.status = "interrupted"
      }
      return Schema.decodeUnknown(schema)({ sequence: commands.length }).pipe(Effect.orDie)
    })) as Server.Transport["call"],
    asset: () => Effect.die("No asset requested"),
  }
  const actions = T3Actions.make(Effect.succeed(transport))
  const threads: T3ToolOptions["threads"] = {
    desk: () => Effect.succeed({ threads: [{
      handle: "t1", ref: to, here: true, called: thread.title, project: "asr", scratch: false,
      directory: Option.some("/projects/asr"), thread, state: "idle", since: 0,
      started: Option.none(), last: Option.none(), brief: false,
    }], away: [{ machine: "offline", reason: "Connection unavailable" }] }),
    find: (ref) => Effect.sync(() => ref.machine === to.machine && ref.id === to.id ? Option.some(thread) : Option.none()),
    unseen: () => Effect.succeedNone,
    detail: (ref, pending) => actions.detail(ref.id, pending).pipe(Effect.mapError((error) => new Threads.ThreadsError({ reason: error.reason }))),
    search: (query) => actions.search(query).pipe(
      Effect.map((matches) => ({ matches: matches.map(({ threadId, snippet }) => ({ ref: { machine: to.machine, id: threadId }, snippet })), missed: ["offline"] })),
      Effect.mapError((error) => new Threads.ThreadsError({ reason: error._tag === "Trouble" ? error.reason : error.message })),
    ),
    waiting: (_ref, requestId) => Effect.sync(() => projection.runtimeRequests.some(({ id, status }) => id === requestId && status === "pending")),
    keep: () => Effect.void,
  }
  const hands = Hands.make({
    threads: { find: threads.find, unseen: threads.unseen, actions: (machine) => machine === to.machine ? Option.some(actions) : Option.none() }, ledger,
  })
  const launcher: Launcher.Launcher = {
    catalog: Effect.succeed({ projects: [{ name: "asr", path: "/projects/asr", repository: true, branch: "dev", worktree: false, recent: [] }], models: [{ name: "configured-model", title: "Configured model", aliases: [], efforts: ["high"] }] }),
    start: (request) => Effect.suspend(() => {
      launches.push(request)
      return launchFailure === undefined
        ? Effect.succeed({ thread: request.ids!.thread, project: request.project, directory: "/projects/asr", branch: "dev", model: request.model ?? "configured-model", worktree: request.worktree ?? false })
        : Effect.fail(launchFailure)
    }),
  }
  const options: T3ToolOptions = { threads, hands, ledger, launchers: new Map([[to.machine, launcher]]), transport: (machine) => machine === to.machine ? Effect.succeed(transport) : undefined }
  const call = async (name: string, args: unknown, ctx = context(), made = createT3Tools(options)) => {
    const selected = made.find((tool) => tool.name === name)
    if (selected === undefined) throw new Error(`Missing tool ${name}`)
    return await selected.execute(args, ctx) as Record<string, unknown>
  }
  return {
    ledger, projection, commands, launches, options, call,
    fail: (next: Server.Trouble | Server.Refusal | undefined) => { failure = next },
    failLaunch: (next: Launcher.LaunchError) => { launchFailure = next },
    beforeDispatch: (next: (payload: Record<string, unknown>) => void) => { beforeDispatch = next },
    failReads: () => { readFailure = true },
    running: (id: string) => {
      projection.runs.push({ id, status: "running", ordinal: projection.runs.length + 1 })
      thread = { ...thread, activeRunId: id, latestRunId: id, activityRunStatus: "running", status: "running" }
    },
    request: (id: string, type: "approval_request" | "user_input_request" | "secret_request", extra: Record<string, unknown> = {}) => {
      projection.turnItems.push({ type, id, requestId: id, status: "pending", ...extra })
      projection.runtimeRequests.push({ id, status: "pending" })
      thread = { ...thread, pendingRuntimeRequest: { id, kind: type === "user_input_request" ? "user_input" : "approval", createdAt: new Date().toISOString() } }
    },
    resolve: (id: string) => {
      const found = projection.runtimeRequests.find((request) => request.id === id)
      if (found !== undefined) found.status = "resolved"
      thread = { ...thread, pendingRuntimeRequest: null }
    },
  }
}

const runFixture = (work: (made: ReturnType<typeof fixture>) => Promise<void>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const store = yield* Store.make(":memory:")
  yield* Effect.promise(() => work(fixture(store)))
})))

describe("V2 T3 tool catalog", () => {
  test("search, read, and send use returned stable IDs and feed JSON-ready actual outcomes", () => runFixture(async (h) => {
    const listed = await h.call("list_threads", {})
    expect(listed.unreachableMachines).toEqual([{ machine: "offline", reason: "Connection unavailable" }])
    const found = await h.call("search_threads", { query: "French tests" })
    expect(found.missedMachines).toEqual(["offline"])
    const { machine, threadId } = (found.matches as Array<{ machine: string; threadId: string }>)[0]!
    const match = { machine, threadId }
    const read = await h.call("read_thread", match)
    expect(read.request).toBeNull()
    expect(read.plan).toBeNull()
    expect(JSON.parse(JSON.stringify(read))).toEqual(read)
    expect("resolved" in read).toBe(false)
    const ctx = context()
    const sent = await h.call("send_message", { ...match, text: ctx.userText }, ctx)
    expect(sent.status).toBe("accepted")
    expect(sent.delivery).toBe("now")
    expect(h.projection.messages.map(({ text }) => text)).toEqual([ctx.userText])
    expect(h.commands[0]).toMatchObject({ threadId: to.id, type: "message.dispatch", commandId: `yapd:v2:${ctx.invocationId}:0`, messageId: `yapd:v2:${ctx.invocationId}:0:m` })
    const row = await Effect.runPromise(h.ledger.get(String(sent.commandId)))
    expect(Option.getOrThrow(row).state).toBe("sent")
    expect(sent.workEnded).toBeNull()
  }))

  test("queued delivery survives adapter recreation without resending or retargeting an invocation", () => runFixture(async (h) => {
    h.running("active")
    const ctx = context()
    const args = { ...target, text: "Run the French tests after this.", how: "after" }
    const first = await h.call("send_message", args, ctx)
    expect(first).toMatchObject({ status: "accepted", delivery: "queued" })
    const replay = await h.call("send_message", args, ctx, createT3Tools(h.options))
    expect(replay).toMatchObject({ status: "accepted", delivery: "queued", replay: true })
    expect(h.commands).toHaveLength(1)
    expect(await h.call("send_message", { ...args, threadId: "another" }, ctx)).toMatchObject({ status: "refused" })
    expect(await h.call("send_message", { ...args, text: "Merge instead." }, ctx)).toMatchObject({ status: "refused" })
    expect(h.commands).toHaveLength(1)
  }))

  test("lost send acknowledgement stays unknown and is not retried automatically", () => runFixture(async (h) => {
    h.fail(new Server.Trouble({ reason: "Connection lost after dispatch.", sent: true }))
    const ctx = context()
    const args = { ...target, text: "Run only French tests." }
    expect(await h.call("send_message", args, ctx)).toMatchObject({ status: "unknown" })
    h.fail(undefined)
    expect(await h.call("send_message", args, ctx, createT3Tools(h.options))).toMatchObject({ status: "unknown", replay: true })
    expect(h.commands).toHaveLength(1)
    expect(h.projection.messages).toHaveLength(0)
  }))

  test("voice yes cannot approve, explicit approval reaches the real pending request, and changed decisions do not replay", () => runFixture(async (h) => {
    h.request("approval-1", "approval_request", { prompt: "Run the test command?", options: [{ decision: "accept", label: "Allow" }, { decision: "decline", label: "Deny" }] })
    const args = { ...target, requestId: "approval-1", decision: "accept" }
    expect(await h.call("respond_to_approval", args, context({ userText: "Yes." }))).toMatchObject({ status: "refused" })
    expect(h.commands).toHaveLength(0)
    const ctx = context({ userText: "I approve running those tests." })
    expect(await h.call("respond_to_approval", args, ctx)).toMatchObject({ status: "accepted" })
    expect(h.commands[0]).toMatchObject({ type: "runtime-request.respond", requestId: "approval-1", decision: "accept" })
    expect(await h.call("respond_to_approval", { ...args, decision: "decline" }, ctx)).toMatchObject({ status: "refused" })
    expect(h.commands).toHaveLength(1)
  }))

  test("stale pending requests and the generic message path cannot bypass approval", () => runFixture(async (h) => {
    h.request("approval-1", "approval_request")
    expect(await h.call("send_message", { ...target, text: "Approve it." })).toMatchObject({ status: "pending_approval" })
    h.resolve("approval-1")
    expect(await h.call("respond_to_approval", { ...target, requestId: "approval-1", decision: "accept" }, context({ userText: "Approve." }))).toMatchObject({ status: "no_longer_pending" })
    expect(h.commands).toHaveLength(0)
  }))

  test("an identical approval already acknowledged is attributed to its original receipt", () => runFixture(async (h) => {
    h.request("approval-1", "approval_request")
    const args = { ...target, requestId: "approval-1", decision: "accept" }
    const first = await h.call("respond_to_approval", args, context({ userText: "Approve." }))
    // The server's pending view can lag an acknowledgment; Hands deliberately reuses its earlier receipt.
    h.request("approval-1", "approval_request")
    const second = await h.call("respond_to_approval", args, context({ userText: "Approve." }))
    expect(second).toMatchObject({ status: "accepted", commandId: first.commandId, receiptPersisted: true })
    expect(h.commands).toHaveLength(1)
  }))

  test("secret input is handed off without sending the supplied words", () => runFixture(async (h) => {
    h.request("turn-item:secret-request:1", "secret_request", { label: "API credential" })
    expect(await h.call("send_message", { ...target, text: "The credential is a-private-value." })).toMatchObject({ status: "requires_secret", requestId: "turn-item:secret-request:1" })
    expect(await h.call("answer_question", { ...target, requestId: "turn-item:secret-request:1", answers: { value: "a-private-value" } })).toMatchObject({ status: "requires_secret" })
    expect(h.commands).toHaveLength(0)
    expect(h.projection.messages).toHaveLength(0)
  }))

  test("question choices are validated and sent under actual question IDs and option values", () => runFixture(async (h) => {
    h.request("question-1", "user_input_request", { questions: [{ id: "language", question: "Which language?", options: [{ label: "French", value: "fr", description: "French tests" }], allowCustomAnswer: false }] })
    const args = { ...target, requestId: "question-1", answers: { language: "fr" } }
    expect(await h.call("answer_question", { ...args, answers: { language: "Spanish" } })).toMatchObject({ status: "refused" })
    expect(await h.call("answer_question", { ...args, answers: { unknown: "fr" } })).toMatchObject({ status: "refused" })
    expect(await h.call("answer_question", args)).toMatchObject({ status: "accepted" })
    expect(h.commands[0]).toMatchObject({ type: "runtime-request.respond", requestId: "question-1", answers: { language: "fr" } })
    expect(h.commands).toHaveLength(1)
  }))

  test("a request superseded during Hands preflight cannot dispatch", () => runFixture(async (h) => {
    let waits = 0
    let current = true
    const ctx = context({
      isCurrent: () => current, canWrite: () => current,
      waitForWrite: async () => { if (++waits > 1) { current = false; throw new SupersededError() } },
    })
    expect(await h.call("send_message", { ...target, text: "Keep the API unchanged." }, ctx)).toMatchObject({ status: "not_sent" })
    expect(h.commands).toHaveLength(0)
  }))

  test("stop dispatch remains pinned even if a new run starts during the request", () => runFixture(async (h) => {
    h.running("original-run")
    h.beforeDispatch((payload) => { if (payload.type === "run.interrupt") h.running("replacement-run") })
    expect(await h.call("stop_run", { ...target, runId: "original-run" })).toMatchObject({ status: "accepted", runId: "original-run" })
    expect(h.commands[0]).toMatchObject({ type: "run.interrupt", runId: "original-run", holdQueue: true })
    expect(h.projection.runs.find(({ id }) => id === "original-run")?.status).toBe("interrupted")
    expect(h.projection.runs.find(({ id }) => id === "replacement-run")?.status).toBe("running")
    expect(await h.call("stop_run", { ...target, runId: "original-run" })).toMatchObject({ status: "refused" })
    expect(h.commands).toHaveLength(1)
  }))

  test("stop needs pinned transport and preserves unknown versus refused receipts", () => runFixture(async (h) => {
    h.running("run-1")
    const { transport: _transport, ...withoutTransport } = h.options
    expect(await h.call("stop_run", { ...target, runId: "run-1" }, context(), createT3Tools(withoutTransport))).toMatchObject({ status: "unavailable" })
    h.fail(new Server.Trouble({ reason: "Lost after sending stop.", sent: true }))
    const ctx = context()
    expect(await h.call("stop_run", { ...target, runId: "run-1" }, ctx)).toMatchObject({ status: "unknown" })
    h.fail(undefined)
    expect(await h.call("stop_run", { ...target, runId: "run-1" }, ctx)).toMatchObject({ status: "unknown", replay: true })
    expect(h.commands).toHaveLength(1)
    h.fail(new Server.Refusal({ tag: "NotInterruptible", message: "Run is no longer interruptible." }))
    expect(await h.call("stop_run", { ...target, runId: "run-1" })).toMatchObject({ status: "refused" })
  }))

  test("new work uses catalog defaults and persistent IDs and does not restart on replay", () => runFixture(async (h) => {
    const projects = await h.call("list_projects", { machine: "rig" })
    expect((projects.projects as Array<{ name: string }>)[0]?.name).toBe("asr")
    const ctx = context()
    const args = { machine: "rig", project: "asr", prompt: "Investigate French token errors.", worktree: true }
    const started = await h.call("start_thread", args, ctx)
    expect(started.status).toBe("accepted")
    const request = h.launches[0]!
    expect(request.ids).toEqual({ thread: String(started.threadId), command: `yapd:v2:${ctx.invocationId}:0`, message: `yapd:v2:${ctx.invocationId}:0:m` })
    expect(request.worktree).toBe(true)
    expect(await h.call("start_thread", args, ctx, createT3Tools(h.options))).toMatchObject({ status: "accepted", replay: true })
    expect(h.launches).toHaveLength(1)
    expect(await h.call("start_thread", { ...args, project: "different" }, ctx)).toMatchObject({ status: "refused" })
    expect(await h.call("start_thread", { ...args, worktree: false }, ctx)).toMatchObject({ status: "refused" })
  }))

  test("a false onset after launch preparation pauses and then releases the original request", () => runFixture(async (h) => {
    const suspended = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const ctx = context({ waitForWrite: async () => {
      if (++calls === 2) { suspended.resolve(); await release.promise }
    } })
    const launching = h.call("start_thread", { machine: "rig", project: "asr", prompt: "Run French tests." }, ctx)
    await suspended.promise
    const prepared = Option.getOrThrow(await Effect.runPromise(h.ledger.get(`yapd:v2:${ctx.invocationId}:0`)))
    expect(prepared.state).toBe("prepared")
    expect(h.launches).toHaveLength(0)
    release.resolve()
    expect(await launching).toMatchObject({ status: "accepted", receiptPersisted: true })
    expect(h.launches).toHaveLength(1)
  }))

  test("unknown launches do not retry, and malformed arguments never reach execution", () => runFixture(async (h) => {
    h.failLaunch(new Launcher.LaunchError({ reason: "Disconnected after launch request.", sent: true }))
    const ctx = context()
    const args = { machine: "rig", project: "asr", prompt: "Inspect the French tests." }
    expect(await h.call("start_thread", args, ctx)).toMatchObject({ status: "unknown" })
    expect(await h.call("start_thread", args, ctx)).toMatchObject({ status: "unknown", replay: true })
    expect(h.launches).toHaveLength(1)
    expect(await h.call("send_message", { ...target, text: "Run tests", decision: "accept" })).toMatchObject({ status: "invalid_arguments" })
    expect(await h.call("send_message", { text: "Run tests" })).toMatchObject({ status: "invalid_arguments" })
    expect(h.commands).toHaveLength(0)
  }))
})
