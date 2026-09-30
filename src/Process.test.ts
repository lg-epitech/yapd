import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
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

const withProcess = async (code: (file: string) => string, check: (pids: ReadonlyArray<number>) => Promise<void>) => {
  const folder = await mkdtemp(join(tmpdir(), "yapd-process-test-"))
  const file = join(folder, "ready")
  const running = Effect.runFork(run([process.execPath, "-e", code(file)]))
  let pids: ReadonlyArray<number> = []
  try {
    for (let tries = 0; tries < 500 && !(await Bun.file(file).exists()); tries++) await Bun.sleep(10)
    pids = (await Bun.file(file).text()).trim().split(" ").map(Number)
    await Effect.runPromise(Fiber.interrupt(running))
    await check(pids)
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
})
