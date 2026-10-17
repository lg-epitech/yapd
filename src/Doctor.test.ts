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

  test("are broken when the copy they run has gone", async () => {
    const hooks = Setup.merge({}, Setup.claude(Setup.command(process.execPath, "/gone/yapd/src/main.ts")))
    const [finding] = await check(hooks, here)
    expect(finding?.status).toBe("fail")
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
  })
})
