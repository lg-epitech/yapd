import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Option, Schedule } from "effect"
import { fstatSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Cli from "./Cli.ts"
import * as Minder from "./Minder.ts"
import * as Sessions from "./Sessions.ts"

const session: Sessions.Session = {
  launch: "launch-1",
  agent: "claude",
  session: "session-1",
  project: "free-sound",
  directory: "/code/free-sound",
  repository: true,
  model: "claude-fable-5-1",
  prompt: "Fix the loader.",
  resume: false,
  state: "running",
  at: "2026-09-29T18:00:00.000Z",
}

const fine = { code: 0, stderr: "" }

const pickUp = "To go on from there, pick it up in a terminal with: cd /code/free-sound && claude --resume session-1"

const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "yapd-minder-test-"))),
  use,
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

const open = (fd: number) => {
  try {
    fstatSync(fd)
    return true
  } catch {
    return false
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidAt = (path: string) => Effect.tryPromise(() => Bun.file(path).text()).pipe(
  Effect.map((text) => Number(text)),
  Effect.retry(Schedule.spaced("5 millis")),
  Effect.timeout("3 seconds"),
)

describe("Minder", () => {
  test("says what the agent was refused or why it stopped short, and how to pick it up", () => {
    expect(Minder.report(session, { ...Cli.silence, began: true, message: "Done." }, fine)).toBeUndefined()
    const heard: Cli.Heard = {
      began: true,
      message: "I need your permission to write the file.",
      denied: [
        { tool: "Write", input: { file_path: "/code/free-sound/probe.txt" } },
        { tool: "Write", input: { file_path: "/code/free-sound/probe.txt" } },
        { tool: "Bash", input: { command: "git push" } },
      ],
    }
    expect(Minder.report(session, heard, fine)).toBe(
      `I need your permission to write the file.\n\nIt needs you: it ran with nobody there to approve things, so it was refused when it tried to change probe.txt, run "git push". ${pickUp}`,
    )
    // In the command line's words, when it stopped short.
    const log = Sessions.log("launch-1")
    expect(Minder.report(session, { ...Cli.silence, error: "You've hit your usage limit" }, { code: 1, stderr: "" })).toBe(
      `It stopped before it was done. You've hit your usage limit. ${pickUp} Everything it printed is in ${log}`,
    )
  })

  test("tells the daemon as the hook that ends a turn would, marked so it isn't skipped", () => {
    expect(Minder.notice(session, "It needs you.")).toEqual({
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: "/code/free-sound",
      last_assistant_message: "It needs you.",
      needs_you: true,
    })
  })

  test("closes the launching process's log descriptor after every minder starts", async () => {
    const result = await Effect.runPromise(withRoot((root) => Effect.gen(function* () {
      const descriptors: Array<number> = []
      const closed: Array<boolean> = []
      let unreferenced = 0
      const start = Minder.makeStart(root, (launch, output) => {
        descriptors.push(output)
        writeFileSync(Sessions.record(launch, root), JSON.stringify({ ...session, launch, state: "running" }))
        return { unref: () => { unreferenced++ } }
      })
      for (let i = 0; i < 3; i++) {
        yield* start({ ...session, launch: `launch-${i}` })
        closed.push(!open(descriptors.at(-1)!))
      }
      return { closed, unreferenced }
    })))
    expect(result.closed).toEqual([true, true, true])
    expect(result.unreferenced).toBe(3)
  })

  test("closes the log descriptor when spawning the minder throws", async () => {
    const result = await Effect.runPromise(withRoot((root) => Effect.gen(function* () {
      let descriptor: number | undefined
      const cause = new Error("Couldn't spawn")
      const start = Minder.makeStart(root, (_, output) => {
        descriptor = output
        throw cause
      })
      const outcome = yield* Effect.exit(start(session))
      return { outcome, closed: descriptor !== undefined && !open(descriptor), cause }
    })))
    expect(result.closed).toBe(true)
    expect(Exit.isFailure(result.outcome) && Array.from(Cause.failures(result.outcome.cause))[0]).toMatchObject({
      _tag: "MindError",
      cause: result.cause,
    })
  })

  test("reports an initial storage failure through MindError before spawning", async () => {
    let spawned = false
    const outcome = await Effect.runPromise(Effect.exit(Minder.makeStart("/dev/null/yapd", () => {
      spawned = true
      return { unref: () => {} }
    })(session)))
    expect(spawned).toBe(false)
    expect(Exit.isFailure(outcome) && Array.from(Cause.failures(outcome.cause))[0]).toMatchObject({
      _tag: "MindError",
      cause: { _tag: "StorageError" },
    })
  })

  test("records the session and final message while consuming both output streams", async () => {
    const result = await Effect.runPromise(withRoot((root) => Effect.gen(function* () {
      yield* Sessions.write({ ...session, directory: root, state: "starting" }, root)
      yield* Minder.mind(session.launch, root, [process.execPath, "-e", `
        console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "named-session" }));
        console.log(JSON.stringify({ type: "assistant", message: { model: "fake-model" } }));
        process.stderr.write("a diagnostic\\n");
        process.stdout.write(JSON.stringify({ type: "result", result: "Done, café.", is_error: false }));
      `])
      return { record: yield* Sessions.read(session.launch, root), log: yield* Effect.promise(() => Bun.file(Sessions.log(session.launch, root)).text()) }
    })))
    expect(result.record).toMatchObject(Option.some({ ...session, directory: expect.any(String), session: "named-session", state: "idle" }))
    expect(result.log).toContain("a diagnostic")
    expect(result.log).toContain("Done, café.")
  })

  test("interrupting a minder terminates and reaps its running agent", async () => {
    const result = await Effect.runPromise(Effect.scoped(withRoot((root) => Effect.gen(function* () {
      const pidFile = join(root, "agent.pid")
      yield* Sessions.write({ ...session, directory: root, state: "starting" }, root)
      const fiber = yield* Minder.mind(session.launch, root, [process.execPath, "-e", `
        import { writeFileSync } from "node:fs";
        process.on("SIGTERM", () => {});
        writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "named-session" }));
        console.log(JSON.stringify({ type: "assistant", message: { model: "fake-model" } }));
        setInterval(() => {}, 1000);
      `]).pipe(Effect.forkScoped)
      const pid = yield* pidAt(pidFile)
      yield* Sessions.read(session.launch, root).pipe(
        Effect.flatMap(Option.filter(({ state }) => state === "running")),
        Effect.retry(Schedule.spaced("5 millis")),
        Effect.timeout("3 seconds"),
      )
      const exit = yield* Fiber.interrupt(fiber)
      return { alive: alive(pid), interrupted: Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause) }
    }))))
    expect(result.interrupted).toBe(true)
    expect(result.alive).toBe(false)
  })

  test("a state write failure after spawning reaps the agent and preserves StorageError", async () => {
    const result = await Effect.runPromise(withRoot((root) => Effect.gen(function* () {
      const pidFile = join(root, "agent.pid")
      const record = Sessions.record(session.launch, root)
      yield* Sessions.write({ ...session, directory: root, state: "starting" }, root)
      const outcome = yield* Effect.exit(Minder.mind(session.launch, root, [process.execPath, "-e", `
        import { mkdirSync, rmSync, writeFileSync } from "node:fs";
        process.on("SIGTERM", () => {});
        writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        rmSync(${JSON.stringify(record)});
        mkdirSync(${JSON.stringify(record)});
        console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "named-session" }));
        console.log(JSON.stringify({ type: "assistant", message: { model: "fake-model" } }));
        setInterval(() => {}, 1000);
      `]))
      const pid = yield* pidAt(pidFile)
      return { outcome, alive: alive(pid), record }
    })))
    expect(result.alive).toBe(false)
    expect(Exit.isFailure(result.outcome) && Array.from(Cause.failures(result.outcome.cause))[0]).toMatchObject({
      _tag: "StorageError",
      path: result.record,
    })
  })
})
