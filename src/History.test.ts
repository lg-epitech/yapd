import { describe, expect, test } from "bun:test"
import * as History from "./History.ts"

const lines = (...entries: ReadonlyArray<object | string>) =>
  entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")

const date = "2026-09-29T18:00:00.000Z"

describe("History", () => {
  test("names a Claude Code session by the title Claude gave it, and says what it ran with", () => {
    const transcript = lines(
      { type: "user", message: { role: "user", content: "Why is the  loader slow?" } },
      { type: "ai-title", aiTitle: "Investigate loader" },
      { type: "assistant", perTurnEffort: "high", message: { model: "claude-fable-5-1", content: [{ type: "text", text: "Looking." }] } },
      { type: "ai-title", aiTitle: "Fix loader latency" },
      '{"type":"assistant","message":{"model":"claude-opus',
    )
    expect(History.claudePast("/code/free-sound", transcript, date)).toEqual({
      agent: "claude",
      directory: "/code/free-sound",
      title: "Fix loader latency",
      date,
      model: "claude-fable-5-1",
      effort: "high",
    })
    expect(History.claudeFolder("/Users/me/.t3/worktrees/free-sound")).toBe("-Users-me--t3-worktrees-free-sound")
  })
})
