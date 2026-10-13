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

  test("his routines are read from the whole file, past what's cut for the rules, and only under their heading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-preferences-"))
    const path = join(dir, "preferences.md")
    try {
      expect(await Effect.runPromise(Preferences.written(path))).toEqual([])
      const long = `Fable on high for hard bugs.\n- Opus 5.5: everyday features.\n\n${"No worktree for questions. ".repeat(300)}`
      await Bun.write(path, `${long}\n\n## Routines\n\n- ship it: Merge the PR once checks pass, then update the dev worktree and reinstall yapd.\n- "Review it": Have Sol review it until it's clean.\n- ship IT: Something else.\nNot a routine.\n\n## Later\n- not one: Never sent.\n`)
      expect(await Effect.runPromise(Preferences.written(path))).toEqual([
        { name: "ship it", steps: "Merge the PR once checks pass, then update the dev worktree and reinstall yapd." },
        { name: "Review it", steps: "Have Sol review it until it's clean." },
      ])
      // The rules are still cut, the routines with them.
      expect(Option.getOrThrow(await Effect.runPromise(Preferences.load(path)))).not.toContain("## Routines")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
