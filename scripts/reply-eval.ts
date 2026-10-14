import { Database } from "bun:sqlite"
import { ConfigProvider, Console, Context, Effect, Either, Layer, Logger, Option, Schema } from "effect"
import { appendFileSync, mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import type * as Assistant from "../src/Assistant.ts"
import * as Brain from "../src/Brain.ts"
import * as Config from "../src/Config.ts"
import * as Conversation from "../src/Conversation.ts"
import { together } from "../src/Conversation.ts"
import { home, settings } from "../src/Home.ts"
import type { Kept } from "../src/Journal.ts"
import type * as Ledger from "../src/Ledger.ts"
import * as Missed from "../src/Missed.ts"
import { Model, ProviderModel } from "../src/Model.ts"
import * as Mutes from "../src/Mutes.ts"
import * as Persona from "../src/Persona.ts"
import * as Responder from "../src/Responder.ts"
import * as Store from "../src/Store.ts"
import * as T3Live from "../src/T3Live.ts"
import * as Threads from "../src/Threads.ts"
import { gist, halts, type Line, question } from "../src/Words.ts"
import * as Baseline from "./eval/baseline-responder.ts"

// How what he says over an update is worked out, replayed on what he said
// before and on cases written for what's new, the way the daemon works it
// out, and how fast. It's never loaded by the daemon, and it never acts: no
// Hands, no relay, nothing written to the journal; yapd's database and T3
// Code's are only read. What it reads and writes stays under ~/.yapd/eval/,
// since it's his own words and work, and isn't to be committed. It prints
// counts and ids only: yapd's own logs as it works, which may say what the
// model said, go to reply-eval.log there.
//
//   bun scripts/reply-eval.ts fixture
//     Writes replies.json from what he said over updates: the log's replies
//     from before the journal began, dated by the log's midnights from the
//     journal's first reply and checked against T3 Code's messages, which
//     give each update the agent's message and his prompt; the Responder's
//     rows in the journal, each with its update; the assistant's own rows
//     said back to its answers; and the replies the log took for talk not
//     meant for yapd since, which the journal never kept. Writes
//     reply-labels.json if there's none: his verdicts, which only change
//     what's expected once he's confirmed them.
//   nice -n 15 bun scripts/reply-eval.ts run [--path baseline,brain,m4] [--era log,journal,synthetic|all] [--only ids] [--limit N] [--repeat N] [--rerun ids] [--out folder]
//     Works each one out on each path, one model call at a time, never two
//     at once, each path going first on every other case: "baseline" is the
//     Responder as it was at M4's batch 1, frozen in scripts/eval;
//     "brain" is the Brain alone, Brain.fast, then the model, then `check`,
//     on the situation the reply came in; "m4" is batch 3's handoff, as
//     Conversation.reading works it out: the mute hook, saying it again, the
//     live Responder, and what it hands over to the Brain, as the assistant
//     routes it, with one rest step. With scripts/eval/replies.cases.json's
//     cases too, kept apart. `--repeat` works each case out that many times,
//     each judged by the majority; `--rerun` works out only those ids, three
//     times more. Says how many agree with what was logged, or his verdict,
//     by era and by intent; the hard fails; the handoffs; the latencies; and
//     what's only to report, all by id. Each answer goes to
//     results-reply-<time>.jsonl, and a whole baseline run to
//     reply-baseline-<sha>.jsonl too, kept for agreement only, against which
//     batch 1's, reply-baseline-c319ce0.jsonl, the same frozen code, is the
//     noise floor.

const folder = join(home, "eval")
const fixtureFile = join(folder, "replies.json")
const labelsFile = join(folder, "reply-labels.json")
/** brain-eval's copy of his threads, for the threads beside the update's own. */
const viewFile = join(folder, "view.json")
const casesFile = join(import.meta.dir, "eval", "replies.cases.json")
const logsFile = join(folder, "reply-eval.log")
const logFile = join(homedir(), "Library", "Logs", "yapd.log")
/** T3 Code's databases: the first stops at 10-07 19:47, the second carries on from it. */
const t3 = [join(homedir(), ".t3", "userdata", "state.sqlite"), join(homedir(), ".t3", "userdata", "statev2.sqlite")]

const hour = 60 * 60_000
const day = 24 * hour

/** What this machine is called, as the daemon calls it, once its settings are read. */
let machineName = hostname().split(".")[0] ?? hostname()

/** The relayed acknowledgements, his verdict pending: what each should have been, by default. */
const seeded = {
  L437: { intent: "dismiss", status: "unconfirmed", why: "an acknowledgement relayed to an update that asked nothing" },
  L655: { intent: "dismiss", status: "unconfirmed", why: "an acknowledgement relayed right after his own instruction" },
  L385: { intent: "send", status: "unconfirmed", why: "an acknowledgement relayed to an offer, where the message said the opposite" },
  L4652: { intent: "send", status: "unconfirmed", why: "an acknowledgement relayed to a question asking to go ahead" },
}

const Intent = Schema.Literal("dismiss", "answer", "send", "resume")
type Intent = typeof Intent.Type

const Label = Schema.Struct({ intent: Intent, status: Schema.Literal("confirmed", "unconfirmed"), why: Schema.optional(Schema.String) })
const Labels = Schema.Record({ key: Schema.String, value: Label })

/** How batch 3's path worked out what he said: said again, by the mute hook, by the Responder alone, or handed over and routed so. */
const Route = Schema.Literal("Again", "Hook", "Responder", "Resume", "Dismiss", "Answer", "Pass", "Act")

/**
 * What's expected of a case written for the eval: the Responder's intent, the
 * Brain's act and thread, and what neither may come to; and for batch 3's
 * path, what it may come to, how it's routed, how it was worked out, what
 * a Pass says was left, whether its rest step was left for the update's own
 * session, what's never done, what a question it asks names, what handed it
 * over, what's never said, and what is.
 */
const Expect = Schema.Struct({
  intent: Schema.optional(Intent),
  act: Schema.optional(Schema.Array(Brain.Act)),
  /** "own" for the update's own thread, or a piece of the title of the thread it's about. */
  target: Schema.optional(Schema.String),
  /** A piece of what's left for after its first step, like the other thread's name. */
  rest: Schema.optional(Schema.String),
  never: Schema.optional(Schema.Array(Brain.Act)),
  neverIntent: Schema.optional(Schema.Array(Intent)),
  intents: Schema.optional(Schema.Array(Schema.String)),
  route: Schema.optional(Schema.Array(Route)),
  neverRoute: Schema.optional(Schema.Array(Route)),
  /** "again" or "mute" for how it was worked out, or "fast" or "model" for the Brain, handed over. */
  source: Schema.optional(Schema.String),
  left: Schema.optional(Schema.String),
  restLeft: Schema.optional(Schema.Boolean),
  neverDone: Schema.optional(Schema.Array(Brain.Act)),
  asking: Schema.optional(Schema.String),
  handedBy: Schema.optional(Schema.Literal("hook", "responder")),
  neverSpoken: Schema.optional(Schema.Array(Schema.String)),
  /** A piece of what's said back, like the thread a line turning it down names. */
  says: Schema.optional(Schema.String),
})
type Expect = typeof Expect.Type

/** How an update is tied: to its thread, which yapd steers; to it, but its hook waits; to a thread on another machine it's only known to be from; or to none. */
const How = Schema.Literal("tied", "hooked", "owner", "untied")

const Synthetic = Schema.Struct({
  view: Schema.Struct({ at: Schema.Number, projects: Schema.Array(Schema.Unknown), threads: Schema.Array(Schema.Unknown) }),
  updates: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      project: Schema.String,
      spoken: Schema.String,
      message: Schema.String,
      needsYou: Schema.Boolean,
      session: Schema.String,
      thread: Schema.String,
    }),
  }),
  cases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      update: Schema.String,
      how: How,
      machine: Schema.optional(Schema.String),
      heard: Schema.String,
      said: Schema.optional(Schema.String),
      left: Schema.optional(Schema.String),
      echo: Schema.optional(Schema.String),
      afterPause: Schema.optional(Schema.String),
      lateBy: Schema.optional(Schema.Number),
      /** Seconds of speech in what he said: clearly spoken, a second, unless it says. */
      voiced: Schema.optional(Schema.Number),
      /** Whether what's said over it goes to its thread by yapd's own hand: as `how` says, unless it says. */
      steered: Schema.optional(Schema.Boolean),
      /** Whether he's at hand, as he is unless it says, like a TV in an empty room. */
      present: Schema.optional(Schema.Boolean),
      /** What the line he spoke over says yapd changed, which "scratch that" reaches: nothing, unless it says. */
      done: Schema.optional(Schema.Struct({ change: Schema.optional(Schema.Struct({ what: Schema.Literal("acted"), utterance: Schema.String })) })),
      /** What yapd last did for him, seconds before, a message to a thread on the desk, which "scratch that" may reach. */
      acted: Schema.optional(Schema.Struct({ thread: Schema.String, text: Schema.String, ago: Schema.Number })),
      /** His routines, by name, with their steps. */
      routines: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, steps: Schema.String }))),
      expect: Expect,
    }),
  ),
})

/** The update he spoke over, as it was told. */
interface Told {
  readonly project: string
  readonly spoken: string
  readonly more?: string
  readonly message: string
  readonly prompt?: string
  readonly needsYou: boolean
  readonly session: string
  /** The thread it came from: tied to it, or, with `owner`, only known to be from it, on another machine. */
  readonly ref?: Threads.Ref
  readonly owner?: boolean
  readonly title?: string
  /** Whether yapd would steer what's sent to it through T3 Code, rather than its waiting hook or the relay, when that's known. */
  readonly steered?: boolean
}

interface Case {
  readonly id: string
  readonly era: "log" | "journal" | "synthetic"
  /** Who worked it out live: the Responder, over an update, or the assistant, over one of its answers. */
  readonly by: "responder" | "assistant"
  readonly at: number
  readonly update?: Told
  /** Said back to one of the assistant's answers: what it had said. */
  readonly answered?: string
  /** The exchange so far, ending with yapd's line he spoke over. */
  readonly lines: ReadonlyArray<Line>
  readonly heard: string
  readonly echo?: string
  readonly afterPause?: string
  /** What yapd hadn't said yet when it stopped for him. */
  readonly left?: string
  readonly lateBy?: number
  readonly voiced?: number
  /** Written: whether what's said over it goes to its thread by yapd's own hand, whether he's at hand, and what its line said yapd changed. */
  readonly steered?: boolean
  readonly present?: boolean
  readonly done?: Brain.Done
  /** Written: what yapd last did for him, as the ledger has it. */
  readonly acted?: Ledger.Row
  /** Written: his routines, by name, with their steps. */
  readonly routines?: ReadonlyArray<{ readonly name: string; readonly steps: string }>
  /** The journal's last few rows before it, as the Brain is shown them. */
  readonly lately?: ReadonlyArray<Kept>
  /** What came of it live: the Responder's intent, or the assistant's act, what was said and what was sent. */
  readonly logged: { readonly intent?: string; readonly act?: string; readonly spoken?: string; readonly message?: string }
  readonly expect?: Expect
  readonly note?: string
  /** What's only guessed or approximate about it. */
  readonly flags: ReadonlyArray<string>
}

