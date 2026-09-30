import { Context, Data, Effect, JSONSchema, Layer, Option, Schema } from "effect"
import { styled } from "./Condenser.ts"
import * as Config from "./Config.ts"
import type { Catalog } from "./Launcher.ts"
import { WriterModel } from "./Model.ts"
import type { Played } from "./Recent.ts"
import type { Researcher } from "./Research.ts"
import type { Line } from "./Responder.ts"
import type { Known, Listed } from "./Threads.ts"

// The user dictates to yapd, not to an agent: new work, a message for an
// agent already at work, or a question about where their work stands. One
// call to the model decides which it is and where it goes, and writes the
// prompt or the message, which is all most requests need. New work that leans
// on something in the project is written by a second call instead, an agent
// run in the project's checkout that can read it, once the first has settled
// which project that is.

export const Action = Schema.Literal("start", "message", "summary", "status", "ask", "research", "none", "drop", "wait")
export type Action = typeof Action.Type

/**
 * What settled the project: they named it, they referred to earlier work that
 * was in it, or what the request is about is only found in it. Anything else is
 * a guess, however likely.
 */
export const Settled = Schema.Literal("named", "referred", "subject", "unclear")
export type Settled = typeof Settled.Type

/** What settled whether there's a worktree. Unclear when they said something about one that could be heard either way. */
export const Direction = Schema.Literal("said", "rule", "last used", "unclear")
export type Direction = typeof Direction.Type

/**
 * What settled the thread a message or a question is about: they described it
 * in their own words, or they pointed at something yapd just read out.
 */
export const ThreadFrom = Schema.Literal("named", "referred", "unclear")
export type ThreadFrom = typeof ThreadFrom.Type

/** A flat object rather than a union, since some CLIs only take an object schema. */
export const Decision = Schema.Struct({
  action: Action,
  about: Schema.String,
  settled: Settled,
  /** Their words that settled the project, which are looked for in what they said. */
  evidence: Schema.String,
  project: Schema.String,
  machine: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  worktreeFrom: Direction,
  worktree: Schema.Boolean,
  branch: Schema.String,
  /** The thread's key as listed, for "message" and "summary". Empty when none. */
  thread: Schema.String,
  threadFrom: ThreadFrom,
  /** Their words that settled the thread, looked for in what they said. */
  threadEvidence: Schema.String,
  /** For "start", the work in a few concrete sentences, kept to know the thread by later. */
  description: Schema.String,
  why: Schema.String,
  prompt: Schema.String,
  spoken: Schema.String,
})
export type Decision = typeof Decision.Type

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "")

const saidBy = (lines: ReadonlyArray<Line>) => new Set(lines.filter(({ speaker }) => speaker === "user").flatMap(({ text }) => words(text)))

/** Whether every word quoted is one the user said. Nothing quoted settles nothing. */
const quoted = (evidence: string, lines: ReadonlyArray<Line>) => {
  const said = saidBy(lines)
  const given = words(evidence)
  return given.length > 0 && given.every((word) => said.has(word))
}

/**
 * Whether the project is settled by something the user really said, rather
 * than by what seemed likely: the reason is one of the three that count, and
 * the words given for it are theirs.
 */
export const grounded = (decision: Pick<Decision, "settled" | "evidence">, lines: ReadonlyArray<Line>) =>
  decision.settled !== "unclear" && quoted(decision.evidence, lines)

/** How a thread is named to the model and back: the machine it's on, then T3 Code's id. */
export const key = (machine: string, id: string) => `${machine}/${id}`

/** The machine and id a key names, when it's one. Machines' names hold no slash, so the first one splits it. */
export const parseKey = (key: string): Option.Option<{ readonly machine: string; readonly id: string }> => {
  const at = key.indexOf("/")
  if (at <= 0 || at === key.length - 1) return Option.none()
  return Option.some({ machine: key.slice(0, at), id: key.slice(at + 1) })
}

/** Words that name nothing on their own, so they can't be what settled a thread. */
const bare = new Set(["the", "a", "an", "agent", "thread", "one", "ones", "it", "its", "that", "this", "those", "these", "to", "on", "in", "s", "them", "they"])

/** The words the listing shows for a thread, which is all the model had to name it by. */
const wordsShown = ({ listed, known }: ThreadListing["threads"][number]) =>
  new Set([
    ...words(listed.title),
    ...words(listed.project),
    ...words(listed.branch ?? ""),
    ...words(listed.state),
    ...listed.needs.flatMap((need) => words(needing[need])),
    ...words(listed.error ?? ""),
    ...Option.match(known, { onNone: () => [], onSome: ({ description, prompt }) => [...words(description ?? ""), ...words(prompt ?? "")] }),
  ])

