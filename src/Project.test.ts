import { describe, expect, test } from "bun:test"
import { fromCommonDir } from "./Project.ts"

describe("Project", () => {
  test("names the repository a worktree belongs to", () => {
    expect(fromCommonDir("/Users/me/projects/yapd/.git")).toBe("yapd")
    expect(fromCommonDir("/srv/yapd.git")).toBe("yapd")
  })
})
