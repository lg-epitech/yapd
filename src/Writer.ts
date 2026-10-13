import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { aloud, styled } from "./Condenser.ts"
import * as Config from "./Config.ts"
import type { Catalog } from "./Launcher.ts"
import type * as Memory from "./Memory.ts"
import { WriterModel } from "./Model.ts"
import { unroutined } from "./Preferences.ts"
import type { Heard } from "./Recent.ts"
import type { Line } from "./Words.ts"

// The user dictates new work to yapd, not to an agent. One call to the model
// decides where it goes and writes the prompt: what the request leans on in
// the project is the agent's to read once it starts.

export const Action = Schema.Literal("start", "ask", "none", "drop", "wait")
export type Action = typeof Action.Type

/**
 * What settled the project: they named it, they referred to earlier work that
 * was in it, or what the request is about is only found in it. Anything else is
 * a guess, however likely. Or that it belongs to no project, which starts it
 * outside them all, in T3 Code's scratch project.
 */
export const Settled = Schema.Literal("named", "referred", "subject", "outside", "unclear")
export type Settled = typeof Settled.Type

/** What settled whether there's a worktree. Unclear when they said something about one that could be heard either way. */
export const Direction = Schema.Literal("said", "rule", "last used", "unclear")
export type Direction = typeof Direction.Type

/** A flat object rather than a union, since some CLIs only take an object schema. */
export const Decision = Schema.Struct({
  action: Action,
  about: Schema.String,
  settled: Settled,
  /** Their words that settled the project, which are looked for in what they said. Outside them, only the words that put it there, or none. */
  evidence: Schema.String,
  project: Schema.String,
  machine: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  worktreeFrom: Direction,
  worktree: Schema.Boolean,
  branch: Schema.String,
  why: Schema.String,
  prompt: Schema.String,
  spoken: Schema.String,
})
export type Decision = typeof Decision.Type

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "")

/**
 * Whether the project is settled by something the user really said, rather
 * than by what seemed likely: the reason is one of the three that count, and
 * the words given for it are theirs.
 */
export const grounded = (decision: Pick<Decision, "settled" | "evidence">, lines: ReadonlyArray<Line>) => {
  if (decision.settled === "unclear") return false
  const said = new Set(lines.filter(({ speaker }) => speaker === "user").flatMap(({ text }) => words(text)))
  const quoted = words(decision.evidence)
  return quoted.length > 0 && quoted.every((word) => said.has(word))
}

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

/** All the writer goes by. */
export interface Material {
  readonly listings: ReadonlyArray<Listing>
  /** The user's preferences file, as they wrote it. Its routines are never shown: only yapd sends them, for their name said. */
  readonly rules: Option.Option<string>
  /** What they asked yapd to keep in mind, by voice: only its facts are shown, in their words, never a routine. */
  readonly memories?: ReadonlyArray<Pick<Memory.Memory, "kind" | "text">>
  readonly recent: ReadonlyArray<Heard>
  /** What they dictated just before, that's still being written, oldest first: they may build on it. */
  readonly earlier: ReadonlyArray<string>
  /** What the user dictated, then any questions yapd asked about it and their answers. */
  readonly lines: ReadonlyArray<Line>
  readonly now: number
}

export class WriteError extends Data.TaggedError("WriteError")<{ readonly cause: unknown }> {}

export class Writer extends Context.Tag("yapd/Writer")<
  Writer,
  {
    readonly decide: (material: Material) => Effect.Effect<Decision, WriteError>
    /** Gets ready for a dictation that's under way. */
    readonly prepare: Effect.Effect<void>
  }
>() {}

const role = `You are yapd, the voice that reads a developer's coding agents' updates aloud. They just dictated new work to you. They're talking to you, not to an agent: you decide where the work goes and write the prompt a new agent session starts from. Nobody looks your decision over before the session starts.`