/**
 * Whether the thread is settled by something the user really said, so a
 * message can't go to the wrong agent: the key is one that was listed, and the
 * words given for it are theirs. When they named it, one of those words, past
 * the bare ones like "the agent", has to be one the listing shows for that
 * thread, or the model went by something it wasn't given. When they only
 * pointed at something yapd read out, what they've heard has to carry that
 * thread, and a bare pointer like "that one" can only mean the last thing they
 * heard: when that carried no thread, or another, they meant something yapd
 * can't tell, and it asks. Bare words are the user's, but settle nothing on
 * their own.
 */
export const groundedThread = (
  decision: Pick<Decision, "thread" | "threadFrom" | "threadEvidence">,
  lines: ReadonlyArray<Line>,
  threads: ReadonlyArray<ThreadListing>,
  recent: ReadonlyArray<Played>,
) => {
  if (decision.threadFrom === "unclear") return false
  const chosen = decision.thread.trim()
  const found = threads.flatMap(({ machine, threads }) => threads.filter(({ listed }) => key(machine, listed.id) === chosen))[0]
  if (found === undefined || !quoted(decision.threadEvidence, lines)) return false
  const telling = words(decision.threadEvidence).filter((word) => !bare.has(word))
  if (decision.threadFrom === "named") {
    const listed = wordsShown(found)
    return telling.some((word) => listed.has(word))
  }
  if (telling.length === 0) {
    const latest = recent.reduce<Played | undefined>((last, heard) => (last === undefined || heard.heardAt > last.heardAt ? heard : last), undefined)
    return latest?.thread !== undefined && key(latest.thread.machine, latest.thread.id) === chosen
  }
  return recent.some(({ thread }) => thread !== undefined && key(thread.machine, thread.id) === chosen)
}

/** What comes back from reading the project: the prompt, or a question it raised. */
export const Written = Schema.Struct({
  action: Schema.Literal("start", "ask"),
  why: Schema.String,
  prompt: Schema.String,
  spoken: Schema.String,
})
export type Written = typeof Written.Type

/** What a machine can start, or why it can't say. */
export interface Listing {
  /** What the user calls the machine. */
  readonly machine: string
  readonly here: boolean
  /** Names its hooks may report it by, which say where an update came from. */
  readonly hosts: ReadonlyArray<string>
  readonly catalog: Option.Option<Catalog>
  /** Why there's no catalog, as the launcher put it. */
  readonly reason?: string
}

/** A machine's threads, as T3 Code lists them there, with what yapd knows of each, or why they couldn't be listed. */
export interface ThreadListing {
  readonly machine: string
  readonly here: boolean
  readonly threads: ReadonlyArray<{ readonly listed: Listed; readonly known: Option.Option<Known> }>
  /** Why there are none to show, as the machine put it. */
  readonly reason?: string
}

/** All the writer goes by. */
export interface Material {
  readonly listings: ReadonlyArray<Listing>
  readonly threads: ReadonlyArray<ThreadListing>
  /** The user's preferences file, as they wrote it. */
  readonly rules: Option.Option<string>
  /** What the user has heard lately, the latest first: only what was read out, since they can't point at what they haven't heard. */
  readonly recent: ReadonlyArray<Played>
  /** What they dictated just before, that's still being written, oldest first: they may build on it. */
  readonly earlier: ReadonlyArray<string>
  /** What the user dictated, then any questions yapd asked about it and their answers. */
  readonly lines: ReadonlyArray<Line>
  /** Whether the project can be read through before writing. */
  readonly research: boolean
  readonly now: number
}

/** Where a request was settled to go, when its prompt is written by reading the project. */
export interface Destination {
  readonly about: string
  readonly project: string
  readonly machine: string
  readonly directory: string
  readonly model: string
  readonly effort: string
  readonly worktree: boolean
  /** What to look up, as the first call put it. */
  readonly lookFor: string
}

export class WriteError extends Data.TaggedError("WriteError")<{ readonly cause: unknown }> {}

export class Writer extends Context.Tag("yapd/Writer")<
  Writer,
  {
    readonly decide: (material: Material) => Effect.Effect<Decision, WriteError>
    /** Writes the prompt from the project's checkout, read through the machine's researcher. */
    readonly research: (material: Material, destination: Destination, researcher: Researcher) => Effect.Effect<Written, WriteError>
    /** Gets ready for a dictation that's under way. */
    readonly prepare: Effect.Effect<void>
  }
>() {}

