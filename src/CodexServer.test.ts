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
  // An older Codex exits on a feature it doesn't know.
  const old = mode === "old" && args.includes("apps")
  if (args.includes("mcp")) {
    if (old) process.exit(1)
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
  let threads = 0
  let turns = 0
  /** The message as the model writes it, four characters at a time. */
  const write = (threadId: string, turnId: string, text: string) => {
    for (const delta of text.match(/.{1,4}/gs) ?? []) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: `message-${threadId}`, delta } })
    }
  }
  const work = (threadId: string) => setInterval(() => record({ working: threadId }), 20)
  for await (const line of console) {
    const { id, method, params } = JSON.parse(line)
    if (id === undefined) continue
    record({ method, params })
    if (method === "initialize") {
      if (mode !== "hang-init") send({ id, result: {} })
    } else if (method === "thread/start") {
      send({ id, result: { thread: { id: `thread-${++threads}` } } })
    } else if (method === "turn/start") {
      turns++
      const threadId = params.threadId
      if (mode === "forget" && turns === 1) {
        send({ id, error: { code: -32600, message: "thread not found" } })
        continue
      }
      send({ id, result: { turn: { id: `turn-${turns}` } } })
      if (mode === "hang-interrupt") { work(threadId); continue }
      if (mode === "malformed") {
        process.stdout.write("not JSON\n")
        continue
      }
      if (crashes) setTimeout(() => process.exit(1), 50)
      if (mode === "hang" || crashes) continue
      const status = mode === "fail-turn" ? "failed" : "completed"
      const text = JSON.stringify({ thread: threadId })
      write(threadId, `turn-${turns}`, text)
      send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text } } })
      send({ method: "turn/completed", params: { threadId, turn: { status } } })
    } else {
      if (mode === "hang-interrupt" && method === "turn/interrupt") continue
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

let runs = 0
const withServer = <A>(
  mode: string,
  body: (server: Effect.Effect.Success<ReturnType<typeof CodexServer.make>>, log: string) => Effect.Effect<A, unknown, Scope.Scope>,
  codex = (log: string) => [process.execPath, script, log, mode],
) => {
  const log = join(dir, `${++runs}.log`)
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Scope.make(),
      // Two ready threads, which is all these need to show how they're kept.
      (scope) => CodexServer.make(settings, codex(log), 2).pipe(
        Effect.flatMap((server) => body(server, log)),
        Scope.extend(scope),
      ),
      (scope) => Scope.close(scope, Exit.void),
    ).pipe(
      Effect.provide(TestContext.TestContext),
    ),
  ).then(async (result) => {
    const recorded = await Effect.runPromise(entries(log))
    expect(await gone(recorded.map((entry) => entry.pid))).toEqual([])
    return result
  })
}

describe("CodexServer", () => {
  test("starts threads with the user's MCP servers, apps and plugins off, set up as the turns run", () =>
    withServer("", (_, log) =>
      Effect.gen(function* () {
        const recorded = yield* until(log, threadsStarted(2))
        expect(calls("thread/start")(recorded)[0]?.params).toMatchObject({
          config: { mcp_servers: { linear: { enabled: false }, "odd.name": { enabled: false } } },
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
