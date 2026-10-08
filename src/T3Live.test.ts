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

  test("tells of a run that came and went between two looks, once", () => {
    const failed = { latestRunId: "r2", latestRunCompletedAt: "2026-10-08T01:00:00.000Z", status: "failed", lastError: "Usage limit reached" }
    const unseen = run([
      snapshot(1, [thread({ latestRunId: "r1", latestRunCompletedAt: "2026-10-08T00:00:00.000Z" })]),
      { kind: "synchronized" },
      { kind: "thread.updated", sequence: 2, location: "active", thread: thread(failed) },
      // Nothing new about it after, however often it's sent again.
      { kind: "thread.updated", sequence: 3, location: "active", thread: thread(failed) },
    ])
    expect(unseen.changes).toEqual(["Finished"])
    const seen = run([
      snapshot(1, [thread({ activeRunId: "r2", latestRunId: "r2", activityRunStatus: "running" })]),
      { kind: "synchronized" },
      { kind: "thread.updated", sequence: 2, location: "active", thread: thread(failed) },
    ])
    expect(seen.changes).toEqual(["Finished"])
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

  test("keeps telling what changed after a whole new snapshot, even if the connection that sent it dropped before catching up", () => {
    const before = run([snapshot(5, [thread()]), { kind: "synchronized" }]).view
    const { changes } = run(
      [
        snapshot(50, [thread()]),
        // The next connection picks up from the snapshot.
        { kind: "thread.updated", sequence: 51, location: "active", thread: thread({ pendingRuntimeRequest: { id: "q1", kind: "user_input", createdAt: "x" } }) },
      ],
      before,
    )
    expect(changes).toEqual(["Asked"])
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

  test("only counts as following again once a new connection has caught up, and keeps trying when a socket can't be used", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { sockets, dial } = fake()
        const live = yield* T3Live.follow(Redacted.make("token"), Effect.succeed({ origin: "http://127.0.0.1:3774" }), dial)
        yield* flush
        sockets[0]!.emit({ _tag: "Open" })
        sockets[0]!.emit({ _tag: "Message", data: JSON.stringify({ _tag: "Chunk", requestId: "shell", values: [snapshot(7, [thread()]), { kind: "synchronized" }] }) })
        yield* flush
        sockets[0]!.emit({ _tag: "Closed", reason: "gone" })
        yield* flush
        yield* TestClock.adjust("2 seconds")
        yield* flush
        sockets[1]!.emit({ _tag: "Open" })
        sockets[1]!.emit({
          _tag: "Message",
          data: JSON.stringify({ _tag: "Chunk", requestId: "shell", values: [{ kind: "thread.updated", sequence: 8, location: "active", thread: thread({ title: "Renamed" }) }] }),
        })
        yield* flush
        const beforeMarker = Option.isSome(yield* live.view)
        sockets[1]!.emit({ _tag: "Message", data: JSON.stringify({ _tag: "Chunk", requestId: "shell", values: [{ kind: "synchronized" }] }) })
        yield* flush
        const afterMarker = Option.isSome(yield* live.view)
        return { beforeMarker, afterMarker }
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ).then(({ beforeMarker, afterMarker }) => {
      expect(beforeMarker).toBe(false)
      expect(afterMarker).toBe(true)
    }))

  test("connects again when T3 Code says the connection broke, even while it still answers pings", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { sockets, dial } = fake()
        const live = yield* T3Live.follow(Redacted.make("token"), Effect.succeed({ origin: "http://127.0.0.1:3774" }), dial)
        yield* flush
        sockets[0]!.emit({ _tag: "Open" })
        sockets[0]!.emit({ _tag: "Message", data: JSON.stringify({ _tag: "Chunk", requestId: "shell", values: [snapshot(7, [thread()]), { kind: "synchronized" }] }) })
        yield* flush
        sockets[0]!.emit({ _tag: "Message", data: JSON.stringify({ _tag: "Defect", defect: "boom" }) })
        sockets[0]!.emit({ _tag: "Message", data: JSON.stringify({ _tag: "Pong" }) })
        yield* flush
        const stale = Option.isSome(yield* live.view)
        yield* TestClock.adjust("2 seconds")
        yield* flush
        return { stale, closed: sockets[0]!.closed, dialed: sockets.length }
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ).then(({ stale, closed, dialed }) => {
      expect(stale).toBe(false)
      expect(closed).toBe(true)
      expect(dialed).toBe(2)
    }))

  test("tries again when a socket throws instead of sending", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let dials = 0
        const dial: T3Live.Dial = () => {
          dials++
          return {
            send: () => {
              throw new Error("WebSocket is not open")
            },
            close: () => {},
            events: (listener) => listener({ _tag: "Open" }),
          }
        }
        yield* T3Live.follow(Redacted.make("token"), Effect.succeed({ origin: "http://127.0.0.1:3774" }), dial)
        yield* flush
        yield* TestClock.adjust("5 seconds")
        yield* flush
        return dials
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ).then((dials) => expect(dials).toBeGreaterThan(1)))
})