const role = `You are yapd, the voice that reads a developer's coding agents' updates aloud. They just dictated something to you: new work, a message for an agent that's already at work, or a question about where their work stands. They're talking to you, not to an agent: you decide which it is and where it goes, and you write the prompt a new agent session starts from, or the message an agent gets. Nobody looks your decision over before it's acted on.`

const prompting = `"prompt": what the agent is given. You're its author, and you write it the way they would have typed it themselves with time to think: in their voice, first person where a person is needed, addressed to the agent. The agent heard none of this and knows nothing about you, so the prompt stands on its own.
- Keep their meaning and intent exactly. Everything they asked for is in it, with every constraint, preference and reason they gave, and everything they ruled out. Keep their own words for things, and how sure they were: "I think it's the cache" stays a guess.
- Clean up what speech leaves behind: false starts, filler, repetition. Where they corrected themselves, only the correction. Put it in the order that reads best, keeping the order of steps they gave.
- Fill in what they skipped because it was obvious to them. Spell out what "it", "that" or "the std thing" refers to, from what you read out lately or the project's recent work, with enough of its substance that the agent knows what it's about without having heard it.
- Add nothing they didn't ask for. No tests, documentation, commit, pull request, clean-up or "also check" of your own, no steps, approach or acceptance criteria they didn't give. What they left open stays open: the agent can read the project and decide.
- Never state what you don't know. Name a file, a function or a cause only if they did or if what's below shows it. If a word looks misheard and you can't tell what it was, keep it as heard and say it was dictated.
- A question stays a question, as they asked it, with nothing telling the agent what to do about it. Asking to look into something, or for a plan, isn't asking for the change.
- As long as what they said needs, which is often a sentence or two. Plain prose: no headings, no bullets unless they listed things, no "Your task is", no closing line.
- Leave out what was meant for you: the machine, the model, the effort, whether to use a worktree. The project only where the sentence needs it.
- In the language they spoke.`

const messaging = `For "message", "prompt" is what the agent gets in its thread, and the same rules hold: you're the author, you keep their meaning and intent exactly, and you write it as they would have typed it to that agent, addressed to it in the second person. "Tell it to keep the public API unchanged" is "Keep the public API unchanged." The agent has its thread, so it needs only what's new, not what it already knows, but anything they pointed at from what you read out is still spelled out.`

const speaking = (actions: ReadonlyArray<Action>) =>
  [
    `"spoken": what you say aloud. They're listening, not reading: short, natural speech, no lists, markdown, code, file paths or URLs. Say names the way a person would, like "Fable" for claude-fable-5-1 or "cryptio sources" for cryptio-sources.`,
    `- For "start", what you say once the session has started: the project, the model, and whether it's in a worktree, like "Started in yapd, on Fable, in a worktree." or "Started in yapd, on Fable, without a worktree." Always say which, in those words, since it's how they catch you having misheard. Most times that's all of it. The machine is only named when it isn't this one, and the effort only when they asked for one. If you filled in or corrected something that changes what the agent will do, add it in a few words, like "I took the std thing to mean the Redis investigation." Never how you decided, and don't repeat the request back.`,
    `- For "ask", the question, in one sentence. They may have dictated other things since, so it says which request it's about, and offers the candidates when two or three projects or threads really fit, like "For the retry fix, is that cryptio saas or integration connectors?" or "Is that the latency investigation in yapd, or the loader fix?" When they named a project you don't know, say so rather than offer ones they didn't name, like "I don't know a project called billing. Which one is the retry fix for?"`,
    ...(actions.includes("message") ? [`- Empty for "message", "summary" and "status": what's said about those is said once they're done, not by you here.`] : []),
    ...(actions.includes("research") ? [`- For "research", only that you're reading the project first, in a few words, like "Looking through yapd first."`] : []),
    ...(actions.includes("none") ? [`- For "none", a few words on why nothing came of it, like "That didn't sound like work to start, so I left it." or "The retry fix thread is on box, and I can't see box's threads right now."`] : []),
    ...(actions.includes("drop") ? [`- For "drop", that it's dropped, in a word or two. Empty for "wait".`] : []),
  ].join("\n")

const reading = `What you're reading is a transcript of speech, not something they typed. Names and technical words come out mangled, and the short words are the least reliable of all: "no", "not", "on", "in", "a" and "now" get swapped or dropped, which can turn an instruction into its opposite. So read for what a person would have said there, and don't take a short word at its face when the sentence around it says otherwise. Where the two readings would do different things and you can't tell which was meant, don't pick the one that happens to be written.`

