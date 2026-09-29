import { describe, expect, test } from "bun:test"
import * as Seen from "./Seen.ts"

describe("Seen", () => {
  test("files a worktree's sessions under the checkout it belongs to", () => {
    expect(Seen.checkout("/code/free-sound/.git", "/home/me/.yapd/worktrees/free-sound/yapd-0a1b2c3d")).toBe("/code/free-sound")
    expect(Seen.checkout("/srv/free-sound.git", "/srv/free-sound.git")).toBe("/srv/free-sound.git")
  })
})