/** yapd's own settings, as the daemon reads them from its .env: what's given here first, then the environment. */
const settled = (overrides: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => Bun.file(settings).text().catch(() => ""))
    const kept = new Map(
      text.split("\n").flatMap((line) => {
        const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        return match === null ? [] : [[match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, "$2")] as const]
      }),
    )
    return ConfigProvider.fromMap(new Map(Object.entries(overrides))).pipe(
      ConfigProvider.orElse(() => ConfigProvider.fromEnv()),
      ConfigProvider.orElse(() => ConfigProvider.fromMap(kept)),
    )
  })

const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback)
}

const percentile = (values: ReadonlyArray<number>, at: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? Number.NaN
}

const seconds = (ms: number) => (Number.isNaN(ms) ? "-" : `${(ms / 1000).toFixed(2)} s`)

/** A database opened only to read, closed once `read` is done with it, or nothing when it can't be opened. */
const reading = <A>(path: string, read: (database: Database) => A): A | undefined => {
  let database: Database | undefined
  try {
    database = new Database(path, { readonly: true })
    return read(database)
  } catch {
    return undefined
  } finally {
    database?.close()
  }
}

// --- The log ---------------------------------------------------------------------------------------------------------

interface Logged {
  /** Its line in the log, from 1. */
  readonly line: number
  readonly hour: number
  /** Milliseconds into its day. */
  readonly into: number
  readonly message: string
  project?: string
  /** Which day it's on, counted by the log's midnights, and when it was, once that's known. */
  day: number
  at: number
}

const logged = (text: string) => {
  const entries: Array<Logged> = []
  for (const [index, raw] of text.split("\n").entries()) {
    const head = /^\[(\d\d):(\d\d):(\d\d)\.(\d{3})\] [A-Z]+ \(#\d+\): (.*)$/.exec(raw)
    if (head !== null) {
      const [hours, minutes, secs, millis] = [1, 2, 3, 4].map((at) => Number(head[at]))
      entries.push({ line: index + 1, hour: hours!, into: ((hours! * 60 + minutes!) * 60 + secs!) * 1000 + millis!, message: head[5]!, day: 0, at: 0 })
      continue
    }
    const note = /^ {2}project: (.*)$/.exec(raw)
    const last = entries.at(-1)
    if (note !== null && last !== undefined) last.project = note[1]!
  }
  // A new day wherever the hour goes back. A gap of a day or more where it doesn't is checked against T3 Code's messages.
  let previous = -1
  let days = 0
  for (const entry of entries) {
    if (entry.hour < previous) days++
    previous = entry.hour
    entry.day = days
  }
  return entries
}

/** Each entry dated from `anchor`, an entry whose day is known: `midnight` is that day's start. */
const dated = (entries: ReadonlyArray<Logged>, anchor: Logged, midnight: Date) => {
  for (const entry of entries) {
    const start = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + entry.day - anchor.day)
    entry.at = start.getTime() + entry.into
  }
}

const startsWith = (message: string, ...prefixes: ReadonlyArray<string>) => prefixes.find((prefix) => message.startsWith(prefix))

/** What an update said, as the log has it. */
const ready = (entry: Logged) => entry.message.slice("Ready: ".length)

/** One reply in the log, with the update it was over and the exchange before it. */
interface Exchange {
  readonly reply: Logged
  readonly ready: Logged
  readonly lines: ReadonlyArray<Line>
  readonly heard: string
  readonly intent: string
  readonly spoken?: string
  message?: string
  failed?: boolean
  /** Shared by every reply over the same update: how what was sent to it went, when it's known. */
  readonly delivery: { steered?: boolean }
}

/** The replies in the log, each over the update read last in its project before it, with what was heard and sent. */
const exchanges = (entries: ReadonlyArray<Logged>) => {
  const found: Array<Exchange> = []
  interface Open {
    ready: Logged
    said: string
    lines: Array<Line>
    heard: Array<string>
    delivery: { steered?: boolean }
    last?: Exchange
    /** An update that came in while he was still being heard over this one, read once what he said is worked out. */
    next?: Logged
  }
  const opened = (entry: Logged): Open => ({ ready: entry, said: ready(entry), lines: [], heard: [], delivery: {} })
  const open = new Map<string, Open>()
  for (const entry of entries) {
    if (entry.message.startsWith("Listening on ")) {
      open.clear()
      continue
    }
    const project = entry.project
    if (project === undefined) continue
    const message = entry.message
    if (message.startsWith("Ready: ")) {
      const current = open.get(project)
      if (current !== undefined && current.heard.length > 0) current.next = entry
      else open.set(project, opened(entry))
      continue
    }
    const state = open.get(project)
    if (state === undefined) continue
    if (message.startsWith("Heard: ")) {
      state.heard.push(message.slice("Heard: ".length))
      continue
    }
    if (message.startsWith("Reply: ")) {
      const [intent = "", ...rest] = message.slice("Reply: ".length).split(", saying: ")
      const heard = state.heard.reduce((all, chunk) => (all === "" ? chunk : together(all, chunk)), "")
      const spoken = rest.join(", saying: ")
      const exchange: Exchange = {
        reply: entry,
        ready: state.ready,
        lines: [...state.lines, { speaker: "yapd", text: state.said }],
        heard,
        intent: intent.trim(),
        ...(spoken === "" ? {} : { spoken }),
        delivery: state.delivery,
      }
      found.push(exchange)
      state.heard = []
      state.last = exchange
      if (state.next !== undefined) {
        open.set(project, { ...opened(state.next), last: exchange })
        continue
      }
      // As the conversation goes on: what was said back to an answer or a send is said over what yapd said of it.
      if (exchange.intent === "answer" || exchange.intent === "send") {
        state.lines.push({ speaker: "yapd", text: state.said }, { speaker: "user", text: heard })
        state.said = exchange.intent === "send" ? (spoken === "" ? Persona.plain.onIt : spoken) : spoken === "" ? "…" : spoken
      }
      continue
    }
    const last = state.last
    if (last === undefined) continue
    // Of what was sent over the update the last reply was over, even with another update come in since.
    if (message.startsWith("Delivered through T3 Code")) last.delivery.steered = true
    else if (message.startsWith("Delivered: ")) last.delivery.steered ??= false
    const sent = startsWith(message, "Sent: ", "Queued: ", "Held: ")
    if (sent !== undefined && last.intent === "send" && last.message === undefined) last.message = message.slice(sent.length)
    if (message.startsWith("Could not send the follow-up")) last.failed = true
  }
  return found
}

// --- T3 Code ---------------------------------------------------------------------------------------------------------

interface Said {
  readonly id: string
  readonly thread: string
  readonly at: number
  readonly created: string
  readonly text: string
  /** Which of T3 Code's databases it's in. */
  readonly source: number
}

interface Titled {
  readonly title: string
  readonly project: string
  readonly folder: string
}

/** T3 Code's agents' messages that ended between `from` and `to`, and its threads, from both its databases, read only. */
const t3Messages = (from: number, to: number) => {
  const messages = new Map<string, Said>()
  const threads = new Map<string, Titled>()
  const range = [new Date(from).toISOString(), new Date(to).toISOString()] as const
  for (const [source, path] of t3.entries()) {
    reading(path, (database) => {
      const projects = new Map(
        database
          .query<{ project_id: string; title: string }, []>("select project_id, title from projection_projects")
          .all()
          .map((row) => [row.project_id, row.title]),
      )
      const rows =
        source === 0
          ? database
              .query<{ message_id: string; thread_id: string; text: string; created_at: string; updated_at: string }, [string, string]>(
                "select message_id, thread_id, text, created_at, updated_at from projection_thread_messages where role = 'assistant' and is_streaming = 0 and updated_at between ? and ?",
              )
              .all(...range)
          : database
              .query<{ message_id: string; thread_id: string; text: string | null; created_at: string; updated_at: string }, [string, string]>(
                "select message_id, thread_id, json_extract(payload_json, '$.text') as text, created_at, updated_at from orchestration_v2_projection_messages where role = 'assistant' and streaming = 0 and updated_at between ? and ?",
              )
              .all(...range)
      for (const row of rows) {
        if (row.text === null || messages.has(row.message_id)) continue
        messages.set(row.message_id, { id: row.message_id, thread: row.thread_id, at: Date.parse(row.updated_at), created: row.created_at, text: row.text, source })
      }
      const titled =
        source === 0
          ? database.query<{ thread_id: string; title: string; project_id: string; worktree_path: string | null }, []>(
              "select thread_id, title, project_id, worktree_path from projection_threads",
            ).all()
          : database
              .query<{ thread_id: string; title: string; project_id: string; worktree_path: string | null }, []>(
                "select thread_id, title, project_id, json_extract(payload_json, '$.worktreePath') as worktree_path from orchestration_v2_projection_threads",
              )
              .all()
      for (const row of titled) {
        threads.set(row.thread_id, { title: row.title, project: projects.get(row.project_id) ?? "", folder: row.worktree_path?.split("/").at(-1) ?? "" })
      }
    })
  }
  return { messages: [...messages.values()].toSorted((one, other) => one.at - other.at), threads }
}

/** His prompt that began the turn a message ended, read only from the database it's in. */
const promptOf = (said: Said) =>
  reading(t3[said.source]!, (database) =>
    said.source === 0
      ? database
          .query<{ text: string }, [string, string]>(
            "select text from projection_thread_messages where thread_id = ? and role = 'user' and created_at <= ? order by created_at desc limit 1",
          )
          .get(said.thread, said.created)?.text
      : database
          .query<{ text: string | null }, [string, string]>(
            "select json_extract(payload_json, '$.text') as text from orchestration_v2_projection_messages where thread_id = ? and role = 'user' and created_at <= ? order by created_at desc limit 1",
          )
          .get(said.thread, said.created)?.text ?? undefined,
  )

const stopwords = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "into", "for", "are", "was", "were", "now", "sir", "its", "it's", "you", "but", "all", "not"])

/** The words that carry what's said, each once. */
const words = (text: string) => new Set(gist(text).split(" ").filter((word) => word.length > 3 && !stopwords.has(word)))

/** How many of the words that carry what's said in `spoken` are in `text`. */
const overlap = (spoken: ReadonlySet<string>, text: string) => {
  const theirs = words(text)
  return [...spoken].filter((word) => theirs.has(word)).length
}

/** The agent's message an update was made from: the last one to end within a minute before it was ready, sharing its words or project. */
const sourceOf = (entry: Logged, said: string, project: string, t3Said: ReadonlyArray<Said>, threads: ReadonlyMap<string, Titled>) => {
  const spoken = words(said)
  const named = (thread: string) => {
    const titled = threads.get(thread)
    const plain = project.toLowerCase()
    return titled !== undefined && (titled.project.toLowerCase() === plain || titled.folder.toLowerCase() === plain)
  }
  const candidates = t3Said
    .filter(({ at }) => at <= entry.at + 2_000 && at >= entry.at - 60_000)
    .map((candidate) => ({ candidate, score: overlap(spoken, candidate.text) + (named(candidate.thread) ? 2 : 0) }))
    .filter(({ score }) => score >= 2)
  return candidates.toSorted((one, other) => other.score - one.score || other.candidate.at - one.candidate.at)[0]?.candidate
}

/** Whether an update seems to need him, as the log never said: it asks, failed, or waits on him. */
const needy = (said: string, message: string) =>
  question.test(said.trim()) ||
  question.test(message.trim()) ||
  /\b(fail(ed|s|ing)?|broke|error|blocked|stuck|needs? (you|your)|waiting (on|for) you|approv\w*|permission|decide|decision)\b/i.test(said)