const deciding = (research: boolean, answering: boolean) =>
  [
    role,
    `Reply with only a JSON object with the keys "action", "about", "settled", "evidence", "project", "machine", "model", "effort", "worktreeFrom", "worktree", "branch", "thread", "threadFrom", "threadEvidence", "description", "why", "prompt" and "spoken".`,
    reading,
    [
      `"action", which is the first thing to settle: whether it's new work, something for an agent that's already at work, or a question.`,
      `- "start" when it's new work, you know which project it's for, and you can write the prompt from what's below. That's most requests. Work that carries on from an earlier thread is still new work unless they address the agent or the thread: "follow up on what the std agent finished" starts a session, "tell the std agent to" does not.`,
      `- "message" when it's for an agent that's already at work, in a thread listed below, and you know which: "tell the retry-fix agent to keep the public API unchanged", "ask the latency one whether it looked at the cache". A thread that's done can still take a message: it picks up where it left off. An approval or an answer that a thread is waiting on is given in T3 Code, not by message: nothing you send gets through until they do.`,
      `- "summary" when they want to know where one thread stands, and you know which: "what's the latency investigation doing", "where's the yapd agent at", "did the loader fix finish", "what did it find".`,
      `- "status" when they ask across their work rather than about one thread: "who needs me", "what finished since lunch", "anything failing", "what's running on rig". It needs no thread and no project: the answer is worked out from the threads afterwards.`,
      `- "ask" when you can't tell which project new work is for, or which thread a message or a question is about. Never guess either: work started in the wrong project, or a message to the wrong agent, is the costly mistake, and a question costs them a few seconds. Also when the request can be read two ways that would send the agent in different directions. Nothing else is worth a question: not the model, the effort or the worktree, and not a detail the agent can find out in the project.`,
      ...(research
        ? [
            `- "research" when new work's project is clear, but the request leans on something in it that you'd have to read to know what's being asked, like "do for the responder what we did for the condenser" or "finish what that TODO in the launcher says". It takes a minute, and the agent reads the project itself, so what it can find on its own is no reason. Most requests don't need it.`,
          ]
        : []),
      `- "none" when there's nothing in it for you or an agent to do: they were trying the microphone, like "testing, one two", talking to someone else, or it makes no sense. Also when what they ask can't be done, like a message for a thread that isn't listed and no listed one could be it. Anything an agent could carry out is work, however small, and even when they call it a test: "this is a test, reply with the word OK" is a prompt like any other, and needs a project like any other.`,
      ...(answering
        ? [
            `- "drop" when they call the request off in answer to your question, like "never mind" or "forget it".`,
            `- "wait" when what they said after your question wasn't an answer to it: talk with someone else, noise, or something unrelated. You'll ask again later.`,
          ]
        : []),
    ].join("\n"),
    `"about": the request in a few words, for you to refer to it aloud later, like "the retry fix" or "the question about the latency investigation". Always filled in.`,
    [
      `Which thread, for "message" and "summary". The threads are listed below, on each machine, with what each is about: its title, project, branch and state as T3 Code has them, and for those you know more about, what the work is and how it was asked for. Only a listed thread can be picked, and only by its key.`,
      `"thread": the thread's key exactly as listed, like "rosie/6f1a2b". Empty for anything else, and when unclear.`,
      `"threadFrom": what settles the thread, which is only ever one of two things.`,
      `- "named": they described it in their own words, and one listed thread fits: its title, its project, its branch, what the work is, or where it stands when that singles it out, like "the retry fix", "the latency investigation", "the yapd agent" when yapd has one thread, or "the one that's waiting for me" when one is waiting. Heard loosely, since dictation mangles names, but at least one of their words has to be one the listing shows for that thread.`,
      `- "referred": they pointed at something you read out lately, like "that one", "it" or "the one that just finished", and what you read out carries the thread's key. Bare pointers like "it" or "that one" mean the last thing you read out, and only when it carries a thread: when it doesn't, that's unclear. Only what you read out counts, and only what's listed below as read out: what they dictated before points at no thread.`,
      `- "unclear": anything else, and then you ask. Two threads fitting about as well is unclear, and so is one that's only likely: the newest, or the only one still running. A thread they name that isn't listed, because it's archived or on a machine whose threads couldn't be listed, can't be reached: "ask" when a listed one could be it, else "none", saying why.`,
      `"threadEvidence": their words that settle it, copied from what they said exactly as transcribed, mistakes included: what they called it, or the words that point at what you read out. Empty when unclear.`,
      `When you ask which thread, name the candidates by what tells them apart: the project, the title or what the work is, and the machine only when it differs.`,
    ].join("\n"),
    [
      `Where new work goes, for "start"${research ? ` and "research"` : ""}. Each of the project, machine, model, effort and worktree is settled by the first of these that says anything about it:`,
      `1. What they said, like "in yapd", "with Fable on low", "in a worktree", "no worktree", "on rig" or "off the release branch".`,
      `2. Their rules, below, judged against this request.`,
      `3. What the project last used, below.`,
      `A message or a question needs no project: the thread settles it. For anything but "start"${research ? ` and "research"` : ""}, "settled" is "unclear", "worktreeFrom" is "rule", "worktree" is false and the rest of these are empty.`,
    ].join("\n"),
    [
      `"settled": what settles the project, which is only ever one of three things.`,
      `- "named": they named it in this dictation or in an answer to you. Dictation mangles names, like "yap D" for yapd or "crypto sources" for cryptio-sources, so take the listed project it sounds like. A name that sounds like nothing listed is a project you don't know: that's "unclear", and you never make one up or fall back on another.`,
      `- "referred": they pointed at earlier work in so many words, like "the same", "that one", "as before", "then do it in", or "follow up on what the std agent just finished", and that work was in the project. What you read out lately and what they dictated before are there to work out what such words point at, and for nothing else.`,
      `- "subject": what the request is about exists in exactly one project, like shower timing statistics, which only nowish has. It has to be about what the project is or contains. A request that would make sense in any project, like a test, a question about git or "fix the failing build", is about none of them.`,
      `- "unclear": anything else, and then you ask. That a request resembles one they made before, was dictated soon after it, or would most likely go where the last one went is not a reason: it's a guess, and they expect to be asked. So is two projects fitting about as well.`,
      `"evidence": their words that settle it, copied from what they said exactly as transcribed, mistakes included: the name they said, the words that point at earlier work, or the words that name the subject. Empty when unclear.`,
      `"project": its name exactly as listed. Empty when unclear.`,
      `"machine": as listed, the one the project is on. When it's on several and nothing says which, the one where it was worked on last. Only where they say to run it counts as said, like "on rig": a machine that's part of what the work is about, like "why is the rig relay slow", says nothing about where it goes.`,
      `"model": a model's name as listed. They name models loosely, like "Fable", "opus five five" or "the big GPT": take the listed model it means, the newest when several fit.`,
      `"effort": one of that model's efforts, or empty when it has none. Heard loosely too: "extra high" is xhigh.`,
      `"worktreeFrom": what settles the worktree: "said", "rule", "last used", or "unclear" when they said something about a worktree and you can't tell which way. People ask for one with "in a worktree" and decline with "no worktree", which sound nearly alike and get transcribed as each other, or as "on a work tree", "know work tree", "no work three" and the like. Judge by how people talk: a bare tag at the end of a sentence, right after they've told you to do nothing else or keep it small, is someone declining. If it could be either, it's "unclear", never "said".`,
      `"worktree": whether the agent works in a new worktree rather than the project's checkout. When unclear, what their rules say for this request, or else what the project last used.`,
      `"branch": the branch a new worktree starts from, when they named one. Empty otherwise.`,
      `"description": for "start", the work in two or three concrete sentences: what is to be done, where, and any notable constraint. It's kept so that the thread can be told apart later, when they talk about it, and never read out. Empty otherwise.`,
      `"why": for the log, not read out. In a sentence or two, what settled the action and the thread or the project, the model, the effort and the worktree, whether said, a rule or last used, and anything you corrected or filled in.`,
    ].join("\n"),
    `${prompting}\nFor "start". ${messaging}${research ? ` For "research", what to look up in the project, in a sentence.` : ""} Empty otherwise.`,
    speaking(["start", "message", "ask", ...(research ? ["research" as const] : []), "none", ...(answering ? ["drop" as const] : [])]),
  ].join("\n\n")

