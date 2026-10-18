import { describe, expect, spyOn, test } from "bun:test"
import { Clock, type Duration, Effect, Exit, Layer, Logger, Option, Redacted, Schema, Scope, TestClock, TestContext } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProcessError } from "./Process.ts"
import * as Remote from "./Remote.ts"
import * as T3Actions from "./T3Actions.ts"
import * as Tunnel from "./Tunnel.ts"

/** Never made: the tunnel only ever removes a socket left behind there. */
const folder = join(tmpdir(), "yapd-tunnel-test-nothing-here")

/**
 * A machine at the other end of SSH that a test talks for. `opens` says how
 * each try to connect goes, and `answers` what `yapd t3` prints there, in turn.
 */
const machine = (
  options: {
    readonly opens?: Array<boolean>
    readonly answers?: Array<string | ProcessError>
    /** How long connecting takes. */
    readonly opening?: Duration.DurationInput
  } = {},
) => {
  const opens = [...(options.opens ?? [])]
  const answers = [...(options.answers ?? [])]
  /** The connections that hang when told to exit. */
  const deaf = new Set<number>()
  /** The connections running here, by their process, each with its forwards listening here, as `-L` gives them. */
  const connections = new Map<number, Set<string>>()
  /** The one on the socket, that what's told through it reaches. */
  let current: number | undefined
  let pids = 100
  const start = () => {
    current = ++pids
    connections.set(current, new Set())
  }
  /** A connection that's gone, and its forwards with it. */
  const end = (pid: number) => {
    connections.delete(pid)
    if (current === pid) current = undefined
  }
  /** The processes killed here. */
  const killed: Array<number> = []
  const calls: Array<string> = []
  /** When each try to connect was made, by the test's clock. */
  const tries: Array<number> = []
  let tokens = 0
  const exec: Remote.Exec = (command) =>
    Effect.gen(function* () {
      const line = command.join(" ")
      calls.push(line)
      const fail = (code: number, stderr = "") => Effect.fail(new ProcessError({ command: line, code, stderr }))
      if (command.includes("-O")) {
        if (command.includes("exit") && current !== undefined && deaf.has(current)) return yield* Effect.never
        const forwards = current === undefined ? undefined : connections.get(current)
        if (current === undefined || forwards === undefined) {
          return yield* fail(255, `Control socket connect(${command[command.indexOf("-S") + 1]}): No such file or directory`)
        }
        // SSH answers these on stderr, which comes back with the rest.
        if (command.includes("check")) return `Master running (pid=${current})\r\n`
        if (command.includes("exit")) {
          end(current)
          return "Exit request sent.\r\n"
        }
        if (command.includes("forward")) {
          forwards.add(command[command.indexOf("-L") + 1] ?? "")
          return ""
        }
        // Like cancelling a forward, which SSH can fail to do, leaving it listening.
        return yield* fail(255, "mux_client_forward: forwarding request failed: Port forwarding failed")
      }
      if (command.includes("-M")) {
        tries.push(yield* Clock.currentTimeMillis)
        if (options.opening !== undefined) yield* Effect.sleep(options.opening)
        if (!(opens.shift() ?? true)) return yield* fail(255, "ssh: connect to host rig port 22: Operation timed out")
        // One that was there is left running, with its forwards, where nothing reaches it through the socket.
        start()
        return ""
      }
      const answer = answers.shift() ?? JSON.stringify({ origin: "http://127.0.0.1:3774", token: `token-${++tokens}` })
      return answer instanceof ProcessError ? yield* Effect.fail(answer) : `Welcome to rig\n${answer}\n`
    })
  /** Whether a process still runs here. */
  const alive = (pid: number) => Effect.sync(() => connections.has(pid))
  return {
    exec,
    alive,
    kill: (pid: number) =>
      Effect.sync(() => {
        killed.push(pid)
        end(pid)
      }),
    calls,
    tries,
    answers,
    killed,
    /** The forwards listening here, whichever connection they go with. */
    listening: () => [...connections.values()].flatMap((forwards) => [...forwards]),
    /** The connection on the socket hangs from now on when told to exit. */
    deafen: () => {
      if (current !== undefined) deaf.add(current)
    },
    /** The connection on the socket drops, like when the network does. */
    drop: () => {
      if (current !== undefined) end(current)
    },
  }
}

/** Free ports, one after the other. */
const ports = () => {
  let next = 50000
  return Effect.sync(() => ++next)
}