// --- The journal -----------------------------------------------------------------------------------------------------

interface Row {
  readonly id: number
  readonly at: number
  readonly kind: Kept["kind"]
  readonly machine: string | null
  readonly project: string | null
  readonly thread: string | null
  readonly directory: string | null
  readonly said: string | null
  readonly text: string | null
  readonly utterance: string | null
  readonly key: string | null
  readonly heard_at: number | null
  readonly detail: string | null
}

const kept = (row: Row): Kept => {
  const detail = (() => {
    try {
      return row.detail === null ? undefined : (JSON.parse(row.detail) as unknown)
    } catch {
      return undefined
    }
  })()
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    ...(row.machine === null ? {} : { machine: row.machine }),
    ...(row.project === null ? {} : { project: row.project }),
    ...(row.thread === null ? {} : { thread: row.thread }),
    ...(row.directory === null ? {} : { directory: row.directory }),
    ...(row.said === null ? {} : { said: row.said }),
    ...(row.text === null ? {} : { text: row.text }),
    ...(row.utterance === null ? {} : { utterance: row.utterance }),
    ...(row.key === null ? {} : { key: row.key }),
    ...(row.heard_at === null ? {} : { heardAt: row.heard_at }),
    ...(detail === undefined ? {} : { detail }),
  }
}

const detailOf = (row: Kept) => (typeof row.detail === "object" && row.detail !== null ? (row.detail as Record<string, unknown>) : {})
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** What the Brain is shown of the journal's last three hours before `at`, as the assistant gathers it. */
const latelyBefore = (journal: ReadonlyArray<Kept>, at: number) =>
  journal
    .filter(
      (row) =>
        row.at < at &&
        row.at >= at - 3 * hour &&
        ["update", "reply", "dictation", "answer", "started", "notice", "sent", "action", "brief"].includes(row.kind) &&
        detailOf(row).held === undefined,
    )
    .slice(-16)
    .filter((row) => (row.kind !== "action" || row.said !== undefined || Brain.unsaid(row) !== undefined) && !Missed.withheld(row))
    .slice(-8)

/**
 * The update a reply row was said over: the last one of its thread before
 * it, within the hour. One from another machine only known to be from a
 * thread there is kept under that thread, and the reply under its session.
 */
const updateOf = (updates: ReadonlyArray<Kept>, reply: Kept) =>
  updates.findLast(
    (row) => row.at <= reply.at && reply.at - row.at <= hour && row.machine === reply.machine && (row.thread === reply.thread || detailOf(row).session === reply.thread),
  )

/**
 * yapd's line as he heard it when he spoke over it, the way Conversation cuts
 * it: as many of its last words as the reply row keeps as `left`, from batch 1
 * on, dropped for "…" where it stopped. Said to its end, it's whole. Stopped
 * short with nothing kept as unheard, or from before batch 1, where it was cut
 * isn't known: flagged, and kept whole unless it's known to be cut.
 */
const heardOf = (said: string, reply: Kept): { readonly text: string; readonly flags: ReadonlyArray<string> } => {
  const detail = detailOf(reply)
  const left = text(detail.left)
  if (left !== undefined && left !== "") {
    const words = said.split(/\s+/)
    const unheard = left.split(/\s+/).length
    // The line kept may not be the one he spoke over, like the update's own picked up again after a mute: then it doesn't end on them.
    const exact = words.slice(-unheard).join(" ") === left
    return { text: `${words.slice(0, Math.max(1, words.length - unheard)).join(" ")}…`, flags: exact ? [] : ["cut-approximate"] }
  }
  if (detail.after === true) return { text: said, flags: [] }
  return { text: detail.after === false ? `${said}…` : said, flags: ["cut-unknown"] }
}

const toldOf = (update: Kept, threads: ReadonlyMap<string, Titled>, view: Option.Option<T3Live.View>): Told => {
  const detail = detailOf(update)
  const tied = typeof detail.session === "string"
  const thread = update.thread ?? ""
  const title = Option.getOrUndefined(Option.flatMap(view, (view) => Option.fromNullable(view.threads.get(thread)?.title))) ?? threads.get(thread)?.title
  const more = text(detail.more)
  const prompt = text(detail.prompt)
  return {
    project: update.project ?? "",
    spoken: update.said ?? "",
    ...(more === undefined ? {} : { more }),
    message: update.text ?? update.said ?? "",
    ...(prompt === undefined ? {} : { prompt }),
    needsYou: detail.priority === "needs-you",
    session: tied ? (text(detail.session) ?? thread) : thread,
    ...(tied ? { ref: { machine: update.machine ?? "", id: thread } } : {}),
    ...(title === undefined ? {} : { title }),
  }
}

// --- fixture ---------------------------------------------------------------------------------------------------------

const fixture = Effect.gen(function* () {
  machineName = Option.getOrElse(yield* Config.name, () => machineName)
  const journal = reading(Store.file, (database) => database.query<Row, []>("select * from journal order by at, id").all().map(kept))
  if (journal === undefined) return yield* Effect.dieMessage(`Can't read ${Store.file}.`)
  const log = logged(yield* Effect.promise(() => Bun.file(logFile).text()))
  const view = yield* Effect.either(viewedFile(viewFile))
  const shell = Either.isRight(view) ? Option.some(view.right.view) : Option.none<T3Live.View>()
  const responder = journal.filter((row) => row.kind === "reply" && typeof detailOf(row).intent === "string")
  const assistant = journal.filter((row) => row.kind === "reply" && typeof detailOf(row).decision === "object")
  const updates = journal.filter((row) => row.kind === "update")

  // Dated from the journal's first reply, found in the log by its time, intent and words.
  const first = responder[0]
  if (first === undefined) return yield* Effect.dieMessage("The journal has no reply to date the log by.")
  const then = new Date(first.at)
  const into = ((then.getHours() * 60 + then.getMinutes()) * 60 + then.getSeconds()) * 1000 + then.getMilliseconds()
  const anchor = log.find(
    (entry, index) =>
      entry.message === `Reply: ${String(detailOf(first).intent)}` &&
      Math.abs(entry.into - into) <= 2_000 &&
      log.slice(Math.max(0, index - 3), index).some(({ message }) => message === `Heard: ${first.text ?? ""}`),
  )
  if (anchor === undefined) return yield* Effect.dieMessage("The journal's first reply isn't in the log, so its days can't be told.")
  dated(log, anchor, new Date(then.getFullYear(), then.getMonth(), then.getDate()))
  const before = log.filter((entry) => entry.day < anchor.day)
  const firstAt = before[0]?.at ?? anchor.at

  // Each day of the log checked against T3 Code's messages: one that matches better a day or two off is moved, and flagged either way.
  const { messages, threads } = t3Messages(firstAt - 3 * day, anchor.at + 30 * day)
  const readies = before.filter(({ message }) => message.startsWith("Ready: "))
  const matching = (entry: Logged, shift: number) => sourceOf({ ...entry, at: entry.at + shift * day }, ready(entry), entry.project ?? "", messages, threads) !== undefined
  const shifts = new Map<number, { readonly shift: number; readonly matched: number; readonly readies: number }>()
  for (const index of new Set(readies.map(({ day }) => day))) {
    const those = readies.filter((entry) => entry.day === index)
    const tried = [0, -1, 1, -2].map((shift) => ({ shift, matched: those.filter((entry) => matching(entry, shift)).length }))
    const best = tried.reduce((one, other) => (other.matched > one.matched ? other : one))
    shifts.set(index, { ...best, readies: those.length })
  }
  for (const entry of before) entry.at += (shifts.get(entry.day)?.shift ?? 0) * day

  const cases: Array<Case> = []
  const all = exchanges(log)
  let recovered = 0
  for (const exchange of all.filter(({ reply }) => reply.day < anchor.day)) {
    const checked = shifts.get(exchange.ready.day)
    const project = exchange.ready.project ?? ""
    const spoken = ready(exchange.ready)
    const source = sourceOf(exchange.ready, spoken, project, messages, threads)
    if (source !== undefined) recovered++
    const prompt = source === undefined ? undefined : promptOf(source)
    const titled = source === undefined ? undefined : threads.get(source.thread)
    const message = source?.text ?? spoken
    const steered = exchange.delivery.steered
    cases.push({
      id: `L${exchange.reply.line}`,
      era: "log",
      by: "responder",
      at: exchange.reply.at,
      update: {
        project,
        spoken,
        message,
        ...(prompt === undefined || prompt === null ? {} : { prompt }),
        needsYou: needy(spoken, message),
        session: source?.thread ?? `log-${exchange.ready.line}`,
        ...(source === undefined ? {} : { ref: { machine: machineName, id: source.thread } }),
        ...(titled === undefined ? {} : { title: titled.title }),
        ...(steered === undefined ? {} : { steered }),
      },
      lines: exchange.lines,
      heard: exchange.heard,
      logged: { intent: exchange.intent, ...(exchange.spoken === undefined ? {} : { spoken: exchange.spoken }), ...(exchange.message === undefined ? {} : { message: exchange.message }) },
      flags: [
        "needsYou-guessed",
        // The log never said where he cut yapd off, so each line is whole.
        "cut-unknown",
        ...(source === undefined ? ["message-from-summary"] : []),
        ...(checked === undefined || checked.matched === 0 ? ["day-unverified"] : checked.shift !== 0 ? ["day-shifted"] : []),
        ...(exchange.lines.some(({ text }) => text === "…") ? ["answer-unlogged"] : []),
        ...(exchange.failed === true ? ["send-failed"] : []),
      ],
    })
  }

  // The Responder's rows in the journal, each with its update, and the exchange before it from the rows between.
  const responders = new Map<string, Array<Kept>>()
  for (const row of responder) responders.set(`${row.machine}\n${row.thread}`, [...(responders.get(`${row.machine}\n${row.thread}`) ?? []), row])
  let unmatched = 0
  let withheld = 0
  for (const reply of responder) {
    const detail = detailOf(reply)
    if (reply.text === undefined) {
      withheld++
      continue
    }
    const update = updateOf(updates, reply)
    if (update === undefined) {
      unmatched++
      continue
    }
    // Kept under its session, the reply was over an update only known to be from its thread.
    const told = { ...toldOf(update, threads, shell), ...(update.thread === reply.thread ? {} : { owner: true }) }
    const earlier = (responders.get(`${reply.machine}\n${reply.thread}`) ?? []).filter((row) => row.at > update.at && row.at < reply.at && row.text !== undefined)
    // Each line as he heard it when he spoke over it, cut where he did, as the Responder was shown it: his own with what may have
    // been yapd's voice in it, as Conversation keeps it for the model asked next.
    const lines: Array<Line> = []
    let said = told.spoken
    for (const row of earlier) {
      const noted = detailOf(row)
      const intent = noted.intent
      if (intent !== "answer" && intent !== "send" && intent !== "mute") continue
      const echo = text(noted.echo)
      const afterPause = text(noted.afterPause)
      lines.push(
        { speaker: "yapd", text: heardOf(said, row).text },
        { speaker: "user", text: row.text ?? "", ...(echo === undefined ? {} : { echo, ...(afterPause === undefined ? {} : { afterPause }) }) },
      )
      // A send's said is kept empty when yapd only said it was on it.
      said = row.said === undefined || row.said === "" ? (intent === "send" ? Persona.plain.onIt : "") : row.said
    }
    const last = heardOf(said, reply)
    // Sent through T3 Code's own hand, or its waiting hook or the relay, as what was kept of the send tells.
    const sent =
      detail.intent === "send"
        ? journal.find(
            (row) => row.kind === "sent" && row.at >= reply.at && row.at - reply.at <= 30_000 && [reply.thread, update.thread, told.session].includes(row.thread),
          )
        : undefined
    const echo = text(detail.echo)
    const afterPause = text(detail.afterPause)
    const left = text(detail.left)
    const message = text(detail.message)
    cases.push({
      id: `J${reply.id}`,
      era: "journal",
      by: "responder",
      at: reply.at,
      update: { ...told, ...(sent === undefined ? {} : { steered: typeof detailOf(sent).commandId === "string" }) },
      lines: [...lines, { speaker: "yapd", text: last.text }],
      heard: reply.text,
      ...(echo === undefined ? {} : { echo, ...(afterPause === undefined ? {} : { afterPause }) }),
      ...(left === undefined ? {} : { left }),
      ...(typeof detail.lateBy === "number" ? { lateBy: detail.lateBy } : {}),
      ...(typeof detail.voiced === "number" ? { voiced: detail.voiced } : {}),
      lately: latelyBefore(journal, reply.at),
      logged: { intent: String(detail.intent), ...(reply.said === undefined || reply.said === "" ? {} : { spoken: reply.said }), ...(message === undefined ? {} : { message }) },
      flags: last.flags,
    })
  }

  // The assistant's rows said back to its own answers, against what it had said: never the Responder's, so the baseline has none.
  for (const reply of assistant) {
    if (reply.text === undefined || detailOf(reply).via !== "reply") continue
    const decision = detailOf(reply).decision as { readonly act?: unknown } | undefined
    const answer = journal.findLast((row) => row.kind === "answer" && row.at <= reply.at && reply.at - row.at <= 10 * 60_000 && row.said !== undefined)
    const echo = text(detailOf(reply).echo)
    const afterPause = text(detailOf(reply).afterPause)
    cases.push({
      id: `J${reply.id}`,
      era: "journal",
      by: "assistant",
      at: reply.at,
      ...(answer?.said === undefined ? {} : { answered: answer.said }),
      lines: answer?.said === undefined ? [] : [{ speaker: "yapd", text: answer.said }],
      heard: reply.text,
      ...(echo === undefined ? {} : { echo, ...(afterPause === undefined ? {} : { afterPause }) }),
      lately: latelyBefore(journal, reply.at),
      logged: { act: String(decision?.act ?? "") },
      flags: ["subject-approximate", ...(["reply", "decide"].includes(String(decision?.act)) ? ["no-open-question"] : [])],
    })
  }

  // What the log took for talk not meant for yapd since the journal began, which the journal never kept, with the update the journal did.
  let resumes = 0
  for (const exchange of all.filter(({ reply, intent }) => reply.day >= anchor.day && intent === "resume")) {
    resumes++
    const update = updates.findLast((row) => row.at <= exchange.ready.at + 5_000 && exchange.ready.at - row.at <= 120_000 && row.project === exchange.ready.project)
    const told: Told =
      update === undefined
        ? { project: exchange.ready.project ?? "", spoken: ready(exchange.ready), message: ready(exchange.ready), needsYou: needy(ready(exchange.ready), ""), session: `log-${exchange.ready.line}` }
        : toldOf(update, threads, shell)
    cases.push({
      id: `L${exchange.reply.line}`,
      era: "journal",
      by: "responder",
      at: exchange.reply.at,
      update: told,
      lines: exchange.lines,
      heard: exchange.heard,
      ...(update === undefined ? {} : { lately: latelyBefore(journal, exchange.reply.at) }),
      logged: { intent: "resume" },
      flags: ["from-log", "cut-unknown", ...(update === undefined ? ["message-from-summary", "needsYou-guessed"] : [])],
    })
  }

  yield* Effect.promise(() => mkdir(folder, { recursive: true }))
  yield* Effect.promise(() => Bun.write(fixtureFile, JSON.stringify({ at: Date.now(), cases }, null, 1)))
  if (!(yield* Effect.promise(() => Bun.file(labelsFile).exists()))) {
    yield* Effect.promise(() => Bun.write(labelsFile, JSON.stringify(seeded, null, 2)))
    yield* Console.log(`Wrote ${labelsFile} with ${Object.keys(seeded).length} verdicts pending.`)
  }
  const logEra = cases.filter(({ era }) => era === "log")
  const count = (flag: string) => logEra.filter(({ flags }) => flags.includes(flag)).length
  const intents = (era: ReadonlyArray<Case>) =>
    Object.entries(Object.groupBy(era, ({ logged }) => logged.intent ?? logged.act ?? "?"))
      .map(([intent, those]) => `${intent} ${those?.length ?? 0}`)
      .join(", ")
  const daysOf = [...shifts.entries()]
    .toSorted(([one], [other]) => one - other)
    .map(([index, { shift, matched, readies }]) => {
      const date = new Date(then.getFullYear(), then.getMonth(), then.getDate() + index - anchor.day + shift)
      return `  ${date.toLocaleDateString("en-CA")}: ${matched}/${readies} updates matched${shift === 0 ? "" : `, moved ${shift} day${Math.abs(shift) === 1 ? "" : "s"}`}`
    })
  const journalEra = cases.filter(({ era, by, flags }) => era === "journal" && by === "responder" && !flags.includes("from-log"))
  yield* Console.log(
    [
      `Log, before ${then.toLocaleDateString("en-CA")}: ${logEra.length} replies (${intents(logEra)}).`,
      `  The agent's message found in T3 Code for ${recovered}, the summary for ${count("message-from-summary")}; needsYou guessed for all; how a send went known for ${logEra.filter(({ update }) => update?.steered !== undefined).length}.`,
      `  Days unverified: ${count("day-unverified")} replies; moved: ${count("day-shifted")}.`,
      ...daysOf,
      `Journal: ${journalEra.length} of the Responder's ${responder.length} rows with their update (${intents(journalEra)}); ${unmatched} with none, ${withheld} held back as secrets.`,
      `  The assistant's rows said back to its answers: ${cases.filter(({ by }) => by === "assistant").length}.`,
      `  Talk the log took as not meant for yapd since: ${resumes}, ${cases.filter(({ flags }) => flags.includes("from-log") && !flags.includes("message-from-summary")).length} with their update.`,
      `Kept ${cases.length} in ${fixtureFile}.`,
    ].join("\n"),
  )
})