const researching = (destination: Destination) =>
  [
    `${role} It's for ${destination.project}, and the prompt can't be written without reading the project first, which is what you're here for.`,
    `You're in its checkout, ${destination.directory}. You can read anything in it and change nothing. Read only what the request leans on, stopping as soon as you can write the prompt. Solving or planning the work is the agent's job, not yours.`,
    `What to look up: ${destination.lookFor}`,
    `Reply with only a JSON object with the keys "action", "why", "prompt" and "spoken".`,
    [
      `"action":`,
      `- "start" once you can write the prompt.`,
      `- "ask" only if what you found leaves what they're asking for open, in a way that would send the agent in different directions.`,
    ].join("\n"),
    `"why": for the log, not read out. What you read, and what it settled, in a sentence or two.`,
    `${prompting}\nYou read the project to spell out what they pointed at, so the prompt says what that is as you found it: what it's called, and what it does today, in a sentence or two. How to do the work is still the agent's to decide. Empty for "ask".`,
    speaking(["start", "ask"]),
    `It starts in ${destination.project}${destination.machine === "" ? "" : ` on ${destination.machine}`}, on ${[destination.model, destination.effort].filter(Boolean).join(" ")}, ${destination.worktree ? "in a new worktree" : "in the project's checkout, without a worktree"}.`,
  ].join("\n\n")

