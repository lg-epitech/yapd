import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Catalog } from "./Launcher.ts"
import * as Writer from "./Writer.ts"

const now = Date.parse("2026-09-29T18:00:00.000Z")

const catalog: Catalog = {
  projects: [
    {
      name: "yapd",
      path: "/code/yapd",
      repository: true,
      branch: "master",
      worktree: true,
      model: { name: "claude-fable-5-1", effort: "high" },
      recent: [
        { title: "Reduce Yapd\nResponse Latency", date: "2026-09-29T16:00:00.000Z" },
        { title: "Explore iPhone App Options", date: "2026-09-28T17:00:00.000Z" },
        { title: "Run Kokoro on the GPU", date: "2026-09-20T18:00:00.000Z" },
        { title: "Something From Long Ago", date: "2026-08-01T18:00:00.000Z" },
      ],
    },
    { name: "notes", path: "/code/notes", repository: false, branch: null, worktree: false, recent: [] },
  ],
  models: [
    { name: "claude-fable-5-1", title: "Claude Fable 5.1", aliases: ["fable"], efforts: ["low", "high"] },
    { name: "claude-haiku-4-5", title: "Claude Haiku 4.5", aliases: [], efforts: [] },
  ],
}

const material = (overrides: Partial<Writer.Material> = {}): Writer.Material => ({
  listings: [
    { machine: "rosie", here: true, hosts: ["Rosie.local"], catalog: Option.some(catalog) },
    { machine: "rig", here: false, hosts: ["rig"], catalog: Option.some({ projects: [], models: catalog.models }) },
    { machine: "box", here: false, hosts: ["box"], catalog: Option.none(), reason: "I can't reach box." },
  ],
  rules: Option.some("Fable on high for hard bugs. No worktree for questions."),
  recent: [],
  earlier: [],
  lines: [{ speaker: "user", text: "In yap D, fix the loader." }],
  research: true,
  now,
  ...overrides,
})

describe("Writer", () => {
  test("leaves the line for going ahead out of what's said once work starts, since yapd says one of its own in front", () => {
    const destination: Writer.Destination = {
      about: "the loader fix",
      project: "yapd",
      machine: "",
      directory: "/code/yapd",
      model: "claude-fable-5-1",
      effort: "high",
      worktree: true,
      lookFor: "What the loader does.",
    }
    const start = `- For "start", what you say once the session has started, which comes after your usual line that it's in hand, so leave that out: the project, the model, and whether it's in a worktree, like "In yapd, on Fable, in a worktree." or "In yapd, on Fable, without a worktree."`
    for (const prompt of [Writer.prompt(material(), Option.some("Call me sir.")), Writer.researchPrompt(material(), destination, Option.some("Call me sir."))]) {
      expect(prompt).toContain(start)
      expect(prompt).not.toMatch(/\bon it\b/i)
    }
  })

  test("gives the model the user's rules, what can start where, and what they dictated", () => {
    const prompt = Writer.prompt(material(), Option.none())
    expect(prompt).toContain("Their rules, as they wrote them:\nFable on high for hard bugs. No worktree for questions.")
    expect(prompt).toContain("On rosie, this machine, the projects:")
    expect(prompt).toContain("- yapd (/code/yapd), last used claude-fable-5-1 high, in a worktree, recent work:")
    expect(prompt).toContain(`"Reduce Yapd Response Latency" (2 h ago), "Explore iPhone App Options" (yesterday), "Run Kokoro on the GPU" (9 days ago)`)
    expect(prompt).not.toContain("Something From Long Ago")
    expect(prompt).toContain("- notes (/code/notes), no model yet, not a repository, so no worktree")
    expect(prompt).toContain("On box: nothing can start there right now. I can't reach box.")
    expect(prompt).toContain("Never guess a project")
    expect(prompt.endsWith("What they dictated:\nIn yap D, fix the loader.")).toBe(true)
  })

  test("passes on what was read out lately, by the name of the machine it came from", () => {
    const prompt = Writer.prompt(
      material({
        recent: [
          { project: "std", host: "rosie.LOCAL", directory: "/code/std", spoken: "Over in std, the Redis investigation is done.", message: `Two options.\n\n${"x".repeat(900)}`, at: now - 4 * 60_000 },
          { project: "trainer", host: "rig", directory: "/home/me/trainer", spoken: "Started in trainer.", message: "Rerun the eval.", started: true, at: now - 90 * 60_000 },
        ],
      }),
      Option.none(),
    )
    expect(prompt).toContain("- 4 min ago, std on rosie, in /code/std. You said: Over in std, the Redis investigation is done.")
    expect(prompt).toContain("  The agent's message: Two options. xxx")
    // Cut short, to keep the call fast.
    expect(prompt).not.toContain("x".repeat(700))
    expect(prompt).toContain("- 2 h ago, trainer on rig, in /home/me/trainer. You said: Started in trainer.\n  The prompt you started it with: Rerun the eval.")
  })

  test("only takes what's said after a question for a way out or an aside", () => {
    const asking = Writer.prompt(material(), Option.none())
    expect(asking).not.toContain(`"drop"`)
    expect(asking).not.toContain(`"wait"`)
    const answering = Writer.prompt(
      material({
        lines: [
          { speaker: "user", text: "Fix the loader." },
          { speaker: "yapd", text: "Is that yapd or std?" },
          { speaker: "user", text: "Never mind." },
        ],
      }),
      Option.none(),
    )
    expect(answering).toContain(`- "drop" when they call the request off`)
    expect(answering).toContain(`- "wait" when what they said after your question wasn't an answer to it`)
    expect(answering.endsWith("What they dictated:\nFix the loader.\n\nYou asked: Is that yapd or std?\n\nThey said, right after: Never mind.")).toBe(true)
  })
})
