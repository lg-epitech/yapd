import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Catalog } from "./Launcher.ts"
import type { Played } from "./Recent.ts"
import type { Listed } from "./Threads.ts"
import * as Writer from "./Writer.ts"

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

const threads: ReadonlyArray<Writer.ThreadListing> = [
  {
    machine: "rosie",
    here: true,
    threads: [
      {
        listed: listed("a1", { title: "Reduce Yapd Response Latency", branch: "latency", state: "waiting", needs: ["approval"], updatedAt: iso(4) }),
        known: Option.some({
          machine: "rosie",
          id: "a1",
          prompt: `Find out why updates take so long to be read out. ${"y".repeat(600)}`,
          dictated: "why are updates so slow",
          description: "Measure where the time goes between an agent's hook and the first spoken word, in yapd.",
          started: true,
          at: iso(120),
        }),
      },
      { listed: listed("b2", { project: "std", title: "Redis investigation", state: "running", requestedAt: iso(12), updatedAt: iso(12) }), known: Option.none() },
    ],
  },
  { machine: "box", here: false, threads: [], reason: "box has no T3 Code token." },
]

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

/** Something read out `minutesAgo`, as soon as it came in. */
const heard = (minutesAgo: number, overrides: Partial<Played> & Pick<Played, "project" | "spoken" | "message">): Played => ({
  id: `heard:${minutesAgo}`,
  directory: `/code/${overrides.project}`,
  at: now - minutesAgo * 60_000,
  heardAt: now - minutesAgo * 60_000,
  ...overrides,
})

const material = (overrides: Partial<Writer.Material> = {}): Writer.Material => ({
  listings: [
    { machine: "rosie", here: true, hosts: ["Rosie.local"], catalog: Option.some(catalog) },
    { machine: "rig", here: false, hosts: ["rig"], catalog: Option.some({ projects: [], models: catalog.models }) },
    { machine: "box", here: false, hosts: ["box"], catalog: Option.none(), reason: "I can't reach box." },
  ],
  threads,
  rules: Option.some("Fable on high for hard bugs. No worktree for questions."),
  recent: [],
  earlier: [],
  lines: [{ speaker: "user", text: "In yap D, fix the loader." }],
  research: true,
  now,
  ...overrides,
})