/**
 * The names a dictation may hold, for what transcribes it to listen for:
 * machines, then projects, then what the models in use are called, since the
 * list is cut from the end when it's too long.
 */
export const vocabulary = (listings: ReadonlyArray<Listing>) => {
  const catalogs = listings.flatMap(({ catalog }) => Option.toArray(catalog))
  const called = catalogs.flatMap(({ projects, models }) => {
    const used = new Set(projects.flatMap(({ model }) => (model === undefined ? [] : [model.name])))
    // "Claude Fable 5.1" is said "Fable", and the version is heard well enough.
    return models.filter(({ name }) => used.has(name)).flatMap(({ title }) => title.split(/[\s-]+/).filter((word) => /^\p{L}{3,}$/u.test(word)))
  })
  return [
    ...new Set([...listings.map(({ machine }) => machine), ...catalogs.flatMap(({ projects }) => projects.map(({ name }) => name)), ...called]),
  ]
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

const shorten = (text: string, length: number) => {
  const squashed = squash(text)
  return squashed.length <= length ? squashed : `${squashed.slice(0, length - 1).trimEnd()}…`
}

/** Days since the epoch where the user is, so "today" and "yesterday" are their days. */
const day = (at: number) => {
  const date = new Date(at)
  return Math.floor((at - date.getTimezoneOffset() * 60_000) / 86_400_000)
}

/**
 * How long ago, the way it's said. Past an hour it says which day that was
 * too, since "3 h ago" at half past one was yesterday, and past a day it
 * counts calendar days like `roughly`, so every prompt names the same day.
 */
export const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const days = day(now) - day(at)
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago, ${days <= 0 ? "today" : "yesterday"}`
  return days <= 1 ? "yesterday" : `${days} days ago`
}

/**
 * How long ago, in words that change rarely: the thread listing is read on
 * every call, and what stays the same from call to call costs less.
 */
export const roughly = (at: number, now: number) => {
  const minutes = (now - at) / 60_000
  if (minutes < 5) return "just now"
  if (minutes < 60) return "minutes ago"
  const days = day(now) - day(at)
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`
}

/** Recent work listed per project. More would crowd out the rest. */
const titles = 3

const project = (now: number) => (listed: Catalog["projects"][number]) =>
  [
    `- ${listed.name} (${listed.path})`,
    listed.model === undefined ? "no model yet" : `last used ${[listed.model.name, listed.model.effort].filter(Boolean).join(" ")}`,
    listed.repository ? (listed.worktree ? "in a worktree" : "without a worktree") : "not a repository, so no worktree",
    ...(listed.recent.length === 0
      ? []
      : [
          `recent work: ${listed.recent
            .slice(0, titles)
            .map(({ title, date }) => {
              const at = Date.parse(date)
              return `"${shorten(title, 70)}"${Number.isNaN(at) ? "" : ` (${ago(at, now)})`}`
            })
            .join(", ")}`,
        ]),
  ].join(", ")

const model = ({ name, title, aliases, efforts }: Catalog["models"][number]) =>
  `- ${[name, ...[title, ...aliases].filter((other) => other.toLowerCase() !== name.toLowerCase())].join(", ")}${
    efforts.length === 0 ? "" : `: ${efforts.join(", ")}`
  }`

/** Every machine's projects and models. Models are listed once when machines share them. */
export const listed = (listings: ReadonlyArray<Listing>, now: number) => {
  const models = new Map<string, string>()
  return listings
    .map(({ machine, here, catalog, reason }) => {
      const name = `${machine}${here ? ", this machine" : ""}`
      if (Option.isNone(catalog)) return `On ${name}: nothing can start there right now. ${reason ?? ""}`.trim()
      const offered = catalog.value.models.map(model).join("\n")
      const same = models.get(offered)
      if (same === undefined) models.set(offered, machine)
      return [
        `On ${name}, the projects:`,
        catalog.value.projects.map(project(now)).join("\n"),
        same === undefined ? `and the models, each with its other names and its efforts:\n${offered}` : `and the same models as on ${same}.`,
      ].join("\n")
    })
    .join("\n\n")
}