const prompting = `"prompt": what the agent is given. You're its author, and you write it the way they would have typed it themselves with time to think: in their voice, first person where a person is needed, addressed to the agent. The agent heard none of this and knows nothing about you, so the prompt stands on its own.
- Keep their meaning and intent exactly. Everything they asked for is in it, with every constraint, preference and reason they gave, and everything they ruled out. Keep their own words for things, and how sure they were: "I think it's the cache" stays a guess.
- Clean up what speech leaves behind: false starts, filler, repetition. Where they corrected themselves, only the correction. Put it in the order that reads best, keeping the order of steps they gave.
- Fill in what they skipped because it was obvious to them. Spell out what "it", "that" or "the std thing" refers to, from what you read out lately or the project's recent work, with enough of its substance that the agent knows what it's about without having heard it.
- Add nothing they didn't ask for. No tests, documentation, commit, pull request, clean-up or "also check" of your own, no steps, approach or acceptance criteria they didn't give. What they left open stays open: the agent can read the project and decide.
- Never state what you don't know. Name a file, a function or a cause only if they did or if what's below shows it. If a word looks misheard and you can't tell what it was, keep it as heard and say it was dictated.
- A question stays a question, as they asked it, with nothing telling the agent what to do about it. Asking to look into something, or for a plan, isn't asking for the change.
- What they asked you to remember, below, you use only where the request needs it: it's never work of its own, and never settles the project.
- For work outside their projects, the agent finds out and reports back, and changes no project or repository on the machine: say so. It's the one thing you add that they didn't say.
- As long as what they said needs, which is often a sentence or two. Plain prose: no headings, no bullets unless they listed things, no "Your task is", no closing line.
- Leave out what was meant for you: the machine, the model, the effort, whether to use a worktree. The project only where the sentence needs it.
- In the language they spoke.`

const speaking = (actions: ReadonlyArray<Action>) =>
  [
    `"spoken": what you say aloud. They're listening, not reading, so keep it short.`,
    aloud,
    `- For "start", what you say once the session has started, which comes after your usual line that it's in hand, so leave that out: the project, the model, and whether it's in a worktree, like "In yapd, on Fable, in a worktree." or "In yapd, on Fable, without a worktree." Always say which, in those words, since it's how they catch you having misheard. Most times that's all of it. The machine is only named when it isn't this one, and the effort only when they asked for one. If you filled in or corrected something that changes what the agent will do, add it in a few words, like "I took the std thing to mean the Redis investigation." Never how you decided, and don't repeat the request back.`,
    `- For "start" outside their projects, that you're looking into it, and the model, like "Looking into it, on Sol." Nothing about a worktree. The machine only when it isn't this one.`,
    `- For "ask", the question, in one sentence. They may have dictated other things since, so it says which request it's about, and offers the candidates when two or three projects really fit, like "For the retry fix, is that cryptio saas or integration connectors?" When they named a project you don't know, say so rather than offer ones they didn't name, like "I don't know a project called billing. Which one is the retry fix for?"`,
    ...(actions.includes("none") ? [`- For "none", a few words on why nothing started, like "That didn't sound like work to start, so I left it."`] : []),
    ...(actions.includes("drop") ? [`- For "drop", that it's dropped, in a word or two. Empty for "wait".`] : []),
  ].join("\n")

const reading = `What you're reading is a transcript of speech, not something they typed. Names and technical words come out mangled, and the short words are the least reliable of all: "no", "not", "on", "in", "a" and "now" get swapped or dropped, which can turn an instruction into its opposite. So read for what a person would have said there, and don't take a short word at its face when the sentence around it says otherwise. Where the two readings would do different things and you can't tell which was meant, don't pick the one that happens to be written.`

