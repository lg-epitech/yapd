import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { note } from "./Hook.ts"
import * as Seen from "./Seen.ts"

const stop = { hook_event_name: "Stop" as const, session_id: "s", cwd: "/tmp", last_assistant_message: "Done." }

describe("Hook", () => {
  test("notes where the agent ran and what with, and never fails over it", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "yapd-hook-")))
    const file = join(dir, "kept", "projects.json")
    try {
      await Effect.runPromise(note("codex", { ...stop, cwd: dir, model: "gpt-6-astra" }, file))
      await Effect.runPromise(note("claude", { ...stop, cwd: dir }, file))
      expect(await Effect.runPromise(Seen.read(file))).toMatchObject({ [dir]: { agent: "claude" } })
      await Effect.runPromise(note("codex", { ...stop, cwd: dir, model: "gpt-6-sol" }, file))
      expect(await Effect.runPromise(Seen.read(file))).toMatchObject({ [dir]: { agent: "codex", model: "gpt-6-sol" } })
      // Nowhere it could write, which the hook mustn't fail over.
      await Effect.runPromise(note("codex", { ...stop, cwd: "/nowhere/at/all" }, "/dev/null/projects.json"))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