/** A view of T3 Code's threads, as brain-eval keeps it, as T3Live keeps it. */
const viewed = (saved: unknown) =>
  Effect.gen(function* () {
    const shell = yield* Schema.decodeUnknown(Synthetic.fields.view)(saved)
    const threads = shell.threads.flatMap((thread) => Option.toArray(Schema.decodeUnknownOption(T3Live.Thread)(thread)))
    const projects = shell.projects.flatMap((project) => Option.toArray(Schema.decodeUnknownOption(T3Live.Project)(project)))
    return {
      at: shell.at,
      view: {
        projects: new Map(projects.map((project) => [project.id, project])),
        threads: new Map(threads.map((thread) => [thread.id, thread])),
        sequence: 1,
        synced: true,
      } satisfies T3Live.View,
    }
  })

/** The view kept in `file`. */
const viewedFile = (file: string) => Effect.flatMap(Effect.tryPromise(() => Bun.file(file).json() as Promise<unknown>), viewed)

// --- run -------------------------------------------------------------------------------------------------------------

/** The synthetic cases, with the threads they're about. */
const synthetic = Effect.gen(function* () {
  const saved = yield* Effect.promise(() => Bun.file(casesFile).json() as Promise<unknown>).pipe(Effect.flatMap(Schema.decodeUnknown(Synthetic)))
  const { at, view } = yield* viewed(saved.view)
  const cases = saved.cases.map((written, index): Case => {
    const update = saved.updates[written.update]
    if (update === undefined) throw new Error(`${written.id} is over an update that isn't written: ${written.update}`)
    const machine = written.machine ?? machineName
    const ref = written.how === "untied" ? undefined : { machine, id: update.thread }
    const said = written.said ?? update.spoken
    const when = at + index * 60_000
    // What yapd last did for him, as the ledger keeps a message it sent.
    const acted: Ledger.Row | undefined =
      written.acted === undefined
        ? undefined
        : {
            commandId: `yapd:u-${written.id}:0`,
            messageId: `yapd:u-${written.id}:0:m`,
            utterance: `u-${written.id}`,
            step: 0,
            kind: "message",
            machine: machineName,
            thread: written.acted.thread,
            body: {},
            digest: written.acted.text.toLowerCase(),
            state: "sent",
            how: "now",
            reason: null,
            at: when - written.acted.ago * 1000,
          }
    return {
      id: written.id,
      era: "synthetic",
      by: "responder",
      at: when,
      update: {
        project: update.project,
        spoken: update.spoken,
        message: update.message,
        needsYou: update.needsYou,
        session: written.how === "untied" ? `${update.session}-untied` : update.session,
        ...(ref === undefined ? {} : { ref }),
        ...(written.how === "owner" ? { owner: true } : {}),
        steered: written.how === "tied",
      },
      lines: [{ speaker: "yapd", text: said }],
      heard: written.heard,
      ...(written.echo === undefined ? {} : { echo: written.echo, ...(written.afterPause === undefined ? {} : { afterPause: written.afterPause }) }),
      ...(written.left === undefined ? {} : { left: written.left }),
      ...(written.lateBy === undefined ? {} : { lateBy: written.lateBy }),
      ...(written.voiced === undefined ? {} : { voiced: written.voiced }),
      ...(written.steered === undefined ? {} : { steered: written.steered }),
      ...(written.present === undefined ? {} : { present: written.present }),
      ...(written.done === undefined ? {} : { done: written.done.change === undefined ? {} : { change: written.done.change } }),
      ...(acted === undefined ? {} : { acted }),
      ...(written.routines === undefined ? {} : { routines: written.routines }),
      logged: written.expect.intent === undefined ? {} : { intent: written.expect.intent },
      expect: written.expect,
      note: written.note,
      flags: [],
    }
  })
  return { cases, view }
})

/** A thread of the update's own, for one the threads at hand don't have, called by what's known of it. */
const standIn = (id: string, title: string, at: number) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId: `p-${id}`,
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    createdAt: new Date(at - hour).toISOString(),
    updatedAt: new Date(at).toISOString(),
  })

/** The update as the daemon has it. */
const asUpdate = (told: Told, at: number): Conversation.Update => ({
  session: told.session,
  project: told.project,
  turn: { prompt: Option.fromNullable(told.prompt), message: told.message },
  needsYou: told.needsYou,
  spoken: told.spoken,
  ...(told.more === undefined ? {} : { more: told.more }),
  audio: "",
  thread: { agent: "claude", session: told.session, cwd: "", message: told.message, origin: {} },
  at,
  ...(told.ref === undefined ? {} : told.owner === true ? { owner: told.ref } : { about: told.ref }),
})

/**
 * What the Brain goes by for a reply over an update, or to an answer, as the
 * assistant puts it together, with what's live stubbed. Handed over, the
 * desk is about the thread the update is from, a rig update's by `owner` too.
 */
