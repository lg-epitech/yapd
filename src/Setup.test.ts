import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Setup from "./Setup.ts"

const run = Setup.command("/Users/me/.bun/bin/bun", "/Users/me/.bun/install/global/node_modules/@launatic/yapd/src/main.ts")

const format = { type: "command", command: "prettier --write ." }

describe("command", () => {
  test("runs yapd by full paths, quoted only when they need it", () => {
    expect(Setup.command("/opt/bun", "/Users/me/My Projects/yapd's/src/main.ts")("codex", false)).toBe(
      `/opt/bun --no-env-file '/Users/me/My Projects/yapd'\\''s/src/main.ts' hook codex`,
    )
  })

  test("is known for yapd's, however it was set up", () => {
    expect(Setup.ours({ command: run("claude", true) })).toBe(true)
    expect(Setup.ours({ command: "yapd hook claude --wait" })).toBe(true)
    expect(Setup.ours(format)).toBe(false)
    expect(Setup.ours({ command: "bun /Users/me/yapd-notes/src/main.ts hook claude" })).toBe(false)
  })
})

describe("merge", () => {
  test("puts yapd's hook where the old one was, and leaves the user's own alone", () => {
    const hooks = {
      Stop: [{ hooks: [format, { type: "command", command: "bun /old/yapd/src/main.ts hook claude --wait", async: true }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [format] }],
    }
    const merged = Setup.merge(hooks, Setup.claude(run))
    expect(merged.Stop).toEqual([{ hooks: [format, Setup.claude(run).Stop!] }])
    expect(merged.PreToolUse).toEqual(hooks.PreToolUse)
    expect(merged.UserPromptSubmit).toEqual([{ hooks: [Setup.claude(run).UserPromptSubmit!] }])
  })
})

describe("install", () => {
  test("writes Claude Code's hooks next to the user's other settings, and keeps the file as it was", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-setup-"))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    const file = join(dir, "settings.json")
    try {
      await Bun.write(file, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [format] }] } }))
      chmodSync(file, 0o600)
      await Effect.runPromise(Setup.install("claude", run))
      const written = JSON.parse(readFileSync(file, "utf8"))
      expect(written.model).toBe("opus")
      expect(written.hooks.Stop).toEqual([{ hooks: [format] }, { hooks: [Setup.claude(run).Stop] }])
      expect(JSON.parse(readFileSync(`${file}.before-yapd`, "utf8")).hooks.Stop).toEqual([{ hooks: [format] }])
      // It can hold keys, so it stays as private as it was.
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(`${file}.before-yapd`).mode & 0o777).toBe(0o600)
      expect((await Effect.runPromise(Setup.install("claude", run))).changed).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("leaves a file it can't read alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-setup-"))
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = dir
    const file = join(dir, "hooks.json")
    try {
      await Bun.write(file, "{ not json")
      await Effect.runPromise(Effect.flip(Setup.install("codex", run)))
      expect(readFileSync(file, "utf8")).toBe("{ not json")
      expect(existsSync(`${file}.before-yapd`)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
})
