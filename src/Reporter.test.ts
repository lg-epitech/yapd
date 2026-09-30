import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import * as Reporter from "./Reporter.ts"
import type { Listed } from "./Threads.ts"

const now = Date.parse("2026-09-29T18:00:00.000Z")

const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()

const listed = (id: string, overrides: Partial<Listed> = {}): Listed => ({
  id,
  project: "yapd",
  directory: "/code/yapd",
  title: `Thread ${id}`,
  branch: null,
  state: "done",
  needs: [],
  requestedAt: null,
  completedAt: null,
  updatedAt: iso(30),
  error: null,
  ...overrides,
})

describe("Reporter", () => {
  test("gives the model the thread, what the work is, its latest messages and the question", () => {
    const prompt = Reporter.summaryPrompt(
      {
        question: "Where's the latency investigation at?",
        machine: "rig",
        here: false,
        detail: {
          thread: listed("a1", { title: "Reduce Yapd Response Latency", branch: "latency", state: "waiting", needs: ["approval", "input"], completedAt: iso(4), updatedAt: iso(4) }),
          messages: [
            { role: "user", text: "Find out why updates take so long.", at: iso(40) },
            { role: "assistant", text: "Most of it is the echo canceller warm-up. May I change the hold?", at: iso(4) },
          ],
        },
        known: Option.some({ machine: "rig", id: "a1", prompt: "Find out why updates take so long.", dictated: null, description: "Measure where the time goes.", started: true, at: iso(50) }),
        now,
      },
      Option.some("Be brisk."),
    )
    expect(prompt).toContain("A thread that's quiet isn't necessarily still working")
    expect(prompt).toContain("Be brisk.")
    expect(prompt).toContain(`It's now ${Reporter.clock(now)}.`)
    expect(prompt).toContain("- Project: yapd, on rig\n- Title: Reduce Yapd Response Latency\n- Branch: latency\n- State: waiting on an approval and your input, since 4 min ago")
    expect(prompt).toContain("What the work is, as you put it when it started:\nMeasure where the time goes.")
    expect(prompt).toContain("User, 40 min ago:\nFind out why updates take so long.\n\nAgent, 4 min ago:\nMost of it is the echo canceller warm-up.")
    expect(prompt.endsWith("What they asked:\nWhere's the latency investigation at?")).toBe(true)
  })

  test("keeps the end of a last message that runs long, and says its start is cut", () => {
    const prompt = Reporter.summaryPrompt(
      {
        question: "Did it finish?",
        machine: "rosie",
        here: true,
        detail: { thread: listed("a1"), messages: [{ role: "assistant", text: `START ${"x".repeat(9_000)} END`, at: iso(4) }] },
        known: Option.none(),
        now,
      },
      Option.none(),
    )
    expect(prompt).toContain("(its start is cut) …xxx")
    expect(prompt).toContain("xxx END")
    expect(prompt).not.toContain("START")
    expect(prompt).not.toContain("x".repeat(8_001))
  })

  test("gives the model every machine's threads and their states, or why a machine couldn't be checked", () => {
    const prompt = Reporter.reportPrompt(
      {
        question: "What finished since lunch?",
        threads: [
          {
            machine: "rosie",
            here: true,
            threads: [
              { listed: listed("a1", { title: "Retry fix", state: "waiting", needs: ["approval"], updatedAt: iso(4) }), known: Option.none() },
              { listed: listed("b2", { project: "std", title: "Redis investigation", state: "failed", error: "Out of credits", completedAt: iso(90), updatedAt: iso(90) }), known: Option.none() },
            ],
          },
          { machine: "box", here: false, threads: [], reason: "box has no T3 Code token." },
        ],
        now,
      },
      Option.none(),
    )
    expect(prompt).toContain("lead with what needs them")
    expect(prompt).toContain(`It's now ${Reporter.clock(now)}.`)
    expect(prompt).toContain(`"Running" means it's working and has asked nothing.`)
    expect(prompt).toContain(`On rosie, this machine, newest first:\n- yapd, "Retry fix": waiting on an approval, since 4 min ago\n- std, "Redis investigation": failed 2 h ago, today: Out of credits`)
    expect(prompt).toContain("On box: couldn't be checked. box has no T3 Code token.")
    expect(prompt.endsWith("What they asked:\nWhat finished since lunch?")).toBe(true)
  })
})
