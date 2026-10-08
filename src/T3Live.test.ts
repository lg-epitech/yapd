import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Fiber, Option, Redacted, Stream, TestClock, TestContext } from "effect"
import * as T3Live from "./T3Live.ts"

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: "t1",
  projectId: "p1",
  title: "Fix the loader",
  branch: "t3code/abc",
  worktreePath: null,
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  activeRunId: null,
  activityRunStatus: null,
  status: "idle",
  pendingRuntimeRequest: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  // What T3 Code sends that yapd doesn't use is let through.
  itemCount: 4,
  ...overrides,
})

const project = { id: "p1", title: "yapd", workspaceRoot: "/code/yapd", scripts: [] }

const snapshot = (sequence: number, threads: ReadonlyArray<object>) => ({
  kind: "snapshot" as const,
  snapshot: { snapshotSequence: sequence, projects: [project], threads, archivedThreads: [] },
})

/** Runs items through, keeping what changed. */
const run = (items: ReadonlyArray<unknown>, view = T3Live.empty) => {
  const changes: Array<T3Live.Change> = []
  for (const item of items) {
    const applied = T3Live.apply(view, item as Parameters<typeof T3Live.apply>[1])
    view = applied.view
    changes.push(...applied.changes)
  }
  return { view, changes: changes.map((change) => change._tag) }
}

describe("T3Live.apply", () => {
  test("takes a snapshot as history, and what follows the catch-up as news", () => {
    const { view, changes } = run([
      snapshot(10, [thread()]),
      { kind: "synchronized" },
      { kind: "thread.updated", sequence: 11, location: "active", thread: thread({ activeRunId: "r1", activityRunStatus: "running" }) },
      {
        kind: "thread.updated",
        sequence: 12,
        location: "active",
        thread: thread({ activeRunId: "r1", activityRunStatus: "running", pendingRuntimeRequest: { id: "q1", kind: "user_input", createdAt: "x" } }),
      },
      { kind: "thread.updated", sequence: 13, location: "active", thread: thread({ activeRunId: "r1", activityRunStatus: "running" }) },
      { kind: "thread.updated", sequence: 14, location: "active", thread: thread({ title: "Fix the config loader", status: "completed" }) },
      { kind: "thread.updated", sequence: 15, location: "active", thread: thread({ id: "t2", activeRunId: "r9", activityRunStatus: "preparing" }) },
      { kind: "thread.removed", sequence: 16, location: "active", threadId: "t1" },
    ])
    expect(changes).toEqual(["Started", "Asked", "Answered", "Renamed", "Finished", "Created", "Started", "Removed"])
    expect([...view.threads.keys()]).toEqual(["t2"])
    expect(view.sequence).toBe(16)
  })

  test("goes from one run straight into the next", () => {
    const { changes } = run([
      snapshot(1, [thread({ activeRunId: "r1", activityRunStatus: "running" })]),
      { kind: "synchronized" },
      { kind: "thread.updated", sequence: 2, location: "active", thread: thread({ activeRunId: "r2", activityRunStatus: "starting" }) },
    ])
    expect(changes).toEqual(["Finished", "Started"])
  })

  test("skips what it already has, like what's replayed after a reconnect", () => {
    const { changes, view } = run([
      snapshot(5, [thread()]),
      { kind: "synchronized" },
      { kind: "thread.updated", sequence: 4, location: "active", thread: thread({ title: "Old news" }) },
    ])
    expect(changes).toEqual([])
    expect(view.threads.get("t1")?.title).toBe("Fix the loader")
  })

  test("lets a snapshot that only fills in repositories patch the projects, and keep the threads", () => {
    const { view } = run([
      snapshot(5, [thread()]),
      { ...snapshot(5, []), snapshot: { snapshotSequence: 5, projects: [{ ...project, title: "yapd!" }], threads: [] }, resolvedRepositoryIdentityRoots: ["/code/yapd"] },
      { kind: "synchronized" },
    ])
    expect(view.threads.size).toBe(1)
    expect(view.projects.get("p1")?.title).toBe("yapd!")
  })

  test("compares a whole new snapshot with what it knew, so nothing that happened meanwhile is missed", () => {
    const before = run([snapshot(5, [thread(), thread({ id: "t2" })]), { kind: "synchronized" }]).view
    const { changes } = run(
      [snapshot(50, [thread({ pendingRuntimeRequest: { id: "a1", kind: "command", createdAt: "x" } }), thread({ id: "t3" })]), { kind: "synchronized" }],
      before,
    )
    expect(changes).toEqual(["Asked", "Created", "Removed"])
  })

  test("leaves out a thread whose shape it doesn't know, rather than the whole snapshot", () => {
    const { view } = run([snapshot(1, [thread(), { id: "broken" }]), { kind: "synchronized" }])
    expect([...view.threads.keys()]).toEqual(["t1"])
  })
})

