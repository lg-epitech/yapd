import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "./Process.ts"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const withProcess = async (code: (file: string) => string, check: (pids: ReadonlyArray<number>, file: string) => Promise<void>) => {
  const folder = await mkdtemp(join(tmpdir(), "yapd-process-test-"))
  const file = join(folder, "ready")
  const running = Effect.runFork(run([process.execPath, "-e", code(file)]))
  let pids: ReadonlyArray<number> = []
  try {
    for (let tries = 0; tries < 500 && !(await Bun.file(file).exists()); tries++) await Bun.sleep(10)
    pids = (await Bun.file(file).text()).trim().split(" ").map(Number)
    await Effect.runPromise(Fiber.interrupt(running))
    await check(pids, file)
  } finally {
    await Effect.runPromise(Fiber.interrupt(running))
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL")
    await rm(folder, { recursive: true, force: true })
  }
}

describe("Process", () => {
  test("fails, rather than dies, when the command can't start", async () => {
    const error = await Effect.runPromise(Effect.flip(run([join(tmpdir(), "yapd-no-such-command")])))
    expect(error).toMatchObject({ _tag: "ProcessError", code: -1 })
  })

  test("runs in the given directory", async () => {
    expect((await Effect.runPromise(run(["pwd"], { cwd: "/" }))).trim()).toBe("/")
  })

  // Like `ssh -O check`, which says the connection's process there.
  test("gives what a command wrote to stderr too, only when asked to", async () => {
    const both = ["sh", "-c", "echo out; echo err >&2"]
    expect(await Effect.runPromise(Effect.all([run(both, { both: true }), run(both)]))).toEqual(["out\nerr\n", "out\n"])
  })

  // Like the proxy an SSH connection goes through, which stays behind in the group when the connection goes into the background.
  test("leaves what a command put in the background running once it succeeds, only when asked to", async () => {
    const helper = ["sh", "-c", "sleep 30 >/dev/null 2>&1 </dev/null & echo $!"]
    const pids: Array<number> = []
    try {
      for (const leave of [true, false]) pids.push(Number((await Effect.runPromise(run(helper, { leave }))).trim()))
      expect(pids.map(alive)).toEqual([true, false])
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL")
    }
  })

  // SSH leaves its own stderr to a ProxyCommand or ProxyJump proxy, which keeps it for as long as the connection lasts.
  test("finishes when a command that leaves something running has, even when that keeps the command's output", async () => {
    const pids: Array<number> = []
    try {
      const done = await Effect.runPromise(
        Effect.timeoutOption(run(["sh", "-c", "sleep 30 </dev/null & echo $!"], { leave: true }), "2 seconds"),
      )
      pids.push(...Option.toArray(done).map((stdout) => Number(stdout.trim())))
      expect(pids.map(alive)).toEqual([true])
      // What went wrong is still said, though what it left running keeps writing where it's read from.
      const failed = await Effect.runPromise(
        Effect.flip(Effect.timeout(run(["sh", "-c", "sleep 30 </dev/null & echo nope >&2; exit 3"], { leave: true }), "2 seconds")),
      )
      expect(failed).toMatchObject({ _tag: "ProcessError", code: 3, stderr: "nope" })
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL")
    }
  })

  test("kills and reaps a command that ignores graceful termination", () => withProcess(
    (file) => `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); await Bun.write(${JSON.stringify(file)}, String(process.pid));`,
    async ([pid]) => { expect(pid !== undefined && alive(pid)).toBe(false) },
  ))

  test("also stops a command's subprocesses when their parent exits first", () => withProcess(
    (file) => {
      const ready = `${file}-child`
      const child = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); await Bun.write(${JSON.stringify(ready)}, "ready");`
      return `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); while (!(await Bun.file(${JSON.stringify(ready)}).exists())) await Bun.sleep(5); await Bun.write(${JSON.stringify(file)}, process.pid + " " + child.pid); setInterval(() => {}, 1000);`
    },
    async (pids) => {
      for (let tries = 0; tries < 100 && pids.some(alive); tries++) await Bun.sleep(10)
      expect(pids.filter(alive)).toEqual([])
    },
  ))

  test("gives subprocesses time to finish graceful shutdown after their parent exits", () => withProcess(
    (file) => {
      const ready = `${file}-child`
      const cleaned = `${file}-cleaned`
      const child = `process.on("SIGTERM", () => { setTimeout(async () => { await Bun.write(${JSON.stringify(cleaned)}, "cleaned"); process.exit(0); }, 100); }); setInterval(() => {}, 1000); await Bun.write(${JSON.stringify(ready)}, "ready");`
      return `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); while (!(await Bun.file(${JSON.stringify(ready)}).exists())) await Bun.sleep(5); await Bun.write(${JSON.stringify(file)}, process.pid + " " + child.pid); setInterval(() => {}, 1000);`
    },
    async (pids, file) => {
      expect(await Bun.file(`${file}-cleaned`).exists()).toBe(true)
      for (let tries = 0; tries < 100 && pids.some(alive); tries++) await Bun.sleep(10)
      expect(pids.filter(alive)).toEqual([])
    },
  ))
})