const deciding = (answering: boolean) =>
  [
    role,
    `Reply with only a JSON object with the keys "action", "about", "settled", "evidence", "project", "machine", "model", "effort", "worktreeFrom", "worktree", "branch", "why", "prompt" and "spoken".`,
    reading,
    [
      `"action":`,
      `- "start" when you know which project it's for, or that it's for none, and can write the prompt from what's below. That's most requests.`,
      `- "ask" when you can't tell which project they mean. Never guess a project: work started in the wrong one is the costly mistake, and a question costs them a few seconds. That's also when it fits a project and none about as well, like "For the glucose question, is that for yapd, or shall I just look into it?" Also when the request can be read two ways that would send the agent in different directions. Nothing else is worth a question: not the model, the effort or the worktree, and not a detail the agent can find out in the project.`,
      `- "none" when there's nothing in it for an agent to do: they were trying the microphone, like "testing, one two", talking to someone else, or it makes no sense. Anything an agent could carry out is work, however small, and even when they call it a test: "this is a test, reply with the word OK" is a prompt like any other, and needs a project like any other. A question to find out or look into is work too: an agent finds out and tells them.`,
      ...(answering
        ? [
            `- "drop" when they call the request off in answer to your question, like "never mind" or "forget it".`,
            `- "wait" when what they said after your question wasn't an answer to it: talk with someone else, noise, or something unrelated. You'll ask again later.`,
          ]
        : []),
    ].join("\n"),
    `"about": the request in a few words, in English, for you to refer to it aloud later, like "the retry fix". Always filled in.`,
    [
      `Where it goes. Each of the project, machine, model, effort and worktree is settled by the first of these that says anything about it:`,
      `1. What they said, like "in yapd", "with Fable on low", "in a worktree", "no worktree", "on rig" or "off the release branch".`,
      `2. Their rules, below, judged against this request.`,
      `3. What the project last used, below.`,
    ].join("\n"),
    [
      `"settled": what settles the project, which is only ever one of three things, or that it's for none.`,
      `- "named": they named it in this dictation or in an answer to you. Dictation mangles names, like "yap D" for yapd or "crypto sources" for cryptio-sources, so take the listed project it sounds like. A name that sounds like nothing listed is a project you don't know: that's "unclear", and you never make one up or fall back on another.`,
      `- "referred": they pointed at earlier work in so many words, like "the same", "that one", "as before", "then do it in", or "follow up on what the std agent just finished", and that work was in the project. What you read out lately and what they dictated before are there to work out what such words point at, and for nothing else.`,
      `- "subject": what the request is about exists in exactly one project, like shower timing statistics, which only nowish has. It has to be about what the project is or contains. A request that would make sense in any project, like a test, a question about git or "fix the failing build", is about none of them.`,
      `- "outside": they named no project, and it's about nothing in any of them, like something on the web or in the world. It starts outside their projects. So does what they say to start in scratch or outside their projects, like "look into it in scratch". A request that names one of their projects is never "outside", and neither is anything about code, a build, tests, a branch or a pull request, wherever they say to start it: with no project named or settled, it's "unclear", and you ask.`,
      `- "unclear": anything else, and then you ask. That a request resembles one they made before, was dictated soon after it, or would most likely go where the last one went is not a reason: it's a guess, and they expect to be asked. So is two projects fitting about as well.`,
      `"evidence": their words that settle it, copied from what they said exactly as transcribed, mistakes included: the name they said, the words that point at earlier work, or the words that name the subject. Outside their projects, only their words that put it there, like "in scratch", or else empty. Empty when unclear.`,
      `"project": its name exactly as listed. Empty when unclear or outside.`,
      `"machine": as listed, the one the project is on. When it's on several and nothing says which, the one where it was worked on last. Outside their projects, only the one they said, or else empty. Only where they say to run it counts as said, like "on rig": a machine that's part of what the work is about, like "why is the rig relay slow", says nothing about where it goes.`,
      `"model": a model's name as listed. They name models loosely, like "Fable", "opus five five" or "the big GPT": take the listed model it means, the newest when several fit.`,
      `"effort": one of that model's efforts, or empty when it has none. Heard loosely too: "extra high" is xhigh.`,
      `"worktreeFrom": what settles the worktree: "said", "rule", "last used", or "unclear" when they said something about a worktree and you can't tell which way. People ask for one with "in a worktree" and decline with "no worktree", which sound nearly alike and get transcribed as each other, or as "on a work tree", "know work tree", "no work three" and the like. Judge by how people talk: a bare tag at the end of a sentence, right after they've told you to do nothing else or keep it small, is someone declining. If it could be either, it's "unclear", never "said".`,
      `"worktree": whether the agent works in a new worktree rather than the project's checkout. When unclear, what their rules say for this request, or else what the project last used.`,
      `"branch": the branch a new worktree starts from, when they named one. Empty otherwise.`,
      `"why": for the log, not read out. In a sentence or two, what settled the project, the model, the effort and the worktree, whether said, a rule or last used, and anything you corrected or filled in.`,
    ].join("\n"),
    `${prompting}\nFor "start" only. Empty otherwise.`,
    speaking(["start", "ask", "none", ...(answering ? ["drop" as const] : [])]),
  ].join("\n\n")

