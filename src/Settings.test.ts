import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Settings from "./Settings.ts"

describe("Settings", () => {
  test("keeps what an older yapd remembered, from before its database had versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "yapd-settings-"))
    const path = join(root, "yapd.sqlite")
    try {
      const old = new Database(path)
      old.exec("create table settings (name text primary key, value text not null); insert into settings values ('on', 'false')")
      old.close()
      expect(await Effect.runPromise(Effect.scoped(Effect.flatMap(Settings.make(path), (settings) => settings.on)))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
