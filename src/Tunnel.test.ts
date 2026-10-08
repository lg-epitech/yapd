import { describe, expect, test } from "bun:test"
import { Clock, type Duration, Effect, Exit, Fiber, Layer, Logger, Option, Redacted, Scope, TestClock, TestContext } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProcessError } from "./Process.ts"
import type { Exec } from "./Remote.ts"
import * as T3Actions from "./T3Actions.ts"
import * as Server from "./T3CodeServer.ts"
import * as Tunnel from "./Tunnel.ts"

/** Never made: the tunnel only ever removes a socket left behind there. */
const folder = join(tmpdir(), "yapd-tunnel-test-nothing-here")

/**
 * A machine at the other end of SSH that a test talks for. `opens` says how
 * each try to connect goes, and `answers` what `yapd t3` prints there, in turn.
 * `open` is for a connection an earlier yapd left open, with its forwards.
 */
const machine = (
  options: {
    readonly opens?: Array<boolean>
    readonly answers?: Array<string | ProcessError>
    readonly open?: ReadonlyArray<string>
    /** How long connecting takes. */
    readonly opening?: Duration.DurationInput
  } = {},
) => {
  const opens = [...(options.opens ?? [])]
  const answers = [...(options.answers ?? [])]
  /** Checks on the connection SSH can't answer, in turn: it couldn't start, or it hangs. */
  const unsure: Array<"failed" | "hung"> = []
  /** How many of the next forwards open without SSH ever saying so. */
  let stalled = 0
  /** The connections that hang when told to exit. */
  const deaf = new Set<number>()
  /** Connections that answer when told to exit but go a while later, by the test's clock, taking whatever socket is on the path then. */
  const lingering = new Map<number, number>()
  /** How long the connection on the socket takes to go once told to exit. */
  let linger: number | undefined
  /** Lets the lingering connections whose time has come go. */
  const settle = Effect.map(Clock.currentTimeMillis, (now) => {
    for (const [pid, at] of lingering) {
      if (at > now) continue
      lingering.delete(pid)
      connections.delete(pid)
      // SSH removes the socket's path as it goes, whichever connection's socket is there by then.
      current = undefined
    }
  })
  /** The connections running here, by their process, each with its forwards listening here, as `-L` gives them. */
  const connections = new Map<number, Set<string>>()
  /** The one on the socket, that what's told through it reaches. */
  let current: number | undefined
  let pids = 100
  const start = (forwards: Iterable<string> = []) => {
    current = ++pids
    connections.set(current, new Set(forwards))
  }
  if (options.open !== undefined) start(options.open)
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
  const exec: Exec = (command) =>
    Effect.gen(function* () {
      yield* settle
      const line = command.join(" ")
      calls.push(line)
      const fail = (code: number, stderr = "") => Effect.fail(new ProcessError({ command: line, code, stderr }))
      if (command.includes("-O")) {
        const trouble = command.includes("check") ? unsure.shift() : undefined
        if (trouble === "hung") return yield* Effect.never
        if (trouble === "failed") return yield* fail(-1, "posix_spawn: Resource temporarily unavailable")
        if (command.includes("exit") && current !== undefined && deaf.has(current)) return yield* Effect.never
        const forwards = current === undefined ? undefined : connections.get(current)
        if (current === undefined || forwards === undefined) {
          return yield* fail(255, `Control socket connect(${command[2]}): No such file or directory`)
        }
        // SSH answers these on stderr, which comes back with the rest.
        if (command.includes("check")) return `Master running (pid=${current})\r\n`
        if (command.includes("exit")) {
          if (linger === undefined) end(current)
          else {
            // Answered, but not gone yet.
            lingering.set(current, (yield* Clock.currentTimeMillis) + linger)
            linger = undefined
            current = undefined
          }
          return "Exit request sent.\r\n"
        }
        if (command.includes("forward")) {
          forwards.add(command[command.indexOf("-L") + 1] ?? "")
          if (stalled === 0) return ""
          stalled--
          return yield* Effect.never
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
  const alive = (pid: number) => Effect.zipRight(settle, Effect.sync(() => connections.has(pid)))
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
    unsure,
    killed,
    /** The forwards listening here, whichever connection they go with. */
    listening: () => [...connections.values()].flatMap((forwards) => [...forwards]),
    stall: () => {
      stalled++
    },
    /** The connection on the socket hangs from now on when told to exit. */
    deafen: () => {
      if (current !== undefined) deaf.add(current)
    },
    /** The connection on the socket answers when told to exit, but goes only `millis` later. */
    linger: (millis: number) => {
      linger = millis
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

describe("yapd t3", () => {
  test("prints the origin and the token and nothing else, and why not when there's none", async () => {
    const token = Option.some(Redacted.make("t3-token"))
    const running = Effect.succeed({ origin: "http://127.0.0.1:3774" })
    expect(await Effect.runPromise(Tunnel.serve(token, running))).toBe('{"origin":"http://127.0.0.1:3774","token":"t3-token"}')
    const stopped = Effect.fail(new Server.Trouble({ reason: "T3 Code isn't running." }))
    expect(JSON.parse(await Effect.runPromise(Tunnel.serve(token, stopped)))).toEqual({ reason: "T3 Code isn't running." })
    expect(JSON.parse(await Effect.runPromise(Tunnel.serve(Option.none(), running)))).toEqual({
      reason: "yapd has no T3 Code token here.",
    })
  })
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
        expect(rig.calls).toContain(`ssh -S ${folder}/ssh-rig.sock -O forward -L 127.0.0.1:50001:127.0.0.1:3774 -- me@rig.example.com`)

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
        expect(rig.calls.filter((line) => line.endsWith("cd / && yapd t3"))).toHaveLength(2)
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

  test("opens a fresh connection whenever its forward is in doubt, never another forward beside it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // SSH never says the first forward opened.
        const rig = machine()
        rig.stall()
        const tunnel = yield* open(rig)
        for (const wait of ["5 seconds", "1 second"] as const) {
          yield* flush
          yield* TestClock.adjust(wait)
        }
        yield* flush
        expect((yield* tunnel.locate).server.origin).toBe("http://127.0.0.1:50002")
        expect([rig.tries.length, rig.listening()]).toEqual([2, ["127.0.0.1:50002:127.0.0.1:3774"]])

        // T3 Code there moved, and closing the connection for it, which hangs, is cut short by what asked being interrupted.
        const moved = JSON.stringify({ origin: "http://127.0.0.1:3775", token: "token-3" })
        rig.answers.push(moved, moved)
        rig.deafen()
        const refreshing = yield* Effect.fork(tunnel.refresh)
        yield* flush
        yield* Fiber.interrupt(refreshing)
        for (const wait of ["5 seconds", "1 second", "5 seconds"] as const) {
          yield* TestClock.adjust(wait)
          yield* flush
        }
        expect((yield* tunnel.locate).server.origin).toBe("http://127.0.0.1:50003")
        expect([rig.killed, rig.listening()]).toEqual([[102], ["127.0.0.1:50003:127.0.0.1:3775"]])
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

  test("waits for a connection told to exit to be gone before opening the next, so it can't take the new one's socket", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rig = machine()
        const tunnel = yield* open(rig)
        yield* tunnel.locate
        // T3 Code there moved, and the connection it had answers when told to exit but takes a moment to go.
        rig.linger(150)
        const moved = JSON.stringify({ origin: "http://127.0.0.1:3775", token: "token-2" })
        rig.answers.push(moved, moved)
        const refreshing = yield* Effect.fork(tunnel.refresh)
        for (let tick = 0; tick < 6; tick++) {
          yield* flush
          yield* TestClock.adjust("50 millis")
        }
        expect((yield* Fiber.join(refreshing)).server.origin).toBe("http://127.0.0.1:50002")
        // Still reachable through the new one's socket, and only its forward listens.
        expect(yield* tunnel.master).toEqual(Option.some(`${folder}/ssh-rig.sock`))
        expect(rig.listening()).toEqual(["127.0.0.1:50002:127.0.0.1:3775"])
        expect((yield* tunnel.refresh).server.origin).toBe("http://127.0.0.1:50002")
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

  test("an action on rig while it's down fails at once with a spoken reason", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const cases = [
          { rig: machine({ opens: [false] }), reason: "I can't reach rig right now." },
          {
            rig: machine({ answers: [new ProcessError({ command: "ssh", code: 1, stderr: "usage: yapd setup | yapd doctor" })] }),
            reason: "yapd on rig needs updating.",
          },
          { rig: machine({ answers: [JSON.stringify({ reason: "T3 Code isn't running." })] }), reason: "rig's T3 Code isn't running." },
        ]
        for (const { rig, reason } of cases) {
          const tunnel = yield* open(rig)
          yield* flush
          const asked = rig.calls.length
          const actions = T3Actions.make(Tunnel.transport(tunnel.locate))
          const sending = yield* Effect.fork(Effect.flip(actions.run("thread-1", { _tag: "Send", text: "Merge it.", steer: false })))
          yield* flush
          const exit = Option.getOrUndefined(yield* sending.poll)
          expect(exit !== undefined && Exit.isSuccess(exit) ? T3Actions.reason(exit.value) : "still waiting").toBe(reason)
          // Nothing was tried on its behalf: trying again is the tunnel's, in the background.
          expect(rig.calls.length).toBe(asked)
        }
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

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

  test("closes a connection an earlier yapd left rather than take it over, and never opens one beside another", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Still forwarding a port nothing here knows of, and SSH can't check on it at first.
        const rig = machine({ open: ["127.0.0.1:49999:127.0.0.1:3774"] })
        rig.unsure.push("failed")
        const tunnel = yield* open(rig)
        yield* flush
        yield* TestClock.adjust("1 second")
        yield* flush
        expect((yield* tunnel.locate).server.origin).toBe("http://127.0.0.1:50001")
        expect(rig.listening()).toEqual(["127.0.0.1:50001:127.0.0.1:3774"])

        // A check that takes too long, while it's up.
        rig.unsure.push("hung")
        for (const wait of ["5 seconds", "5 seconds"] as const) {
          yield* TestClock.adjust(wait)
          yield* flush
        }
        expect(yield* tunnel.status).toEqual({ _tag: "Up" })
        expect(rig.calls.filter((line) => line.includes(" -M "))).toHaveLength(1)
        expect(rig.listening()).toEqual(["127.0.0.1:50001:127.0.0.1:3774"])
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    ))

  test("closes the connection with its scope, even when it was opened where nothing can be interrupted", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rig = machine()
        const scope = yield* Scope.make()
        // Like acquireRelease's acquisition.
        const opening = Effect.uninterruptible(open(rig))
        const tunnel = yield* Scope.extend(opening, scope)
        yield* flush
        expect(yield* tunnel.status).toEqual({ _tag: "Up" })
        // Not the test's own fiber, which would wait for it, however long.
        const closing = yield* Effect.forkDaemon(Scope.close(scope, Exit.void))
        yield* flush
        expect(Option.isSome(yield* closing.poll)).toBe(true)
        expect(rig.calls.filter((line) => line.includes(" -O exit "))).toHaveLength(1)
      }).pipe(Effect.provide(TestContext.TestContext)),
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
