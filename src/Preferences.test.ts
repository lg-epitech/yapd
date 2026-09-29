import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Preferences from "./Preferences.ts"

describe("Preferences", () => {
  test("reads the user's rules as they wrote them, each time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-preferences-"))
    const path = join(dir, "preferences.md")
    try {
      expect(await Effect.runPromise(Preferences.load(path))).toEqual(Option.none())
      await Bun.write(path, "\nFable on high for hard bugs.\n\nNo worktree for questions.\n")
      expect(await Effect.runPromise(Preferences.load(path))).toEqual(Option.some("Fable on high for hard bugs.\n\nNo worktree for questions."))
      await Bun.write(path, "Opus for everything.")
      expect(await Effect.runPromise(Preferences.load(path))).toEqual(Option.some("Opus for everything."))
      await Bun.write(path, "  \n")
      expect(await Effect.runPromise(Preferences.load(path))).toEqual(Option.none())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
