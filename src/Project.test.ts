import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fromCommonDir, name } from "./Project.ts"

describe("Project", () => {
  test("names the repository a worktree belongs to", () => {
    expect(fromCommonDir("/Users/me/projects/yapd/.git")).toBe("yapd")
    expect(fromCommonDir("/srv/yapd.git")).toBe("yapd")
  })

  test("falls back to the directory outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yapd-project-"))
    try {
      expect(await Effect.runPromise(name(dir))).toBe(basename(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
