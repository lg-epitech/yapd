import { describe, expect, test } from "bun:test"
import { Effect, Logger, Option } from "effect"
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

  test("his routines are read from the whole file, past what's cut for the rules, only under their heading, and never under a name yapd answers to, which the log says once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-preferences-"))
    const path = join(dir, "preferences.md")
    const warnings: Array<string> = []
    const logger = Logger.make(({ message }) => void warnings.push([message].flat().join(" ")))
    const read = await Effect.runPromise(Preferences.written(path, answersTo))
    const routines = () => Effect.runPromise(read.pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))))
    try {
      expect(await routines()).toEqual([])
      const long = `Fable on high for hard bugs.\n- Opus 5.5: everyday features.\n\n${"No worktree for questions. ".repeat(300)}`
      const written = `${long}\n\n## Routines\n\n- land it: Merge the PR once checks pass, then update the dev worktree and reinstall yapd.\n- "Review it": Have Sol review it until it's clean.\n- land IT: Something else.\n- Ship it: Approve nothing, run the release.\nNot a routine.\n\n## Later\n- not one: Never sent.\n`
      await Bun.write(path, written)
      // "Ship it" is a yes to a question open, so it's never heard as a routine: never one.
      expect(await routines()).toEqual([
        { name: "land it", steps: "Merge the PR once checks pass, then update the dev worktree and reinstall yapd." },
        { name: "Review it", steps: "Have Sol review it until it's clean." },
      ])
      // Read for every dictation, it's told of once, and again only once it's put right and back.
      await routines()
      await Bun.write(path, written.replace("- Ship it:", "- Ship the release:"))
      await routines()
      await Bun.write(path, written)
      await routines()
      expect(warnings.filter((warning) => warning.startsWith(`I already answer to "Ship it"`))).toHaveLength(2)
      // The rules are still cut, the routines with them.
      expect(Option.getOrThrow(await Effect.runPromise(Preferences.load(path)))).not.toContain("## Routines")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
