import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type * as Memory from "./Memory.ts"
import * as Writer from "./Writer.ts"

const now = Date.parse("2026-09-29T18:00:00.000Z")

const material = (overrides: Partial<Writer.Material> = {}): Writer.Material => ({
  listings: [{ machine: "rosie", here: true, hosts: ["Rosie.local"], catalog: Option.some({ projects: [], models: [] }) }],
  rules: Option.none(),
  recent: [],
  earlier: [],
  lines: [{ speaker: "user", text: "In yap D, fix the loader." }],
  now,
  ...overrides,
})

describe("Writer", () => {
  test("never shows a routine, kept by voice or in his preferences, whose steps only yapd sends for its name said", () => {
    const memories: ReadonlyArray<Memory.Memory> = [
      { id: 2, at: now, kind: "routine", name: "review it", text: "Have Codex review the diff twice.", heard: "When I say review it, have Codex review the diff twice." },
    ]
    const rules = "Fable on high for hard bugs.\n\n## Routines\n\n- land it: Merge the PR once checks pass, then deploy.\n\n### Worktrees\n\nNo worktree for questions."
    const prompt = Writer.prompt(material({ rules: Option.some(rules), memories }), Option.none())
    expect(prompt).toContain("Fable on high for hard bugs.\n\n### Worktrees\n\nNo worktree for questions.")
    for (const routine of ["Routines", "land it", "Merge the PR once checks pass", "review it", "Have Codex review the diff twice"]) expect([routine, prompt.includes(routine)]).toEqual([routine, false])
  })

  test("passes on what was read out lately, by the name of the machine it came from", () => {
    const prompt = Writer.prompt(
      material({
        recent: [
          { project: "std", host: "rosie.LOCAL", directory: "/code/std", spoken: "Over in std, the Redis investigation is done.", message: `Two options.\n\n${"x".repeat(900)}`, at: now - 4 * 60_000 },
        ],
      }),
      Option.none(),
    )
    expect(prompt).toContain("- 4 min ago, std on rosie, in /code/std. You said: Over in std, the Redis investigation is done.")
    expect(prompt).toContain("  The agent's message: Two options. xxx")
    // Cut short, to keep the call fast.
    expect(prompt).not.toContain("x".repeat(700))
  })
})
