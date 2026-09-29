import { describe, expect, test } from "bun:test"
import { Effect, Either, Exit } from "effect"
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
    const relay = Remote.relay(remotes, (command, stdin) =>
      Effect.sync(() => {
        calls.push({ command, stdin })
        return "welcome to rig\n{}\n"
      }),
    )
    await Effect.runPromise(relay.send(thread("Rig"), "Merge it; rm -rf ~"))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toEqual([
      "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "me@rig.example.com", "yapd", "relay",
    ])
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual({ thread: thread("Rig"), text: "Merge it; rm -rf ~" })
  })

  test("leaves threads from unlisted machines to the local relays", async () => {
    const relay = Remote.relay(remotes, () => Effect.die("not called"))
    expect(await Effect.runPromiseExit(relay.send(thread(), "Merge it."))).toMatchObject({ _tag: "Failure" })
    const unreachable = await Effect.runPromise(relay.send(thread("rosie"), "Merge it.").pipe(Effect.flip))
    expect(unreachable).toBeInstanceOf(Relay.Unreachable)
  })

  test("keeps local relays to this machine's threads", async () => {
    const sent: Array<string> = []
    const local = Remote.here(remotes)({ send: (_, text) => Effect.sync(() => void sent.push(text)) })
    await Effect.runPromise(local.send(thread(), "a"))
    await Effect.runPromise(local.send(thread("rosie"), "b"))
    const skipped = await Effect.runPromise(local.send(thread("rig"), "c").pipe(Effect.flip))
    expect(skipped).toBeInstanceOf(Relay.Unreachable)
    expect(sent).toEqual(["a", "b"])
  })

  test("says why the remote didn't send", async () => {
    const answering = (stdout: string) => Remote.relay(remotes, () => Effect.succeed(stdout))
    const failing = (code: number, stderr = "") =>
      Remote.relay(remotes, (command) => Effect.fail(new ProcessError({ command: command.join(" "), code, stderr })))
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
      JSON.stringify({ reason: "I can't reach that session from here." }),
    )
    expect(JSON.parse(await Effect.runPromise(Remote.serve(sending, "{}")))).toHaveProperty("reason")
  })

  test("reads a .env file", () => {
    expect(
      Remote.dotenv(
        ['# comment', 'YAPD_T3CODE_TOKEN=abc', 'export YAPD_STYLE="Call me sir. # not a comment"', "EMPTY=", "LANG=fr # note", "QUOTED='x' # note", "bad line"].join("\n"),
      ),
    ).toEqual({ YAPD_T3CODE_TOKEN: "abc", YAPD_STYLE: "Call me sir. # not a comment", EMPTY: "", LANG: "fr", QUOTED: "x" })
  })
})
