import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Fiber, TestClock, TestContext } from "effect"
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
  let threads = 0
  let turns = 0
  for await (const line of console) {
    const { id, method, params } = JSON.parse(line)
    if (id === undefined) continue
    record({ method, params })
    if (method === "initialize") {
      if (mode !== "hang-init") send({ id, result: {} })
    } else if (method === "thread/start") {
      const thread = { id, result: { thread: { id: `thread-${++threads}` } } }
      if (mode === "slow-thread") later(() => send(thread))
      else send(thread)
    } else if (method === "turn/start") {
      turns++
      const threadId = params.threadId
      if (mode === "forget" && turns === 1) {
        send({ id, error: { code: -32600, message: "thread not found" } })
        continue
      }
      const started = { id, result: { turn: { id: `turn-${turns}` } } }
      if (mode === "late-ack") {
        later(() => send(started))
        continue
      }
      send(started)
      if (crashes) setTimeout(() => process.exit(1), 50)
      if (mode === "hang" || crashes) continue
      const status = mode === "fail-turn" ? "failed" : "completed"
      const text = JSON.stringify({ thread: threadId })
      send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text } } })
      send({ method: "turn/completed", params: { threadId, turn: { status } } })
    } else {
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
  body: (server: Effect.Effect.Success<ReturnType<typeof CodexServer.make>>, log: string) => Effect.Effect<A, unknown, never>,
  codex = (log: string) => [process.execPath, script, log, mode],
) => {
  const log = join(dir, `${++runs}.log`)
  return Effect.runPromise(
    CodexServer.make(settings, codex(log)).pipe(
      Effect.flatMap((server) => body(server, log)),
      Effect.scoped,
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

  test("lets go of threads that have waited too long", () =>
    withServer("", (server, log) =>
      Effect.gen(function* () {
        yield* until(log, threadsStarted(2))
        yield* settle
        yield* TestClock.adjust("1 hour")
        expect(yield* server.run(turn)).toBe(answer("thread-3"))
        const recorded = yield* until(log, (recorded) => calls("thread/unsubscribe")(recorded).length === 3)
        expect(calls("thread/unsubscribe")(recorded).map((entry) => entry.params.threadId).toSorted()).toEqual([
          "thread-1",
          "thread-2",
          "thread-3",
        ])
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
