import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Doctor from "./Doctor.ts"
import * as Setup from "./Setup.ts"

/** Claude Code's hooks as they're written, checked against the yapd at `main`. */
const check = async (hooks: object | undefined, main: string) => {
  const dir = await mkdtemp(join(tmpdir(), "yapd-doctor-"))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    if (hooks !== undefined) await Bun.write(join(dir, "settings.json"), JSON.stringify({ hooks }))
    return await Effect.runPromise(Doctor.hooks("claude", Setup.command(process.execPath, main)))
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
}

/** This yapd, which is there. */
const here = join(import.meta.dir, "main.ts")

describe("hooks", () => {
  test("are fine when they run this yapd", async () => {
    const hooks = Setup.merge({}, Setup.claude(Setup.command(process.execPath, here)))
    expect((await check(hooks, here)).map(({ status }) => status)).toEqual(["ok"])
  })

  test("are broken when there are none", async () => {
    const [finding] = await check(undefined, here)
    expect(finding).toEqual({ status: "fail", text: expect.stringContaining("no Stop or UserPromptSubmit hook") })
  })

  test("point elsewhere when they run another copy that's still there", async () => {
    const hooks = Setup.merge({}, Setup.claude(Setup.command(process.execPath, here)))
    const [finding] = await check(hooks, "/somewhere/else/src/main.ts")
    expect(finding?.status).toBe("warn")
  })

  test("are broken when the copy they run has gone", async () => {
    const hooks = Setup.merge({}, Setup.claude(Setup.command(process.execPath, "/gone/yapd/src/main.ts")))
    const [finding] = await check(hooks, here)
    expect(finding).toEqual({ status: "fail", text: expect.stringContaining("/gone/yapd/src/main.ts, which isn't there any more") })
  })
})

describe("Codex hook trust", () => {
  const hook = { command: "yapd hook codex", enabled: true, trustStatus: "trusted" }
  const check = (overrides: Partial<typeof hook> = {}, others: Array<typeof hook> = []) =>
    Doctor.codexTrust({ data: [{ hooks: [{ ...hook, ...overrides }, ...others] }] })

  test("accepts saved trust and ignores unrelated hooks needing review", () => {
    expect(check({}, [{ ...hook, command: "another-tool", trustStatus: "untrusted" }])).toEqual([
      { status: "ok", text: expect.stringContaining("Trust survives restarts") },
    ])
  })

  test.each([
    ["untrusted", "hasn't trusted"],
    ["modified", "changed since they were trusted"],
  ])("fails for %s hooks instead of treating registration as sufficient", (trustStatus, reason) => {
    expect(check({ trustStatus })).toEqual([
      { status: "fail", text: expect.stringContaining(reason) },
    ])
    expect(check({ trustStatus })[0]?.text).toContain("/hooks on this machine")
  })

  test("fails for disabled hooks even when they're trusted", () => {
    expect(check({ enabled: false })).toEqual([
      { status: "fail", text: expect.stringContaining("disabled hooks") },
    ])
  })

  test("doesn't claim success when Codex omits the hooks or returns an unknown status", () => {
    expect(Doctor.codexTrust({ data: [] })[0]?.status).toBe("warn")
    expect(check({ trustStatus: "unknown" })[0]?.status).toBe("warn")
  })
})
