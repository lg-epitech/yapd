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
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the latency one" }, lines, threads, threads, recent)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "unclear", threadEvidence: "the latency one" }, lines, threads, threads, recent)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/zz", threadFrom: "named", threadEvidence: "the latency one" }, lines, threads, threads, recent)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the yapd thread" }, lines, threads, threads, recent)).toBe(false)
    // Their words, but none the listing shows for that thread: the model went by something else.
    const vague = [{ speaker: "user" as const, text: "Tell the other agent to stop." }]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the other agent" }, vague, threads, threads, recent)).toBe(false)
    // Where it stands names it, when that singles it out.
    const standing = [{ speaker: "user" as const, text: "Tell the one that's waiting for me to go ahead." }]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "named", threadEvidence: "the one that's waiting" }, standing, threads, threads, recent)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "named", threadEvidence: "the one that's waiting" }, standing, threads, threads, recent)).toBe(false)
    // "That one" is theirs, but it only settles a thread yapd read out, and on its own only the latest one.
    const pointing = [{ speaker: "user" as const, text: "Tell that one to stop." }]
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, threads, recent)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, threads, recent)).toBe(false)
    const both = [heard(1, redis), heard(0, { project: "yapd", spoken: "Waiting on you.", message: "May I?", thread: { machine: "rosie", id: "a1" } })]
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, threads, both)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "that one" }, pointing, threads, threads, both)).toBe(true)
    // "The one that just finished" points at nothing but its place in the telling, so it's the latest thing heard too.
    const finished = [{ speaker: "user" as const, text: "Tell the one that just finished to stop." }]
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "referred", threadEvidence: "the one that just finished" }, finished, threads, threads, both)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "the one that just finished" }, finished, threads, threads, both)).toBe(true)
    // The last thing heard was an update with no thread to its name, like one from another machine: "it" can't be an older
    // one, and neither can "tell it to" or "the last one", however the model words what they pointed with.
    const unlinked = [...both, heard(0, { project: "trainer", host: "rig", spoken: "Over on rig, the eval is done.", message: "Done.", heardAt: now + 1 })]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "it" }, pointing, threads, threads, unlinked)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "tell it to" }, [{ speaker: "user", text: "Tell it to stop." }], threads, threads, unlinked)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "the last one" }, [{ speaker: "user", text: "Tell the last one to stop." }], threads, threads, unlinked)).toBe(false)
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "tell that one" }, pointing, threads, threads, unlinked)).toBe(false)
    // Past the pointing words, their words reach an older reading only when it spoke of them.
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "the one that's waiting" }, standing, threads, threads, unlinked)).toBe(true)
    const retries = [{ speaker: "user" as const, text: "Tell the retry one you told me about to keep going." }]
    const aboutRetry = { threadFrom: "referred" as const, threadEvidence: "the retry one you told me about" }
    const told = [heard(1, { project: "yapd", spoken: "The retry fix is done: retries now back off.", message: "Done.", thread: { machine: "rosie", id: "a1" } }), heard(0, redis)]
    expect(Writer.groundedThread({ thread: "rosie/a1", ...aboutRetry }, retries, threads, threads, told)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/b2", ...aboutRetry }, retries, threads, threads, told)).toBe(false)
    // When the latest reading spoke of it too, about another thread, either could be meant.
    const twice = [told[0]!, heard(0, { ...redis, spoken: "Redis is done, with a retry on timeouts." })]
    expect(Writer.groundedThread({ thread: "rosie/a1", ...aboutRetry }, retries, threads, threads, twice)).toBe(false)
    expect(Writer.parseKey("rosie/a1")).toEqual(Option.some({ machine: "rosie", id: "a1" }))
    expect(Writer.parseKey("a1")).toEqual(Option.none())
  })

  test("takes the machine's name on its own only when it's the only thread listed there, and with other words to tell machines apart", () => {
    const lines = [{ speaker: "user" as const, text: "Tell the one on rig to stop." }]
    const byMachine = { threadFrom: "named" as const, threadEvidence: "the one on rig" }
    const rerun = { listed: listed("r1", { project: "trainer", title: "Rerun the eval", state: "running" }), known: Option.none() }
    const retry = { listed: listed("r2", { project: "trainer", title: "Retry fix" }), known: Option.none() }
    const one = [...threads, { machine: "rig", here: false, threads: [rerun] }]
    expect(Writer.groundedThread({ thread: "rig/r1", ...byMachine }, lines, one, one, [])).toBe(true)
    // With two on rig, "the one on rig" is either: yapd asks.
    const two = [...threads, { machine: "rig", here: false, threads: [rerun, retry] }]
    expect(Writer.groundedThread({ thread: "rig/r1", ...byMachine }, lines, two, two, [])).toBe(false)
    // Past the machine's name, their words have to fit the thread as usual.
    const naming = [{ speaker: "user" as const, text: "Tell the retry fix on rig to stop." }]
    expect(Writer.groundedThread({ thread: "rig/r2", threadFrom: "named", threadEvidence: "the retry fix on rig" }, naming, two, two, [])).toBe(true)
    expect(Writer.groundedThread({ thread: "rig/r1", threadFrom: "named", threadEvidence: "the retry fix on rig" }, naming, two, two, [])).toBe(false)
    // The same work on both machines: the machine's name is what tells them apart, even where neither is the only thread there.
    const twice = [
      { machine: "rosie", here: true, threads: [{ listed: listed("f1", { title: "Fix retries" }), known: Option.none() }, ...threads[0]!.threads] },
      { machine: "rig", here: false, threads: [{ listed: listed("r3", { title: "Fix retries" }), known: Option.none() }, rerun] },
    ]
    const both = [{ speaker: "user" as const, text: "Tell fix retries on rig to stop." }]
    expect(Writer.groundedThread({ thread: "rig/r3", threadFrom: "named", threadEvidence: "fix retries on rig" }, both, twice, twice, [])).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/f1", threadFrom: "named", threadEvidence: "fix retries on rig" }, both, twice, twice, [])).toBe(false)
    expect(Writer.groundedThread({ thread: "rig/r3", threadFrom: "named", threadEvidence: "fix retries" }, both, twice, twice, [])).toBe(false)
  })

  test("holds the user's words against every thread listed, not only the ones the writer was shown", () => {
    const lines = [{ speaker: "user" as const, text: "Tell the one on rig to stop." }]
    const rerun = { listed: listed("r1", { project: "trainer", title: "Rerun the eval", updatedAt: iso(5) }), known: Option.none() }
    // Done three weeks ago, so the writer isn't shown it, and "the one on rig" is still either of them.
    const old = { listed: listed("r2", { project: "trainer", title: "Retry fix", updatedAt: iso(21 * 24 * 60) }), known: Option.none() }
    const all = [...threads, { machine: "rig", here: false, threads: [rerun, old] }]
    const shown = Writer.shortlist(all, now)
    expect(shown.at(-1)?.threads.map(({ listed }) => listed.id)).toEqual(["r1"])
    expect(Writer.groundedThread({ thread: "rig/r1", threadFrom: "named", threadEvidence: "the one on rig" }, lines, shown, all, [])).toBe(false)
    // A title the old one shares: neither the one shown nor the one that wasn't is settled.
    const naming = [{ speaker: "user" as const, text: "Tell the retry fix to stop." }]
    const shared = [...threads, { machine: "rig", here: false, threads: [{ listed: listed("r3", { project: "trainer", title: "Retry fix", updatedAt: iso(5) }), known: Option.none() }, old] }]
    const retry = { threadFrom: "named" as const, threadEvidence: "the retry fix" }
    expect(Writer.groundedThread({ thread: "rig/r3", ...retry }, naming, Writer.shortlist(shared, now), shared, [])).toBe(false)
    expect(Writer.groundedThread({ thread: "rig/r2", ...retry }, naming, Writer.shortlist(shared, now), shared, [])).toBe(false)
  })

  test("keeps a message on the machine the user named, even when that machine's threads couldn't be listed", () => {
    const lines = [{ speaker: "user" as const, text: "Tell the retry fix on rig to stop." }]
    const retry = { threadFrom: "named" as const, threadEvidence: "the retry fix on rig" }
    const fix = (machine: string, id: string) => ({ listed: listed(id, { project: "trainer", title: "Retry fix" }), known: Option.none() })
    // rig can't be listed, so rosie's retry fix is the only one shown: it's still not the one they asked for.
    const down = [{ ...threads[0]!, threads: [...threads[0]!.threads, fix("rosie", "f1")] }, { machine: "rig", here: false, threads: [], reason: "rig isn't answering." }]
    expect(Writer.groundedThread({ thread: "rosie/f1", ...retry }, lines, down, down, [])).toBe(false)
    // With rig listed, its own retry fix is settled, and rosie's isn't.
    const up = [down[0]!, { machine: "rig", here: false, threads: [fix("rig", "r1")] }]
    expect(Writer.groundedThread({ thread: "rig/r1", ...retry }, lines, up, up, [])).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/f1", ...retry }, lines, up, up, [])).toBe(false)
    // No machine named: nothing changes, and a word that only sounds like one names none.
    const plain = [{ speaker: "user" as const, text: "Tell the retry fix to stop rigging the tests." }]
    expect(Writer.groundedThread({ thread: "rosie/f1", threadFrom: "named", threadEvidence: "the retry fix" }, plain, down, down, [])).toBe(true)
  })

  test("takes a name only when it sets the thread apart from the others listed", () => {
    const known = (id: string, prompt: string) => Option.some({ machine: "rosie", id, prompt, dictated: null, description: null, started: false, at: iso(60) })
    const backoff = { listed: listed("r1", { title: "Retry backoff fix" }), known: known("r1", "Make retries back off, and keep the budget for them as it is.") }
    const budget = { listed: listed("r2", { title: "Retry budget" }), known: known("r2", "Cap the retries per minute.") }
    const npm = { listed: listed("n1", { title: "Distribute yapd on npm" }), known: known("n1", "Publish yapd to npm, with the same retries as the installer.") }
    const shown = [{ machine: "rosie", here: true, threads: [backoff, budget, npm] }]
    const named = (thread: string, threadEvidence: string) => ({ thread, threadFrom: "named" as const, threadEvidence })
    // "The retry one" fits two threads as well as each other, so it's sent to neither: yapd asks.
    const retry = [{ speaker: "user" as const, text: "Tell the retry one to keep going." }]
    expect(Writer.groundedThread(named("rosie/r1", "the retry one"), retry, shown, shown, [])).toBe(false)
    expect(Writer.groundedThread(named("rosie/r2", "the retry one"), retry, shown, shown, [])).toBe(false)
    // "Retry budget" is shown by one of them only, though the other's first message mentions the budget too.
    const fuller = [{ speaker: "user" as const, text: "Tell the retry budget one to keep going." }]
    expect(Writer.groundedThread(named("rosie/r2", "the retry budget one"), fuller, shown, shown, [])).toBe(true)
    expect(Writer.groundedThread(named("rosie/r1", "the retry budget one"), fuller, shown, shown, [])).toBe(false)
    // One npm thread, though retries come up in its first message: what names it settles it, and the message is looked at only when that doesn't.
    const distribution = [{ speaker: "user" as const, text: "Tell the npm distribution agent to keep going." }]
    expect(Writer.groundedThread(named("rosie/n1", "the npm distribution agent"), distribution, shown, shown, [])).toBe(true)
    // Their word is in the first messages only, and in one of them: that settles it too.
    const minute = [{ speaker: "user" as const, text: "Tell the per minute one to keep going." }]
    expect(Writer.groundedThread(named("rosie/r2", "the per minute one"), minute, shown, shown, [])).toBe(true)
    // The same holds for what was read out: "the retry one you told me about" reaches neither of two readings that spoke of retries.
    const told = [{ speaker: "user" as const, text: "Tell the retry one you told me about to keep going." }]
    const readings = [
      heard(2, { project: "yapd", spoken: "The retry backoff is in.", message: "Done.", thread: { machine: "rosie", id: "r1" } }),
      heard(1, { project: "yapd", spoken: "The retry budget is capped.", message: "Done.", thread: { machine: "rosie", id: "r2" } }),
      heard(0, { project: "yapd", spoken: "npm is set up.", message: "Done.", thread: { machine: "rosie", id: "n1" } }),
    ]
    expect(Writer.groundedThread({ thread: "rosie/r1", threadFrom: "referred", threadEvidence: "the retry one you told me about" }, told, shown, shown, readings)).toBe(false)
    const toldFuller = [{ speaker: "user" as const, text: "Tell the retry budget one you told me about to keep going." }]
    expect(Writer.groundedThread({ thread: "rosie/r2", threadFrom: "referred", threadEvidence: "the retry budget one you told me about" }, toldFuller, shown, shown, readings)).toBe(true)
  })

  test("hears a bare pointer in French too", () => {
    const readings = [heard(0, { project: "yapd", spoken: "Le correctif des retries est prêt.", message: "Prêt.", thread: { machine: "rosie", id: "a1" } })]
    const lines = [{ speaker: "user" as const, text: "Dis-lui de continuer." }]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "lui" }, lines, threads, threads, readings)).toBe(true)
    expect(Writer.groundedThread({ thread: "rosie/b2", threadFrom: "referred", threadEvidence: "lui" }, lines, threads, threads, readings)).toBe(false)
    const that = [{ speaker: "user" as const, text: "Dis à celui-là de continuer." }]
    expect(Writer.groundedThread({ thread: "rosie/a1", threadFrom: "referred", threadEvidence: "celui-là" }, that, threads, threads, readings)).toBe(true)
  })
})
