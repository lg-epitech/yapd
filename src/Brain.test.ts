import { describe, expect, test } from "bun:test"
import { Effect, Either, Option, Schema } from "effect"
import type * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import * as Conversation from "./Conversation.ts"
import * as Drafts from "./Drafts.ts"
import type { Kept } from "./Journal.ts"
import * as Persona from "./Persona.ts"
import * as Research from "./Research.ts"
import type * as T3Actions from "./T3Actions.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"

const now = Date.parse("2026-10-08T22:00:00.000Z")

const thread = (id: string, title: string, projectId: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId,
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T20:00:00.000Z",
    ...overrides,
  })

const mina = thread("2d5cee5c-0f1e-4a6b-9c1d-5e2f3a4b5c6d", "Open Mina SSV2 Bug Tickets", "p-connectors")
const tezos = thread("850299f8-1a2b-4c3d-8e4f-5a6b7c8d9e0f", "Migrate Tezos Integration", "p-integration", {
  activeRunId: "run-7",
  activityRunStatus: "running",
  latestRunStartedAt: "2026-10-08T21:48:00.000Z",
})
const std = thread("c41a7e2b-3d4e-4f5a-8b6c-7d8e9f0a1b2c", "Fix the transcription upload", "p-std", {
  pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: "2026-10-08T21:55:00.000Z" },
})

const view: T3Live.View = {
  projects: new Map([
    ["p-connectors", { id: "p-connectors", title: "integration-connectors", workspaceRoot: "/code/integration-connectors" }],
    ["p-integration", { id: "p-integration", title: "integration", workspaceRoot: "/code/integration" }],
    ["p-std", { id: "p-std", title: "std", workspaceRoot: "/code/std" }],
  ]),
  threads: new Map([mina, tezos, std].map((thread) => [thread.id, thread])),
  sequence: 1,
  synced: true,
}

const ref = (thread: T3Live.Thread): Threads.Ref => ({ machine: "Rosie", id: thread.id })

const desk = (pending: ReadonlyArray<Threads.Ref> = []): Threads.Desk => ({
  threads: Threads.shortlist({ machine: "Rosie", view, focus: Option.none(), pending, most: 30, started: new Map(), said: new Map(), now }),
  away: [{ machine: "rig", reason: "I can't see rig's threads yet." }],
})

const lines: Persona.Lines = { ...Persona.plain, leaving: "I'll leave that one, sir.", cantTell: "I couldn't tell which one you meant, sir.", address: "sir" }

const situation = (heard: string, overrides: Partial<Brain.Situation> = {}): Brain.Situation => ({
  utterance: { id: "u1", heard, via: "shortcut", at: now, voiced: 2, turns: 1 },
  subject: { _tag: "Nothing" },
  lines: [],
  open: Option.none(),
  desk: desk(),
  lately: [],
  unheard: [],
  usage: Option.none(),
  second: Option.none(),
  asked: [],
  now,
  ...overrides,
})

const which = (candidates: ReadonlyArray<Threads.Ref>): Assistant.Open => ({
  id: "o1",
  version: 1,
  kind: "which",
  utterance: "u0",
  heard: "What's the status on the migration one?",
  decision: Brain.decision({ act: "answer", target: "t1", sure: "low", others: "t2, t3", spoken: "It's going well." }),
  candidates,
  asked: "Open Mina SSV2 Bug Tickets, Migrate Tezos Integration or Fix the transcription upload, sir?",
  about: "",
  at: now - 5_000,
  material: Option.none(),
  resend: Option.none(),
})

