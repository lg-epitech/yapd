import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as Codex from "./Codex.ts"
import * as Origin from "./Origin.ts"
import * as Relay from "./Relay.ts"

const thread: Relay.Thread = { agent: "claude", session: "s", cwd: "/repo", message: "Done.", origin: {} }

const recording = (name: string, sent: Array<string>, outcome: "sent" | "unreachable" | "failed"): Relay.Relay => ({
  send: (_, text) => {
    if (outcome === "unreachable") return Effect.fail(new Relay.Unreachable())
    if (outcome === "failed") return Effect.fail(new Relay.RelayError({ reason: `${name} failed` }))
    return Effect.sync(() => void sent.push(`${name}: ${text}`))
  },
})

describe("Relay", () => {
  test("sends through the first relay that reaches the thread", async () => {
    const sent: Array<string> = []
    const relays = Relay.make([recording("a", sent, "unreachable"), recording("b", sent, "sent"), recording("c", sent, "sent")])
    await Effect.runPromise(relays.send(thread, "Merge it."))
    expect(sent).toEqual(["b: Merge it."])
  })

  test("stops at a relay that reaches the thread but can't send", async () => {
    const sent: Array<string> = []
    const relays = Relay.make([recording("a", sent, "failed"), recording("b", sent, "sent")])
    const exit = await Effect.runPromiseExit(relays.send(thread, "Merge it."))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(sent).toEqual([])
  })

  test("says so when nothing reaches it", async () => {
    const exit = await Effect.runPromiseExit(Relay.make([]).send(thread, "Merge it."))
    expect(exit).toMatchObject({ _tag: "Failure" })
  })

  test("doesn't let a message run as a command", () => {
    expect(Relay.plain("  /compact please")).toBe("compact please")
    expect(Relay.plain("!rm -rf build")).toBe("rm -rf build")
    expect(Relay.plain("Use /tmp instead!")).toBe("Use /tmp instead!")
  })

  test("won't send nothing", async () => {
    const sent: Array<string> = []
    const exit = await Effect.runPromiseExit(Relay.make([recording("a", sent, "sent")]).send(thread, " / "))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(sent).toEqual([])
  })
})

describe("Origin", () => {
  test("reads the app from the environment", () => {
    expect(Origin.fromEnv({ __CFBundleIdentifier: "com.googlecode.iterm2" })).toEqual({ app: "com.googlecode.iterm2" })
    expect(Origin.fromEnv({})).toEqual({})
  })
})

describe("ClaudeCode", () => {
  const run = <A>(effect: Effect.Effect<A, never, ClaudeCode.Waiting>) =>
    Effect.runPromise(effect.pipe(Effect.provide(ClaudeCode.WaitingLive)))

  test("hands the waiting hook the reply", async () => {
    const reply = await run(
      Effect.gen(function* () {
        const waiting = yield* ClaudeCode.Waiting
        const ticket = yield* waiting.open("claude:s")
        const answer = yield* Effect.fork(waiting.reply(ticket))
        expect(yield* waiting.deliver("claude:s", "Merge it.")).toBe(true)
        return yield* Fiber.join(answer)
      }),
    )
    expect(reply).toBe("Merge it.")
  })

  test("has nowhere to deliver once the hook is let go", async () => {
    const taken = await run(
      Effect.gen(function* () {
        const waiting = yield* ClaudeCode.Waiting
        const ticket = yield* waiting.open("claude:s")
        yield* waiting.close(ticket)
        expect(yield* waiting.reply(ticket)).toBeUndefined()
        return yield* waiting.deliver("claude:s", "Merge it.")
      }),
    )
    expect(taken).toBe(false)
  })

  test("doesn't let an old update's end close a newer hook", async () => {
    const taken = await run(
      Effect.gen(function* () {
        const waiting = yield* ClaudeCode.Waiting
        const older = yield* waiting.open("claude:s")
        yield* waiting.open("claude:s")
        yield* waiting.close(older)
        return yield* waiting.deliver("claude:s", "Merge it.")
      }),
    )
    expect(taken).toBe(true)
  })

  test("only wakes Claude Code sessions", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const relay = yield* ClaudeCode.relay
        return yield* relay.send({ ...thread, agent: "codex" }, "Merge it.")
      }).pipe(Effect.provide(ClaudeCode.WaitingLive)),
    )
    expect(exit).toMatchObject({ _tag: "Failure", cause: { error: { _tag: "Unreachable" } } })
  })
})

describe("Codex", () => {
  test("queues only for sessions whose owner reads the queue", () => {
    expect(Codex.reads("codex-tui")).toBe(true)
    expect(Codex.reads("t3code_desktop")).toBe(false)
    expect(Codex.reads("codex_exec")).toBe(false)
  })
})
