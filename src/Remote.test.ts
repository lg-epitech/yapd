import { describe, expect, test } from "bun:test"
import { Effect, Either, Exit, Option, TestClock, TestContext } from "effect"
import * as Launcher from "./Launcher.ts"
import { ProcessError } from "./Process.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"

const thread = (host?: string): Relay.Thread => ({
  agent: "claude",
  session: "s",
  cwd: "/home/me/repo",
  message: "Done.",
  origin: host === undefined ? {} : { host },
})

const remotes = new Map([["rig", "me@rig.example.com"]])

const reason = (exit: Exit.Exit<void, unknown>) =>
  Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof Relay.RelayError
    ? exit.cause.error.reason
    : undefined

describe("Remote", () => {
  test("reads hosts and their destinations", () => {
    expect(Remote.parse(" rig , box=me@box.example.com,,")).toEqual(
      Either.right(new Map([["rig", "rig"], ["box", "me@box.example.com"]])),
    )
    expect(Remote.parse("")).toEqual(Either.right(new Map()))
    expect(Either.isLeft(Remote.parse("=box"))).toBe(true)
    expect(Either.isLeft(Remote.parse("box=-oProxyCommand=evil"))).toBe(true)
  })

  test("runs yapd relay on the thread's machine, with the message on stdin", async () => {
    const calls: Array<{ command: ReadonlyArray<string>; stdin: string }> = []
    const relay = Remote.relay(remotes, () => "rosie", (command, stdin) =>
      Effect.sync(() => {
        calls.push({ command, stdin })
        return "welcome to rig\n{}\n"
      }),
    )
    await Effect.runPromise(relay.send(thread("Rig"), "Merge it; rm -rf ~"))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toEqual([
      "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "--", "me@rig.example.com", "cd / && yapd relay",
    ])
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual({ thread: thread("Rig"), text: "Merge it; rm -rf ~" })
  })

  test("leaves this machine's threads to the local relays", async () => {
    const relay = Remote.relay(remotes, () => "Rosie", () => Effect.die("not called"))
    for (const local of [thread(), thread("rosie")]) {
      expect(await Effect.runPromise(relay.send(local, "Merge it.").pipe(Effect.flip))).toBeInstanceOf(Relay.Unreachable)
    }
  })

  test("says so when another machine isn't listed", async () => {
    const relay = Remote.relay(remotes, () => "rosie", () => Effect.die("not called"))
    expect(reason(await Effect.runPromiseExit(relay.send(thread("box"), "Merge it.")))).toBe(
      "I don't know how to reach box. It needs adding to YAPD_REMOTES.",
    )
  })

  test("keeps local relays to this machine's threads", async () => {
    const sent: Array<string> = []
    const local = Remote.here(() => "Rosie")({ send: (_, text) => Effect.sync(() => void sent.push(text)) })
    await Effect.runPromise(local.send(thread(), "a"))
    await Effect.runPromise(local.send(thread("rosie"), "b"))
    // Listed or not, another machine's thread could share a path and message with one here.
    for (const [host, text] of [["rig", "c"], ["box", "d"]] as const) {
      expect(await Effect.runPromise(local.send(thread(host), text).pipe(Effect.flip))).toBeInstanceOf(Relay.Unreachable)
    }
    expect(sent).toEqual(["a", "b"])
  })

  test("says why the remote didn't send", async () => {
    const answering = (stdout: string) => Remote.relay(remotes, () => "rosie", () => Effect.succeed(stdout))
    const failing = (code: number, stderr = "") =>
      Remote.relay(remotes, () => "rosie", (command) => Effect.fail(new ProcessError({ command: command.join(" "), code, stderr })))
    const send = (relay: Relay.Relay) => Effect.runPromiseExit(relay.send(thread("rig"), "Merge it."))

    expect(reason(await send(answering('{"reason":"It\'s in the middle of another turn."}')))).toBe(
      "It's in the middle of another turn.",
    )
    expect(reason(await send(failing(255)))).toBe("I can't reach rig.")
    expect(reason(await send(failing(127)))).toBe("yapd isn't on rig's path.")
    expect(reason(await send(failing(1, "usage: yapd serve | yapd install")))).toBe("yapd on rig needs updating.")
    expect(reason(await send(answering("not json")))).toBe("yapd on rig answered in a way I don't understand.")
  })

  test("relays one follow-up and reports how it went", async () => {
    const input = JSON.stringify({ thread: thread("rig"), text: "Merge it." })
    const sent: Array<string> = []
    const sending = Relay.make([{ send: (_, text) => Effect.sync(() => void sent.push(text)) }])
    expect(await Effect.runPromise(Remote.serve(sending, input))).toBe("{}")
    expect(sent).toEqual(["Merge it."])

    expect(await Effect.runPromise(Remote.serve(Relay.make([]), input))).toBe(
      JSON.stringify({ reason: "I can't reach that work from here." }),
    )
    expect(JSON.parse(await Effect.runPromise(Remote.serve(sending, "{}")))).toHaveProperty("reason")
  })
})

