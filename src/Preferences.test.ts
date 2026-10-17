import { describe, expect, test } from "bun:test"
import { Effect, Logger, Option } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answersTo } from "./Brain.ts"
import * as Preferences from "./Preferences.ts"

describe("Preferences", () => {
  test("his routines are read from the whole file, past what's cut for the rules, only under their heading, and never under a name yapd answers to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-preferences-"))
    const path = join(dir, "preferences.md")
    const read = await Effect.runPromise(Preferences.written(path, answersTo))
    const routines = () => Effect.runPromise(read.pipe(Effect.provide(Logger.replace(Logger.defaultLogger, Logger.none))))
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
      // The rules are still cut, the routines with them.
      expect(Option.getOrThrow(await Effect.runPromise(Preferences.load(path)))).not.toContain("## Routines")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
