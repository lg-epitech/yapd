import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Chunk, Effect, Exit, Fiber, Scope, Stream, TestClock, TestContext } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CodexServer from "./CodexServer.ts"

// Each test starts real processes.
setDefaultTimeout(15_000)

/**
 * Stands in for the codex CLI, run as a script. It lists MCP servers, or serves
 * the app-server's JSON-RPC, and records how it was started and every request.
 */
const fakeCodex = async () => {
  const [log = "", mode = "", ...args] = process.argv.slice(2)
  const { appendFileSync, existsSync, readFileSync } = require("node:fs") as typeof import("node:fs")
  const record = (entry: object) => appendFileSync(log, `${JSON.stringify(entry)}\n`)
  if (mode === "malformed-idle") process.on("SIGTERM", () => record({ stopping: process.pid }))
  // An older Codex exits on a feature it doesn't know.
  const old = mode === "old" && args.includes("apps")
  if (args.includes("mcp")) {
    if (old) process.exit(1)
    if (mode === "unlisted") process.exit(1)
    if (mode === "stuck") {
      record({ listing: process.pid })
      setInterval(() => {}, 1000)
      return
    }
    console.log(
      JSON.stringify([
        { name: "linear", enabled: true, transport: { type: "streamable_http" } },
        { name: "computer-use", enabled: false },
        { name: "odd.name", enabled: true },
      ]),
    )
    process.exit(0)
  }
  // Only the first server crashes.
  const crashes = mode === "crash" && !(existsSync(log) && readFileSync(log, "utf8").includes("launched"))
  record({ launched: args, pid: process.pid })
  if (old) process.exit(1)
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const later = (action: () => void) => setTimeout(action, 300)
  if (mode === "close-stdin" || mode === "stall-stdin") {
    const { readSync } = require("node:fs") as typeof import("node:fs")
    const byte = Buffer.alloc(1)
    let line = ""
    while (readSync(0, byte, 0, 1, null) > 0) {
      if (byte[0] !== 10) { line += byte.toString(); continue }
      const { id, method, params } = JSON.parse(line)
      line = ""
      if (id === undefined) continue
      record({ method, params })
      if (method === "initialize") send({ id, result: {} })
      else if (method === "thread/start") { send({ id, result: { thread: { id: "thread-1" } } }); break }
    }
    setInterval(() => {}, 1000)
    if (mode === "close-stdin") setTimeout(() => process.exit(1), 100)
    return
  }
  let threads = 0
  let turns = 0
  let lateThread: object | undefined
  const held: string[] = []
  /** The message as the model writes it, four characters at a time. */
  const write = (threadId: string, turnId: string, text: string) => {
    for (const delta of text.match(/.{1,4}/gs) ?? []) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: `message-${threadId}`, delta } })
    }
  }
  const complete = (threadId: string) => {
    const text = JSON.stringify({ thread: threadId })
    write(threadId, "turn", text)
    send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text } } })
    send({ method: "turn/completed", params: { threadId, turn: { status: "completed" } } })
  }
  const work = (threadId: string) => setInterval(() => record({ working: threadId }), 20)
  for await (const line of console) {
    const { id, method, params } = JSON.parse(line)
    if (id === undefined) continue
    record({ method, params })
    if (method === "initialize") {
      if (mode !== "hang-init") send({ id, result: {} })
    } else if (method === "hooks/list") {
      send({ id, result: { data: [{ cwd: params.cwds[0], hooks: [{ command: "yapd hook codex", enabled: true, trustStatus: "modified" }] }] } })
    } else if (method === "thread/start") {
      if (mode === "hang-thread") continue
      const thread = { id, result: { thread: { id: `thread-${++threads}` } } }
      if (mode === "late-thread" && threads === 3) { lateThread = thread; continue }
      if (mode === "slow-thread") later(() => send(thread))
      else send(thread)
      if (mode === "malformed-idle" && threads === 2) setTimeout(() => process.stdout.write("not JSON\n"), 50)
    } else if (method === "turn/start") {
      turns++
      const threadId = params.threadId
      if (mode === "forget" && turns === 1) {
        send({ id, error: { code: -32600, message: "thread not found" } })
        continue
      }
      const started = { id, result: { turn: { id: `turn-${turns}` } } }
      if (mode === "hang-ack") { work(threadId); continue }
      if (mode === "late-ack") {
        later(() => send(started))
        continue
      }
      send(started)
      if (mode === "hang-interrupt") { work(threadId); continue }
      if ((mode === "late-thread" || mode === "hang-release") && params.input[0].text === "healthy") {
        held.push(threadId)
        continue
      }
      if (mode === "malformed" || mode === "invalid-envelope") {
        process.stdout.write(mode === "malformed" ? "not JSON\n" : "null\n")
        continue
      }
      if (crashes) setTimeout(() => process.exit(1), 50)
      // Writes the start of its message, then never finishes it.
      if (mode === "trickle") write(threadId, `turn-${turns}`, JSON.stringify({ spoken: "On it, sir. I'll merge it." }).slice(0, 20))
      if (mode === "hang" || mode === "trickle" || crashes) continue
      const status = mode === "fail-turn" ? "failed" : "completed"
      const text = JSON.stringify({ thread: threadId })
      write(threadId, `turn-${turns}`, text)
      send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text } } })
      send({ method: "turn/completed", params: { threadId, turn: { status } } })
      if (lateThread !== undefined) { send(lateThread); lateThread = undefined }
      for (const healthy of held.splice(0)) complete(healthy)
    } else {
      if (mode === "hang-interrupt" && method === "turn/interrupt") continue
      if (mode === "hang-release" && method === "thread/unsubscribe" && params.threadId === "thread-1") continue
      send({ id, result: {} })
    }
  }
}

