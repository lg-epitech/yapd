import { describe, expect, test } from "bun:test"
import { glossary, heard } from "./Transcriber.ts"

describe("Transcriber", () => {
  test("tells Whisper the words to listen for, and leaves names out before the worktree ones when it's too long", () => {
    expect(glossary(["rig", "free-sound", " ", "rig"])).toBe(" Glossary: worktree, no worktree, in a worktree, rig, free-sound.")
    expect(glossary(["rig", "free-sound", "yapd"], (text) => text.length < 60)).toBe(" Glossary: worktree, no worktree, in a worktree, rig.")
    expect(glossary(["rig"], () => false)).toBe(" Glossary: worktree, no worktree, in a worktree.")
  })

  test("never passes the glossary on as something the user said", () => {
    const told = glossary(["yapd"])
    expect(heard(`${told} In yapd, fix it, no worktree.`, told)).toBe(" In yapd, fix it, no worktree.")
    // Given back changed, there's no telling where it ends, so it's heard again without.
    expect(heard(" Glossary: worktree, no work tree. In yapd, fix it.", told)).toBeUndefined()
  })
})