describe("Remote launcher", () => {
  const request: Launcher.Request = { project: "free-sound", prompt: "Fix the loader; rm -rf ~", worktree: true }
  const started: Launcher.Started = {
    thread: "thread-1",
    project: "free-sound",
    directory: "/home/me/.t3/worktrees/free-sound/t3code-0a1b2c3d",
    branch: "t3code/0a1b2c3d",
    model: "claude-fable-5-1",
    worktree: true,
  }
  const own: Launcher.Launcher = {
    start: () => Effect.succeed({ ...started, directory: "/code/free-sound" }),
    catalog: Effect.succeed({ projects: [], models: [] }),
  }
  const why = <A>(effect: Effect.Effect<A, Launcher.LaunchError>) =>
    Effect.runPromise(effect.pipe(Effect.flip, Effect.map(({ reason }) => reason)))
  const answering = (stdout: string) => Remote.launcher("rig", "me@rig.example.com", () => Effect.succeed(stdout))
  const failing = (code: number, stderr = "") =>
    Remote.launcher("rig", "me@rig.example.com", (command) => Effect.fail(new ProcessError({ command: command.join(" "), code, stderr })))

  test("runs yapd start on the machine, with the request on stdin", async () => {
    const calls: Array<{ command: ReadonlyArray<string>; stdin: string }> = []
    const launcher = Remote.launcher("rig", "me@rig.example.com", (command, stdin) =>
      Effect.sync(() => {
        calls.push({ command, stdin })
        return `welcome to rig\n${JSON.stringify({ started, catalog: { projects: [], models: [] } })}\n`
      }),
    )
    expect(await Effect.runPromise(launcher.start(request))).toEqual(started)
    expect(calls[0]?.command).toEqual([
      "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "--", "me@rig.example.com", "cd / && yapd start",
    ])
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual(request)
    expect(await Effect.runPromise(launcher.catalog)).toEqual({ projects: [], models: [] })
    expect(calls[1]?.command.at(-1)).toBe("cd / && yapd catalog")
  })

  test("says why the machine didn't start it, and doesn't claim to know when it stops answering", async () => {
    expect(await why(answering('{"reason":"T3 Code isn\'t running."}').start(request))).toBe("T3 Code isn't running.")
    expect(await why(failing(255).start(request))).toBe("I can't reach rig.")
    expect(await why(failing(1, "usage: yapd serve | yapd install").start(request))).toBe("yapd on rig needs updating.")
    expect(await why(answering("not json").start(request))).toBe("yapd on rig answered in a way I don't understand.")
    const silent = Remote.launcher("rig", "rig", () => Effect.never)
    /** How a start that never hears back stands after a while: still waiting, or given up and why. */
    const after = (duration: `${number} minutes`) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(Effect.flip(silent.start(request)))
          yield* TestClock.adjust(duration)
          const exit = Option.getOrUndefined(yield* fiber.poll)
          return exit === undefined ? "waiting" : Exit.isSuccess(exit) ? exit.value.reason : "failed"
        }).pipe(Effect.provide(TestContext.TestContext)),
      )
    // A worktree can take minutes.
    expect(await after("6 minutes")).toBe("waiting")
    expect(await after("7 minutes")).toBe("rig isn't answering, so I don't know if it started.")
  })

  test("says when the machine's T3 Code may have started it all the same, as it does there, or it stops answering, and never when nothing started", async () => {
    /** What `yapd start` there makes of what its own launcher came to, as it comes back here: the reason, and whether it may have started. */
    const through = (start: Launcher.Launcher["start"]) =>
      Effect.runPromise(
        Remote.launcher("rig", "rig", (_, stdin) => Launcher.serve({ ...own, start }, stdin))
          .start(request)
          .pipe(
            Effect.flip,
            Effect.map(({ reason, sent }) => ({ reason, sent: sent === true })),
          ),
      )
    // T3 Code there took it, and its answer was lost.
    expect(await through(() => Effect.fail(new Launcher.LaunchError({ reason: "T3 Code is taking too long, so I don't know if it started.", sent: true })))).toEqual({
      reason: "T3 Code is taking too long, so I don't know if it started.",
      sent: true,
    })
    expect(await through(() => Effect.fail(new Launcher.LaunchError({ reason: "T3 Code isn't running." })))).toEqual({ reason: "T3 Code isn't running.", sent: false })
    // It was handed to yapd there, which never answered.
    const silent = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.flip(Remote.launcher("rig", "rig", () => Effect.never).start(request)))
        yield* TestClock.adjust("7 minutes")
        return yield* fiber
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect({ reason: silent.reason, sent: silent.sent === true }).toEqual({ reason: "rig isn't answering, so I don't know if it started.", sent: true })
    // Never handed over, it can't have started.
    expect((await Effect.runPromise(Effect.flip(failing(255).start(request)))).sent).toBeUndefined()
  })

  test("picks the launcher by the machine's name, which for this one can be what the user calls it", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const launchers = Remote.launchers(
      remotes,
      () => "Laurents-MacBook-Pro.local",
      own,
      (command) =>
        Effect.sync(() => {
          calls.push(command)
          return JSON.stringify({ started })
        }),
      "Rosie",
    )
    for (const here of [undefined, "", " Rosie ", "laurents-macbook-pro"]) {
      expect((await Effect.runPromise(launchers(here).start(request))).directory).toBe("/code/free-sound")
    }
    expect(calls).toEqual([])
    expect(await Effect.runPromise(launchers("Rig").start(request))).toEqual(started)
    expect(calls[0]?.at(-2)).toBe("me@rig.example.com")
    expect(await why(launchers("box").start(request))).toBe("I don't know how to reach box. It needs adding to YAPD_REMOTES.")
  })

  test("goes through the SSH connection to the machine that's open already, and connects as before when there's none", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    let open = true
    const launchers = Remote.launchers(
      remotes,
      () => "rosie",
      own,
      (command) =>
        Effect.sync(() => {
          calls.push(command)
          return JSON.stringify({ started })
        }),
      undefined,
      (host) => Effect.sync(() => (open && host === "rig" ? Option.some("/home/me/.yapd/ssh-rig.sock") : Option.none())),
    )
    await Effect.runPromise(launchers("Rig").start(request))
    open = false
    await Effect.runPromise(launchers("Rig").start(request))
    expect(calls).toEqual([
      ["ssh", "-S", "/home/me/.yapd/ssh-rig.sock", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "--", "me@rig.example.com", "cd / && yapd start"],
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "--", "me@rig.example.com", "cd / && yapd start"],
    ])
  })
})
