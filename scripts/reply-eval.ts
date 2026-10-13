import { Database } from "bun:sqlite"
import { ConfigProvider, Console, Context, Effect, Either, Layer, Logger, Option, Schema } from "effect"
import { appendFileSync, mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import type * as Assistant from "../src/Assistant.ts"
import * as Brain from "../src/Brain.ts"
import * as Config from "../src/Config.ts"
import type * as Conversation from "../src/Conversation.ts"
import { together } from "../src/Conversation.ts"
import { home, settings } from "../src/Home.ts"
import type { Kept } from "../src/Journal.ts"
import * as Missed from "../src/Missed.ts"
import { Model, ProviderModel } from "../src/Model.ts"
import * as Persona from "../src/Persona.ts"
import * as Store from "../src/Store.ts"
import * as T3Live from "../src/T3Live.ts"
import * as Threads from "../src/Threads.ts"
import { gist, type Line, question } from "../src/Words.ts"
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
//   nice -n 15 bun scripts/reply-eval.ts run [--path baseline,brain] [--era log|journal|synthetic|all] [--only ids] [--limit N] [--out folder]
//     Works each one out on each path, one model call at a time, never two
//     at once, each path going first on every other case: "baseline" is the
//     Responder as it was at M4's batch 1, frozen in scripts/eval;
//     "brain" is the Brain alone, Brain.fast, then the model, then `check`,
//     on the situation the reply came in. "m4" comes with batch 3. With
//     scripts/eval/replies.cases.json's cases too, kept apart. Says how many
//     agree with what was logged, or his verdict, by era and by intent; the
//     hard fails; the latencies; and what's only to report, all by id. Each
//     answer goes to results-reply-<time>.jsonl, and a whole baseline run to
//     reply-baseline-<sha>.jsonl too, kept for agreement only.

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

/** What's expected of a case written for the eval: the Responder's intent, the Brain's act and thread, and what neither may come to. */
const Expect = Schema.Struct({
  intent: Schema.optional(Intent),
  act: Schema.optional(Schema.Array(Brain.Act)),
  /** "own" for the update's own thread, or a piece of the title of the thread it's about. */
  target: Schema.optional(Schema.String),
  /** A piece of what's left for after its first step, like the other thread's name. */
  rest: Schema.optional(Schema.String),
  never: Schema.optional(Schema.Array(Brain.Act)),
  neverIntent: Schema.optional(Schema.Array(Intent)),
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
    return {
      id: written.id,
      era: "synthetic",
      by: "responder",
      at: at + index * 60_000,
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

/** What the Brain goes by for a reply over an update, or to an answer, as the assistant puts it together, with what's live stubbed. */
const situation = (case_: Case, base: T3Live.View): Brain.Situation => {
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
    focus: Option.fromNullable(update?.about),
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
    acted: Option.none(),
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

const run = Effect.gen(function* () {
  const paths = option("path", "baseline").split(",").filter((path) => path !== "")
  if (paths.includes("m4")) return yield* Effect.dieMessage("The m4 path comes with batch 3: run baseline or brain.")
  const unknown = paths.filter((path) => path !== "baseline" && path !== "brain")
  if (unknown.length > 0 || paths.length === 0) return yield* Effect.dieMessage(`Unknown path: ${unknown.join(", ")}`)
  const era = option("era", "all")
  const only = new Set(option("only", "").split(",").filter((id) => id !== ""))
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
    .filter((case_) => era === "all" || case_.era === era)
    .filter((case_) => only.size === 0 || only.has(case_.id))
    .slice(0, limit > 0 ? limit : undefined)
  const whole = only.size === 0 && limit === 0 && era === "all"

  const out = option("out", folder)
  yield* Effect.promise(() => mkdir(out, { recursive: true }))
  const results = join(out, `results-reply-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
  const writer = Bun.file(results).writer()
  const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim() || "unknown"
  const baselineFile = join(out, `reply-baseline-${sha}.jsonl`)
  const baselineWriter = whole && paths.includes("baseline") ? Bun.file(baselineFile).writer() : undefined

  const context = yield* Layer.build(Layer.provideMerge(Brain.ProviderBrain, ProviderModel))
  const model = Context.get(context, Model)
  const brain = Context.get(context, Brain.Brain)
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

  const done: Array<Result> = []
  for (const [index, case_] of chosen.entries()) {
    // Each path goes first on every other case, so the model's speed drifting over the run falls on both alike.
    const order = index % 2 === 0 ? paths : paths.toReversed()
    for (const path of order) {
      const result = path === "baseline" ? yield* baseline(case_) : yield* thinking(case_)
      if (result === undefined) continue
      done.push(result)
      writer.write(`${JSON.stringify({ ...result, expected: expected(case_, labels), logged: case_.logged, flags: case_.flags })}\n`)
      if (path === "baseline") baselineWriter?.write(`${JSON.stringify(result)}\n`)
    }
  }
  yield* Effect.promise(() => Promise.resolve(writer.end()))
  if (baselineWriter !== undefined) yield* Effect.promise(() => Promise.resolve(baselineWriter.end()))
  yield* Console.log(report(chosen, done, paths, labels))
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

const negations = /\b(don't|do not|not|never|no|leave|keep)\b/i

/** The words of a message for the agent that are in neither what he said, the agent's message nor the conversation. */
const unfounded = (case_: Case, message: string) => {
  const known = words([case_.heard, case_.update?.message ?? "", case_.update?.prompt ?? "", ...case_.lines.map(({ text }) => text)].join(" "))
  return [...words(message)].filter((word) => word.length > 4 && !known.has(word)).length
}

const report = (cases: ReadonlyArray<Case>, done: ReadonlyArray<Result>, paths: ReadonlyArray<string>, labels: typeof Labels.Type) => {
  const byId = new Map(cases.map((case_) => [case_.id, case_]))
  const lines: Array<string> = []
  const ids = (those: ReadonlyArray<Result>) => (those.length === 0 ? "none" : those.map(({ id }) => id).join(" "))
  for (const path of paths) {
    const mine = done.filter((result) => result.path === path)
    const logged = mine.filter((result) => byId.get(result.id)?.era !== "synthetic")
    lines.push(`${path}: ${mine.length} run, ${mine.filter(({ failed }) => failed !== undefined).length} failed.`)
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
    // Hard fails: what was only an answer, a dismissal or talk not meant for yapd that came to a change, a confirmed acknowledgement
    // that became a write, a logged send to another thread than the update's own.
    const hard = logged.filter((result) => {
      const case_ = byId.get(result.id)!
      if (case_.by !== "responder") return false
      const wanted = expected(case_, labels)
      const label = labels[case_.id]
      return (
        (["dismiss", "answer", "resume"].includes(String(wanted)) && changing.has(result.intent)) ||
        (label?.status === "confirmed" && label.intent === "dismiss" && changing.has(result.intent)) ||
        (wanted === "send" && result.intent === "elsewhere")
      )
    })
    // Those over a line kept whole as where he cut it off isn't known, which may be the replay's doing, like a question he hadn't heard.
    const uncut = hard.filter((result) => byId.get(result.id)!.flags.includes("cut-unknown"))
    lines.push(`  Hard fails: ${hard.length}${hard.length === 0 ? "" : `: ${ids(hard)}`}${uncut.length === 0 ? "" : `; where he cut in isn't known for ${ids(uncut)}`}.`)
    const ms = logged.filter(({ failed }) => failed === undefined).map(({ ms }) => ms)
    const model = logged.filter(({ source }) => source === "model")
    lines.push(
      `  Latency: p50 ${seconds(percentile(ms, 0.5))}, p90 ${seconds(percentile(ms, 0.9))}; with the model p50 ${seconds(percentile(model.map(({ ms }) => ms), 0.5))}, p90 ${seconds(percentile(model.map(({ ms }) => ms), 0.9))}; worked out without it ${logged.length === 0 ? "-" : `${((100 * (logged.length - model.length)) / logged.length).toFixed(0)}%`}.`,
    )
    const synthetic = mine.filter((result) => result.era === "synthetic")
    if (synthetic.length > 0) {
      const judged = synthetic.map((result) => ({ result, met: meets(byId.get(result.id)!, result) }))
      const failing = judged.filter(({ met }) => met === false).map(({ result }) => result)
      lines.push(`  Written cases: ${judged.filter(({ met }) => met === true).length} met, ${failing.length} not${failing.length === 0 ? "" : ` (${ids(failing)})`}, ${judged.filter(({ met }) => met === undefined).length} not for this path.`)
    }
    // Only to report.
    const sends = logged.filter((result) => byId.get(result.id)?.logged.intent === "send")
    lines.push(`  A question where a send was logged: ${ids(sends.filter(({ intent }) => intent === "clarify"))}.`)
    const lost = sends.filter((result) => negations.test(byId.get(result.id)!.heard) && result.message !== undefined && !negations.test(result.message))
    lines.push(`  A negation he said lost from the message: ${ids(lost)}.`)
    lines.push(`  A message with words in nothing said: ${ids(sends.filter((result) => result.message !== undefined && unfounded(byId.get(result.id)!, result.message) >= 3))}.`)
  }
  // His verdicts, and what each path made of each.
  for (const [id, label] of Object.entries(labels)) {
    const made = done.filter((result) => result.id === id).map((result) => `${result.path} ${result.intent}`)
    if (made.length > 0) lines.push(`${id} (${label.status}, ${label.intent}): ${made.join(", ")}.`)
  }
  if (paths.length === 2) {
    const both = done.filter(({ path }) => path === "baseline").flatMap((one) => {
      const other = done.find((result) => result.path === "brain" && result.id === one.id)
      return other === undefined ? [] : [[one, other] as const]
    })
    const same = both.filter(([one, other]) => one.intent === other.intent)
    const modelled = both.filter(([one, other]) => one.source === "model" && other.source === "model")
    lines.push(
      `baseline and brain: the same on ${same.length}/${both.length}; p50 ${seconds(percentile(both.map(([one]) => one.ms), 0.5))} against ${seconds(percentile(both.map(([, other]) => other.ms), 0.5))}, both with the model ${seconds(percentile(modelled.map(([one]) => one.ms), 0.5))} against ${seconds(percentile(modelled.map(([, other]) => other.ms), 0.5))} (${modelled.length}).`,
    )
  }
  return lines.join("\n")
}

const command = process.argv[2]
const chosen: Effect.Effect<void, unknown> | undefined = command === "fixture" ? fixture : command === "run" ? run : undefined
if (chosen === undefined) {
  console.error("usage: bun scripts/reply-eval.ts fixture | run [--path baseline,brain] [--era log|journal|synthetic|all] [--only ids] [--limit N] [--out folder]")
  process.exit(1)
}
// yapd's logs, like the translation of a line the model said that wasn't in English, are his: kept with the rest, never printed.
mkdirSync(folder, { recursive: true })
const toFile = Logger.replace(Logger.defaultLogger, Logger.map(Logger.logfmtLogger, (line) => appendFileSync(logsFile, `${line}\n`)))
await Effect.runPromise(Effect.flatMap(settled(), (provider) => chosen.pipe(Effect.withConfigProvider(provider))).pipe(Effect.provide(toFile)))
