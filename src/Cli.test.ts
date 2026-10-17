import { describe, expect, test } from "bun:test"
import { Either } from "effect"
import * as Cli from "./Cli.ts"

const both = new Set(["claude", "codex"] as const)

const codex = JSON.stringify({
  models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
  ],
})

const claude = (fetchedAt: number, models: ReadonlyArray<object>) => JSON.stringify({ fetchedAt, catalog: { config: { models } } })

const effort = { type: "effort", effort_options: [{ id: "low" }, { id: "high" }] }

const latest = claude(2, [
  { id: "claude-fable-5-1", name: "Fable 5.1", short_name: "Fable", section: "main", thinking: effort },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", short_name: "Haiku", section: "main", thinking: { type: "none" } },
  { id: "claude-fable-5", name: "Fable 5", short_name: "Fable", section: "overflow", thinking: effort },
])

describe("Cli's models", () => {
  test("finds a model by any of the names its command line lists it under, in the latest list for Claude Code", () => {
    const older = claude(1, [{ id: "claude-opus-5-5", name: "Opus 5.5", short_name: "Opus", section: "main" }])
    const models = [...Cli.claudeModels([older, "cut sho", latest]), ...Cli.codexModels(codex)]
    expect(models.map(({ name, efforts }) => [name, efforts.join(" ")])).toEqual([
      ["claude-fable-5-1", "low high"],
      ["claude-haiku-4-5-20251001", ""],
      ["claude-fable-5", "low high"],
      ["gpt-6-astra", "low high"],
    ])
    const agent = (name: string) => Either.map(Cli.pick(models, name, both), (model) => [model.agent, model.name])
    expect(agent(" Fable ")).toEqual(Either.right(["claude", "claude-fable-5-1"]))
    expect(agent("fable 5")).toEqual(Either.right(["claude", "claude-fable-5"]))
    expect(agent("GPT-6-Astra")).toEqual(Either.right(["codex", "gpt-6-astra"]))
    // Named like Claude's, which its list may not have yet.
    expect(agent("claude-opus-6")).toEqual(Either.right(["claude", "claude-opus-6"]))
  })
})

describe("Cli's commands", () => {
  const turn: Cli.Turn = {
    agent: "claude",
    session: "session-1",
    resume: false,
    model: "claude-fable-5-1",
    effort: undefined,
    permissions: undefined,
    repository: true,
  }

  test("skips no approvals unless the user's setting says so", () => {
    for (const agent of ["claude", "codex"] as const) {
      const command = Cli.command({ ...turn, agent }).join(" ")
      expect(command).not.toMatch(/dangerously|bypass|permission-mode|sandbox/)
    }
  })
})

describe("Cli's output", () => {
  const hear = (agent: "claude" | "codex", lines: ReadonlyArray<object | string>) =>
    lines.reduce<Cli.Heard>((heard, line) => Cli.hear(agent, heard, typeof line === "string" ? line : JSON.stringify(line)), Cli.silence)

  test("hears that Claude Code is under way once the model answers, not when it speaks for one it couldn't reach", () => {
    const init = { type: "system", subtype: "init", session_id: "session-1" }
    expect(hear("claude", [init])).toEqual({ session: "session-1", began: false, denied: [] })
    expect(hear("claude", [init, { type: "assistant", message: { model: "claude-fable-5-1", content: [] } }]).began).toBe(true)
    const unreached = hear("claude", [
      init,
      { type: "assistant", message: { model: "<synthetic>", content: [] } },
      { type: "result", is_error: true, result: "There's an issue with the selected model (claude-nope-9)." },
    ])
    expect(unreached).toMatchObject({ began: false, error: "There's an issue with the selected model (claude-nope-9)." })
  })

  test("hears Codex's session and its last message, or why its turn failed", () => {
    const heard = hear("codex", [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I'll look." } },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Done." } },
      { type: "turn.completed" },
    ])
    expect(heard).toEqual({ session: "thread-1", began: true, denied: [], message: "Done." })
    expect(hear("codex", [{ type: "turn.failed", error: { message: "You've hit your usage limit." } }]).error).toBe(
      "You've hit your usage limit.",
    )
  })
})
