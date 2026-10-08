import { describe, expect, test } from "bun:test"
import { Effect, Either, Option, Schema } from "effect"
import type * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import * as Conversation from "./Conversation.ts"
import * as Drafts from "./Drafts.ts"
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
  })

  test("a bare stop never stops a thread", () => {
    for (const heard of ["Stop.", "Stop", "Quiet!", "Shut up.", "Enough."]) expect(Brain.fast(situation(heard), lines)?.act).toBe("dismiss")
    // Even when the model takes it to mean the thread, stopping one isn't something yapd does yet.
    const stopped = Brain.check(Brain.decision({ act: "stop", target: "t1" }), situation("Stop the Mina one."), lines)
    expect(stopped).toEqual({ _tag: "Say", spoken: "I can't do that yet, sir." })
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
    const usage: Option.Option<T3Actions.Usage> = Option.some([
      { provider: "Claude", windows: [{ label: "5h", usedPercent: 60.4, resetsAt: "2026-10-08T20:10:00.000Z" }, { label: "Weekly · Fable", usedPercent: 40, resetsAt: undefined }] },
      { provider: "Codex", windows: [{ label: "Weekly", usedPercent: 20, resetsAt: "2026-10-12T13:00:00.000Z" }] },
    ])
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
      expect(line).not.toMatch(/\bthe (\w+ ){0,2}(agent|session)\b/i)
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
    expect(said[0]).toBe("Fix the transcription upload, Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?")
    expect(said[1]).toBe("Which one, sir: Fix the transcription upload, Migrate Tezos Integration or Open Mina SSV2 Bug Tickets?")
  })
})
