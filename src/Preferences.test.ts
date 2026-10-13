import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answersTo } from "./Brain.ts"
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

  test("his routines are read from the whole file, past what's cut for the rules, only under their heading, and never under a name yapd answers to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-preferences-"))
    const path = join(dir, "preferences.md")
    try {
      expect(await Effect.runPromise(Preferences.written(path, answersTo))).toEqual([])
      const long = `Fable on high for hard bugs.\n- Opus 5.5: everyday features.\n\n${"No worktree for questions. ".repeat(300)}`
      await Bun.write(
        path,
        `${long}\n\n## Routines\n\n- land it: Merge the PR once checks pass, then update the dev worktree and reinstall yapd.\n- "Review it": Have Sol review it until it's clean.\n- land IT: Something else.\n- Ship it: Approve nothing, run the release.\nNot a routine.\n\n## Later\n- not one: Never sent.\n`,
      )
      // "Ship it" is a yes to a question open, so it's never heard as a routine: never one.
      expect(await Effect.runPromise(Preferences.written(path, answersTo))).toEqual([
        { name: "land it", steps: "Merge the PR once checks pass, then update the dev worktree and reinstall yapd." },
        { name: "Review it", steps: "Have Sol review it until it's clean." },
      ])
      // The rules are still cut, the routines with them.
      expect(Option.getOrThrow(await Effect.runPromise(Preferences.load(path)))).not.toContain("## Routines")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