const dir = mkdtempSync(join(tmpdir(), "yapd-codex-test-"))
const script = join(dir, "codex.js")
await Bun.write(script, `(${fakeCodex.toString()})()`)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const settings = { model: "gpt-6-sol", effort: "low", tier: "priority" }
const turn = { prompt: "Sum this up.", schema: { type: "object" } }
const answer = (thread: string) => JSON.stringify({ thread })

type Entry = {
  readonly launched?: ReadonlyArray<string>
  readonly pid?: number
  readonly listing?: number
  readonly stopping?: number
  readonly working?: string
  readonly method?: string
  readonly params?: any
}

const entries = (log: string) =>
  Effect.promise(async () =>
    (await Bun.file(log).exists())
      ? (await Bun.file(log).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry)
      : [],
  )

/** Waits, in real time, for the fake to have recorded what the test expects. */
const until = (log: string, done: (entries: ReadonlyArray<Entry>) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries++) {
      const recorded = yield* entries(log)
      if (done(recorded)) return recorded
      yield* Effect.promise(() => Bun.sleep(10))
    }
    return yield* Effect.die(`The fake never got there: ${JSON.stringify(yield* entries(log))}`)
  })

const calls = (method: string) => (recorded: ReadonlyArray<Entry>) => recorded.filter((entry) => entry.method === method)
const launches = (recorded: ReadonlyArray<Entry>) => recorded.filter((entry) => entry.launched !== undefined)
const threadsStarted = (count: number) => (recorded: ReadonlyArray<Entry>) => calls("thread/start")(recorded).length === count

/** Lets yapd read what the fake already wrote back. */
const settle = Effect.promise(() => Bun.sleep(50))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits for the processes to be gone, which they should be once the daemon's scope has closed. */
const gone = async (pids: ReadonlyArray<number | undefined>) => {
  for (let tries = 0; tries < 100 && pids.some((pid) => pid !== undefined && alive(pid)); tries++) await Bun.sleep(10)
  return pids.filter((pid) => pid !== undefined && alive(pid))
}

test("reads hook trust without starting a thread and closes the server", async () => {
  const log = join(dir, "hooks.log")
  const result = await Effect.runPromise(CodexServer.hooks("/code", [process.execPath, script, log, "hooks"]))
  expect(result).toEqual({ data: [{ cwd: "/code", hooks: [{ command: "yapd hook codex", enabled: true, trustStatus: "modified" }] }] })
  const recorded = await Effect.runPromise(entries(log))
  expect(recorded.filter(({ method }) => method !== undefined).map(({ method }) => method)).toEqual(["initialize", "hooks/list"])
  expect(await gone(launches(recorded).map(({ pid }) => pid))).toEqual([])
})