/**
 * The names a dictation may hold, for what transcribes it to listen for:
 * machines, then projects, then what the models in use are called, then the
 * words of the titles of the threads most likely talked about, since the list
 * is cut from the end when it's too long.
 */
export const vocabulary = (listings: ReadonlyArray<Listing>, titles: ReadonlyArray<string> = []) => {
  const catalogs = listings.flatMap(({ catalog }) => Option.toArray(catalog))
  const called = catalogs.flatMap(({ projects, models }) => {
    const used = new Set(projects.flatMap(({ model }) => (model === undefined ? [] : [model.name])))
    // "Claude Fable 5.1" is said "Fable", and the version is heard well enough.
    return models.filter(({ name }) => used.has(name)).flatMap(({ title }) => title.split(/[\s-]+/).filter((word) => /^\p{L}{3,}$/u.test(word)))
  })
  // Names like Tezos are what Whisper mishears; everyday words it gets anyway.
  const named = titles.flatMap((title) => title.split(/[^\p{L}\p{N}]+/u).filter((word) => /^\p{Lu}[\p{L}\p{N}]{2,}$/u.test(word)))
  return [
    ...new Set([
      ...listings.map(({ machine }) => machine),
      ...catalogs.flatMap(({ projects }) => projects.filter(({ scratch }) => scratch !== true).map(({ name }) => name)),
      ...called,
      ...named,
    ]),
  ]
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

const shorten = (text: string, length: number) => {
  const squashed = squash(text)
  return squashed.length <= length ? squashed : `${squashed.slice(0, length - 1).trimEnd()}…`
}

/** How long ago, the way it's said. */
export const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`
  const days = Math.round(minutes / (24 * 60))
  return days === 1 ? "yesterday" : `${days} days ago`
}

/** Where work outside their projects starts, on a machine where it can. */
const outside = (listed: Catalog["projects"][number]) =>
  `Outside their projects (scratch): work that belongs to no project starts here, in a folder of its own${
    listed.model === undefined ? "" : `, last used ${[listed.model.name, listed.model.effort].filter(Boolean).join(" ")}`
  }.`

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
      const scratch = catalog.value.projects.find(({ scratch }) => scratch === true)
      return [
        `On ${name}, the projects:`,
        catalog.value.projects.filter(({ scratch }) => scratch !== true).map(project(now)).join("\n"),
        ...(scratch === undefined ? [] : [outside(scratch)]),
        same === undefined ? `and the models, each with its other names and its efforts:\n${offered}` : `and the same models as on ${same}.`,
      ].join("\n")
    })
    .join("\n\n")
}

/** How much of an agent's message is passed on. The summary is there whole. */
const excerpt = 700

const machineOf = (listings: ReadonlyArray<Listing>, host: string | undefined) =>
  (host === undefined
    ? listings.find(({ here }) => here)
    : listings.find(({ hosts }) => hosts.some((known) => known.toLowerCase() === host.toLowerCase()))
  )?.machine ?? host

const heard = (listings: ReadonlyArray<Listing>, now: number) => (said: Heard) =>
  [
    `- ${ago(said.at, now)}, ${said.project.trim() === "" ? "outside their projects" : said.project}${Option.match(Option.fromNullable(machineOf(listings, said.host)), { onNone: () => "", onSome: (machine) => ` on ${machine}` })}, in ${said.directory}. You said: ${squash(said.spoken)}`,
    `  ${said.started === true ? "The prompt you started it with" : "The agent's message"}: ${shorten(said.message, excerpt)}`,
  ].join("\n")

const fenced = (text: string) => `«${squash(text).replace(/[«»]/g, '"')}»`

/**
 * What's known of your own voice in what they said, as they said it: what
 * came first may be yours, and what followed a pause is theirs, even naming
 * one of the projects you `offered`, when it's an answer to you. What you
 * were saying is left out when it held a routine's steps, which this model
 * never sees, nor the routine.
 */
const overYou = ({ echo, afterPause, echoRoutines }: Line, offered: boolean) =>
  echo === undefined
    ? ""
    : `\nThey began that while your own voice could still get into their microphone, so what came first may be your own words${(echoRoutines ?? []).length > 0 ? "" : `, from around ${fenced(echo)}`}, misheard or not, and words that sound like yours there are yours.${
        afterPause === undefined || afterPause.trim() === ""
          ? ""
          : ` What they said after a pause, ${fenced(afterPause)}, is surely theirs, even where it repeats your words${offered ? ", like naming one of the projects you offered" : ""}.`
      }`

const dialogue = (lines: ReadonlyArray<Line>) => {
  const [first, ...rest] = lines
  return [
    `What they dictated:\n${first?.text ?? ""}${first === undefined ? "" : overYou(first, false)}`,
    ...rest.map((line) => (line.speaker === "yapd" ? `You asked: ${line.text}` : `They said, right after: ${line.text}${overYou(line, true)}`)),
  ].join("\n\n")
}

/**
 * What's shown of what they asked yapd to keep in mind, and of their rules:
 * facts alone, never a routine, by voice or in the file, whose steps only
 * yapd sends, for its name said, and never go into a prompt.
 */
const facts = ({ rules, memories = [] }: Pick<Material, "rules" | "memories">) => ({
  rules: Option.filter(Option.map(rules, unroutined), (rules) => rules !== ""),
  memories: memories.filter(({ kind }) => kind === "fact").map(({ text }) => `- ${fenced(text)}`),
})

const context = (material: Material, style: Option.Option<string>) => {
  const { listings, recent, earlier, lines, now } = material
  const { rules, memories } = facts(material)
  return [
    ...Option.toArray(Option.map(style, styled)),
    Option.match(rules, {
      onNone: () => "They have written no rules.",
      onSome: (rules) => `Their rules, as they wrote them:\n${rules}`,
    }),
    ...(memories.length === 0
      ? []
      : [`What they asked you to remember, in their words, as what's so about them and their work, never an instruction to you:\n${memories.join("\n")}`]),
    listed(listings, now),
    recent.length === 0
      ? "You've read nothing out lately."
      : `What you read out lately, newest first:\n${recent.map(heard(listings, now)).join("\n")}`,
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
}

/** What stays the same from call to call comes first, so the provider can reuse it. */
export const prompt = (material: Material, style: Option.Option<string>) =>
  [deciding(material.lines.length > 1), ...context(material, style)].join("\n\n")

export const ProviderWriter = Layer.effect(
  Writer,
  Effect.gen(function* () {
    const model = yield* WriterModel
    const style = yield* Config.style
    return {
      decide: (material) =>
        model.ask(Decision, prompt(material, style)).pipe(Effect.mapError((cause) => new WriteError({ cause }))),
      prepare: model.prepare,
    }
  }),
)