describe("Writer", () => {
  test("gives the model the user's rules, what can start where, and what they dictated", () => {
    const prompt = Writer.prompt(material(), Option.none())
    expect(prompt).toContain("Their rules, as they wrote them:\nFable on high for hard bugs. No worktree for questions.")
    expect(prompt).toContain("On rosie, this machine, the projects:")
    expect(prompt).toContain("- yapd (/code/yapd), last used claude-fable-5-1 high, in a worktree, recent work:")
    expect(prompt).toContain(`"Reduce Yapd Response Latency" (2 h ago, today), "Explore iPhone App Options" (yesterday), "Run Kokoro on the GPU" (9 days ago)`)
    expect(prompt).not.toContain("Something From Long Ago")
    expect(prompt).toContain("- notes (/code/notes), no model yet, not a repository, so no worktree")
    expect(prompt).toContain("On box: nothing can start there right now. I can't reach box.")
    expect(prompt).toContain("Never guess either: work started in the wrong project, or a message to the wrong agent")
    expect(prompt.endsWith("What they dictated:\nIn yap D, fix the loader.")).toBe(true)
  })

  test("passes on what was read out lately, by the name of the machine it came from", () => {
    const prompt = Writer.prompt(
      material({
        recent: [
          heard(4, { project: "std", host: "rosie.LOCAL", spoken: "Over in std, the Redis investigation is done.", message: `Two options.\n\n${"x".repeat(900)}` }),
          heard(90, { project: "trainer", host: "rig", directory: "/home/me/trainer", spoken: "Started in trainer.", message: "Rerun the eval.", started: true }),
        ],
      }),
      Option.none(),
    )
    expect(prompt).toContain("- 4 min ago, std on rosie, in /code/std. You said: Over in std, the Redis investigation is done.")
    expect(prompt).toContain("  The agent's message: Two options. xxx")
    // Cut short, to keep the call fast.
    expect(prompt).not.toContain("x".repeat(700))
    expect(prompt).toContain("- 2 h ago, today, trainer on rig, in /home/me/trainer. You said: Started in trainer.\n  The prompt you started it with: Rerun the eval.")
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

  test("lists the threads by key, with what the work is, so a message or a question can be about one", () => {
    const prompt = Writer.prompt(
      material({ recent: [heard(1, { project: "std", host: "rosie.LOCAL", spoken: "Done.", message: "Two options.", thread: { machine: "rosie", id: "b2" } })] }),
      Option.none(),
    )
    expect(prompt).toContain(`- "message" when it's for an agent that's already at work`)
    expect(prompt).toContain(`- "summary" when they want to know where one thread stands`)
    expect(prompt).toContain(`- "status" when they ask across their work`)
    expect(prompt).toContain("On rosie, this machine, the threads, newest first:")
    // Times are rough here, so the listing reads the same from one call to the next.
    expect(prompt).toContain(`- rosie/a1: in yapd, "Reduce Yapd Response Latency", on branch latency, waiting on an approval, since just now`)
    expect(prompt).toContain("  What the work is: Measure where the time goes between an agent's hook and the first spoken word, in yapd.")
    expect(prompt).toContain("  Its first message began: Find out why updates take so long to be read out. yyy")
    // Cut shorter still when a description says what the work is.
    expect(prompt).not.toContain("y".repeat(200))
    expect(prompt).toContain(`- rosie/b2: in std, "Redis investigation", running, started minutes ago`)
    expect(prompt).toContain("On box: its threads can't be listed right now, so none there can be picked. box has no T3 Code token.")
    // What was read out names its thread, so "that one" can be resolved. What it carried may be the agent's or what yapd sent it.
    expect(prompt).toContain("- 1 min ago, std on rosie, in /code/std, thread rosie/b2. You said: Done.\n  What it was about: Two options.")
  })

  test("says how long ago in words that change rarely", () => {
    const local = (day: number, hour: number) => new Date(2026, 8, day, hour).getTime()
    const at = local(29, 12)
    expect(Writer.roughly(at - 4 * 60_000, at)).toBe("just now")
    expect(Writer.roughly(at - 45 * 60_000, at)).toBe("minutes ago")
    expect(Writer.roughly(local(29, 1), at)).toBe("today")
    expect(Writer.roughly(local(28, 23), at)).toBe("yesterday")
    expect(Writer.roughly(local(26, 23), at)).toBe("3 days ago")
    // Said exactly, it still names the day: at half past one, three hours ago was yesterday, and 30 hours ago the day before.
    const late = local(29, 1) + 30 * 60_000
    expect(Writer.ago(at - 3 * 60 * 60_000, at)).toBe("3 h ago, today")
    expect(Writer.ago(late - 3 * 60 * 60_000, late)).toBe("3 h ago, yesterday")
    expect(Writer.ago(late - 30 * 60 * 60_000, late)).toBe("2 days ago")
    expect(Writer.ago(late - 30 * 60 * 60_000, late)).toBe(Writer.roughly(late - 30 * 60 * 60_000, late))
  })

  test("shows every running or waiting thread, and only the newest of the rest", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ listed: listed(`d${index}`, { updatedAt: iso(index + 2) }), known: Option.none() }))
    // Newest by the time its line shows: when it finished, though it was touched long before.
    const late = { listed: listed("late", { completedAt: iso(1), updatedAt: iso(50) }), known: Option.none() }
    const shortlist = Writer.shortlist(
      [
        { machine: "rosie", here: true, threads: [{ listed: listed("old", { state: "running", updatedAt: iso(30 * 24 * 60) }), known: Option.none() }, ...many, late] },
        { machine: "rig", here: false, threads: [{ listed: listed("wait", { state: "waiting", updatedAt: iso(20 * 24 * 60) }), known: Option.none() }, { listed: listed("stale", { updatedAt: iso(20 * 24 * 60) }), known: Option.none() }] },
      ],
      now,
    )
    const ids = shortlist.map(({ threads }) => threads.map(({ listed }) => listed.id))
    expect(ids[0]?.slice(0, 2)).toEqual(["late", "d0"])
    expect(ids[0]).toContain("old")
    expect(ids[1]).toEqual(["wait"])
    expect(ids.flat()).toHaveLength(40)
    // A time that can't be read makes a thread the oldest, not one to leave out.
    const undated = Writer.shortlist([{ machine: "rig", here: false, threads: [{ listed: listed("undated", { updatedAt: "" }), known: Option.none() }] }], now)
    expect(undated[0]?.threads.map(({ listed }) => listed.id)).toEqual(["undated"])
  })

  test("only takes a thread that's listed, and settled by the user's own words", () => {
    const lines = [{ speaker: "user" as const, text: "Tell the latency one to keep the public API unchanged." }]
    const redis = { project: "std", spoken: "Done.", message: "Two options.", thread: { machine: "rosie", id: "b2" } }
    const recent = [heard(0, redis)]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the latency one" }, lines, threads, recent)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "unclear", threadEvidence: "the latency one" }, lines, threads, recent)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/zz", threadFrom: "named", threadEvidence: "the latency one" }, lines, threads, recent)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the yapd thread" }, lines, threads, recent)).toBe(false)
    // Their words, but none the listing shows for that thread: the model went by something else.
    const vague = [{ speaker: "user" as const, text: "Tell the other agent to stop." }]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the other agent" }, vague, threads, recent)).toBe(false)
    // Where it stands names it, when that singles it out.
    const standing = [{ speaker: "user" as const, text: "Tell the one that's waiting for me to go ahead." }]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the one that's waiting" }, standing, threads, recent)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "named", threadEvidence: "the one that's waiting" }, standing, threads, recent)).toBe(false)
    // "That one" is theirs, but it only settles a thread yapd read out, and on its own only the latest one.
    const pointing = [{ speaker: "user" as const, text: "Tell that one to stop." }]
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, recent)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, recent)).toBe(false)
    const both = [heard(1, redis), heard(0, { project: "yapd", spoken: "Waiting on you.", message: "May I?", thread: { machine: "rosie", id: "a1" } })]
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, both)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, both)).toBe(true)
    const finished = [{ speaker: "user" as const, text: "Tell the one that just finished to stop." }]
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "referred", threadEvidence: "the one that just finished" }, finished, threads, both)).toBe(true)
    // The last thing heard was an update with no thread to its name, like one from another machine: "it" can't be an older one.
    const unlinked = [...both, heard(0, { project: "trainer", host: "rig", spoken: "Over on rig, the eval is done.", message: "Done.", heardAt: now + 1 })]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "it" }, pointing, threads, unlinked)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "the one that's waiting" }, standing, threads, unlinked)).toBe(true)
    expect(Writer.parseKey("rosie/a1")).toEqual(Option.some({ machine: "rosie", id: "a1" }))
    expect(Writer.parseKey("a1")).toEqual(Option.none())
  })
})
