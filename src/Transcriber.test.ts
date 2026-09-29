import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { glossary, heard, once } from "./Transcriber.ts"

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

  test("tries again to load a model that didn't, and keeps the one that did", async () => {
    let loads = 0
    const tried = await Effect.gen(function* () {
      const model = yield* once(Effect.suspend(() => (++loads === 1 ? Effect.fail("offline") : Effect.succeed(`model ${loads}`))))
      return [yield* Effect.either(model), yield* Effect.either(model), yield* Effect.either(model)].map((tried) => tried._tag)
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(tried).toEqual(["Left", "Right", "Right"])
    expect(loads).toBe(2)
  })
})