/** Threads that haven't moved in this long aren't what the user talks about by voice. */
const lately = 14 * 24 * 60 * 60_000
/** About how many threads are shown in all. More would crowd out the rest, and cost time on every call. */
const shown = 40

/** When, as T3 Code stamps it, if it can be read. */
export const when = (at: string | null) => {
  const parsed = Date.parse(at ?? "")
  return Number.isNaN(parsed) ? Option.none() : Option.some(parsed)
}

const active = ({ state }: Listed) => state === "running" || state === "waiting"

/**
 * Which threads the model gets to see: every one that's running or waiting on
 * the user, since those are what messages and questions are mostly about,
 * then the newest of the rest from the last two weeks, up to about `shown` in
 * all across machines. Each machine's threads come back newest first, by the
 * time `standing` shows: when the thread finished, or else when it moved.
 */
export const shortlist = (threads: ReadonlyArray<ThreadListing>, now: number): ReadonlyArray<ThreadListing> => {
  const at = (listed: Listed) => when(listed.completedAt ?? listed.updatedAt)
  // One whose time can't be read sorts as the oldest, but stays in the running.
  const ended = (listed: Listed) => Option.getOrElse(at(listed), () => 0)
  const fresh = (listed: Listed) => Option.match(at(listed), { onNone: () => true, onSome: (at) => now - at <= lately })
  const rest = threads
    .flatMap(({ machine, threads }) => threads.map(({ listed }) => ({ key: key(machine, listed.id), listed })))
    .filter(({ listed }) => !active(listed) && fresh(listed))
    .toSorted((one, other) => ended(other.listed) - ended(one.listed))
  const running = threads.reduce((count, { threads }) => count + threads.filter(({ listed }) => active(listed)).length, 0)
  const kept = new Set(rest.slice(0, Math.max(0, shown - running)).map(({ key }) => key))
  return threads.map((listing) => ({
    ...listing,
    threads: listing.threads
      .filter(({ listed }) => active(listed) || kept.has(key(listing.machine, listed.id)))
      .toSorted((one, other) => ended(other.listed) - ended(one.listed)),
  }))
}

const needing: Record<Listed["needs"][number], string> = { approval: "an approval", input: "your input", plan: "a plan to accept" }

/**
 * Where a thread stands, in a few words: its state, what it waits on, and how
 * long ago that was, worded by `tell`. What it waits on is always said, whatever
 * the state: an older machine may list a turn as running while an approval holds it.
 */
export const standing = (thread: Listed, now: number, tell: (at: number, now: number) => string = ago) => {
  const since = (at: string | null) => Option.match(when(at), { onNone: () => "", onSome: (at) => ` ${tell(at, now)}` })
  const ended = since(thread.completedAt ?? thread.updatedAt)
  const waits = thread.needs.length === 0 ? "" : `waiting on ${thread.needs.map((need) => needing[need]).join(" and ")}`
  const also = waits === "" ? "" : `, ${waits}`
  switch (thread.state) {
    case "running":
      return `running, started${since(thread.requestedAt ?? thread.updatedAt)}${also}`
    case "waiting":
      return `${waits || "waiting on you"}, since${ended}`
    case "done":
      return `done${ended}${also}`
    case "failed":
      return `failed${ended}${thread.error === null || thread.error === "" ? "" : `: ${squash(thread.error)}`}${also}`
    case "stopped":
      return `stopped${ended}${also}`
    case "new":
      return `not started yet, made${since(thread.updatedAt)}${also}`
  }
}

/** How much of a thread's first message is shown: less when a description says what the work is. It's most of what the listing costs. */
const opening = 300
const glimpse = 200

const thread = (machine: string, now: number) => ({ listed, known }: ThreadListing["threads"][number]) =>
  [
    `- ${key(machine, listed.id)}: in ${listed.project}, "${shorten(listed.title, 90)}"${listed.branch === null || listed.branch === "" ? "" : `, on branch ${listed.branch}`}, ${standing(listed, now, roughly)}`,
    ...Option.match(known, {
      onNone: () => [],
      onSome: ({ description, prompt }) => {
        const described = description !== null && description.trim() !== ""
        return [
          ...(described ? [`  What the work is: ${squash(description)}`] : []),
          ...(prompt === null || prompt.trim() === "" ? [] : [`  Its first message began: ${shorten(prompt, described ? glimpse : opening)}`]),
        ]
      },
    }),
  ].join("\n")

/**
 * Every machine's threads, newest first, each by its key, with what yapd knows
 * of the work. Machines whose threads couldn't be listed say why.
 */