const situation = (case_: Case, base: T3Live.View, handoff = false): Brain.Situation => {
  const now = case_.at
  const told = case_.update
  const update = told === undefined ? undefined : asUpdate(told, now)
  const said = case_.lines.findLast(({ speaker }) => speaker === "yapd")?.text ?? ""
  const subject: Assistant.Subject =
    update !== undefined
      ? { _tag: "Session", update, said }
      : case_.answered !== undefined
        ? { _tag: "Answer", said: case_.answered, about: Option.none() }
        : { _tag: "Nothing" }
  // The update's own thread first, made up from what's known of it when the threads at hand don't have it; the rest beside it.
  const ref = told?.ref
  const own = ref === undefined || (ref.machine === machineName && base.threads.has(ref.id)) ? undefined : standIn(ref.id, told?.title ?? told?.project ?? "", now)
  const here = own !== undefined && ref?.machine === machineName ? { ...base, threads: new Map([...base.threads, [own.id, own]]) } : base
  const others: ReadonlyArray<Threads.Seen> =
    own !== undefined && ref !== undefined && ref.machine !== machineName
      ? [{ machine: ref.machine, here: false, view: { ...T3Live.empty, threads: new Map([[own.id, own]]), synced: true }, started: new Map(), said: new Map() }]
      : []
  const threads = Threads.shortlist({
    machine: machineName,
    view: here,
    focus: Option.fromNullable(handoff ? (update?.about ?? update?.owner) : update?.about),
    pending: [],
    heard: case_.heard,
    most: 12,
    more: 120,
    started: new Map(),
    said: new Map(),
    others,
    now,
  })
  return {
    utterance: {
      id: `eval-${case_.id}`,
      heard: case_.heard,
      via: "reply",
      at: now,
      // How long he spoke, kept only from batch 1 on: before that, taken as clearly spoken.
      voiced: case_.voiced ?? 1,
      turns: 0,
      ...(case_.echo === undefined ? {} : { echo: case_.echo, ...(case_.afterPause === undefined ? {} : { afterPause: case_.afterPause }) }),
    },
    subject,
    lines: case_.lines,
    open: Option.none(),
    desk: { threads, away: [] },
    lately: case_.lately ?? [],
    missed: { since: now - day, spoke: now - day, groups: [] },
    mutes: [],
    muteChange: Option.none(),
    usage: Option.none(),
    second: Option.none(),
    asked: [],
    acted: Option.fromNullable(case_.acted),
    ...(case_.acted === undefined ? {} : { recent: [case_.acted] }),
    ...(case_.routines === undefined ? {} : { memories: { kept: [], written: case_.routines } }),
    now,
  }
}

/** What the Responder is told of a reply over an update. */
const interruption = (case_: Case, told: Told): Baseline.Interruption => ({
  project: told.project,
  turn: { prompt: Option.fromNullable(told.prompt), message: told.message },
  needsYou: told.needsYou,
  lines: case_.lines,
  heard: case_.heard,
  ...(case_.echo === undefined ? {} : { echo: case_.echo, ...(case_.afterPause === undefined ? {} : { afterPause: case_.afterPause }) }),
  ...(case_.left === undefined ? {} : { unsaid: case_.left }),
  ...(told.more === undefined ? {} : { more: told.more }),
  ...(case_.routines === undefined ? {} : { routines: case_.routines.map(({ name }) => name) }),
})

interface Result {
  readonly id: string
  readonly era: Case["era"]
  readonly path: string
  readonly source: string
  readonly ms: number
  readonly modelMs?: number
  /** As the Responder's intents are, with "elsewhere" for a send to another thread than the update's own. */
  readonly intent: string
  readonly act?: string
  readonly target?: string
  readonly title?: string
  readonly checked?: string
  readonly spoken?: string
  readonly message?: string
  readonly rest?: string
  readonly failed?: string
  /** The Brain's decision as the model or `fast` gave it, before `check`: only to look into, never scored. */
  readonly raw?: { readonly act: string; readonly target?: string; readonly spoken?: string; readonly message?: string; readonly rest?: string }
  /** Which run of the case this is, from 1, when it's worked out more than once. */
  readonly run?: number
  /** Batch 3's: how it was routed, what handed it over, and how the Brain worked it out, with its part of the time and the Responder's. */
  readonly route?: string
  readonly handedBy?: "hook" | "responder"
  readonly brainSource?: string
  readonly brainMs?: number
  readonly responderMs?: number
  /** Whether what's said over it goes to its thread by yapd's own hand, and whether he's at hand. */
  readonly steered?: boolean
  readonly present?: boolean
  /** For a Pass, what's said of the rest left. */
  readonly left?: string
  /**
   * For an Act: whether its first step was left for the update's own session,
   * or about mutes, what it does, unless that's turned down while he isn't at
   * hand, and whether all of it may be yapd's own words.
   */
  readonly leftFirst?: boolean
  readonly done?: string
  readonly doubted?: boolean
  /** Its rest, worked out as the next step: what it does, to which thread, and whether it's left. */
  readonly restAct?: string
  readonly restTitle?: string
  readonly restLeft?: boolean
  /** Writes to the update's own thread over an unsteered update that nothing left, which must be none, and how many were left. */
  readonly ownByHands?: number
  readonly leftOver?: number
}

/** The Brain's act, as the Responder's intent it'd be: what it reads is an answer, and a send to another thread than "it" is elsewhere. */
const intentOf = (decision: Brain.Decision, ownHandle: string | undefined) => {
  switch (decision.act) {
    case "dismiss":
    case "resume":
      return decision.act
    case "answer":
    case "again":
    case "look":
    case "find":
    case "show":
    case "catchup":
      return "answer"
    case "send":
    case "reply":
      return decision.target === "" || decision.target === ownHandle ? "send" : "elsewhere"
    default:
      return decision.act
  }
}

/** What changes something, which what was only an answer, a dismissal or talk not meant for yapd may never come to. */
const changing = new Set(["send", "elsewhere", "reply", "decide", "stop", "undo", "tidy", "start", "mute", "mode", "remind", "remember", "forget"])

/** What the Brain decided, as it's logged beside a result, before `check`. */
const rawOf = (decision: Brain.Decision) => ({
  act: decision.act,
  ...(decision.target === "" ? {} : { target: decision.target }),
  ...(decision.spoken === "" ? {} : { spoken: decision.spoken }),
  ...(decision.text === "" ? {} : { message: decision.text }),
  ...(decision.rest === "" ? {} : { rest: decision.rest }),
})