describe("Brain", () => {
  test("the first, the second and the last pick the open question's candidates in order", () => {
    const candidates = [ref(mina), ref(tezos), ref(std)]
    const asking = situation("", { open: Option.some(which(candidates)), desk: desk(candidates) })
    const pick = (heard: string) => {
      const decided = Brain.fast({ ...asking, utterance: { ...asking.utterance, heard } }, lines)
      return { act: decided?.act, pending: decided?.pending, thread: asking.desk.threads.find(({ handle }) => handle === decided?.target)?.thread.title }
    }
    expect(pick("The first.")).toEqual({ act: "look", pending: "answers", thread: "Open Mina SSV2 Bug Tickets" })
    expect(pick("Number two, please.")).toEqual({ act: "look", pending: "answers", thread: "Migrate Tezos Integration" })
    expect(pick("The last one.")).toEqual({ act: "look", pending: "answers", thread: "Fix the transcription upload" })
    // A name only one of them has.
    expect(pick("The Tezos one.")).toEqual({ act: "look", pending: "answers", thread: "Migrate Tezos Integration" })
    expect(pick("Neither.")).toEqual({ act: "dismiss", pending: "answers", thread: undefined })
    // Said over and over, as people do, it's still no, never Whisper looping on noise.
    expect(pick("No, no, no.")).toEqual({ act: "dismiss", pending: "answers", thread: undefined })
  })

  test("'say that again' is about what he heard last: the question only right after it, an update heard since it", () => {
    const candidates = [ref(mina), ref(tezos)]
    const open = which(candidates)
    const update: Conversation.Update = {
      session: "claude:s1",
      project: "yapd",
      turn: { prompt: Option.none(), message: "The review came back clean." },
      needsYou: false,
      spoken: "Yapd's review came back clean, two small fixes left.",
      audio: "/tmp/update.wav",
      thread: { agent: "claude", session: "s1", cwd: "/code/yapd", message: "The review came back clean.", origin: {} },
      at: now - 20_000,
    }
    const again = (subject: Assistant.Subject) => {
      const decided = Brain.fast(situation("Say that again.", { open: Option.some(open), desk: desk(candidates), subject }), lines)
      return { act: decided?.act, pending: decided?.pending, spoken: decided?.spoken }
    }
    expect(again({ _tag: "Answer", said: open.asked, about: Option.none() })).toEqual({ act: "again", pending: "answers", spoken: open.asked })
    expect(again({ _tag: "Session", update, said: update.spoken })).toEqual({ act: "again", pending: "replaces", spoken: update.spoken })
    // Over an update, the line said last, like the answer to what he asked over it, which the model is shown beside the update.
    const answered = "The two fixes are in the loader, sir."
    expect(again({ _tag: "Session", update, said: answered })).toEqual({ act: "again", pending: "replaces", spoken: answered })
    const shown = Brain.prompt(situation("Can you repeat that?", { subject: { _tag: "Session", update, said: answered } }), Option.none())
    expect(shown).toContain(`yet: «${update.spoken}»\nWhat you said last, over it: «${answered}»`)
  })

  test("a bare stop never stops a thread", () => {
    for (const heard of ["Stop.", "Stop", "Quiet!", "Shut up.", "Enough."]) expect(Brain.fast(situation(heard), lines)?.act).toBe("dismiss")
    // Even when the model takes it to mean the thread, stopping one isn't something yapd does yet.
    const stopped = Brain.check(Brain.decision({ act: "stop", target: "t1" }), situation("Stop the Mina one."), lines)
    expect(stopped).toEqual({ _tag: "Say", spoken: "I can't do that yet, sir." })
  })

  test("'show me that' shows what was just talked about without the model, and 'hide that' only takes a card down while one is up", () => {
    const subject: Assistant.Subject = { _tag: "Answer", said: "The Tezos migration is comparing fee tables, sir.", about: Option.some(ref(tezos)) }
    const shown = (heard: string, overrides: Partial<Brain.Situation> = {}) => {
      const decided = Brain.fast(situation(heard, { subject, ...overrides }), lines)
      return decided === undefined ? undefined : { act: decided.act, how: decided.how, target: decided.target }
    }
    const tezosHandle = desk().threads.find(({ ref }) => ref.id === tezos.id)!.handle
    expect(shown("Show me that.")).toEqual({ act: "show", how: "thread", target: tezosHandle })
    expect(shown("Show me that P.R.")).toEqual({ act: "show", how: "pr", target: tezosHandle })
    // Opening it is the same, at once even when the model is slow or down.
    for (const heard of ["Open that PR.", "Open that P.R.", "Open the pull request."]) expect(shown(heard)).toEqual({ act: "show", how: "pr", target: tezosHandle })
    // Its pull request while that's open, which opens it in the browser too, and the thread once it's merged.
    const pulled = (state: string): Threads.Desk => ({
      ...desk(),
      threads: desk().threads.map((listed) =>
        listed.ref.id !== tezos.id
          ? listed
          : {
              ...listed,
              thread: Schema.decodeUnknownSync(T3Live.Thread)({
                ...listed.thread,
                pullRequests: [{ number: 412, url: "https://github.com/lg-epitech/integration/pull/412", repository: "lg-epitech/integration", snapshot: { state, title: "Migrate Tezos" } }],
              }),
            },
      ),
    })
    expect(shown("Show me that.", { desk: pulled("OPEN") })).toEqual({ act: "show", how: "pr", target: tezosHandle })
    expect(shown("Show me that.", { desk: pulled("MERGED") })).toEqual({ act: "show", how: "thread", target: tezosHandle })
    // Asked for by name, the thread is what's shown, never its pull request opened in its place.
    expect(shown("Show me the thread.", { desk: pulled("OPEN") })).toEqual({ act: "show", how: "thread", target: tezosHandle })
    expect(shown("Show me that thread.", { desk: pulled("OPEN") })).toEqual({ act: "show", how: "thread", target: tezosHandle })
    expect(shown("Show me what's running.")).toEqual({ act: "show", how: "threads", target: "" })
    // Nothing "that" could be, so which thread is the model's to work out.
    expect(shown("Show me that.", { subject: { _tag: "Nothing" } })).toBeUndefined()
    // With nothing up, "hide that" could be about a thread.
    expect(shown("Hide that.")).toBeUndefined()
    expect(shown("Hide that.", { showing: "What's going on" })).toEqual({ act: "show", how: "hide", target: "" })
  })

  test("showing a thread or its pull request asks between those it can't tell apart, and says why when no thread can be seen", () => {
    const checked = (decided: Brain.Decision, overrides: Partial<Brain.Situation> = {}) => Brain.check(decided, situation("Show me the migration PR.", overrides), lines)
    const [tezosHandle = "", minaHandle = ""] = [tezos, mina].map((thread) => desk().threads.find(({ ref }) => ref.id === thread.id)!.handle)
    // Its pull request opens in his browser, so a low guess between two, or none at all, is asked about first.
    expect(checked(Brain.decision({ act: "show", how: "pr", target: tezosHandle, others: minaHandle, sure: "low" }))._tag).toBe("Ask")
    expect(checked(Brain.decision({ act: "show", how: "pr", others: `${tezosHandle}, ${minaHandle}` }))._tag).toBe("Ask")
    expect(checked(Brain.decision({ act: "show", how: "pr", target: tezosHandle, others: minaHandle, sure: "medium" }))._tag).toBe("Do")
    expect(checked(Brain.decision({ act: "show", how: "thread" }))).toEqual({ _tag: "Say", spoken: lines.cantTell })
    // With T3 Code down, there's no thread it could have told apart.
    const blind: Threads.Desk = {
      threads: [],
      away: [
        { machine: "Rosie", reason: "T3 Code isn't running, so I can't see your threads." },
        { machine: "rig", reason: "I can't see rig's threads yet." },
      ],
    }
    for (const how of ["thread", "pr"]) {
      expect(checked(Brain.decision({ act: "show", how }), { desk: blind })).toEqual({
        _tag: "Say",
        spoken: "T3 Code isn't running, so I can't see your threads, sir. I can't see rig's threads yet.",
      })
    }
  })

  test("naming a machine that can't be seen still lets through a thread here he plainly meant", () => {
    const rig = (decided: Brain.Decision) => Brain.check(decided, situation("What's the rig relay fix doing?"), lines)
    const here = rig(Brain.decision({ act: "look", target: "t2", machine: "rig", sure: "high" }))
    expect(here._tag === "Do" ? Option.map(here.plan.target, ({ thread }) => thread.title) : here).toEqual(Option.some("Migrate Tezos Integration"))
    // With nothing here picked, it says why it can't look there.
    expect(rig(Brain.decision({ act: "look", machine: "rig" }))).toEqual({ _tag: "Say", spoken: "I can't see rig's threads yet, sir." })
  })

  test("only a limit or whose it is makes \"how much is left\" a usage question", () => {
    const usage: Option.Option<Threads.Usage> = Option.some({ at: now, providers: [{ provider: "Claude", windows: [] }, { provider: "Codex", windows: [] }] })
    const usageAsked = (heard: string) => Brain.fast(situation(heard, { usage }), lines)?.act === "answer"
    expect(usageAsked("How much Claude have I got left?")).toBe(true)
    expect(usageAsked("How much of my quota is left?")).toBe(true)
    // About the work he just heard of, which only the model can answer.
    for (const heard of ["How much is left?", "How much work is left?", "How much time is left?", "How much of it is left?"]) expect(usageAsked(heard)).toBe(false)
  })

  test("a name said on its own is an answer, never silence, and \"Jarvis.\" picks the thread called that", () => {
    const jarvis = thread("6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f", "Jarvis companion assistant", "p-std")
    const latency = thread("7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d", "Latency audit", "p-std")
    const named: T3Live.View = { ...view, threads: new Map([jarvis, latency].map((thread) => [thread.id, thread])) }
    const candidates = [ref(jarvis), ref(latency)]
    const listed = Threads.shortlist({ machine: "Rosie", view: named, focus: Option.none(), pending: candidates, most: 30, started: new Map(), said: new Map(), now })
    const asking = { ...which(candidates), asked: "Jarvis companion assistant or Latency audit, sir?" }
    const picked = Brain.fast(situation("Jarvis.", { open: Option.some(asking), desk: { threads: listed, away: [] } }), lines)
    expect({ act: picked?.act, pending: picked?.pending, thread: listed.find(({ handle }) => handle === picked?.target)?.thread.title }).toEqual({
      act: "look",
      pending: "answers",
      thread: "Jarvis companion assistant",
    })
    // Which project, with "Yapd." for an answer, is for the model, which hears it out.
    const project: Assistant.Open = { ...which([]), kind: "project", asked: "For the loader fix, is that yapd or std?", about: "the loader fix" }
    for (const heard of ["Yapd.", "yapd please", "Jarvis, um."]) expect(Brain.fast(situation(heard, { open: Option.some(project) }), lines)).toBeUndefined()
    // Only what fills a pause, or asks nicely, is nothing said.
    for (const heard of ["Um.", "Uh, sir.", "Please."]) expect(Brain.fast(situation(heard, { open: Option.some(project) }), lines)?.act).toBe("resume")
  })

  test("a message passed on to a thread shows in what happened lately in the words it was sent", () => {
    const message = "Use mainnet first, then ghostnet."
    // As the daemon keeps it once it's sent: the message, and nothing said aloud.
    const sent: Kept = { id: 1, at: now - 60_000, kind: "sent", machine: "Rosie", project: "integration", thread: tezos.id, directory: "/code/integration", text: message }
    const shown = Brain.prompt(situation("What did I just tell the Tezos one?", { lately: [sent] }), Option.none())
    const handle = desk().threads.find(({ ref }) => ref.id === tezos.id)?.handle
    expect(shown).toContain(`LATELY, oldest first:\n- 1 min ago, you sent his message to the thread (integration, ${handle}): «${message}»\n`)
  })

  test("usage read too long ago is never said or shown as what's used now, nor a window that has reset since", () => {
    const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    const read = now - 6 * 60 * 60_000
    const week = now + 3 * 24 * 60 * 60_000
    const resetting = `${new Date(week).toLocaleDateString("en-US", { weekday: "long" })} at ${clock(week)}`
    const windows: ReadonlyArray<T3Actions.Window> = [
      { kind: "session", label: "Session", minutes: 300, usedPercent: 95, resetsAt: new Date(now - 2 * 60 * 60_000).toISOString() },
      { kind: "weekly", label: "Weekly", minutes: 10080, usedPercent: 40, resetsAt: new Date(week).toISOString() },
    ]
    const usage = (at: number, kept = windows) => Option.some({ at, providers: [{ provider: "Claude", windows: kept }] })
    expect(Brain.used(usage(read), "usage", lines, now)).toBe(`As of ${clock(read)}, Claude was at 40 percent of its weekly window, resetting ${resetting}, sir.`)
    expect(Brain.used(usage(read, windows.slice(0, 1)), "usage", lines, now)).toBe(`Claude's limits have reset since I read them at ${clock(read)}, sir.`)
    // Read a few minutes ago, what's still to reset is what's used now.
    expect(Brain.used(usage(now - 5 * 60_000), "usage", lines, now)).toBe(`Claude is at 40 percent of its weekly window, resetting ${resetting}, sir.`)
    const shown = Brain.prompt(situation("What's left of my Claude week?", { usage: usage(read) }), Option.none()).split("USAGE:\n")[1]!.split("\n\n")[0]
    expect(shown).toBe(
      `As of ${clock(read)}, when T3 Code last answered, so never what's used now: say it's as of ${clock(read)}.\n` +
        `- Claude: the five-hour window has reset since, so what it's at now isn't known, 40% of the weekly window (resets ${resetting})`,
    )
  })

  test("a near-silence 'Thank you.' is ignored", () => {
    const faint = (heard: string, voiced: number) => Brain.fast(situation(heard, { utterance: { ...situation(heard).utterance, voiced } }), lines)?.act
    expect(faint("Thank you.", 0.2)).toBe("resume")
    expect(faint("you.", 0.1)).toBe("resume")
    expect(faint("Thank you. Thank you. Thank you. Thank you.", 3)).toBe("resume")
    // Said for real, it's for the model to make sense of.
    expect(faint("Thank you.", 1.2)).toBeUndefined()
  })

  test("spoken lines never carry a handle, an id, a path, 'the agent' or 'the session'", () => {
    const candidates = desk().threads
    const project = { kind: "project" as const, asked: "Which project is the retry fix for?", about: "the retry fix" }
    // As T3 Code labels them.
    const usage: Option.Option<Threads.Usage> = Option.some({
      at: now - 60_000,
      providers: [
        {
          provider: "Claude",
          windows: [
            { kind: "session", label: "Session", minutes: 300, usedPercent: 60.4, resetsAt: "2026-10-09T01:10:00.000Z" },
            { kind: "weekly", label: "Weekly", minutes: 10080, usedPercent: 11, resetsAt: "2026-10-10T06:00:00.000Z" },
            { kind: "weekly", label: "Weekly · Fable", minutes: 10080, usedPercent: 40, resetsAt: undefined },
          ],
        },
        { provider: "Codex", windows: [{ kind: "weekly", label: "Weekly", minutes: 10080, usedPercent: 20, resetsAt: "2026-10-12T13:00:00.000Z" }] },
      ],
    })
    const resolved = Drafts.resolve(
      [{ name: "rig", here: false, hosts: [], launcher: { start: () => Effect.die(""), catalog: Effect.die("") }, researcher: Research.unavailable("") }],
      [{ machine: "rig", here: false, hosts: [], catalog: Option.some({ projects: [{ name: "trainer", path: "/home/me/trainer", repository: true, branch: "main", worktree: true, recent: [] }], models: [] }) }],
      { about: "the loader fix", project: "trainer", machine: "rig", model: "", effort: "", worktree: true, worktreeFrom: "said", branch: "", prompt: "Fix it." },
    )
    const said = [
      Brain.which(candidates, lines, []),
      Brain.which(candidates, lines, [Brain.which(candidates, lines, []) ?? ""]),
      Brain.reworded({ kind: "which", asked: Brain.which(candidates, lines, []) ?? "", about: Brain.choices(candidates) }, [], lines),
      Brain.reworded(project, [], lines),
      Brain.dropped({ kind: "which", about: Brain.choices(candidates) }, lines),
      Brain.dropped(project, lines),
      Brain.left({ kind: "which", about: Brain.choices(candidates) }, lines),
      Brain.left(project, lines),
      Brain.notYet(lines),
      Brain.nothingSaid(lines),
      Brain.needing(desk(), lines, now),
      Brain.used(usage, "how much claude have i got left", lines, now),
      Brain.used(usage, "usage", lines, now),
      Brain.used(Option.none(), "usage", lines, now),
      ...Persona.sayable(Persona.plain),
      Conversation.movedOn,
      Drafts.confirmation("", Either.getOrThrow(resolved), { thread: "t9", project: "trainer", directory: "/home/me/trainer", branch: null, model: "gpt-6-sol", worktree: false }),
      Brain.speakable("I updated src/Brain.ts and the config in ~/.yapd/config.json, commit a1b2c3d4e5. The Codex agent is idle.", desk()),
      Brain.speakable("The Claude Code session finished the fix in the commit 9f3e2a1c, and a Claude Code agent pushed it. It's on the t3/jarvis-m1 branch.", desk()),
      Brain.speakable("It flagged wallet 0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c as unmatched, and/or skipped it.", desk()),
      Brain.speakable(
        "t2 is still at it: it rewrote /Users/me/code/integration/src/fees.ts at 5c529e6b, and the agent says the session ends soon, see https://github.com/x/y/pull/412.",
        desk(),
      ),
    ]
    for (const line of said) {
      expect(line).toBeString()
      expect(line).not.toMatch(/\bt\d+\b/)
      expect(line).not.toMatch(/[\da-f]{8}-[\da-f]{4}-/)
      expect(line).not.toMatch(/\b(?=[\da-f]*\d)(?=[\da-f]*[a-f])[\da-f]{7,}\b/)
      expect(line).not.toMatch(/(^|\s)~?\/[\w.-]+\//)
      expect(line).not.toMatch(/https?:/)
      expect(line).not.toMatch(/\bthe ((claude code|t3 code|claude|codex|coding|ai|opencode) )?(agent|session)s?\b/i)
      expect(line).not.toMatch(/0x[\da-f]{6,}/i)
      expect(line).not.toMatch(/\w\.(ts|js|json|md)\b/)
    }
    expect(said.at(-1)).toBe("Migrate Tezos Integration is still at it: it rewrote a file at a commit, and the work says the work ends soon, see a link.")
    expect(said.at(-2)).toBe("It flagged an address as unmatched, and/or skipped it.")
    expect(said.at(-3)).toBe("The work finished the fix in a commit, and a thread pushed it. It's on a branch.")
    expect(said.at(-4)).toBe("I updated a file and the config in a file, a commit. The work is idle.")
    // A weekly window resets days away, so the day is said, and "sir" only once however many lines.
    const everything = Brain.used(usage, "usage", lines, now)
    expect(everything).toContain("resetting Monday at")
    expect(everything.match(/sir/g)).toHaveLength(1)
    expect(everything).toContain("Claude is at 60 percent of its five-hour window")
    expect(everything).toContain("Fable's weekly window is at 40 percent.")
    expect(everything).not.toMatch(/session/i)
    // Pairs that aren't branches, and sessions that aren't the work, are said as they are.
    for (const line of [
      "The tunnel fix now waits for the old SSH session to exit before opening the next one.",
      "It splits the SSv1/SSv2 connectors by source, and the x86/arm64 builds pass.",
    ]) {
      expect(Brain.speakable(line, desk())).toBe(line)
    }
    expect(said[0]).toBe("Fix the transcription upload, Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?")
    expect(said[1]).toBe("Which one, sir: Fix the transcription upload, Migrate Tezos Integration or Open Mina SSV2 Bug Tickets?")
  })

  test("hyphenated pairs like \"on-chain/off-chain\" or \"unit/end-to-end\" are said as written, with the word before them, and only branches become \"a branch\"", () => {
    for (const line of [
      "The on-chain/off-chain reconciliation is done.",
      "The client/server-side split is in.",
      "It added read/write-heavy tests.",
      "The arm64/x86-64 builds pass, and UTF-8/UTF-16 decoding too.",
      "The unit/end-to-end tests pass.",
      "The client/peer-to-peer link works, and the in-band/out-of-band checks too.",
      "The stale/up-to-date flags and the copy/copy-on-write split are in.",
      "The Claude/Codex-style prompts are shorter.",
      "The BTC/USD-1000 contract settled.",
    ]) {
      expect(Brain.speakable(line, desk())).toBe(line)
    }
    expect(Brain.speakable("It pushed the t3code/reactor-menu-bar-icon to origin.", desk())).toBe("It pushed a branch to origin.")
    expect(Brain.speakable("It pushed t3code/fix-loader.", desk())).toBe("It pushed a branch.")
    expect(Brain.speakable("It's on laurent/fix-loader now.", desk())).toBe("It's on a branch now.")
    expect(Brain.speakable("It's on laurent/issue-412 now.", desk())).toBe("It's on a branch now.")
    expect(Brain.speakable("It's on laurent/jarvis-companion-assistant now.", desk())).toBe("It's on a branch now.")
  })
})