export const threadsListed = (threads: ReadonlyArray<ThreadListing>, now: number) =>
  shortlist(threads, now)
    .map(({ machine, here, threads, reason }) => {
      const name = `${machine}${here ? ", this machine" : ""}`
      if (reason !== undefined) return `On ${name}: its threads can't be listed right now, so none there can be picked. ${reason}`.trim()
      if (threads.length === 0) return `On ${name}: no threads lately.`
      return `On ${name}, the threads, newest first:\n${threads.map(thread(machine, now)).join("\n")}`
    })
    .join("\n\n")

/** How much of an agent's message is passed on. The summary is there whole. */
const excerpt = 700

/** The machine something heard came from: by its host when hooks named one, else the thread's, else this one's. */
const machineOf = (listings: ReadonlyArray<Listing>, said: Played) =>
  said.host === undefined
    ? (said.thread?.machine ?? listings.find(({ here }) => here)?.machine)
    : (listings.find(({ hosts }) => hosts.some((known) => known.toLowerCase() === said.host?.toLowerCase()))?.machine ?? said.host)

/** Something read out, and where it came from. What was about no project or thread in particular, like a report across them, says only what it said. */
const heard = (listings: ReadonlyArray<Listing>, now: number) => (said: Played) => {
  const where = [
    ...(said.project === "" ? [] : [`${said.project}${Option.match(Option.fromNullable(machineOf(listings, said)), { onNone: () => "", onSome: (machine) => ` on ${machine}` })}`]),
    ...(said.directory === "" ? [] : [`in ${said.directory}`]),
    ...(said.thread === undefined ? [] : [`thread ${key(said.thread.machine, said.thread.id)}`]),
  ]
  return [
    `- ${[ago(said.heardAt, now), ...where].join(", ")}. You said: ${squash(said.spoken)}`,
    // With a thread and no start, the text could be the agent's or a message yapd sent it, so neither is claimed.
    ...(said.message === ""
      ? []
      : [`  ${said.started === true ? "The prompt you started it with" : said.thread === undefined ? "The agent's message" : "What it was about"}: ${shorten(said.message, excerpt)}`]),
  ].join("\n")
}

const dialogue = (lines: ReadonlyArray<Line>) => {
  const [first, ...rest] = lines
  return [
    `What they dictated:\n${first?.text ?? ""}`,
    ...rest.map(({ speaker, text }) => (speaker === "yapd" ? `You asked: ${text}` : `They said, right after: ${text}`)),
  ].join("\n\n")
}

/** What's there to pick from is left out once the destination is settled, as when the project is read through. */
const context = ({ listings, threads, rules, recent, earlier, lines, now }: Material, style: Option.Option<string>, choosing = true) => [
  ...Option.toArray(Option.map(style, styled)),
  Option.match(rules, {
    onNone: () => "They have written no rules.",
    onSome: (rules) => `Their rules, as they wrote them:\n${rules}`,
  }),
  ...(choosing ? [listed(listings, now), threadsListed(threads, now)] : []),
  recent.length === 0
    ? "You've read nothing out lately."
    : `What you read out lately, the last thing first:\n${recent.map(heard(listings, now)).join("\n")}`,
  ...(earlier.length === 0
    ? []
    : [
        `What they dictated just before, which is being started on its own. It's only here for what they refer to, so leave its work out of this prompt:\n${earlier
          .map((heard) => `- ${squash(heard)}`)
          .join("\n")}`,
      ]),
  "What they said was transcribed from speech and can have mistakes, so go with what they most likely meant.",
  dialogue(lines),
]

/** What stays the same from call to call comes first, so the provider can reuse it. */
export const prompt = (material: Material, style: Option.Option<string>) =>
  [deciding(material.research, material.lines.length > 1), ...context(material, style)].join("\n\n")

export const researchPrompt = (material: Material, destination: Destination, style: Option.Option<string>) =>
  [researching(destination), ...context(material, style, false)].join("\n\n")

export const ProviderWriter = Layer.effect(
  Writer,
  Effect.gen(function* () {
    const model = yield* WriterModel
    const style = yield* Config.style
    return {
      decide: (material) =>
        model.ask(Decision, prompt(material, style)).pipe(Effect.mapError((cause) => new WriteError({ cause }))),
      research: (material, destination, researcher) =>
        researcher
          .research({
            directory: destination.directory,
            prompt: researchPrompt(material, destination, style),
            schema: JSONSchema.make(Written) as unknown as Record<string, unknown>,
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknown(Written)),
            Effect.mapError((cause) => new WriteError({ cause })),
          ),
      prepare: model.prepare,
    }
  }),
)