const run = Effect.gen(function* () {
  const paths = option("path", "baseline").split(",").filter((path) => path !== "")
  const unknown = paths.filter((path) => path !== "baseline" && path !== "brain" && path !== "m4")
  if (unknown.length > 0 || paths.length === 0) return yield* Effect.dieMessage(`Unknown path: ${unknown.join(", ")}`)
  // One era or several, as "log,journal" for the gate.
  const eras = option("era", "all").split(",").filter((era) => era !== "")
  const unknownEras = eras.filter((era) => era !== "all" && era !== "log" && era !== "journal" && era !== "synthetic")
  if (unknownEras.length > 0 || eras.length === 0) return yield* Effect.dieMessage(`Unknown era: ${unknownEras.join(", ")}`)
  const inEra = (era: Case["era"]) => eras.includes("all") || eras.includes(era)
  // Run again, only those, three times more: a disagreement or a hard fail counts once it holds in two of the three.
  const rerun = new Set(option("rerun", "").split(",").filter((id) => id !== ""))
  const only = rerun.size > 0 ? rerun : new Set(option("only", "").split(",").filter((id) => id !== ""))
  const repeat = rerun.size > 0 ? 3 : Math.max(1, Math.floor(Number(option("repeat", "1"))) || 1)
  const limit = Number(option("limit", "0"))
  machineName = Option.getOrElse(yield* Config.name, () => machineName)

  const saved = yield* Effect.tryPromise(() => Bun.file(fixtureFile).json() as Promise<{ readonly cases: ReadonlyArray<Case> }>).pipe(
    Effect.orElse(() => Effect.dieMessage(`Run "bun scripts/reply-eval.ts fixture" first: there's no ${fixtureFile}.`)),
  )
  const written = yield* synthetic
  const labels = yield* Effect.tryPromise(() => Bun.file(labelsFile).json() as Promise<unknown>).pipe(
    Effect.flatMap(Schema.decodeUnknown(Labels)),
    Effect.orElseSucceed(() => ({}) as typeof Labels.Type),
  )
  const shell = yield* Effect.either(viewedFile(viewFile))
  const base = Either.isRight(shell) ? shell.right.view : T3Live.empty
  if (Either.isLeft(shell)) yield* Console.log(`No ${viewFile}: the threads beside each update's own are none. brain-eval's fixture writes it.`)

  const every = [...saved.cases, ...written.cases]
  const chosen = every
    .filter((case_) => inEra(case_.era))
    .filter((case_) => only.size === 0 || only.has(case_.id))
    .slice(0, limit > 0 ? limit : undefined)
  const whole = only.size === 0 && limit === 0 && (["log", "journal", "synthetic"] as const).every(inEra)

  const out = option("out", folder)
  yield* Effect.promise(() => mkdir(out, { recursive: true }))
  const results = join(out, `results-reply-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
  const writer = Bun.file(results).writer()
  const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim() || "unknown"
  const baselineFile = join(out, `reply-baseline-${sha}.jsonl`)
  const baselineWriter = whole && paths.includes("baseline") ? Bun.file(baselineFile).writer() : undefined

  // The live Responder over the same model, with the plain persona, beside the Brain.
  const context = yield* Layer.build(Layer.provideMerge(Layer.mergeAll(Brain.ProviderBrain, Responder.ProviderResponder), Layer.merge(ProviderModel, Persona.Plain)))
  const model = Context.get(context, Model)
  const brain = Context.get(context, Brain.Brain)
  const responder = Context.get(context, Responder.Responder)
  const style = yield* Config.style
  const lines = Persona.plain
  yield* Console.log(`${chosen.length} cases, on ${paths.join(" and ")}, one model call at a time.`)

  const baseline = (case_: Case) =>
    Effect.gen(function* () {
      const told = case_.update
      if (case_.by !== "responder" || told === undefined) return undefined
      const began = performance.now()
      const answered = yield* Effect.either(Baseline.respond(interruption(case_, told), model, style, lines, Effect.succeed(lines.onIt)))
      const ms = performance.now() - began
      if (Either.isLeft(answered)) return { id: case_.id, era: case_.era, path: "baseline", source: "failed", ms, intent: "failed", failed: String(answered.left) } satisfies Result
      const { reply, source, modelMs } = answered.right
      return {
        id: case_.id,
        era: case_.era,
        path: "baseline",
        source,
        ms,
        ...(modelMs === undefined ? {} : { modelMs }),
        intent: reply.intent,
        ...(reply.spoken === "" ? {} : { spoken: reply.spoken }),
        ...(reply.message === "" ? {} : { message: reply.message }),
      } satisfies Result
    })

  const thinking = (case_: Case) =>
    Effect.gen(function* () {
      const situated = situation(case_, case_.era === "synthetic" ? written.view : base)
      const ownRef = case_.update?.ref
      const own = ownRef === undefined ? undefined : situated.desk.threads.find((listed) => Threads.same(listed.ref, ownRef))?.handle
      const began = performance.now()
      const quick = Brain.fast(situated, lines)
      const decided = quick === undefined ? yield* Effect.either(brain.decide(situated)) : Either.right(quick)
      const ms = performance.now() - began
      if (Either.isLeft(decided)) return { id: case_.id, era: case_.era, path: "brain", source: "failed", ms, intent: "failed", failed: String(decided.left.cause) } satisfies Result
      const decision = decided.right
      const checked = Brain.check(decision, situated, lines)
      const raw = {
        act: decision.act,
        ...(decision.target === "" ? {} : { target: decision.target }),
        ...(decision.spoken === "" ? {} : { spoken: decision.spoken }),
        ...(decision.text === "" ? {} : { message: decision.text }),
        ...(decision.rest === "" ? {} : { rest: decision.rest }),
      }
      // Scored as what the check makes of it, which is what the assistant acts on: a faint mute is talk to carry on over, a question
      // is a clarify, and a send it turns down with a reason is only an answer.
      const made = (() => {
        if (checked._tag === "Ask") return { intent: "clarify", act: "clarify", ...(checked.open.asked === "" ? {} : { spoken: checked.open.asked }) }
        if (checked._tag === "Say") return { intent: "answer", act: "answer", ...(checked.spoken === "" ? {} : { spoken: checked.spoken }) }
        const { decision: planned, target, left } = checked.plan
        const listed = Option.getOrUndefined(target) ?? situated.desk.threads.find(({ handle }) => handle === planned.target)
        const rest = planned.rest === "" ? (left ?? "") : planned.rest
        return {
          intent: intentOf(planned, own),
          act: planned.act,
          ...(planned.target === "" ? {} : { target: planned.target }),
          ...(listed === undefined ? {} : { title: listed.thread.title }),
          ...(planned.spoken === "" ? {} : { spoken: planned.spoken }),
          ...(planned.text === "" ? {} : { message: planned.text }),
          ...(rest === "" ? {} : { rest }),
        }
      })()
      return {
        id: case_.id,
        era: case_.era,
        path: "brain",
        source: quick === undefined ? "model" : "fast",
        ms,
        ...(quick === undefined ? { modelMs: ms } : {}),
        ...made,
        checked: checked._tag,
        raw,
      } satisfies Result
    })

  /**
   * Batch 3's handoff, as Conversation.reading works out what he said over an
   * update, plainly his or not: "Mute." and the mute hook's commands in so
   * many words, with nothing done; saying it again; the live Responder, told
   * how long he spoke and how late, a second and none unless the case says;
   * and what it hands over, or the hook does, worked out by the Brain on the
   * update as "it", with its own thread, as said back to a "done" line, and
   * routed as the assistant routes it. An Act's first step is checked and
   * guarded, and turned down as what only his word does while he isn't at
   * hand, as the assistant turns it down, and its rest worked out as the
   * next step is, with the update still "it", and checked and guarded too,
   * nothing of either done.
   */
  const handoff = (case_: Case) =>
    Effect.gen(function* () {
      const told = case_.update
      if (case_.by !== "responder" || told === undefined) return undefined
      const situated = situation(case_, case_.era === "synthetic" ? written.view : base, true)
      if (situated.subject._tag !== "Session") return undefined
      const session = situated.subject
      const { update } = session
      // Unsteered where how a send went isn't known, as hooks carried 47 of the 52 deliveries logged.
      const steered = case_.steered ?? told.steered ?? false
      const present = case_.present ?? true
      const ref = update.subagent === undefined ? (update.about ?? update.owner) : undefined
      const own: Brain.Own = { ...(ref === undefined ? {} : { ref }), steered }
      const ownHandle = ref === undefined ? undefined : situated.desk.threads.find((listed) => Threads.same(listed.ref, ref))?.handle
      const voiced = case_.voiced ?? 1
      const echo = case_.echo
      const afterPause = case_.afterPause ?? ""
      // The hook's, plainly his only, as Daemon has it: a change in so many words, done, or what's about mutes in other words, handed over.
      const plain = echo === undefined && voiced >= Brain.faintest
      const hooked: Option.Option<Conversation.Hooked> = !plain
        ? Option.none()
        : Option.isSome(Brain.modeCommand(case_.heard, told.needsYou))
          ? Option.some({ _tag: "Done", made: "mode", doing: Effect.succeed("") })
          : Option.isSome(Mutes.command(case_.heard))
            ? Option.some({ _tag: "Done", made: "mute", doing: Effect.succeed("") })
            : Mutes.aboutSubagents(case_.heard) || Mutes.aboutMuting(case_.heard)
              ? Option.some({ _tag: "Over", line: Effect.succeed("") })
              : Option.none()
      /** What came of what was handed over, beside what the reading gives back. */
      let handed: Partial<Result> & { readonly brainMs?: number } = {}
      /** What's said of a first step left, as the assistant says it: tidying a session with no thread, plainly, or anything else, in his words. */
      const leftSaid = (decision: Brain.Decision, by: Brain.Handed | undefined, heard: string, desk: Threads.Desk) => {
        const said = Brain.handoffLines(lines)
        if (decision.act === "tidy" && by?.muting !== true) return said.untidied(decision.how)
        return said.left(decision.rest.trim() === "" ? heard : decision.text.trim() || heard, desk)
      }
      let failed: string | undefined
      let responderMs: number | undefined
      const over =
        (muting: boolean) =>
        (heard: string): Effect.Effect<Conversation.Handed> =>
          Effect.gen(function* () {
            const began = performance.now()
            const utterance: Assistant.Utterance = {
              ...situated.utterance,
              heard,
              voiced,
              afterDone: case_.done ?? {},
              ...(case_.left === undefined ? {} : { unsaid: case_.left }),
              handed: { present, ...(muting || Mutes.mentionsMuting(heard) ? { muting: true as const } : {}) },
              own,
            }
            const handedOver: Brain.Situation = { ...situated, utterance, subject: { ...session, own: ref === undefined ? {} : { ref } } }
            const quick = Brain.fast(handedOver, lines)
            const taken = quick !== undefined && Brain.atOnce(quick, utterance, handedOver.subject) ? quick : undefined
            const decided = taken === undefined ? yield* Effect.either(brain.decide(handedOver)) : Either.right(taken)
            const brainMs = performance.now() - began
            if (Either.isLeft(decided)) failed = String(decided.left.cause)
            const decision = Either.isLeft(decided) ? Brain.decision({ act: "answer", spoken: "I couldn't work that out just now." }) : decided.right
            const source = Either.isLeft(decided) ? "failed" : taken === undefined ? "model" : "fast"
            const routed = Brain.route(decision, handedOver, lines)
            const checked = Brain.check(decision, handedOver, lines)
            const leftFirst = Brain.leftOver(decision, own, utterance.handed, handedOver)
            // While he isn't at hand, a first step only his word does, with more after it, is acted on only to be turned down.
            const turnedDown = routed._tag === "Act" && routed.unattended === true
            /**
             * Whether a checked write reaches the turn of the update's own thread, as `Brain.turnOf` has it, over an unsteered update: by
             * thread, or one with none, by none. Never tidying it, nor taking back what tidying did, which change nothing of its turn.
             */
            const ownWrite = (plan: Brain.Plan) => {
              const turn = Brain.turnOf(plan.decision, handedOver)
              if (steered || turn === undefined) return false
              if (turn !== "named") return ref !== undefined && Threads.same(turn, ref)
              return ref === undefined
                ? plan.decision.target.trim() === "" && plan.decision.act !== "undo"
                : Option.exists(plan.target, (listed) => Threads.same(listed.ref, ref))
            }
            let ownByHands = routed._tag === "Act" && !leftFirst && checked._tag === "Do" && ownWrite(checked.plan) ? 1 : 0
            let leftOver = routed._tag === "Act" && leftFirst ? 1 : 0
            // Its rest, as the next step works it out, with the update still "it", from what he said, never what may be yapd's own voice.
            let rest: Partial<Result> = {}
            if (routed._tag === "Act" && decision.rest.trim() !== "") {
              const { echo: _, afterPause: __, echoRoutines: ___, carried: ____, afterDone: _____, ...before } = utterance
              const next: Assistant.Utterance = {
                ...before,
                heard: decision.rest,
                whole: utterance.whole ?? (utterance.echo === undefined ? utterance.heard : ""),
                ...(Brain.mayBeOwn(utterance) ? { echoedBack: true as const } : {}),
              }
              const then: Brain.Situation = { ...handedOver, utterance: next, lines: [{ speaker: "user", text: heard, ...Brain.overheard(utterance) }] }
              const restQuick = Brain.fast(then, lines)
              const restTaken = restQuick !== undefined && Brain.atOnce(restQuick, next, then.subject) ? restQuick : undefined
              const restDecided = restTaken === undefined ? yield* Effect.either(brain.decide(then)) : Either.right(restTaken)
              if (Either.isRight(restDecided)) {
                const restChecked = Brain.check(restDecided.right, then, lines)
                const restLeft = Brain.leftOver(restDecided.right, own, next.handed, then)
                if (restLeft) leftOver++
                else if (restChecked._tag === "Do" && ownWrite(restChecked.plan)) ownByHands++
                const listed = restChecked._tag === "Do" ? Option.getOrUndefined(restChecked.plan.target) : undefined
                rest = { restAct: restChecked._tag === "Do" ? restChecked.plan.decision.act : restChecked._tag === "Ask" ? "clarify" : "answer", ...(listed === undefined ? {} : { restTitle: listed.thread.title }), restLeft }
              }
            }
            const plan = checked._tag === "Do" ? checked.plan : undefined
            const listed = plan === undefined ? undefined : (Option.getOrUndefined(plan.target) ?? handedOver.desk.threads.find(({ handle }) => handle === plan.decision.target))
            handed = {
              handedBy: muting ? "hook" : "responder",
              brainSource: source,
              brainMs,
              route: routed._tag,
              act: plan?.decision.act ?? decision.act,
              ...(decision.target === "" ? {} : { target: decision.target }),
              ...(listed === undefined ? {} : { title: listed.thread.title }),
              checked: checked._tag,
              ...(leftFirst
                ? { spoken: leftSaid(decision, utterance.handed, heard, handedOver.desk) }
                : turnedDown
                ? { spoken: Brain.handoffLines(lines).shortcut }
                : checked._tag === "Ask"
                  ? { spoken: checked.open.asked }
                  : checked._tag === "Say"
                    ? { spoken: checked.spoken }
                    : plan?.decision.spoken === "" || plan === undefined
                      ? {}
                      : { spoken: plan.decision.spoken }),
              ...(decision.text === "" ? {} : { message: decision.text }),
              ...(decision.rest === "" ? {} : { rest: decision.rest }),
              ...(routed._tag === "Pass" && routed.left !== undefined ? { left: routed.left } : {}),
              ...(routed._tag === "Act" ? { leftFirst, ...(plan === undefined || turnedDown ? {} : { done: plan.decision.act }), doubted: routed.doubted } : {}),
              ...rest,
              ownByHands,
              leftOver,
              raw: rawOf(decision),
              intent:
                routed._tag === "Resume"
                  ? "resume"
                  : routed._tag === "Dismiss"
                    ? "dismiss"
                    : routed._tag === "Answer"
                      ? "answer"
                      : routed._tag === "Pass"
                        ? "send"
                        : leftFirst || turnedDown
                          ? "answer"
                          : checked._tag === "Ask"
                            ? "clarify"
                            : checked._tag === "Say"
                              ? "answer"
                              : intentOf(checked.plan.decision, ownHandle),
            }
            const how = { source, ms: brainMs, ...(source === "model" ? { modelMs: brainMs } : {}), routed: routed._tag.toLowerCase() } as const
            return routed._tag === "Act" ? { ...routed, ...how, run: () => Effect.void } : { ...routed, ...how }
          })
      const began = performance.now()
      const worked = yield* Conversation.reading({
        heard: case_.heard,
        voiced,
        afterPause,
        halt: halts(case_.heard) && !/mute/i.test(echo ?? ""),
        echo,
        needsYou: told.needsYou,
        hooked,
        may: true,
        respond: (heard) =>
          Effect.gen(function* () {
            const asked = performance.now()
            const answered = yield* Effect.either(responder.respond({ ...interruption(case_, told), heard, voiced, lateBy: case_.lateBy ?? 0 }))
            responderMs = performance.now() - asked
            if (Either.isLeft(answered)) {
              failed = String(answered.left.cause)
              return { reply: { intent: "answer", spoken: lines.misheard, message: "" }, source: "failed" } satisfies Conversation.Worked
            }
            return { reply: answered.right.reply, source: answered.right.source, ...(answered.right.modelMs === undefined ? {} : { modelMs: answered.right.modelMs }) } satisfies Conversation.Worked
          }),
        over: (muting) => over(muting),
        shortcut: Effect.succeed(Brain.handoffLines(lines).shortcut),
      })
      const ms = performance.now() - began
      const { reply, source, modelMs } = worked
      const route = source === "again" ? "Again" : source === "mute" ? "Hook" : worked.handed === undefined ? "Responder" : worked.handed._tag
      return {
        id: case_.id,
        era: case_.era,
        path: "m4",
        source,
        ms,
        ...(modelMs === undefined ? {} : { modelMs }),
        ...(responderMs === undefined ? {} : { responderMs }),
        steered,
        present,
        intent: source === "mute" ? "mute" : reply.intent === "assistant" ? "answer" : reply.intent,
        ...(reply.spoken === "" ? {} : { spoken: reply.spoken }),
        ...(reply.message === "" ? {} : { message: reply.message }),
        ...(worked.handed === undefined ? {} : handed),
        route,
        ...(failed === undefined ? {} : { failed }),
      } satisfies Result
    })

  const done: Array<Result> = []
  for (const [index, case_] of chosen.entries()) {
    // Each path goes first on every other case, so the model's speed drifting over the run falls on both alike.
    const order = index % 2 === 0 ? paths : paths.toReversed()
    for (let time = 1; time <= repeat; time++) {
      for (const path of order) {
        const worked = path === "baseline" ? yield* baseline(case_) : path === "m4" ? yield* handoff(case_) : yield* thinking(case_)
        if (worked === undefined) continue
        const result = repeat === 1 ? worked : { ...worked, run: time }
        done.push(result)
        writer.write(`${JSON.stringify({ ...result, expected: expected(case_, labels), logged: case_.logged, flags: case_.flags })}\n`)
        if (path === "baseline" && time === 1) baselineWriter?.write(`${JSON.stringify(worked)}\n`)
      }
    }
  }
  yield* Effect.promise(() => Promise.resolve(writer.end()))
  if (baselineWriter !== undefined) yield* Effect.promise(() => Promise.resolve(baselineWriter.end()))
  // Batch 1's baseline, the same frozen code, whose agreement with today's is the noise floor.
  const batch1 = yield* Effect.promise(() =>
    Bun.file(join(folder, "reply-baseline-c319ce0.jsonl"))
      .text()
      .then((text) => text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Result))
      .catch(() => [] as Array<Result>),
  )
  if (rerun.size > 0) yield* Console.log(reruns(chosen, done, paths, labels))
  yield* Console.log(report(chosen, done, paths, labels, batch1))
  yield* Console.log(`Every answer is in ${results}.${baselineWriter === undefined ? "" : ` The baseline's are kept in ${baselineFile} too.`}`)
}).pipe(Effect.scoped)

/** What a case should come to: his confirmed verdict, else what was logged, as the Responder's intent; the assistant's act for its own rows. */
const expected = (case_: Case, labels: typeof Labels.Type) => {
  const label = labels[case_.id]
  if (label !== undefined && label.status === "confirmed") return label.intent
  return case_.by === "assistant" ? case_.logged.act : case_.logged.intent
}

/** Whether a path's answer agrees with what's expected: for the assistant's rows, the same act. */
const agrees = (case_: Case, result: Result, labels: typeof Labels.Type) => {
  const wanted = expected(case_, labels)
  return case_.by === "assistant" ? result.act === wanted : result.intent === wanted
}

/** Whether a written case's expectations hold on this path, or none of them apply to it. */
const meets = (case_: Case, result: Result): boolean | undefined => {
  const expect = case_.expect
  if (expect === undefined) return undefined
  if (result.path === "m4") return meetsHandoff(case_, expect, result)
  const checks: Array<boolean> = []
  if (expect.intent !== undefined && (result.path === "baseline" || expect.act === undefined)) checks.push(result.intent === expect.intent)
  if (expect.neverIntent !== undefined && result.path === "baseline") checks.push(!expect.neverIntent.includes(result.intent as Intent))
  if (result.path === "brain") {
    if (expect.act !== undefined) checks.push(result.act !== undefined && expect.act.includes(result.act as Brain.Act))
    if (expect.never !== undefined) checks.push(result.act === undefined || !expect.never.includes(result.act as Brain.Act))
    if (expect.target !== undefined)
      checks.push(expect.target === "own" ? result.intent === "send" : (result.title ?? "").toLowerCase().includes(expect.target.toLowerCase()))
    if (expect.rest !== undefined) checks.push((result.rest ?? "").toLowerCase().includes(expect.rest.toLowerCase()))
  }
  return checks.length === 0 ? undefined : checks.every(Boolean)
}

/**
 * Whether batch 3's path meets a written case: the Responder's intent when it
 * kept it, the Brain's act, thread and rest when it was handed over, what
 * it may come to, how it's routed and worked out, what a Pass left, whether
 * the rest was left, what's never done, what a question names, what handed
 * it over, what's never said and what is; and always, nothing written by
 * yapd's own hand to an unsteered update's own thread, nor a Pass that loses
 * a negation he said or puts in words nothing said.
 */
const meetsHandoff = (case_: Case, expect: Expect, result: Result): boolean => {
  const handed = result.route !== undefined && !["Again", "Hook", "Responder"].includes(result.route)
  const lower = (text: string | undefined) => (text ?? "").toLowerCase()
  const checks: Array<boolean> = [(result.ownByHands ?? 0) === 0]
  if (expect.intent !== undefined && (!handed || expect.act === undefined)) checks.push(result.intent === expect.intent)
  if (expect.intents !== undefined) checks.push(expect.intents.includes(result.intent))
  if (expect.neverIntent !== undefined) checks.push(!expect.neverIntent.includes(result.intent as Intent))
  if (expect.act !== undefined && (handed || expect.intent === undefined)) checks.push(result.act !== undefined && expect.act.includes(result.act as Brain.Act))
  if (expect.never !== undefined) checks.push(result.act === undefined || !expect.never.includes(result.act as Brain.Act))
  if (expect.target !== undefined) checks.push(expect.target === "own" ? result.intent === "send" : lower(result.title).includes(lower(expect.target)))
  if (expect.rest !== undefined) checks.push(lower(result.rest).includes(lower(expect.rest)) || lower(result.left).includes(lower(expect.rest)))
  if (expect.route !== undefined) checks.push(expect.route.includes(result.route as typeof Route.Type))
  if (expect.neverRoute !== undefined) checks.push(!expect.neverRoute.includes(result.route as typeof Route.Type))
  if (expect.source !== undefined) checks.push(result.source === expect.source || result.brainSource === expect.source)
  if (expect.left !== undefined) checks.push(lower(result.left).includes(lower(expect.left)))
  if (expect.restLeft !== undefined) checks.push(result.restLeft === expect.restLeft)
  if (expect.neverDone !== undefined) checks.push(result.done === undefined || result.leftFirst === true || !expect.neverDone.includes(result.done as Brain.Act))
  if (expect.asking !== undefined) checks.push(result.checked !== "Ask" || lower(result.spoken).includes(lower(expect.asking)))
  if (expect.handedBy !== undefined) checks.push(result.handedBy === expect.handedBy)
  if (expect.neverSpoken !== undefined) checks.push(!expect.neverSpoken.some((words) => lower(result.spoken).includes(lower(words))))
  if (expect.says !== undefined) checks.push(lower(result.spoken).includes(lower(expect.says)))
  if (result.route === "Pass") checks.push(!lostNegation(case_, result) && unfounded(case_, result.message ?? "") <= 2)
  return checks.every(Boolean)
}

const negations = /\b(don't|do not|not|never|no|leave|keep)\b/i

/** Whether a message for the agent leaves out a negation he said. */
const lostNegation = (case_: Case, result: Result) => negations.test(case_.heard) && result.message !== undefined && !negations.test(result.message)

/** The words of a message for the agent that are in neither what he said, the agent's message nor the conversation. */
const unfounded = (case_: Case, message: string) => {
  const known = words([case_.heard, case_.update?.message ?? "", case_.update?.prompt ?? "", ...case_.lines.map(({ text }) => text)].join(" "))
  return [...words(message)].filter((word) => word.length > 4 && !known.has(word)).length
}

/** A case's results on a path, every run of it. */
const runsOf = (done: ReadonlyArray<Result>, path: string, id: string) => done.filter((result) => result.path === path && result.id === id)

/** Of several runs of a case, the one whose intent most of them came to: the first such, so a case run once is that run. */
const modal = (runs: ReadonlyArray<Result>): Result | undefined => {
  const counts = new Map<string, number>()
  for (const { intent } of runs) counts.set(intent, (counts.get(intent) ?? 0) + 1)
  const most = Math.max(0, ...counts.values())
  return runs.find(({ intent }) => counts.get(intent) === most)
}

/** Whether most of a case's runs meet it, or none of its expectations apply to the path. */
const meetsMost = (case_: Case, runs: ReadonlyArray<Result>): boolean | undefined => {
  const judged = runs.map((result) => meets(case_, result)).filter((met): met is boolean => met !== undefined)
  return judged.length === 0 ? undefined : judged.filter(Boolean).length * 2 > judged.length
}

/**
 * Whether a result is a hard fail: what was only an answer, a dismissal or
 * talk not meant for yapd that came to a change, a confirmed acknowledgement
 * that became a write, a logged send to another thread than the update's
 * own; and for batch 3, a write by yapd's own hand to an unsteered update's
 * own thread, a Pass that's faint, about mutes, over what may be yapd's own
 * words or a routine's name, and on a written case, one that loses a
 * negation he said. A logged "ask me that with the shortcut" that came to
 * the mode, mute, catch-up or tidying it named is listed for his verdict
 * instead.
 */
const hardFail = (case_: Case, result: Result, labels: typeof Labels.Type) => {
  if (case_.by !== "responder") return false
  const wanted = expected(case_, labels)
  const label = labels[case_.id]
  if (result.path === "m4" && verdictOnly(case_, result)) return false
  const passed = result.route === "Pass"
  return (
    (["dismiss", "answer", "resume"].includes(String(wanted)) && changing.has(result.intent)) ||
    (label?.status === "confirmed" && label.intent === "dismiss" && changing.has(result.intent)) ||
    (wanted === "send" && result.intent === "elsewhere") ||
    (wanted === "send" && result.path === "m4" && ["start", "stop", "undo", "tidy", "mute", "mode", "remind", "remember", "forget"].includes(result.intent)) ||
    (result.ownByHands ?? 0) > 0 ||
    (passed && ((case_.voiced ?? 1) < Brain.faintest || Mutes.mentionsMuting(case_.heard) || (case_.echo !== undefined && (case_.afterPause ?? "").trim() === ""))) ||
    (passed && (case_.routines ?? []).some(({ name }) => Brain.nameSaid(name, { heard: case_.heard }))) ||
    (passed && case_.era === "synthetic" && lostNegation(case_, result))
  )
}

/** A logged "ask me that with the shortcut" that batch 3 turned into the mode, mute, catch-up or tidying it named, for his verdict. */
const verdictOnly = (case_: Case, result: Result) =>
  case_.logged.intent === "answer" && /shortcut/i.test(case_.logged.spoken ?? "") && (["mode", "mute", "tidy"].includes(result.intent) || result.act === "catchup")

/** Each case run again, by path: what each run came to, and how many of them disagree with what's expected or are hard fails. */
const reruns = (cases: ReadonlyArray<Case>, done: ReadonlyArray<Result>, paths: ReadonlyArray<string>, labels: typeof Labels.Type) =>
  cases
    .map((case_) =>
      [
        `${case_.id}:`,
        ...paths.map((path) => {
          const runs = runsOf(done, path, case_.id)
          if (runs.length === 0) return `${path} -`
          const against = case_.era === "synthetic" ? runs.filter((result) => meets(case_, result) === false).length : runs.filter((result) => !agrees(case_, result, labels)).length
          const failing = runs.filter((result) => hardFail(case_, result, labels)).length
          return `${path} ${runs.map(({ intent }) => intent).join(" ")} (${case_.era === "synthetic" ? "not met" : "disagrees"} ${against}/${runs.length}, hard fails ${failing}/${runs.length})`
        }),
      ].join(" "),
    )
    .join("\n")

const report = (cases: ReadonlyArray<Case>, done: ReadonlyArray<Result>, paths: ReadonlyArray<string>, labels: typeof Labels.Type, batch1: ReadonlyArray<Result> = []) => {
  const byId = new Map(cases.map((case_) => [case_.id, case_]))
  const lines: Array<string> = []
  const ids = (those: ReadonlyArray<Result>) => (those.length === 0 ? "none" : those.map(({ id }) => id).join(" "))
  /** Each case's result on a path, by the majority of its runs. */
  const modals = (path: string) =>
    cases.flatMap((case_) => Option.toArray(Option.fromNullable(modal(runsOf(done, path, case_.id)))))
  for (const path of paths) {
    const all = done.filter((result) => result.path === path)
    const mine = modals(path)
    const logged = mine.filter((result) => byId.get(result.id)?.era !== "synthetic")
    lines.push(`${path}: ${all.length} run, ${all.filter(({ failed }) => failed !== undefined).length} failed${all.length === mine.length ? "" : `, ${mine.length} cases by the majority of their runs`}.`)
    for (const era of ["log", "journal"] as const) {
      const those = logged.filter((result) => result.era === era)
      if (those.length === 0) continue
      const agreed = those.filter((result) => agrees(byId.get(result.id)!, result, labels))
      lines.push(`  ${era}: ${agreed.length}/${those.length} agree (${((100 * agreed.length) / those.length).toFixed(1)}%).`)
      const byIntent = Object.groupBy(those, (result) => String(expected(byId.get(result.id)!, labels)))
      for (const [intent, group] of Object.entries(byIntent)) {
        if (group === undefined) continue
        const missed = group.filter((result) => !agrees(byId.get(result.id)!, result, labels))
        lines.push(`    ${intent}: ${group.length - missed.length}/${group.length}${missed.length === 0 ? "" : `, missed ${ids(missed)}`}`)
      }
    }
    const hard = logged.filter((result) => hardFail(byId.get(result.id)!, result, labels))
    // Those over a line kept whole as where he cut it off isn't known, which may be the replay's doing, like a question he hadn't heard.
    const uncut = hard.filter((result) => byId.get(result.id)!.flags.includes("cut-unknown"))
    lines.push(`  Hard fails: ${hard.length}${hard.length === 0 ? "" : `: ${ids(hard)}`}${uncut.length === 0 ? "" : `; where he cut in isn't known for ${ids(uncut)}`}.`)
    const ms = logged.filter(({ failed }) => failed === undefined).map(({ ms }) => ms)
    const model = logged.filter(({ source, modelMs }) => source === "model" || modelMs !== undefined)
    lines.push(
      `  Latency: p50 ${seconds(percentile(ms, 0.5))}, p90 ${seconds(percentile(ms, 0.9))}; with the model p50 ${seconds(percentile(model.map(({ ms }) => ms), 0.5))}, p90 ${seconds(percentile(model.map(({ ms }) => ms), 0.9))}; worked out without it ${logged.length === 0 ? "-" : `${((100 * (logged.length - model.length)) / logged.length).toFixed(0)}%`}.`,
    )
    if (path === "m4") {
      // What was handed over, by era, by id, and how; how steered was taken; and the guard at work.
      for (const era of ["log", "journal", "synthetic"] as const) {
        const handed = mine.filter((result) => result.era === era && result.handedBy !== undefined)
        const of = mine.filter((result) => result.era === era).length
        if (of > 0) lines.push(`  Handed over, ${era}: ${handed.length}/${of}${handed.length === 0 ? "" : `: ${handed.map(({ id, route, act }) => `${id} (${route}, ${act})`).join(" ")}`}.`)
      }
      lines.push(`  Taken as steered: ${mine.filter(({ steered }) => steered === true).length}, unsteered: ${mine.filter(({ steered }) => steered === false).length}.`)
      lines.push(`  Written by yapd's own hand to an unsteered update's own thread: ${all.reduce((sum, { ownByHands }) => sum + (ownByHands ?? 0), 0)}; left for it: ${all.reduce((sum, { leftOver }) => sum + (leftOver ?? 0), 0)}.`)
      lines.push(`  A logged "ask me that with the shortcut" that came to what it named, for his verdict: ${ids(logged.filter((result) => verdictOnly(byId.get(result.id)!, result)))}.`)
      const handoffs = all.filter((result) => result.era === "synthetic" && result.handedBy !== undefined && result.failed === undefined)
      const asked = handoffs.filter(({ brainSource }) => brainSource === "model")
      const unasked = handoffs.filter(({ brainSource }) => brainSource === "fast")
      lines.push(`  A handoff's p50, Responder and Brain together, on the written cases: with the Brain's model ${seconds(percentile(asked.map(({ ms }) => ms), 0.5))} (${asked.length}), without ${seconds(percentile(unasked.map(({ ms }) => ms), 0.5))} (${unasked.length}).`)
    }
    const synthetic = mine.filter((result) => result.era === "synthetic")
    if (synthetic.length > 0) {
      const judged = synthetic.map((result) => ({ result, met: meetsMost(byId.get(result.id)!, runsOf(done, path, result.id)) }))
      const failing = judged.filter(({ met }) => met === false).map(({ result }) => result)
      lines.push(`  Written cases: ${judged.filter(({ met }) => met === true).length} met, ${failing.length} not${failing.length === 0 ? "" : ` (${ids(failing)})`}, ${judged.filter(({ met }) => met === undefined).length} not for this path.`)
      const passes = synthetic.filter((result) => result.route === "Pass" && hardFail(byId.get(result.id)!, result, labels))
      if (path === "m4" && passes.length > 0) lines.push(`  A Pass that's a hard fail on a written case: ${ids(passes)}.`)
    }
    // Only to report.
    const sends = logged.filter((result) => byId.get(result.id)?.logged.intent === "send")
    lines.push(`  A question where a send was logged: ${ids(sends.filter(({ intent }) => intent === "clarify"))}.`)
    const lost = sends.filter((result) => lostNegation(byId.get(result.id)!, result))
    lines.push(`  A negation he said lost from the message: ${ids(lost)}.`)
    lines.push(`  A message with words in nothing said: ${ids(sends.filter((result) => result.message !== undefined && unfounded(byId.get(result.id)!, result.message) >= 3))}.`)
  }
  // His verdicts, and what each path made of each.
  for (const [id, label] of Object.entries(labels)) {
    const made = paths.flatMap((path) => Option.toArray(Option.fromNullable(modal(runsOf(done, path, id))))).map((result) => `${result.path} ${result.intent}`)
    if (made.length > 0) lines.push(`${id} (${label.status}, ${label.intent}): ${made.join(", ")}.`)
  }
  // The baseline against every other path, and against batch 1's, the same frozen code, which is the noise floor.
  const baselines = new Map(modals("baseline").map((result) => [result.id, result]))
  const pairwise = (name: string, others: ReadonlyArray<Result>) => {
    const both = others.flatMap((other) => {
      const one = baselines.get(other.id)
      return one === undefined || byId.get(other.id)?.era === "synthetic" ? [] : [[one, other] as const]
    })
    const same = both.filter(([one, other]) => one.intent === other.intent)
    const modelled = both.filter(([one, other]) => one.source === "model" && (other.source === "model" || other.modelMs !== undefined))
    const differ = both.filter(([one, other]) => one.intent !== other.intent)
    // By era too, since the gate counts the log era's on its own.
    const byEra = (["log", "journal"] as const).flatMap((era) => {
      const those = same.filter(([one]) => one.era === era).length
      const of = both.filter(([one]) => one.era === era).length
      return of === 0 ? [] : [`${era} ${those}/${of}`]
    })
    lines.push(
      `baseline and ${name}: the same on ${same.length}/${both.length}${byEra.length === 0 ? "" : ` (${byEra.join(", ")})`}; p50 ${seconds(percentile(both.map(([one]) => one.ms), 0.5))} against ${seconds(percentile(both.map(([, other]) => other.ms), 0.5))}, both with the model ${seconds(percentile(modelled.map(([one]) => one.ms), 0.5))} against ${seconds(percentile(modelled.map(([, other]) => other.ms), 0.5))} (${modelled.length}).`,
    )
    if (name !== "batch 1's baseline" && differ.length > 0) lines.push(`  Not the same: ${differ.map(([one, other]) => `${other.id} (${one.intent}, ${other.intent})`).join(" ")}.`)
  }
  if (baselines.size > 0) {
    for (const path of paths.filter((path) => path !== "baseline")) pairwise(path, modals(path))
    if (batch1.length > 0) pairwise("batch 1's baseline", batch1)
  }
  return lines.join("\n")
}

const command = process.argv[2]
const chosen: Effect.Effect<void, unknown> | undefined = command === "fixture" ? fixture : command === "run" ? run : undefined
if (chosen === undefined) {
  console.error("usage: bun scripts/reply-eval.ts fixture | run [--path baseline,brain,m4] [--era log,journal,synthetic|all] [--only ids] [--limit N] [--repeat N] [--rerun ids] [--out folder]")
  process.exit(1)
}
// yapd's logs, like the translation of a line the model said that wasn't in English, are his: kept with the rest, never printed.
mkdirSync(folder, { recursive: true })
const toFile = Logger.replace(Logger.defaultLogger, Logger.map(Logger.logfmtLogger, (line) => appendFileSync(logsFile, `${line}\n`)))
await Effect.runPromise(Effect.flatMap(settled(), (provider) => chosen.pipe(Effect.withConfigProvider(provider))).pipe(Effect.provide(toFile)))
