import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Settings from "./Settings.ts"

describe("Settings", () => {
  test("is on until turned off, which lasts across restarts, in a private file", async () => {
    const root = await mkdtemp(join(tmpdir(), "yapd-settings-"))
    const path = join(root, "nested", "yapd.sqlite")
    const opened = <A, E>(use: (settings: Settings.Settings["Type"]) => Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.scoped(Effect.flatMap(Settings.make(path), use)))
    try {
      expect(await opened((settings) => settings.on)).toBe(true)
      await opened((settings) => settings.remember(false))
      expect(await opened((settings) => settings.on)).toBe(false)
      await opened((settings) => settings.remember(true))
      expect(await opened((settings) => settings.on)).toBe(true)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
