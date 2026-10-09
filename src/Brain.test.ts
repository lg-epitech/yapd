import { describe, expect, test } from "bun:test"
import { Effect, Either, Option, Schema } from "effect"
import type * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import * as Conversation from "./Conversation.ts"
import * as Drafts from "./Drafts.ts"
import * as Hands from "./Hands.ts"
import * as Notices from "./Notices.ts"
import type { Kept } from "./Journal.ts"
import * as Persona from "./Persona.ts"
import * as Questions from "./Questions.ts"
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
  acted: Option.none(),
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

/** The Tezos migration's question in two parts, open at `part`, the first answered "Red" when it's the second. */
const questionOpen = (part: number) => {
  const colour: Questions.Question = {
    id: "colour",
    header: "Colour",
    question: "Which colour should the test use?",
    options: [
      { label: "Red", description: "A red test." },
      { label: "Blue", description: "" },
    ],
    multiSelect: false,
    allowCustomAnswer: true,
    required: true,
  }
  const extras: Questions.Question = {
    id: "extras",
    header: "Extras",
    question: "Which test extras should run?",
    options: [
      { label: "Alpha", description: "Runs the alpha suite." },
      { label: "Beta", description: "" },
      { label: "Gamma (Recommended)", description: "" },
    ],
    multiSelect: true,
    allowCustomAnswer: true,
    required: true,
  }
  const parts = [colour, extras].map((question) => Questions.said(question, Questions.sayQuestion(question.question)))
  const worded = Questions.worded({ called: "Migrate Tezos Integration", parts, lines })
  if (worded._tag !== "Ask") throw new Error("Only told")
  const wording = worded.parts[part]!
  const open: Assistant.Open = {
    ...which([ref(tezos)]),
    kind: "question",
    heard: "",
    decision: Brain.decision({ act: "reply" }),
    asked: part === 0 ? wording.first : wording.last("Red"),
    about: "the question on Migrate Tezos Integration",
    asks: { _tag: "Question", requestId: "q1", questions: [colour, extras], mode: "live", part, collected: part === 0 ? {} : { colour: { _tag: "Picked", options: [0] } }, inFull: true },
    wording,
  }
  return { open, desk: desk([ref(tezos)]) }
}

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

  test("the OPEN section shows the part being asked, its options with what they mean, whether several can be picked, yapd's pick and what's answered already", () => {
    const { open } = questionOpen(1)
    const shown = Brain.prompt(situation("Alpha, and Gamma too.", { open: Option.some(open), desk: desk([ref(tezos)]) }), Option.none())
    expect(shown).toContain("It asks the thread's question for it, part 2 of 2.")
    expect(shown).toContain("He answered already: «Which colour should the test use?» → «Red».")
    expect(shown).toContain("The question: «Which test extras should run?», headed «Extras».")
    expect(shown).toContain("Its options: «Alpha» («Runs the alpha suite.»), «Beta», «Gamma (Recommended)». Several can be picked.")
    expect(shown).toContain("You said you'd go with «Gamma (Recommended)».")
    expect(shown).toContain(`"how" "skip" with "reply" skips this part. "again" with "how" "more" is to hear what the options mean.`)
    // His words go as they are, and a no isn't taken for letting it go.
    expect(shown).toContain(`"text" is all of his words, as he'd type them.`)
    expect(shown).not.toContain("A no that isn't one of its options")
    expect(shown).toContain(`"text" empty when he wants to hear a thread's question before answering: yapd reads it to him.`)
    // On a second look at a thread asking him, its options too.
    const [colour] = open.asks?._tag === "Question" ? open.asks.questions : []
    const looked = Brain.prompt(
      situation("What's it asking?", {
        second: Option.some({ ref: ref(tezos), detail: { messages: [], runs: [], request: Option.some({ _tag: "Question", id: "q1", questions: [colour!], mode: "live" }), plan: Option.none(), pending: ["q1"] } }),
      }),
      Option.none(),
    )
    expect(looked).toContain("Asking him: «Which colour should the test use?» Its options: «Red», «Blue».")
  })

  test("'what's the question' and 'what are the options' are worked out without the model", () => {
    const decided = (heard: string, part: number) => {
      const { open, desk: shown } = questionOpen(part)
      const made = Brain.fast(situation(heard, { open: Option.some(open), desk: shown, subject: { _tag: "Answer", said: open.asked, about: Option.some(ref(tezos)) } }), lines)
      return made === undefined ? undefined : { act: made.act, how: made.how, text: made.text, pending: made.pending }
    }
    expect(decided("What are the options?", 0)).toEqual({ act: "again", how: "more", text: "", pending: "answers" })
    expect(decided("What's the question?", 0)).toEqual({ act: "again", how: "same", text: "", pending: "answers" })
    expect(decided("Later.", 0)).toEqual({ act: "dismiss", how: "later", text: "", pending: "answers" })
    expect(decided("Skip that one.", 0)).toEqual({ act: "reply", how: "skip", text: "", pending: "answers" })
    expect(decided("Red, please.", 0)).toEqual({ act: "reply", how: "", text: "Red", pending: "answers" })
    expect(decided("All but Beta.", 1)).toEqual({ act: "reply", how: "", text: "Alpha\nGamma (Recommended)", pending: "answers" })
    // With nothing open, about the thread he's on about while it asks him something: read to him again.
    const asking = thread("9b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e", "Cloud deployment discovery", "p-std", {
      pendingRuntimeRequest: { id: "q1", kind: "user_input", createdAt: "2026-10-08T21:58:00.000Z" },
    })
    const shown: Threads.Desk = {
      threads: Threads.shortlist({ machine: "Rosie", view: { ...view, threads: new Map([...view.threads, [asking.id, asking]]) }, focus: Option.none(), pending: [], most: 30, started: new Map(), said: new Map(), now }),
      away: [],
    }
    const about = (of: T3Live.Thread) => Brain.fast(situation("What's the question?", { desk: shown, subject: { _tag: "Answer", said: "I'll leave it.", about: Option.some(ref(of)) } }), lines)
    expect(about(asking)).toEqual(Brain.decision({ act: "reply", target: shown.threads.find(({ ref }) => ref.id === asking.id)!.handle }))
    expect(about(mina)).toBeUndefined()
  })

  test("a bare stop never stops a thread", () => {
    const busy: Assistant.Subject = { _tag: "Answer", said: "It's comparing fee tables.", about: Option.some(ref(tezos)) }
    // Not even while he's hearing about one that's running.
    for (const heard of ["Stop.", "Stop", "Quiet!", "Shut up.", "Enough."]) {
      expect(Brain.fast(situation(heard), lines)?.act).toBe("dismiss")
      expect(Brain.fast(situation(heard, { subject: busy }), lines)?.act).toBe("dismiss")
    }
    // Nor with a question open whose yes would stop one, or send something again: it lets the question go.
    const confirming: Assistant.Open = {
      ...which([ref(tezos)]),
      kind: "confirm",
      decision: Brain.decision({ act: "stop", target: "t1", sure: "medium" }),
      asked: "Stop Migrate Tezos Integration, sir?",
      about: "stop Migrate Tezos Integration",
    }
    const resending: Assistant.Open = { ...confirming, kind: "resend", decision: Brain.decision({ act: "send", text: "Use the fee table." }), resend: Option.some("yapd:u0:0") }
    for (const open of [confirming, resending]) {
      for (const heard of ["Stop.", "Quiet!", "Enough."]) {
        expect(Brain.fast(situation(heard, { subject: busy, open: Option.some(open) }), lines)).toMatchObject({ act: "dismiss", pending: "answers" })
      }
    }
    // Saying to stop the work does, at once, for the one he's hearing about.
    const working = Brain.fast(situation("Stop working.", { subject: busy }), lines)
    expect(working === undefined ? undefined : desk().threads.find(({ handle }) => handle === working.target)?.thread.title).toBe("Migrate Tezos Integration")
    expect(working?.act).toBe("stop")
    const idle = desk().threads.find(({ thread }) => thread.id === mina.id)!
    expect(Brain.check(Brain.decision({ act: "stop", target: idle.handle }), situation("Stop the Mina one."), lines)).toEqual({
      _tag: "Say",
      spoken: "Open Mina SSV2 Bug Tickets isn't doing anything right now, sir.",
    })
  })

  test("a write only fairly sure of its thread is confirmed on the focus thread when it's a stop, and asked about or left elsewhere", () => {
    const listed = (of: T3Live.Thread) => desk().threads.find(({ thread }) => thread.id === of.id)!
    const on: Assistant.Subject = { _tag: "Answer", said: "It's comparing fee tables.", about: Option.some(ref(tezos)) }
    const checked = (decided: Brain.Decision, subject: Assistant.Subject = { _tag: "Nothing" }) => Brain.check(decided, situation("Stop the migration.", { subject }), lines)
    const stop = checked(Brain.decision({ act: "stop", target: listed(tezos).handle, sure: "medium" }), on)
    expect(stop._tag === "Ask" ? { kind: stop.open.kind, asked: stop.open.asked } : stop).toEqual({ kind: "confirm", asked: "Stop Migrate Tezos Integration, sir?" })
    // Sure of it, a stop goes ahead.
    expect(checked(Brain.decision({ act: "stop", target: listed(tezos).handle, sure: "high" }), on)._tag).toBe("Do")
    // A message to the focus thread goes ahead; to one that isn't, with nothing else it could be, it isn't guessed at.
    const message = (sure: Brain.Sure, others = "") => Brain.decision({ act: "send", target: listed(tezos).handle, sure, others, text: "Use the fee table." })
    expect(checked(message("medium"), on)._tag).toBe("Do")
    expect(checked(message("medium"))).toEqual({ _tag: "Say", spoken: "I couldn't tell which one you meant, sir." })
    const between = checked(message("medium", listed(mina).handle))
    expect(between._tag === "Ask" ? between.open.kind : between).toBe("which")
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

  test("what was done for him that he was never told of, since he turned yapd off meanwhile, shows in what happened lately with what would have been said", () => {
    const line = "I stopped Migrate Tezos Integration, sir, but couldn't tell it yet: yapd was turned off before I could."
    const stopped: Kept = { id: 1, at: now - 60_000, kind: "action", machine: "Rosie", thread: tezos.id, text: "Fix the loader instead.", detail: { reason: "yapd was turned off before I could.", unsaid: line } }
    const sent: Kept = { id: 2, at: now - 60_000, kind: "sent", machine: "Rosie", thread: tezos.id, text: "Use the fee table.", detail: { unsaid: "On it, sir." } }
    const shown = Brain.prompt(situation("What did you do to the Tezos one?", { lately: [stopped, sent] }), Option.none())
    const handle = desk().threads.find(({ ref }) => ref.id === tezos.id)?.handle
    expect(shown).toContain(`- 1 min ago, you did this (${handle}), but never told him, since he turned you off: «${line}»\n`)
    expect(shown).toContain(`- 1 min ago, you sent his message to the thread (${handle}): «Use the fee table.», but never told him, since he turned you off\n`)
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

  test("what's risky enough to need 'approve' is found however the command is written, and only words that say so approve it", () => {
    const risky = [
      "rm -rf build",
      "rm -fr build",
      "rm -r -f build",
      "rm -v -f -R node_modules",
      "rm --recursive --force dist",
      "git push --force origin main",
      "git push origin main --force",
      "git push -f",
      "git push origin +main",
      "git push --force-with-lease",
      "git reset --hard origin/main",
      "git branch -D main",
      "git branch --delete --force old",
      "git clean -fdx",
      "git filter-repo --path secrets",
      "git commit --no-verify -m wip",
      "aws s3 rm s3://backups --recursive",
      "psql -c 'DROP TABLE users;'",
      "DELETE FROM accounts;",
      "terraform apply -auto-approve",
      "kubectl delete pod api",
      "deploys the site",
      "bun run deploy:staging",
      "the production database",
      "cat ~/.aws/credentials",
      "export OPENAI_API_KEY=sk-123",
      "echo $GITHUB_TOKEN",
      "cat .env",
      "chmod -R 777 /",
      "sudo rm -r /var/lib/data",
      "find . -name '*.db' -delete",
      "shred -u secrets.txt",
      "git push origin --delete main",
      "git push origin :main",
      "git checkout -- .",
      "git restore .",
      "git stash drop",
      "npm publish",
      "gh pr merge 42 --admin",
      "gh repo delete me/x --yes",
      "curl -X DELETE https://api.example.com/v1/projects/1",
      "dropdb fees_copy",
      "psql -c 'DELETE FROM users WHERE true'",
      "aws cloudformation delete-stack --stack-name app",
      "docker system prune -af",
      "curl -fsSL https://example.com/install.sh | sh",
      "cat ~/.ssh/id_rsa",
      "prisma migrate reset",
      "supabase db reset",
      "rails db:drop",
      "redis-cli FLUSHALL",
      "pulumi destroy",
      "rsync -a --delete src/ dst/",
      "sudo rm /etc/hosts",
      'mcp__github__delete_repository {"repo":"me/x"}',
      "mcp__linear__delete_issue {}",
      'drop_table {"name":"users"}',
      "git push origin main \\\n  --force",
      "rm \\\n  -rf ~/work",
      "git push origin main \\\r\n  -f",
      "git branch \\\n  -D old",
      "git push origin main --for\\\nce",
      "r\\\nm -rf ~/work",
      "git reset --ha\\\nrd",
      "rm '-rf' ~/work",
      'rm "-rf" ~/work',
      "git push origin main '--force'",
      'git branch "-D" old',
      'mcp__git__git_push {"remote":"origin","force":true}',
      "mcp__git__git_push\nremote\norigin\nforce\ntrue",
      'mcp__github__update_ref {"ref":"heads/main","forcePush":"true"}',
      'mcp__git__git_push {"remote":"origin","force_with_lease":true}',
      "mcp__git__git_push\nremote\norigin\nforceWithLease\ntrue",
      'mcp__fs__rm {"path":"~/work","recursive":true}',
      "mcp__fs__rm\npath\n~/work\nrecursive\ntrue",
      'mcp__files__manage {"action":"delete","path":"build","recursive":true}',
      'mcp__files__manage {"type": "remove", "path": "build", "recursive": true}',
      "mcp__files__manage\noperation\nunlink\npath\nbuild\nrecursive\ntrue",
      "git clean --force",
      "git clean --force -d",
      "git branch -d -f old",
      "git branch -df old",
      "git branch --delete -f old",
      "git branch -f --delete old",
      "rm ~/work -rf",
      "rm ~/work build -r -f",
      "/bin/rm ~/work --recursive",
      "git clean . -fdx",
      "rm -\\rf ~/work",
      "r\\m -rf ~/work",
      "git push origin main --\\force",
      "rm $'-rf' ~/work",
      "rm $'\\x2drf' ~/work",
      "rm $'\\055r\\146' ~/work",
      'git push origin main $"--force"',
      'mcp__fs__copy_file {"source":"a.txt","destination":"b.txt","overwrite":true}',
      "mcp__fs__move_file\nsource\na.txt\ndestination\nb.txt\noverwriteExisting\ntrue",
      'grep -r "$(rm -rf ~/work)" src',
      "git commit -m \"`rm -rf ~/work`\"",
      "grep -l TODO -r src | xargs rm -rf",
      "sudo -u grep rm -rf ~/work",
      "find . -name '*.tmp' -exec rm -rf {} +",
      "git submodule foreach git clean -fdx",
      "git -C ~/work clean -fdx",
      "git --no-pager branch -D old",
      "git -c core.pager='rm -rf ~/work' log",
      "echo rm -rf ~/work | xargs -0 sh -c",
      'mcp__proxy__call {"tool":"remove_directory","path":"build"}',
      "mcp__fs__delete_file\npath\nbuild",
      "bin/rails runner 'User.delete_all'",
      "rm 'a;b' -rf ~/work",
      'rm "a|b" -rf ~/work',
      "rm a\\;b -rf ~/work",
      "git push origin 'a;b' --force",
      "git push -uf origin main",
      "git push -fu origin main",
      "git push -vf",
      "git push -qf origin main",
      "git push origin main -uf",
      "git push origin -ud old",
      "git push --mirror",
      "git push --prune origin",
      "git reset -q --hard",
      "git reset HEAD~1 --hard",
      "git reset -q HEAD~1 --hard",
      "git -C ~/work reset -q --hard HEAD~2",
      "git submodule foreach 'git reset --hard'",
      "rm --rec ~/work",
      "rm --r -f ~/work",
      "git clean --fo -d",
      "git clean --f",
      "git branch --del -f old",
      "git branch -d --forc old",
      "git push --forc origin main",
      "git push origin --de old",
      "git push --mir",
      "git push --pru origin",
      "git reset --ha",
      "git reset --h HEAD~1",
      "rimraf ~/work",
      "npx rimraf ~/work",
      "bunx rimraf --glob 'dist/**'",
      "filesystem/delete_file\npath\nx",
      'filesystem/delete_file {"path":"x"}',
      "github/delete_repository\nrepo\nme/x",
      "supabase/drop_table\nname\nusers",
      "fs/rm\npath\nx\nrecursive\ntrue",
      "deleteFile\npath\nx",
      "fsRemoveDirectory\npath\nx",
      'mcp__files__manage {"action":"deleteAll","path":"build"}',
      "mcp__git__push\nremote\norigin\nflags\n--force",
      "mcp__git__push\nremote\norigin\nflags\n-u -f",
      "mcp__git__push\nremote\norigin\nrefspec\n+main",
      "mcp__git__push\nremote\norigin\nbranch\nmain\ndelete\ntrue",
      'mcp__git__git_push {"remote":"origin","branch":"old","delete":true}',
      "mcp__git__reset\nmode\nhard\ntarget\nHEAD~3",
      'mcp__git__git_reset {"mode":"hard"}',
      "git_reset\nhard\ntrue",
      "mcp__git__clean\nflags\n-fd",
      "rg --pre 'rm' -r x src",
      "git grep -O'rm -rf' -e x",
      "ack --pager='rm -rf ~/work' x",
      "rg -l x | xargs rm -rf",
      'git commit -m "$(cat <<EOF\n$(rm -rf ~/work)\nEOF\n)"',
      "git commit -m \"$(cat <<'EOF'\nwip\nEOF\n)\" && rm -rf ~/work",
      "git commit -m \"$(cat <<'EOF'\nwip\nEOF\n)\"\nrm -rf ~/work",
      "git commit -m \"$(cat <<'EOF'\nwip\n  EOF\n)\"\nrm -rf ~/work\nEOF\nrm -rf ~/x",
      "git commit -m \"$(cat <<-'EOF'\nwip\n\tEOF\n)\"\nrm -rf ~/work",
      "$(cat <<'EOF'\nrm -rf ~/work\nEOF\n)",
      "sh -c \"$(cat <<'EOF'\nrm -rf ~/work\nEOF\n)\"",
      "eval \"x; git commit -m \"$(cat <<'EOF'\nfoo; rm -rf ~/work\nEOF\n)\"",
      "echo 'a\ngit commit -m \"$(cat <<'EOF'\n'; rm -rf ~/work; echo '\nEOF",
      "git commit -m \"$(cat <<'EOF'\nwip\nEOF\n)\" && git push --force",
      "git commit -m \"$(cat <<'EOF'\nwip\nEOF)\" && git push --force",
      "git commit -m \"$(cat <<'EOF'\nwip\nEOF\n)\"; rm -rf x",
      "git commit -m \"$(cat <<'EOF'\nwip\nEOF)\"; rm -rf x",
      "git commit -m \"$(cat <<'EOF'\nwip\nEOF)\"\nrm -rf x",
      "git commit -m \"$(cat <<'EOF'\nwip\n  EOF\n)\" && git push --force",
      "echo hi # ; git commit -m \"$(cat <<'EOF'\nrm -rf x",
    ]
    const ordinary = [
      "npm install left-pad",
      "git push origin main",
      "git push --follow-tags",
      "git branch -d merged-feature",
      "git clean -n",
      "rm notes.txt",
      "rm -f build.log",
      "bun test src/token.test.ts",
      "Read the fee tables",
      "cat .envrc",
      "git rm -r --cached node_modules",
      "git fetch --prune",
      "git restore --staged src/a.ts",
      "git checkout -b fee-tables",
      "find . -name '*.ts'",
      "git push origin main:main",
      "docker compose up",
      "prisma migrate dev",
      "rsync -a src/ dst/",
      'mcp__linear__list_issues {"team":"core"}',
      "git push origin main \\\n  --follow-tags",
      "git rm -r \\\n  --cached node_modules",
      "git rm -r --cach\\\ned node_modules",
      "rm '-f' build.log",
      'git rm -r "--cached" node_modules',
      'mcp__fs__list_directory {"path":"src","recursive":true}',
      "mcp__fs__list_directory\npath\nsrc\nrecursive\ntrue",
      'mcp__git__git_push {"remote":"origin","force":false}',
      'mcp__git__git_push {"remote":"origin","force_with_lease":false}',
      'mcp__search__search {"query":"how to remove a recursive function","recursive":true}',
      "mcp__search__search\nquery\nhow to remove a recursive function\nrecursive\ntrue",
      'mcp__fetch__fetch {"url":"https://example.com","forceRefresh":true}',
      "git clean --dry-run -d",
      "git branch --delete old -v",
      "rm build.log -f",
      "git rm node_modules -r --cached",
      "docker run --rm -it node:20 ls -R",
      "rm -\\f build.log",
      "git push origin main --\\follow-tags",
      "rm $'-f' build.log",
      "rm $'\\x2df' build.log",
      'mcp__fs__copy_file {"source":"a.txt","destination":"b.txt","overwrite":false}',
      'mcp__fs__write_file {"path":"b.txt","no_overwrite":true}',
      "grep 'rm' -r src",
      'grep "rm" -rn src',
      "grep rm -r src",
      "LC_ALL=C sudo grep -R 'clean' -f patterns.txt /etc",
      "git log --grep 'clean' -f",
      'git commit -m "rm" -r',
      'git commit -m "push --force"',
      "git -C ~/work log --grep branch -D",
      "bash -c 'grep rm -r src'",
      'mcp__search__search {"query":"remove","recursive":true}',
      "mcp__search__search\nquery\nremove\nrecursive\ntrue",
      'mcp__search__grep {"pattern":"delete_user","path":"src","recursive":true}',
      "mcp__search__grep\npattern\ndelete_user\npath\nsrc\nrecursive\ntrue",
      "mcp__search__grep\npattern\nrm\nrecursive\ntrue",
      "mcp__fs__list\npath\nsrc\nremove_duplicates\nfalse\nrecursive\ntrue",
      "rm 'a;b' -f build.log",
      'git commit -m "wip; tidy" && git push origin main',
      "git push -u origin feature",
      "git push -uv origin main",
      "git reset -q HEAD~1",
      "git reset --soft HEAD~1",
      'git commit -m "git reset --hard was wrong"',
      "grep -rn 'reset --hard' docs",
      "npm i -D rimraf",
      "npm uninstall rimraf",
      "grep rimraf package.json",
      "git push --dry-run origin main",
      "git push --porcelain origin main",
      "git branch --format='%(refname)' --delete old",
      "rm --dir empty",
      "git reset --help",
      "filesystem/read_file\npath\ndelete_me.txt",
      "filesystem/list_directory\npath\nsrc\nrecursive\ntrue",
      "readFile\npath\nsrc/deleteFile.ts",
      "github/search_code\nq\ndelete_repository",
      "undeleteFile\npath\nx",
      "mcp__git__push\nremote\norigin\nflags\n--follow-tags",
      "mcp__git__push\nremote\norigin\nbranch\nmain\ndelete\nfalse",
      "mcp__git__reset\nmode\nsoft\ntarget\nHEAD~1",
      "mcp__git__branch\nname\nold\nmode\ndelete",
      "mcp__git__log\nflags\n-f",
      "rg 'rm -rf' src",
      'rg -n "push --force" src',
      "rg rm -r src",
      "git grep 'rm -rf'",
      "git grep -n 'push --force'",
      "ag 'rm -rf' src",
      "ack 'rm -rf'",
      "ack -r 'clean -f' lib",
      "git commit -m \"$(cat <<'EOF'\nRemove the rm -rf from the docs\n\nIt's git push --force and git clean -fdx no more.\nEOF\n)\"",
      "git add -A && git commit -m \"$(cat <<'EOF'\nfix: rm -rf; push --force | clean -f\nEOF\n)\"",
      "git commit -m \"$(cat <<'EOF'\nfix: rm -rf it's\nEOF\n)\"\nBash: git commit -m \"$(cat <<'EOF'\nfix: rm -rf it's",
      "gh pr create --title \"Fix\" --body \"$(cat <<'EOF'\n- drops git reset --hard before the deploy to production\nEOF\n)\"",
      "git tag -a v1 -m \"$(cat <<'EOF'\nrm -rf\nEOF\n)\"",
      "cd ~/work && git commit -am \"$(cat <<'EOF'\nDrop git push -f from the docs\nEOF\n)\"",
      "git commit -m \"$(cat <<'EOF'\nDrop the rm -rf from the docs\nEOF)\"",
      "git commit -m \"$(cat <<'EOF'\nfix: rm -rf\nEOF)\" && git push",
      "git commit -m \"$(cat <<'EOF'\nFixes #12 # rm -rf; git push --force\nEOF\n)\"",
    ]
    expect(risky.filter((text) => !Brain.dangerous(text))).toEqual([])
    expect(ordinary.filter(Brain.dangerous)).toEqual([])
    // As an approval is read: all of what it would run, then T3 Code's own words for it, the tool's name and a colon before the command.
    const asked = (text: string) => `${text}\nBash: ${text}`
    expect(risky.filter((text) => !Brain.dangerous(asked(text)))).toEqual([])
    expect(ordinary.filter((text) => Brain.dangerous(asked(text)))).toEqual([])
    // The words that allow a risky one, and never one turned down in the same breath.
    expect(["Approve.", "Yes, approve it.", "Allow it.", "Confirm.", "I approve."].filter((heard) => !Brain.approving(heard))).toEqual([])
    expect(
      [
        "Yes.",
        "Sure.",
        "Go ahead.",
        "No, don't approve that.",
        "Never approve it.",
        "Do not allow it.",
        "Don't confirm.",
        "Don’t approve it.",
        "I wouldn't approve that.",
        "Can't approve that.",
        "Approve? No.",
      ].filter(Brain.approving),
    ).toEqual([])
    // For the rest of its work only in so many words.
    expect(["Yes, for the session.", "Allow it from now on."].every(Brain.forSession)).toBe(true)
    expect(["Yes.", "Approve it, it's a session thing.", "Always."].some(Brain.forSession)).toBe(false)
  })

  test("what's risky is told in moments, however what it would run is written, up to as much of it as is looked through", () => {
    // As much as an approval is looked through for what's risky, written so that patterns take time growing with the square of its
    // length: a command going on over many lines, many names a flag could follow in one command, or among its flags, a long word, a
    // name set to true with a long run of spaces and line breaks after it, many short commands, a $' never closed or many of them, and
    // separators that end no command, between quotes or after a backslash.
    const long = {
      "a push going on over lines": "push \\\n".repeat(3000),
      "an rm going on over lines": "rm \\\n".repeat(5000),
      "rm after rm": "rm ".repeat(7000),
      "rm among rm's flags": `rm ${"-.rm ".repeat(4000)}`,
      "branch among branch's flags": `branch ${"-.branch ".repeat(2200)}`,
      "clean among clean's flags": `clean ${"-.clean ".repeat(2500)}`,
      "az after az": "az ".repeat(7000),
      "rsync after rsync": "rsync ".repeat(3500),
      "restore after restore, staged after them all": `${"git restore ".repeat(1700)}--staged`,
      "rm -r after rm -r, cached after them all": `${"rm -r ".repeat(3300)}--cached`,
      "a long word": "a".repeat(20_000),
      "a long word of parts": "a_".repeat(10_000),
      "force with line breaks after it": `"force${"\n ".repeat(9990)}`,
      "recursive with line breaks after it": `"recursive${"\n ".repeat(9990)}rm`,
      "overwrite with line breaks after it": `"overwrite${"\n ".repeat(9990)}`,
      "many short commands": "rm;".repeat(6666),
      "a $' left open": `$'${"\\'".repeat(9999)}`,
      "many $'": "$'".repeat(10_000),
      "separators between quotes": "'a;'".repeat(5000),
      "separators after backslashes": "rm \\;".repeat(5000),
      "a git tool told many flags": `mcp__git__push\n${"-a -b\nmode\na\n".repeat(1700)}`,
      "many messages": `git commit -m "$(cat <<'EOF'\nx\nEOF\n)"\n`.repeat(600),
      "many messages begun on a line": `git commit${` -m "$(cat <<'E'`.repeat(1000)}`,
    }
    /** How long it takes to tell, the quickest of three, so a pause in between doesn't count. */
    const took = (text: string) =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const start = performance.now()
          Brain.dangerous(text.slice(0, 20_000))
          return performance.now() - start
        }),
      )
    expect(Object.entries(long).flatMap(([name, text]) => (took(text) > 20 ? [name] : []))).toEqual([])
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
    type Asked<Tag extends string> = Extract<T3Actions.Request, { readonly _tag: Tag }>
    const asking = (request: Asked<"Approval">, what: string, risk: "low" | "high" = "low") =>
      Notices.asking({ ref: ref(tezos), called: "Migrate Tezos Integration", project: "integration", request, what, risk, at: now }, lines)
    const questioning = (request: Asked<"Question">) =>
      Notices.questioning(
        { ref: ref(tezos), called: "Migrate Tezos Integration", project: "integration", request, spoken: request.questions.map(({ question }) => Questions.sayQuestion(question)), at: now },
        lines,
      )
    const question = (options: ReadonlyArray<string>, more = false): Asked<"Question"> => ({
      _tag: "Question",
      id: "q1",
      questions: [
        { id: "q", header: "", question: "Which network?", options: options.map((label) => ({ label, description: "" })), multiSelect: false, allowCustomAnswer: true, required: true },
        ...(more ? [{ id: "r", header: "", question: "And which fee table?", options: [], multiSelect: false, allowCustomAnswer: true, required: true }] : []),
      ],
      mode: "live",
    })
    const approve = (command: string): Asked<"Approval"> => ({ _tag: "Approval", id: "r1", what: `Bash: ${command}`, kind: "command", decisions: [{ decision: "accept", label: "Allow" }], command })
    const asks = [
      asking(approve("git push origin tezos"), "wants to push the branch"),
      asking(approve("rm -rf /tmp/build"), "wants to delete the build folder"),
      asking(approve("ls"), "needs your go-ahead to look around", "high"),
      questioning(question(["Mainnet", "Ghostnet"])),
      questioning(question([])),
      // One whose option can't be said goes by its number, one with two parts is asked a part at a time, and one with too many options is told.
      questioning(question(["~/code/integration/mainnet.json", "Ghostnet"])),
      questioning(question(["Mainnet"], true)),
      questioning(question(["Mainnet", "Ghostnet", "Shadownet", "Weeklynet", "Localnet"])),
    ]
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
      Brain.confirming("stop Migrate Tezos Integration", lines, []),
      Brain.reworded({ kind: "resend", asked: "Send it again?", about: "send that to Migrate Tezos Integration again" }, [], lines),
      Brain.dropped({ kind: "confirm", about: "stop Migrate Tezos Integration" }, lines),
      Brain.left({ kind: "offer", about: "tell Migrate Tezos Integration to ignore that" }, lines),
      Hands.done({ _tag: "Stop", to: ref(tezos) }, "now", lines, Option.some("Migrate Tezos Integration")),
      Hands.failed(
        { _tag: "Message", to: ref(tezos), text: "Merge it.", how: "now" },
        { _tag: "Refused", reason: Hands.plainly(`Thread ${tezos.id} is a subagent thread and can't take messages; command yapd:u1:0 was refused`) },
        lines,
        Option.none(),
      ),
      Hands.failed({ _tag: "Message", to: ref(tezos), text: "Merge it.", how: "now" }, { _tag: "Unknown", reason: "T3 Code is taking too long.", again: Option.some("yapd:u1:0") }, lines, Option.some("Migrate Tezos Integration")),
      // A message held behind a turn that's waiting, and a restart T3 Code couldn't take, done as a stop and then the message.
      Hands.done({ _tag: "Message", to: ref(tezos), text: "Merge it.", how: "now" }, "queued", lines, Option.some("Migrate Tezos Integration"), { waiting: "asked" }),
      Hands.done({ _tag: "Message", to: ref(tezos), text: "Merge it.", how: "restart" }, "now", lines, Option.none(), { stopped: true }),
      Hands.failed(
        { _tag: "Message", to: ref(tezos), text: "Merge it.", how: "restart" },
        { _tag: "Refused", reason: Hands.plainly(`Target run ${tezos.id} is waiting and cannot be steered.`), stopped: true },
        lines,
        Option.some("Migrate Tezos Integration"),
      ),
      Hands.failed({ _tag: "Message", to: ref(tezos), text: "Merge it.", how: "restart" }, { _tag: "Unknown", reason: "T3 Code is taking too long.", again: Option.none(), stopped: false }, lines, Option.none()),
      // As T3 Code words its reasons, with ids of any shape in them, quoted or not.
      ...[
        "Command yapd:u1:0 was previously rejected: Thread 'thr_01J9ABC' is archived.",
        "No active provider session for thread abc123.",
        "The agent session has ended.",
        `Thread not found: ${tezos.id}`,
        "Session 01J9ABCDEF2345 expired",
      ].map((reason) => Hands.failed({ _tag: "Message", to: ref(tezos), text: "Merge it.", how: "now" }, { _tag: "Refused", reason: Hands.plainly(reason) }, lines, Option.none())),
      Hands.twice(now - 54_000, now, lines, Option.none()),
      Hands.unconfirmedBefore(lines),
      Hands.unsentBefore(lines),
      Hands.read(lines, Option.some("Migrate Tezos Integration")),
      Hands.lost(lines, Option.none()),
      Hands.unoffered(lines, Option.some("Migrate Tezos Integration"), "Its thread is archived now."),
      Hands.unsure({ kind: "stop", body: { _tag: "Stop" } }, lines, Option.none()),
      Hands.unsure({ kind: "undo", body: { _tag: "Cancel", runId: "run_7f3a9c2b" } }, lines, Option.some("Migrate Tezos Integration")),
      // What's brought up about threads, with T3 Code's own words for why a run failed, and a secret's name as the agent gave it.
      ...[
        `Provider session ${tezos.id} was closed before the turn finished.`,
        "Claude API is overloaded (529). Try again shortly.",
        'Run "run_7f3a9c2b" failed: {"type":"error","error":{"type":"api_error"}}',
      ].map((message) =>
        Notices.lines.failed("Migrate Tezos Integration", Notices.reason(Option.some({ class: "unknown", message }), tezos), lines),
      ),
      Notices.lines.failed("Migrate Tezos Integration", Notices.reason(Option.none(), { ...tezos, lastErrorClass: "transport_error" }), lines),
      Notices.lines.limited("Migrate Tezos Integration", Notices.provider("claudeAgent"), Option.fromNullable(Brain.clock("2026-10-09T01:10:00.000Z", now)), lines),
      Notices.lines.secret("Migrate Tezos Integration", "STRIPE_API_KEY_2", lines),
      Notices.lines.secret("Migrate Tezos Integration", "deploy key", lines),
      Notices.lines.waiting("Migrate Tezos Integration", "wants to push the branch", lines),
      // What a thread waits on him for, asked, asked again and let go, and what's said of answering it.
      ...asks.flatMap((worded) => (worded._tag === "Ask" ? [worded.asking.asked, ...worded.asking.rewordings, worded.asking.about] : [worded.spoken])),
      ...asks.flatMap((worded) =>
        worded._tag === "Ask"
          ? (worded.asking.parts ?? []).flatMap((part) => [part.first, part.next("Mainnet"), part.last("Mainnet"), ...part.again, ...part.still, part.here, part.more, part.instead, part.letGo])
          : [],
      ),
      Brain.dropped({ kind: "approval", about: "allow Migrate Tezos Integration to push the branch" }, lines),
      Brain.dropped({ kind: "question", about: "the question on Migrate Tezos Integration" }, lines),
      Brain.dealtWith(lines),
      Brain.secretly(lines),
      Brain.unapproved(lines),
      Brain.cutShort(lines),
      Hands.done({ _tag: "Decide", to: ref(tezos), requestId: "r1", decision: "accept" }, "now", lines, Option.some("Migrate Tezos Integration")),
      Hands.done({ _tag: "Decide", to: ref(tezos), requestId: "r1", decision: "decline" }, "now", lines, Option.none()),
      Hands.done({ _tag: "Reply", to: ref(tezos), requestId: "q1", answers: { q: "ghostnet" }, said: Option.some("Ghostnet") }, "now", lines, Option.none()),
      Hands.failed({ _tag: "Decide", to: ref(tezos), requestId: "r1", decision: "accept" }, { _tag: "Refused", reason: Hands.plainly("Runtime request r1 is expired.") }, lines, Option.none()),
      Hands.failed({ _tag: "Reply", to: ref(tezos), requestId: "q1", answers: {}, said: Option.none() }, { _tag: "Unknown", reason: "T3 Code is taking too long.", again: Option.none() }, lines, Option.some("Migrate Tezos Integration")),
      Hands.failed({ _tag: "Message", to: ref(tezos), text: "Merge it.", how: "now" }, { _tag: "Refused", reason: Hands.given }, lines, Option.some("Migrate Tezos Integration")),
      ...[
        "It's waiting on a secret, so nothing goes to it by voice until that's given in T3 Code.",
        "It's waiting on you for something I couldn't read, so I held that back in case it's a secret.",
      ].map((reason) => Hands.failed({ _tag: "Message", to: ref(tezos), text: "Merge it.", how: "now" }, { _tag: "Refused", reason }, lines, Option.some("Migrate Tezos Integration"))),
      Hands.unsure({ kind: "decide", body: { _tag: "Decide", requestId: "r1", decision: "accept" } }, lines, Option.some("Migrate Tezos Integration")),
      Hands.failed(
        { _tag: "Decide", to: ref(tezos), requestId: "r1", decision: "decline" },
        { _tag: "Refused", reason: "Your earlier answer may already have got there, so this one needs T3 Code." },
        lines,
        Option.some("Migrate Tezos Integration"),
      ),
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
      expect(line).not.toMatch(/\w_\w*\d|\d{4}|\byapd:|['"]\w*\d/)
      expect(line).not.toMatch(/\b(agent|provider) session/i)
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
