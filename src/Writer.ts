import { Context, Data, Effect, JSONSchema, Layer, Option, Schema } from "effect"
import { styled } from "./Condenser.ts"
import * as Config from "./Config.ts"
import type { Catalog } from "./Launcher.ts"
import { WriterModel } from "./Model.ts"
import type { Heard } from "./Recent.ts"
import type { Researcher } from "./Research.ts"
import type { Line } from "./Responder.ts"

// The user dictates new work to yapd, not to an agent. One call to the model
// decides where it goes and writes the prompt, which is all most requests
// need. A request that leans on something in the project is written by a
// second call instead, an agent run in the project's checkout that can read
// it, once the first has settled which project that is.

export const Action = Schema.Literal("start", "ask", "research", "none", "drop", "wait")
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

/** All the writer goes by. */
export interface Material {
  readonly listings: ReadonlyArray<Listing>
  /** The user's preferences file, as they wrote it. */
  readonly rules: Option.Option<string>
  readonly recent: ReadonlyArray<Heard>
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

const role = `You are yapd, the voice that reads a developer's coding agents' updates aloud. They just dictated new work to you. They're talking to you, not to an agent: you decide where the work goes and write the prompt a new agent session starts from. Nobody looks your decision over before the session starts.`

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

const speaking = (actions: ReadonlyArray<Action>) =>
  [
    `"spoken": what you say aloud, in English whatever language they spoke, since the voice can't speak anything else. They're listening, not reading: short, natural speech, no lists, markdown, code, file paths or URLs. Say names the way a person would, like "Fable" for claude-fable-5-1 or "cryptio sources" for cryptio-sources.`,
    `- For "start", what you say once the session has started: the project, the model, and whether it's in a worktree, like "Started in yapd, on Fable, in a worktree." or "Started in yapd, on Fable, without a worktree." Always say which, in those words, since it's how they catch you having misheard. Most times that's all of it. The machine is only named when it isn't this one, and the effort only when they asked for one. If you filled in or corrected something that changes what the agent will do, add it in a few words, like "I took the std thing to mean the Redis investigation." Never how you decided, and don't repeat the request back.`,
    `- For "ask", the question, in one sentence. They may have dictated other things since, so it says which request it's about, and offers the candidates when two or three projects really fit, like "For the retry fix, is that cryptio saas or integration connectors?" When they named a project you don't know, say so rather than offer ones they didn't name, like "I don't know a project called billing. Which one is the retry fix for?"`,
    ...(actions.includes("research") ? [`- For "research", only that you're reading the project first, in a few words, like "Looking through yapd first."`] : []),
    ...(actions.includes("none") ? [`- For "none", a few words on why nothing started, like "That didn't sound like work to start, so I left it."`] : []),
    ...(actions.includes("drop") ? [`- For "drop", that it's dropped, in a word or two. Empty for "wait".`] : []),
  ].join("\n")

const reading = `What you're reading is a transcript of speech, not something they typed. Names and technical words come out mangled, and the short words are the least reliable of all: "no", "not", "on", "in", "a" and "now" get swapped or dropped, which can turn an instruction into its opposite. So read for what a person would have said there, and don't take a short word at its face when the sentence around it says otherwise. Where the two readings would do different things and you can't tell which was meant, don't pick the one that happens to be written.`

const deciding = (research: boolean, answering: boolean) =>
  [
    role,
    `Reply with only a JSON object with the keys "action", "about", "settled", "evidence", "project", "machine", "model", "effort", "worktreeFrom", "worktree", "branch", "why", "prompt" and "spoken".`,
    reading,
    [
      `"action":`,
      `- "start" when you know which project it's for and can write the prompt from what's below. That's most requests.`,
      `- "ask" when you can't tell which project they mean. Never guess a project: work started in the wrong one is the costly mistake, and a question costs them a few seconds. Also when the request can be read two ways that would send the agent in different directions. Nothing else is worth a question: not the model, the effort or the worktree, and not a detail the agent can find out in the project.`,
      ...(research
        ? [
            `- "research" when the project is clear, but the request leans on something in it that you'd have to read to know what's being asked, like "do for the responder what we did for the condenser" or "finish what that TODO in the launcher says". It takes a minute, and the agent reads the project itself, so what it can find on its own is no reason. Most requests don't need it.`,
          ]
        : []),
      `- "none" when there's nothing in it for an agent to do: they were trying the microphone, like "testing, one two", talking to someone else, asking you something, or it makes no sense. Anything an agent could carry out is work, however small, and even when they call it a test: "this is a test, reply with the word OK" is a prompt like any other, and needs a project like any other.`,
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
      `"why": for the log, not read out. In a sentence or two, what settled the project, the model, the effort and the worktree, whether said, a rule or last used, and anything you corrected or filled in.`,
    ].join("\n"),
    `${prompting}\nFor "start" only.${research ? ` For "research", what to look up in the project, in a sentence.` : ""} Empty otherwise.`,
    speaking(["start", "ask", ...(research ? ["research" as const] : []), "none", ...(answering ? ["drop" as const] : [])]),
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

/** How long ago, the way it's said. */
export const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`
  const days = Math.round(minutes / (24 * 60))
  return days === 1 ? "yesterday" : `${days} days ago`
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

/** How much of an agent's message is passed on. The summary is there whole. */
const excerpt = 700

const machineOf = (listings: ReadonlyArray<Listing>, host: string | undefined) =>
  (host === undefined
    ? listings.find(({ here }) => here)
    : listings.find(({ hosts }) => hosts.some((known) => known.toLowerCase() === host.toLowerCase()))
  )?.machine ?? host

const heard = (listings: ReadonlyArray<Listing>, now: number) => (said: Heard) =>
  [
    `- ${ago(said.at, now)}, ${said.project}${Option.match(Option.fromNullable(machineOf(listings, said.host)), { onNone: () => "", onSome: (machine) => ` on ${machine}` })}, in ${said.directory}. You said: ${squash(said.spoken)}`,
    `  ${said.started === true ? "The prompt you started it with" : "The agent's message"}: ${shorten(said.message, excerpt)}`,
  ].join("\n")

const dialogue = (lines: ReadonlyArray<Line>) => {
  const [first, ...rest] = lines
  return [
    `What they dictated:\n${first?.text ?? ""}`,
    ...rest.map(({ speaker, text }) => (speaker === "yapd" ? `You asked: ${text}` : `They said, right after: ${text}`)),
  ].join("\n\n")
}

const context = ({ listings, rules, recent, earlier, lines, now }: Material, style: Option.Option<string>, catalogs = true) => [
  ...Option.toArray(Option.map(style, styled)),
  Option.match(rules, {
    onNone: () => "They have written no rules.",
    onSome: (rules) => `Their rules, as they wrote them:\n${rules}`,
  }),
  ...(catalogs ? [listed(listings, now)] : []),
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
