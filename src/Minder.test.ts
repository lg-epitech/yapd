import { describe, expect, test } from "bun:test"
import * as Cli from "./Cli.ts"
import * as Minder from "./Minder.ts"
import * as Sessions from "./Sessions.ts"

const session: Sessions.Session = {
  launch: "launch-1",
  agent: "claude",
  session: "session-1",
  project: "free-sound",
  directory: "/code/free-sound",
  repository: true,
  model: "claude-fable-5-1",
  prompt: "Fix the loader.",
  resume: false,
  state: "running",
  at: "2026-09-29T18:00:00.000Z",
}

const fine = { code: 0, stderr: "" }

const pickUp = "To go on from there, pick it up in a terminal with: cd /code/free-sound && claude --resume session-1"

describe("Minder", () => {
  test("says what the agent was refused or why it stopped short, and how to pick it up", () => {
    expect(Minder.report(session, { ...Cli.silence, began: true, message: "Done." }, fine)).toBeUndefined()
    const heard: Cli.Heard = {
      began: true,
      message: "I need your permission to write the file.",
      denied: [
        { tool: "Write", input: { file_path: "/code/free-sound/probe.txt" } },
        { tool: "Write", input: { file_path: "/code/free-sound/probe.txt" } },
        { tool: "Bash", input: { command: "git push" } },
      ],
    }
    expect(Minder.report(session, heard, fine)).toBe(
      `I need your permission to write the file.\n\nIt needs you: it ran with nobody there to approve things, so it was refused when it tried to change probe.txt, run "git push". ${pickUp}`,
    )
    // In the command line's words, when it stopped short.
    const log = Sessions.log("launch-1")
    expect(Minder.report(session, { ...Cli.silence, error: "You've hit your usage limit" }, { code: 1, stderr: "" })).toBe(
      `It stopped before it was done. You've hit your usage limit. ${pickUp} Everything it printed is in ${log}`,
    )
  })

  test("tells the daemon as the hook that ends a turn would, marked so it isn't skipped", () => {
    expect(Minder.notice(session, "It needs you.")).toEqual({
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: "/code/free-sound",
      last_assistant_message: "It needs you.",
      needs_you: true,
    })
  })
})