/** A T3 Code that a test talks for. */
const fake = () => {
  const sockets: Array<{ sent: Array<Record<string, unknown>>; emit: (event: Parameters<Parameters<ReturnType<T3Live.Dial>["events"]>[0]>[0]) => void; closed: boolean }> = []
  const dial: T3Live.Dial = () => {
    const socket = { sent: [] as Array<Record<string, unknown>>, emit: (_: never) => {}, closed: false }
    sockets.push(socket as never)
    return {
      send: (data) => void socket.sent.push(JSON.parse(data)),
      close: () => {
        socket.closed = true
      },
      events: (listener) => {
        socket.emit = listener as never
      },
    }
  }
  return { sockets, dial }
}

const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

describe("T3Live.follow", () => {
  test("acks each chunk, reports what changes, and picks up where it left off after a drop", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { sockets, dial } = fake()
        const live = yield* T3Live.follow(Redacted.make("token"), Effect.succeed({ origin: "http://127.0.0.1:3774" }), dial)
        const changes = yield* live.changes.pipe(Stream.take(1), Stream.runCollect, Effect.fork)
        yield* flush
        const first = sockets[0]!
        first.emit({ _tag: "Open" })
        yield* flush
        expect(first.sent[0]).toMatchObject({ _tag: "Request", tag: "orchestration.subscribeShell", payload: { requestCompletionMarker: true }, headers: [] })
        expect(first.sent[0]?.payload).not.toHaveProperty("afterSequence")

        first.emit({ _tag: "Message", data: JSON.stringify({ _tag: "Chunk", requestId: "shell", values: [snapshot(7, [thread()])] }) })
        first.emit({ _tag: "Message", data: JSON.stringify({ _tag: "Chunk", requestId: "shell", values: [{ kind: "synchronized" }] }) })
        yield* flush
        expect(first.sent.filter(({ _tag }) => _tag === "Ack")).toHaveLength(2)
        expect(Option.map(yield* live.view, (view) => view.threads.size)).toEqual(Option.some(1))

        first.emit({
          _tag: "Message",
          data: JSON.stringify({
            _tag: "Chunk",
            requestId: "shell",
            values: [{ kind: "thread.updated", sequence: 8, location: "active", thread: thread({ activeRunId: "r1", activityRunStatus: "running" }) }],
          }),
        })
        expect(Chunk.toArray(yield* Fiber.join(changes)).map(({ _tag }) => _tag)).toEqual(["Started"])

        first.emit({ _tag: "Closed", reason: "gone" })
        yield* flush
        expect(Option.isNone(yield* live.view)).toBe(true)
        yield* TestClock.adjust("1 second")
        yield* flush
        const second = sockets[1]!
        second.emit({ _tag: "Open" })
        yield* flush
        expect(second.sent[0]).toMatchObject({ payload: { afterSequence: 8 } })
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

  test("pings while it's quiet, and gives up on a connection that stops answering", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { sockets, dial } = fake()
        yield* T3Live.follow(Redacted.make("token"), Effect.succeed({ origin: "http://127.0.0.1:3774" }), dial)
        yield* flush
        sockets[0]!.emit({ _tag: "Open" })
        yield* flush
        for (let tick = 0; tick < 3; tick++) {
          yield* TestClock.adjust("5 seconds")
          yield* flush
        }
        expect(sockets[0]!.sent.filter(({ _tag }) => _tag === "Ping")).toHaveLength(3)
        yield* TestClock.adjust("5 seconds")
        yield* flush
        expect(sockets[0]!.closed).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))
})
