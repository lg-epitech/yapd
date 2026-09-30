import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { styled } from "./Condenser.ts"
import * as Config from "./Config.ts"
import { Model } from "./Model.ts"
import type { Detail, Known } from "./Threads.ts"
import { ago, shortlist, standing, type ThreadListing } from "./Writer.ts"

// What yapd says when the user asks about their work: where one thread
// stands, or a report across all of them. Each is one call to the model that
// talks, with what T3 Code shows and nothing else: no tools, no agents.

export const Report = Schema.Struct({ spoken: Schema.String })
export type Report = typeof Report.Type

/** One thread, read for the question they asked about it. */
export interface Summarizing {
  readonly question: string
  readonly machine: string
  readonly here: boolean
  readonly detail: Detail
  readonly known: Option.Option<Known>
  readonly now: number
}

/** Every machine's threads, for a question across them. */
export interface Reporting {
  readonly question: string
  readonly threads: ReadonlyArray<ThreadListing>
  readonly now: number
}

export class ReportError extends Data.TaggedError("ReportError")<{ readonly cause: unknown }> {}

export class Reporter extends Context.Tag("yapd/Reporter")<
  Reporter,
  {
    readonly summarize: (input: Summarizing) => Effect.Effect<Report, ReportError>
    readonly report: (input: Reporting) => Effect.Effect<Report, ReportError>
  }
>() {}

const spoken = `They're listening, not reading: natural speech, contractions, connected sentences, no lists, markdown, code or URLs. No file paths unless they asked for one. Say names the way a person would, like "cryptio sources" for cryptio-sources. No filler, and don't name the agent. In the language they spoke.`

const summarizing = `You are yapd, the voice that reads a developer's coding agents' updates aloud. They asked where one of their agents' threads stands, and you've been given what T3 Code shows of it. Answer them.

Reply with only a JSON object with the key "spoken".

"spoken": the answer, at most 60 words.
- Answer what they asked first. If they asked for nothing in particular, say what the work is in a few words, what happened in the latest turn, and where it stands now: running, waiting on them and for what, done, or failed and why.
- Name the project and the thread's title once, early, as part of a sentence, so they know which one you read: they may have several going.
- Tell what T3 Code shows from what you'd suppose. A thread that's quiet isn't necessarily still working: say it's running only when its state says so, and a turn that ended is over even if its last message sounds unfinished.
- The latest messages are what's happened lately. The first message is what the work started as, so don't recount it unless they asked.
- ${spoken}`

const reporting = `You are yapd, the voice that reads a developer's coding agents' updates aloud. They asked a question about their work as a whole, across every machine, and you've been given what T3 Code shows of their threads. Answer them.

Reply with only a JSON object with the key "spoken".

"spoken": the answer, at most 80 words.
- Answer what they asked. When they asked nothing in particular, or for everything, lead with what needs them: approvals, input, plans to accept, failures. Then what finished, then what's running. Leave out what's quiet and old unless they asked for it.
- A thread needs them only when its line says it's waiting on something. "Running" means it's working and has asked nothing.
- Time words like "since lunch" or "this morning" are judged against the time given below, from when each thread finished or was last updated. "Today" starts at the midnight before that time, "yesterday" is the calendar day before, and so on: at half past one, what finished three hours ago was yesterday, and each line older than an hour says which day it was.
- Say a machine couldn't be checked when it's listed that way, so they know the answer may be short.
- When there are many, give counts and name the few that matter: "Three need you: the retry fix wants an approval, ..." Name threads by their project and title, and their machine only when it isn't this one.
- Only what's shown: a thread that's quiet isn't necessarily still working, and one that's done isn't necessarily right.
- ${spoken}`

/** The moment as they'd say it, for time words in the question to be judged against. */
export const clock = (now: number) => new Date(now).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })

const cut = (text: string, length: number) => (text.length <= length ? text : `${text.slice(0, length).trimEnd()}…`)

/** How long ago, when the time can be read. */
const since = (at: string, now: number) => {
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? "" : `, ${ago(parsed, now)}`
}

/** How much of each message is shown. The latest matters most, so it's the end of that one that's kept. */
const excerpt = 2_500
const opening = 1_500
const last = 8_000

const tail = (text: string) => (text.length <= last ? text : `(its start is cut) …${text.slice(-last).trimStart()}`)

export const summaryPrompt = ({ question, machine, here, detail, known, now }: Summarizing, style: Option.Option<string>) => {
  const { thread, messages } = detail
  return [
    summarizing,
    ...Option.toArray(Option.map(style, styled)),
    `It's now ${clock(now)}.`,
    [
      `The thread, as T3 Code shows it:`,
      `- Project: ${thread.project}${here ? "" : `, on ${machine}`}`,
      `- Title: ${thread.title}`,
      ...(thread.branch === null || thread.branch === "" ? [] : [`- Branch: ${thread.branch}`]),
      `- State: ${standing(thread, now)}`,
    ].join("\n"),
    ...Option.match(known, {
      onNone: () => [],
      onSome: ({ description, prompt }) => [
        ...(description === null || description.trim() === "" ? [] : [`What the work is, as you put it when it started:\n${description}`]),
        ...(prompt === null || prompt.trim() === "" ? [] : [`The thread's first message, which is what the work started as:\n${cut(prompt, opening)}`]),
      ],
    }),
    messages.length === 0
      ? "T3 Code shows no messages in its latest turns."
      : `The latest turns' messages, oldest first:\n${messages
          .map(({ role, text, at }, index) => `${role === "user" ? "User" : "Agent"}${since(at, now)}:\n${index === messages.length - 1 ? tail(text) : cut(text, excerpt)}`)
          .join("\n\n")}`,
    `What they asked:\n${question}`,
  ].join("\n\n")
}

const line = (now: number) => ({ listed }: ThreadListing["threads"][number]) =>
  `- ${listed.project}, "${listed.title}"${listed.branch === null || listed.branch === "" ? "" : ` on ${listed.branch}`}: ${standing(listed, now)}`

/** The threads on every machine, without keys or what the work is: enough to say where things stand. */
export const overview = (threads: ReadonlyArray<ThreadListing>, now: number) =>
  shortlist(threads, now)
    .map(({ machine, here, threads, reason }) => {
      const name = `${machine}${here ? ", this machine" : ""}`
      if (reason !== undefined) return `On ${name}: couldn't be checked. ${reason}`.trim()
      if (threads.length === 0) return `On ${name}: no threads lately.`
      return `On ${name}, newest first:\n${threads.map(line(now)).join("\n")}`
    })
    .join("\n\n")

export const reportPrompt = ({ question, threads, now }: Reporting, style: Option.Option<string>) =>
  [
    reporting,
    ...Option.toArray(Option.map(style, styled)),
    `It's now ${clock(now)}.`,
    `Their threads, as T3 Code shows them:\n\n${overview(threads, now)}`,
    `What they asked:\n${question}`,
  ].join("\n\n")

export const ProviderReporter = Layer.effect(
  Reporter,
  Effect.gen(function* () {
    const model = yield* Model
    const style = yield* Config.style
    const ask = (prompt: string) => model.ask(Report, prompt).pipe(Effect.mapError((cause) => new ReportError({ cause })))
    return {
      summarize: (input) => ask(summaryPrompt(input, style)),
      report: (input) => ask(reportPrompt(input, style)),
    }
  }),
)
