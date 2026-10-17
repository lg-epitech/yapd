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

  test("relays one follow-up and reports how it went", async () => {
    const input = JSON.stringify({ thread: thread("rig"), text: "Merge it." })
    const sent: Array<string> = []
    const sending = Relay.make([{ send: (_, text) => Effect.sync(() => void sent.push(text)) }])
    expect(await Effect.runPromise(Remote.serve(sending, input))).toBe("{}")
    expect(sent).toEqual(["Merge it."])

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

  test("doesn't claim to know when the machine stops answering, after giving a worktree minutes", async () => {
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

  test("takes work as maybe started once yapd there said it has it, however SSH or yapd there ends after, and never before", async () => {
    /**
     * `yapd start` there, as SSH brings it back: given the request, it ends
     * as `ends` says before its answer gets here, with what it said on stderr
     * ahead of SSH's own.
     */
    const there =
      (ends: (said: string) => ProcessError): Remote.Exec =>
      (_, stdin) =>
        Effect.gen(function* () {
          const said: Array<string> = []
          yield* Launcher.serve(own, stdin, Effect.sync(() => void said.push(`${Launcher.asking}\n`)))
          return yield* ends(said.join(""))
        })
    /** Whether it may have started. */
    const through = (exec: Remote.Exec, asked: Launcher.Request = request) =>
      Effect.runPromise(
        Remote.launcher("rig", "rig", exec)
          .start(asked)
          .pipe(
            Effect.flip,
            Effect.map(({ sent }) => sent === true),
          ),
      )
    const dropped = (said: string) => new ProcessError({ command: "ssh", code: 255, stderr: `${said}client_loop: send disconnect: Broken pipe` })
    // The connection dropped while T3 Code there was getting it ready.
    expect(await through(there(dropped))).toBe(true)
    // An answer that can't be read may be work it started.
    expect(await through(() => Effect.succeed("Segmentation fault"))).toBe(true)
    // Never connected, or ended before it had anything to start, it can't have started.
    expect(await through(() => Effect.fail(new ProcessError({ command: "ssh", code: 255, stderr: "ssh: connect to host rig port 22: Connection refused" })))).toBe(false)
    expect(await through(there(dropped), { ...request, prompt: " " })).toBe(false)
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
  })
})