/** The tunnel to rig, where processes are only ever killed in the test's play. */
const open = (rig: ReturnType<typeof machine>) =>
  Tunnel.forward("rig", "me@rig.example.com", rig.exec, ports(), folder, rig.kill, rig.alive)

/** Lets the tunnel's fibers catch up, since the clock only moves when told to. */
const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

/** What an effect gives within a second by the test's clock, or that it's still waiting. */
const within = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(effect)
    yield* TestClock.adjust("1 second")
    yield* flush
    const exit = Option.getOrUndefined(yield* fiber.poll)
    return exit !== undefined && Exit.isSuccess(exit) ? exit.value : "still waiting"
  })

describe("Tunnel", () => {
  test("connects again with backoff and asks for the token again", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rig = machine({ opens: [true, false, false, true] })
        const tunnel = yield* open(rig)
        const before = yield* tunnel.locate
        expect(before.server.origin).toBe("http://127.0.0.1:50001")
        expect(Redacted.value(before.token)).toBe("token-1")

        rig.drop()
        yield* TestClock.adjust("5 seconds")
        yield* flush
        expect(yield* tunnel.status).toEqual({ _tag: "Down", reason: "I can't reach rig right now.", outage: 1 })
        for (const wait of ["1 second", "2 seconds"] as const) {
          yield* TestClock.adjust(wait)
          yield* flush
        }
        const after = yield* tunnel.locate
        expect(after.server.origin).toBe("http://127.0.0.1:50002")
        expect(Redacted.value(after.token)).toBe("token-2")
        expect(rig.tries).toEqual([0, 5000, 6000, 8000])
        expect(rig.calls.filter((line) => line.endsWith(" yapd t3"))).toHaveLength(2)
        expect(yield* tunnel.master).toEqual(Option.some(`${folder}/ssh-rig.sock`))

        // T3 Code there restarted on another port, with a new token: a fresh connection forwards there, and nothing else listens.
        rig.answers.push(JSON.stringify({ origin: "http://127.0.0.1:3775", token: "token-3" }))
        const moved = yield* tunnel.refresh
        expect([moved.server.origin, Redacted.value(moved.token)]).toEqual(["http://127.0.0.1:50003", "token-3"])
        expect([rig.tries.length, rig.listening()]).toEqual([5, ["127.0.0.1:50003:127.0.0.1:3775"]])

        // The connection went, and the forward with it, though SSH still reaches rig on its own.
        rig.drop()
        rig.answers.push(JSON.stringify({ origin: "http://127.0.0.1:3775", token: "token-3" }))
        expect((yield* Effect.flip(tunnel.refresh)).reason).toBe("I can't reach rig right now.")
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

  test("carries no forward the user's SSH config sets for the machine", async () => {
    const ssh = Bun.which("ssh")
    if (ssh === null) return
    const dir = await mkdtemp(join(tmpdir(), "yapd-tunnel-config-"))
    try {
      const config = join(dir, "config")
      await Bun.write(config, "Host rig\n  LocalForward 9999 127.0.0.1:9999\n  DynamicForward 1080\n  RemoteForward 9998 127.0.0.1:9998\n")
      // `ssh -G` says how SSH would connect, without connecting.
      const resolved = (...options: ReadonlyArray<string>) =>
        Bun.spawnSync([ssh, "-G", ...options, "rig"], { stderr: "ignore" }).stdout.toString()
      expect(resolved("-F", config)).toContain("localforward")
      const opened = resolved("-F", config, ...Tunnel.opening)
      expect(opened).not.toMatch(/^(localforward|dynamicforward|remoteforward) /m)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("an action on rig while it's down fails at once with a spoken reason", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const cases = [{ rig: machine({ opens: [false] }), reason: "I can't reach rig right now." }]
        for (const { rig, reason } of cases) {
          const tunnel = yield* open(rig)
          yield* flush
          const asked = rig.calls.length
          const actions = T3Actions.make(Tunnel.transport(tunnel.locate, "rig"))
          const sending = yield* Effect.fork(Effect.flip(actions.run("thread-1", { _tag: "Send", text: "Merge it.", messageId: "message-1", how: "now" }, "yapd:u1:0")))
          yield* flush
          const exit = Option.getOrUndefined(yield* sending.poll)
          expect(exit !== undefined && Exit.isSuccess(exit) ? T3Actions.reason(exit.value) : "still waiting").toBe(reason)
          // Nothing was tried on its behalf: trying again is the tunnel's, in the background.
          expect(rig.calls.length).toBe(asked)
        }
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

  test("never puts the token in the log, nor in what's said, whatever rig's T3 Code or the way there says", async () => {
    const secret = "t3-secret-token"
    const located = Effect.succeed<Tunnel.Located>({ server: { origin: "http://127.0.0.1:1" }, token: Redacted.make(secret) })
    // The worst a failing transport could do: quote the token, in its error and in what T3 Code says no with.
    const answers: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError(`fetch failed with authorization: Bearer ${secret}`)),
      async () => new Response(JSON.stringify({ token: secret }), { status: 200 }),
    ]
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => answers.shift()!(), { preconnect: globalThis.fetch.preconnect }))
    const lines: Array<string> = []
    // As the log prints it, whole, causes and all.
    const logger = Logger.make(({ message }) => void lines.push(Bun.inspect(message)))
    try {
      const reasons = await Effect.runPromise(
        Effect.gen(function* () {
          const { api } = yield* Tunnel.transport(located, "rig")
          const failed = [
            yield* Effect.flip(api("/api/test", Schema.Unknown)),
            yield* Effect.flip(api("/api/test", Schema.Struct({ token: Schema.Number }))),
          ]
          for (const error of failed) yield* Effect.logWarning(`Couldn't read rig's thread: ${error.reason}`, error)
          return failed.map(({ reason }) => reason)
        }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
      )
      expect(reasons).toEqual(["rig's T3 Code isn't answering.", "rig's T3 Code answered in a way I don't understand."])
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain("fetch failed with authorization: Bearer [token]")
      expect(lines.some((line) => line.includes(secret))).toBe(false)
    } finally {
      fetch.mockRestore()
    }
  })

  test("right after yapd starts, says it's still connecting rather than wait for SSH", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rig = machine({ opening: "10 seconds" })
        const tunnel = yield* open(rig)
        expect(yield* within(tunnel.status)).toEqual({ _tag: "Down", reason: "I'm still connecting to rig.", outage: 0 })
        expect(yield* within(Effect.map(Effect.flip(tunnel.locate), ({ reason }) => reason))).toBe("I'm still connecting to rig.")
        yield* TestClock.adjust("8 seconds")
        yield* flush
        expect(yield* tunnel.status).toEqual({ _tag: "Up" })
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

  test("closes the connection with its scope before long even when it hangs, killing it with its forward", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rig = machine()
        const scope = yield* Scope.make()
        const tunnel = yield* Scope.extend(open(rig), scope)
        yield* flush
        expect(yield* tunnel.status).toEqual({ _tag: "Up" })
        rig.deafen()
        const closing = yield* Effect.forkDaemon(Scope.close(scope, Exit.void))
        yield* flush
        yield* TestClock.adjust("5 seconds")
        yield* flush
        expect(Option.isSome(yield* closing.poll)).toBe(true)
        expect([rig.killed, rig.listening()]).toEqual([[101], []])
      }).pipe(Effect.provide(TestContext.TestContext)),
    ))

  test("never puts the token in the log, even when what came back can't be read", async () => {
    const secret = "t3-secret-token"
    const lines: Array<string> = []
    const statuses: Array<Tunnel.Status> = []
    const logger = Logger.map(Logger.logfmtLogger, (line) => void lines.push(line))
    await Effect.runPromise(
      Effect.gen(function* () {
        const rig = machine({
          answers: [
            // Decoding says what it found instead of a string.
            JSON.stringify({ origin: "http://127.0.0.1:3774", token: [secret] }),
            JSON.stringify({ origin: "nowhere", token: secret }),
            JSON.stringify({ origin: "http://127.0.0.1:3774", token: secret }),
          ],
        })
        const tunnel = yield* open(rig)
        yield* flush
        statuses.push(yield* tunnel.status)
        for (const wait of ["1 second", "2 seconds"] as const) {
          yield* TestClock.adjust(wait)
          yield* flush
        }
        statuses.push(yield* tunnel.status)
        expect(Redacted.value((yield* tunnel.locate).token)).toBe(secret)
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(TestContext.TestContext, Logger.replace(Logger.defaultLogger, logger)))),
    )
    expect(statuses).toEqual([{ _tag: "Down", reason: "yapd on rig answered in a way I don't understand.", outage: 1 }, { _tag: "Up" }])
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter((line) => line.includes(secret))).toEqual([])
  })

})