let runs = 0
const withServer = <A>(
  mode: string,
  body: (server: Effect.Effect.Success<ReturnType<typeof CodexServer.make>>, log: string, scope: Scope.CloseableScope) => Effect.Effect<A, unknown, Scope.Scope>,
  codex = (log: string) => [process.execPath, script, log, mode],
) => {
  const log = join(dir, `${++runs}.log`)
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Scope.make(),
      (scope) => CodexServer.make(settings, codex(log)).pipe(
        Effect.flatMap((server) => body(server, log, scope)),
        Scope.extend(scope),
      ),
      (scope) => Scope.close(scope, Exit.void),
    ).pipe(
      Effect.provide(TestContext.TestContext),
    ),
  ).then(async (result) => {
    const recorded = await Effect.runPromise(entries(log))
    expect(await gone(recorded.flatMap((entry) => [entry.pid, entry.listing]))).toEqual([])
    return result
  })
}

describe("CodexServer", () => {
  test("starts threads with the user's MCP servers, apps and plugins off, set up as the turns run", () =>
    withServer("", (_, log) =>
      Effect.gen(function* () {
        const recorded = yield* until(log, threadsStarted(2))
        expect(launches(recorded).map((entry) => entry.launched)).toEqual([
          ["app-server", ...CodexServer.isolated, ...CodexServer.features],
        ])
        expect(calls("thread/start")(recorded)[0]?.params).toMatchObject({
          model: "gpt-6-sol",
          serviceTier: "priority",
          config: {
            model_reasoning_effort: "low",
            mcp_servers: { linear: { enabled: false }, "odd.name": { enabled: false } },
          },
          ephemeral: true,
        })
      }),
    ))

  test("runs turns on threads it started ahead", () =>
    withServer("", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        expect(yield* server.run(turn)).toBe(answer("thread-1"))
        const recorded = yield* until(log, threadsStarted(3))
        expect(calls("turn/start")(recorded).map((entry) => entry.params)).toMatchObject([
          { threadId: "thread-1", effort: "low", serviceTier: "priority" },
        ])
        yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).some((entry) => entry.params.threadId === "thread-1"))
      }),
    ))

  test("gives calls at the same time a thread each", () =>
    withServer("", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        yield* settle
        const answers = yield* Effect.all([server.run(turn), server.run(turn)], { concurrency: "unbounded" })
        expect(answers.toSorted()).toEqual([answer("thread-1"), answer("thread-2")])
      }),
    ))

  test("starts a new thread when Codex has let a ready one go", () =>
    withServer("forget", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        expect(yield* server.run(turn)).toBe(answer("thread-3"))
      }),
    ))

  test("replaces ready threads before they'd be too old to trust, so a call after a quiet spell finds one", () =>
    withServer("", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        yield* settle
        // Each round of five minutes looks them over: at fifteen they're replaced.
        for (let round = 0; round < 3; round++) {
          yield* TestClock.adjust("5 minutes")
          yield* settle
        }
        const recorded = yield* until(log, threadsStarted(4))
        expect(calls("thread/unsubscribe")(recorded).map((entry) => entry.params.threadId).toSorted()).toEqual(["thread-1", "thread-2"])
        expect(yield* server.run(turn)).toBe(answer("thread-3"))
      }),
    ))

  test("stops a turn it gives up on", () =>
    withServer("hang", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        const running = yield* Effect.fork(server.run(turn))
        yield* until(log, (recorded) => calls("turn/start")(recorded).length === 1)
        yield* Fiber.interrupt(running)
        const recorded = yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).length === 1)
        expect(calls("turn/interrupt")(recorded).map((entry) => entry.params)).toEqual([
          { threadId: "thread-1", turnId: "turn-1" },
        ])
      }),
    ))

  test("stops a turn it gives up on before Codex says it started", () =>
    withServer("late-ack", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        const running = yield* Effect.fork(server.run(turn))
        yield* until(log, (recorded) => calls("turn/start")(recorded).length === 1)
        yield* Fiber.interrupt(running)
        const recorded = yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).length === 1)
        expect(calls("turn/interrupt")(recorded).map((entry) => entry.params)).toEqual([
          { threadId: "thread-1", turnId: "turn-1" },
        ])
      }),
    ))

  test("passes a streamed answer on in order as it's written, then whole", () =>
    withServer("", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        const written = Chunk.toReadonlyArray(yield* Stream.runCollect(server.stream(turn)))
        const whole = answer("thread-1")
        expect(written.at(-1)).toEqual({ _tag: "Whole", text: whole })
        expect(written.slice(0, -1)).toEqual(
          (whole.match(/.{1,4}/gs) ?? []).map((text) => ({ _tag: "Piece", message: "message-thread-1", text })),
        )
      }),
    ))

  test("streams on a new thread when Codex has let a ready one go", () =>
    withServer("forget", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        const written = Chunk.toReadonlyArray(yield* Stream.runCollect(server.stream(turn)))
        expect(written.at(-1)).toEqual({ _tag: "Whole", text: answer("thread-3") })
      }),
    ))

  test("stops a turn it gives up on mid-stream", () =>
    withServer("trickle", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        const written = yield* Stream.runCollect(Stream.take(server.stream(turn), 2))
        expect(Chunk.toReadonlyArray(written).map((entry) => entry.text)).toEqual(['{"sp', 'oken'])
        const recorded = yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).length === 1)
        expect(calls("turn/interrupt")(recorded).map((entry) => entry.params)).toEqual([
          { threadId: "thread-1", turnId: "turn-1" },
        ])
      }),
    ))

  test("stops a turn it gives up on mid-stream, even read where nothing can be interrupted", () =>
    withServer("trickle", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        const written = yield* Stream.runCollect(Stream.take(server.stream(turn), 2)).pipe(
          Effect.uninterruptible,
          // Fails the test, in real time, should closing the stream wait on the model, which never finishes here.
          Effect.disconnect,
          Effect.raceFirst(Effect.promise(() => Bun.sleep(2_000)).pipe(Effect.zipRight(Effect.dieMessage("Closing the stream hung")))),
        )
        expect(Chunk.toReadonlyArray(written).map((entry) => entry.text)).toEqual(['{"sp', 'oken'])
        const recorded = yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).length === 1)
        expect(calls("turn/interrupt")(recorded).map((entry) => entry.params)).toEqual([
          { threadId: "thread-1", turnId: "turn-1" },
        ])
      }),
    ))

  test("doesn't lose a thread a call stopped waiting for", () =>
    withServer("slow-thread", (server, log) =>
      Effect.gen(function* () {
        // No thread is ready yet, so the call starts its own.
        const running = yield* Effect.fork(server.run(turn))
        yield* until(log, threadsStarted(3))
        yield* Fiber.interrupt(running)
        // Two are ready by the time it's there, so it's let go.
        yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).some((entry) => entry.params.threadId === "thread-3"))
      }),
    ))

  test("doesn't retry a turn the model failed", () =>
    withServer("fail-turn", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        expect(yield* Effect.flip(server.run(turn))).toBeInstanceOf(CodexServer.TurnError)
        expect(calls("turn/start")(yield* entries(log))).toHaveLength(1)
      }),
    ))

  test("starts again after the server stopped mid-turn", () =>
    withServer("crash", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        expect(yield* Effect.flip(server.run(turn))).toBeInstanceOf(CodexServer.ServerError)
        expect(yield* server.run(turn)).toContain("thread-")
        expect(launches(yield* entries(log))).toHaveLength(2)
      }),
    ))

  test("stops the process and preserves the decoding error when its output is malformed", () =>
    withServer("malformed", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(2))
      const error = yield* Effect.flip(server.run(turn))
      expect(error).toBeInstanceOf(CodexServer.ServerError)
      expect(error.cause).toMatchObject({ _tag: "ParseError" })
    })))

  test("rejects invalid protocol envelopes and stops the process", () =>
    withServer("invalid-envelope", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(2))
      const error = yield* Effect.flip(server.run(turn))
      expect(error).toBeInstanceOf(CodexServer.ServerError)
      expect(error.cause).toMatchObject({ _tag: "ParseError" })
    })))

  test("waits for reader cleanup already in progress when the daemon scope closes", () =>
    withServer("malformed-idle", (_, log, scope) => Effect.gen(function* () {
      const recorded = yield* until(log, (recorded) => recorded.some(({ stopping }) => stopping !== undefined))
      const pid = recorded.find(({ stopping }) => stopping !== undefined)?.stopping
      yield* Scope.close(scope, Exit.void)
      expect(pid !== undefined && alive(pid)).toBe(false)
    })))

  test("handles a buffered write whose reader exits and stops the process", () =>
    withServer("close-stdin", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(1))
      yield* settle
      const error = yield* Effect.flip(server.run({ ...turn, prompt: "x".repeat(4 * 1024 * 1024) }))
      expect(error).toBeInstanceOf(CodexServer.ServerError)
      // EOF and EPIPE can arrive in either order; both must be observed by the transport.
      expect(error.cause === "Codex's app-server stopped" || (error.cause instanceof Error && "code" in error.cause && error.cause.code === "EPIPE")).toBe(true)
    })))

  test("stops a server when a buffered request cannot finish writing before its deadline", () =>
    withServer("stall-stdin", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(1))
      yield* settle
      const running = yield* Effect.fork(Effect.flip(server.run({ ...turn, prompt: "x".repeat(4 * 1024 * 1024) })))
      yield* settle
      yield* TestClock.adjust("15 seconds")
      // A waiting spare is retried once on a fresh thread; its stalled write must be stopped too.
      yield* until(log, (recorded) => launches(recorded).length === 2 && calls("thread/start")(recorded).length === 2)
      yield* settle
      yield* TestClock.adjust("15 seconds")
      expect(yield* Fiber.join(running)).toBeInstanceOf(CodexServer.ServerError)
      expect(launches(yield* entries(log)).every(({ pid }) => pid !== undefined && !alive(pid))).toBe(true)
    })))

  test("fails a stalled thread request in time to use the CLI fallback", () =>
    withServer("hang-thread", (server, log) => Effect.gen(function* () {
      const running = yield* Effect.fork(server.run(turn).pipe(
        Effect.catchTag("ServerError", () => Effect.succeed("fallback")),
        Effect.timeout("60 seconds"),
      ))
      yield* until(log, threadsStarted(3))
      yield* settle
      yield* TestClock.adjust("15 seconds")
      expect(yield* Fiber.join(running)).toBe("fallback")
    })))

  test("isolates a thread response timeout and releases its late thread while healthy turns finish", () =>
    withServer("late-thread", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(2))
      yield* settle
      const healthy = yield* Effect.fork(Effect.all([
        server.run({ ...turn, prompt: "healthy" }),
        server.run({ ...turn, prompt: "healthy" }),
      ], { concurrency: "unbounded" }))
      yield* until(log, (recorded) => calls("turn/start")(recorded).length === 2)
      const slow = yield* Effect.fork(server.run(turn).pipe(
        Effect.catchTag("ServerError", () => Effect.succeed("fallback")),
      ))
      yield* until(log, threadsStarted(3))
      yield* settle
      yield* TestClock.adjust("15 seconds")
      expect(yield* Fiber.join(slow)).toBe("fallback")
      expect((yield* Fiber.poll(healthy))._tag).toBe("None")
      yield* until(log, threadsStarted(5))
      yield* settle
      expect(yield* server.run(turn)).toBe(answer("thread-4"))
      expect((yield* Fiber.join(healthy)).toSorted()).toEqual([answer("thread-1"), answer("thread-2")])
      yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).some(({ params }) => params.threadId === "thread-3"))
      expect(launches(yield* entries(log))).toHaveLength(1)
    })))

  test("keeps a healthy turn running when another thread's unsubscribe never answers", () =>
    withServer("hang-release", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(2))
      yield* settle
      expect(yield* server.run(turn)).toBe(answer("thread-1"))
      yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).length === 1)
      const healthy = yield* Effect.fork(server.run({ ...turn, prompt: "healthy" }))
      yield* until(log, (recorded) => calls("turn/start")(recorded).length === 2)
      yield* settle
      yield* TestClock.adjust("5 seconds")
      expect((yield* Fiber.poll(healthy))._tag).toBe("None")
      expect(yield* server.run(turn)).toBe(answer("thread-3"))
      expect(yield* Fiber.join(healthy)).toBe(answer("thread-2"))
      expect(launches(yield* entries(log))).toHaveLength(1)
    })))

  test("bounds a canceled turn whose start was never acknowledged", () =>
    withServer("hang-ack", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(2))
      const running = yield* Effect.fork(server.run(turn))
      yield* until(log, (recorded) => recorded.some(({ working }) => working !== undefined))
      yield* Fiber.interrupt(running)
      yield* TestClock.adjust("15 seconds")
      const recorded = yield* until(log, (recorded) => launches(recorded).every(({ pid }) => pid !== undefined && !alive(pid)))
      const work = recorded.filter(({ working }) => working !== undefined).length
      expect(work).toBeGreaterThan(0)
      yield* settle
      expect((yield* entries(log)).filter(({ working }) => working !== undefined)).toHaveLength(work)
    })))

  test("stops active generation when cancellation is never acknowledged", () =>
    withServer("hang-interrupt", (server, log) => Effect.gen(function* () {
      yield* until(log, threadsStarted(2))
      const running = yield* Effect.fork(server.run(turn))
      yield* until(log, (recorded) => recorded.some(({ working }) => working !== undefined))
      yield* Fiber.interrupt(running)
      yield* until(log, (recorded) => calls("turn/interrupt")(recorded).length === 1)
      yield* TestClock.adjust("5 seconds")
      const recorded = yield* until(log, (recorded) => launches(recorded).every(({ pid }) => pid !== undefined && !alive(pid)))
      const work = recorded.filter(({ working }) => working !== undefined).length
      expect(work).toBeGreaterThan(0)
      yield* settle
      expect((yield* entries(log)).filter(({ working }) => working !== undefined)).toHaveLength(work)
    })))

  test("gives up on a server that won't start, and stops it", () =>
    withServer("hang-init", (server, log) =>
      Effect.gen(function* () {
        const running = yield* Effect.fork(server.run(turn))
        yield* until(log, (recorded) => launches(recorded).length === 1)
        yield* TestClock.adjust("15 seconds")
        expect(yield* Effect.flip(Fiber.join(running))).toBeInstanceOf(CodexServer.ServerError)
        // Without starting another one for a while, so calls can fall back to `codex exec` in time.
        expect(yield* Effect.flip(server.run(turn))).toBeInstanceOf(CodexServer.ServerError)
        expect(launches(yield* entries(log))).toHaveLength(1)
      }),
    ))

  test("stops a server that's still starting when the daemon stops", () =>
    withServer("hang-init", (_, log) => until(log, (recorded) => launches(recorded).length === 1)))

  test("still runs on a Codex that won't take the flags", () =>
    withServer("old", (server, log) =>
      Effect.gen(function* () {
        expect(yield* server.run(turn)).toContain("thread-")
        const recorded = yield* entries(log)
        expect(launches(recorded).map((entry) => entry.launched)).toEqual([
          ["app-server", ...CodexServer.isolated, ...CodexServer.features],
          ["app-server", ...CodexServer.isolated],
        ])
        expect(calls("thread/start")(recorded)[0]?.params.config).toEqual({ model_reasoning_effort: "low" })
      }),
    ))

  test("starts threads anyway when it can't list the MCP servers", () =>
    withServer("unlisted", (server, log) =>
      Effect.gen(function* () {
        expect(yield* server.run(turn)).toContain("thread-")
        expect(calls("thread/start")(yield* entries(log))[0]?.params.config).toEqual({ model_reasoning_effort: "low" })
      }),
    ))

  test("doesn't wait on a listing that hangs", () =>
    withServer("stuck", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, (recorded) => recorded.filter((entry) => entry.listing).length === 2)
        yield* TestClock.adjust("5 seconds")
        yield* until(log, threadsStarted(2))
        yield* settle
        expect(yield* server.run(turn)).toContain("thread-")
      }),
    ))

  test("fails like a stopped server when codex can't be started", () =>
    withServer(
      "",
      (server) =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(server.run(turn))).toBeInstanceOf(CodexServer.ServerError)
        }),
      () => [join(dir, "missing")],
    ))
})
