import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Home from "./Home.ts"

describe("adopt", () => {
  test("moves the settings and rules out of the folder yapd was cloned into, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-home-"))
    const folder = join(dir, "yapd")
    const home = join(dir, ".yapd")
    try {
      await Bun.write(join(folder, ".env"), "YAPD_NAME=rosie\n")
      await Bun.write(join(folder, "preferences.md"), "Fable on high for hard bugs.\n")
      Home.adopt(folder, home)
      expect(readFileSync(join(home, ".env"), "utf8")).toBe("YAPD_NAME=rosie\n")
      expect(readFileSync(join(home, "preferences.md"), "utf8")).toBe("Fable on high for hard bugs.\n")
      expect(existsSync(join(folder, ".env"))).toBe(false)
      expect(existsSync(join(folder, "preferences.md"))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("leaves both alone when the home already has its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-home-"))
    const folder = join(dir, "yapd")
    const home = join(dir, ".yapd")
    try {
      await Bun.write(join(folder, ".env"), "YAPD_NAME=old\n")
      await Bun.write(join(home, ".env"), "YAPD_NAME=rosie\n")
      Home.adopt(folder, home)
      expect(readFileSync(join(home, ".env"), "utf8")).toBe("YAPD_NAME=rosie\n")
      expect(readFileSync(join(folder, ".env"), "utf8")).toBe("YAPD_NAME=old\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
