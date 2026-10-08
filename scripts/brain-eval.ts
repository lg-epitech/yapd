import { Database } from "bun:sqlite"
import { ConfigProvider, Console, Context, Effect, Either, Layer, Option, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import type * as Assistant from "../src/Assistant.ts"
import * as Brain from "../src/Brain.ts"
import * as Config from "../src/Config.ts"
import { home, settings } from "../src/Home.ts"
import { ProviderModel } from "../src/Model.ts"
import * as Persona from "../src/Persona.ts"
import * as Store from "../src/Store.ts"
import * as T3Actions from "../src/T3Actions.ts"
import * as T3CodeServer from "../src/T3CodeServer.ts"
import * as T3Live from "../src/T3Live.ts"
import * as Threads from "../src/Threads.ts"

// How well the brain picks the thread the user means, and how fast, asked of
// the live model with a copy of their own threads, the way the daemon asks it.
// It's never loaded by the daemon. What it reads and writes stays under
// ~/.yapd/eval/, since it's the user's own work and isn't to be committed.
//
//   bun scripts/brain-eval.ts fixture
//     Copies T3 Code's threads to view.json, reading only, the ones it's
//     working on as the daemon follows them, and writes phrases.json to edit
//     if there's none: what was said, a piece of the title or project of the
//     thread it was about ("" for none), what it should come to when that's
//     what matters, like "start" for new work that names a thread, and, for an
//     answer to a question yapd asked, the request it was about, a piece of
//     each thread it offered, and whether it was said over the question
//     rather than dictated.
//   bun scripts/brain-eval.ts run [--runs 5] [--effort low,minimal]
//     Searches the threads for each phrase as the daemon does, reading only,
//     then asks the model about it, the runs times over, at each effort, and
//     says whether the gate passes at the first effort, the others being only
//     to compare: the right thread every time, as its pick even when it asks,
//     an answer to its question taken as one and settling it, no question in
//     at least four runs in five of each phrase, and a median under 3.6 s.
//     Each answer goes to results-<time>.jsonl.
//   bun scripts/brain-eval.ts probe [--runs 20]
//     Times orchestration.searchThreads, which only reads, to tell whether
//     its hits are quick enough to add to every request.

const folder = join(home, "eval")
const viewFile = join(folder, "view.json")
const phrasesFile = join(folder, "phrases.json")

/** The question yapd asked in the log about each request, by the threads it offered. */
const mina = { request: "Can you please tell me what's the status on MiNAS SV2?", choices: ["Mina SSV2", "Tezos"] }
const tezos = { request: "What's the status on my Tesla's migration request comparison?", choices: ["Tezos", "Mina SSV2"] }

/** The phrases that went wrong in the reverted attempt, the answers he gave its questions, and a few everyday ones, to start from. */
const logged = [
  { heard: "Can you please tell me what's the status on MiNAS SV2?", thread: "Mina SSV2" },
  { heard: "What's the status on my Tesla's migration request comparison?", thread: "Tezos" },
  // Said over the question it asked about that one, as they were in the log.
  { heard: "Tesla celebration comparison", thread: "Tezos", open: tezos, via: "reply" },
  { heard: "Dazzles migration", thread: "Tezos", open: tezos, via: "reply" },
  { heard: "migrate stasos", thread: "Tezos", open: tezos, via: "reply" },
  { heard: "My grades tezos.", thread: "Tezos", open: tezos, via: "reply" },
  // Said over the question, then over it asked again; "Migrate Tezos." was dictated while it was open.
  { heard: "The recent one with mean migrations.", thread: "Mina SSV2", open: mina, via: "reply" },
  { heard: "The most recent one with Mina.", thread: "Mina SSV2", open: mina, via: "reply" },
  { heard: "Migrate Tezos.", thread: "Tezos", open: tezos },
  { heard: "What's going on?", thread: "", act: "answer" },
  { heard: "What did I miss?", thread: "", act: "answer" },
  { heard: "How's the yapd review going?", thread: "yapd" },
  // 21:39: new work that names an existing thread, which is to be started, not sent to it.
  {
    heard:
      "Can you please go and look at what I did for the migration process for Mina and start another thread in integration on the main worktree to start working on the migration for Tezos, so I have a ticket open for that as well in my linear.",
    thread: "",
    act: "start",
    said: "2026-10-01T01:39:00.000Z",
  },
]

const Phrases = Schema.Array(
  Schema.Struct({
    heard: Schema.String,
    thread: Schema.String,
    act: Schema.optional(Brain.Act),
    open: Schema.optional(Schema.Struct({ request: Schema.String, choices: Schema.Array(Schema.String) })),
    /** Said over the question rather than dictated by the shortcut. */
    via: Schema.optional(Schema.Literal("shortcut", "reply")),
    /** When it was said, as ISO 8601: threads made after it, like the one it started, weren't there to be meant. */
    said: Schema.optional(Schema.String),
  }),
)
const Shell = Schema.Struct({
  projects: Schema.Array(Schema.Unknown),
  threads: Schema.Array(Schema.Unknown),
})

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

const token = Effect.flatMap(Config.t3codeToken, Option.match({ onNone: () => Effect.dieMessage("Set YAPD_T3CODE_TOKEN in ~/.yapd/.env first."), onSome: Effect.succeed }))

const fixture = Effect.gen(function* () {
  const transport = yield* T3CodeServer.connect(yield* token)
  const shell = yield* transport.api("/api/orchestration/shell", Shell)
  yield* Effect.promise(() => mkdir(folder, { recursive: true }))
  yield* Effect.promise(() => Bun.write(viewFile, JSON.stringify({ at: Date.now(), ...shell }, null, 2)))
  yield* Console.log(`Kept ${shell.threads.length} threads in ${viewFile}.`)
  if (!(yield* Effect.promise(() => Bun.file(phrasesFile).exists()))) {
    yield* Effect.promise(() => Bun.write(phrasesFile, JSON.stringify(logged, null, 2)))
    yield* Console.log(`Wrote ${phrasesFile}: make each "thread" a piece of the title or project of one of your threads.`)
  }
})

/** The view as T3Live keeps it. */
const viewed = Effect.gen(function* () {
  const saved = yield* Effect.promise(() => Bun.file(viewFile).json() as Promise<unknown>)
  const shell = yield* Schema.decodeUnknown(Schema.extend(Shell, Schema.Struct({ at: Schema.Number })))(saved)
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

interface Started {
  readonly dictated: string
  readonly description: string | null
  readonly at: number
}

/** What yapd noted of the work it started, read only, or nothing when there's no database to read. */
const startedWork = (machine: string) =>
  Effect.try({
    try: () => {
      const database = new Database(Store.file, { readonly: true })
      try {
        return new Map(
          database
            .query<{ id: string; dictated: string | null; prompt: string | null; description: string | null; at: string }, [string]>(
              "select id, dictated, prompt, description, at from threads where machine = ? and started = 1",
            )
            .all(machine)
            .map((row): [string, Started] => [row.id, { dictated: row.dictated ?? row.prompt ?? "", description: row.description, at: Date.parse(row.at) || 0 }]),
        )
      } finally {
        database.close()
      }
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) => Console.log(`Going without the work yapd started, since its database can't be read: ${String(cause)}`).pipe(Effect.as(new Map<string, Started>()))),
  )

/**
 * What a search of the threads adds to the desk for each phrase, as the daemon
 * searches them, reading only. Nothing for any phrase without a token.
 */
const searchedFor = (phrases: ReadonlyArray<{ readonly heard: string }>, machine: string) =>
  Effect.gen(function* () {
    const token = yield* Config.t3codeToken
    if (Option.isNone(token)) {
      yield* Console.log("No T3 Code token, so the desk goes without what a search would add.")
      return new Map<string, ReadonlyArray<Threads.Ref>>()
    }
    const actions = T3Actions.make(T3CodeServer.connect(token.value))
    const search: Threads.Search<string> = (words) =>
      actions.search(words).pipe(
        Effect.map((matches) => matches.map(({ threadId, snippet }) => ({ ref: { machine, id: threadId }, snippet }))),
        Effect.mapError(T3Actions.reason),
      )
    const found = yield* Effect.forEach(phrases, ({ heard }) =>
      Threads.searched(heard, search).pipe(
        Effect.catchAll((reason) => Console.log(`Couldn't search for "${heard}": ${reason}`).pipe(Effect.as<ReadonlyArray<Threads.Ref>>([]))),
        Effect.map((refs) => [heard, refs] as const),
      ),
    )
    return new Map(found)
  })

const percentile = (values: ReadonlyArray<number>, at: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? Number.NaN
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`

const run = Effect.gen(function* () {
  const runs = Number(option("runs", "5"))
  const efforts = option("effort", "low").split(",").filter((effort) => effort !== "")
  const phrases = yield* Effect.promise(() => Bun.file(phrasesFile).json() as Promise<unknown>).pipe(Effect.flatMap(Schema.decodeUnknown(Phrases)))
  const { at, view } = yield* viewed
  const machine = Option.getOrElse(yield* Config.name, () => hostname().split(".")[0] ?? hostname())
  const remotes = yield* Config.remotes
  const started = yield* startedWork(machine)
  const found = yield* searchedFor(phrases, machine)
  const results = join(folder, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
  const writer = Bun.file(results).writer()
  yield* Console.log(`${phrases.length} phrases, ${runs} runs each, against the threads as of ${new Date(at).toLocaleString()}.`)
  let passed = true
  for (const [index, effort] of efforts.entries()) {
    const provider = yield* settled({ YAPD_EFFORT: effort })
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Brain.ProviderBrain.pipe(Layer.provide(ProviderModel)))
        const brain = Context.get(context, Brain.Brain)
        const times: Array<number> = []
        let correct = 0
        let total = 0
        const quiet: Array<{ readonly heard: string; readonly asked: number }> = []
        const away = [...remotes.keys()].map((other) => ({ machine: other, reason: `I can't see ${other}'s threads yet.` }))
        const fits = (listed: Threads.Listed | undefined, piece: string) =>
          listed !== undefined && `${listed.thread.title} ${listed.project} ${listed.called}`.toLowerCase().includes(piece.toLowerCase())
        for (const phrase of phrases) {
          let asked = 0
          // Over the question, it's taken as a reply is: about the question, on a smaller desk, with no search.
          const reply = phrase.via === "reply" && phrase.open !== undefined
          for (let run = 0; run < runs; run++) {
            const now = Date.now()
            // Only the threads there were when it was said.
            const before = phrase.said === undefined ? undefined : Date.parse(phrase.said)
            const then: T3Live.View =
              before === undefined
                ? view
                : { ...view, threads: new Map([...view.threads].filter(([, thread]) => Date.parse(thread.createdAt) < before)) }
            const shortlist = (pending: ReadonlyArray<Threads.Ref>, most: number, more = 0) =>
              Threads.shortlist({ machine, view: then, focus: Option.none(), pending, found: reply ? [] : (found.get(phrase.heard) ?? []), heard: phrase.heard, most, more, started, said: new Map(), now })
            // The threads it offered, first in the order it offered them, as when it asked.
            const every = shortlist([], view.threads.size)
            const offered = (phrase.open?.choices ?? []).flatMap((piece) => Option.toArray(Option.fromNullable(every.find((listed) => fits(listed, piece)))))
            // As the daemon's desk: the likeliest in full, then the rest of the month's by name.
            const desk: Threads.Desk = { threads: shortlist(offered.map(({ ref }) => ref), reply ? 12 : 30, 120), away }
            const choices = desk.threads.slice(0, offered.length)
            const open = Option.map(Option.fromNullable(phrase.open), ({ request }): Assistant.Open => ({
              id: "eval-open",
              version: 1,
              kind: "which",
              utterance: "eval-request",
              heard: request,
              decision: Brain.decision({ act: "answer", target: "t1", sure: "low", others: choices.slice(1).map(({ handle }) => handle).join(", ") }),
              candidates: choices.map(({ ref }) => ref),
              asked: Brain.which(choices, Persona.plain, []) ?? "",
              about: Brain.choices(choices),
              at: now - 20_000,
              material: Option.none(),
              resend: Option.none(),
            }))
            const question = Option.match(open, { onNone: () => "", onSome: ({ asked }) => asked })
            const situation: Brain.Situation = {
              utterance: { id: `eval-${run}`, heard: phrase.heard, via: reply ? "reply" : "shortcut", at: now, voiced: 3, turns: 0 },
              subject: reply ? { _tag: "Answer", said: question, about: Option.none() } : { _tag: "Nothing" },
              lines: reply ? [{ speaker: "yapd", text: question }] : [],
              open,
              desk,
              lately: [],
              unheard: [],
              usage: Option.none(),
              second: Option.none(),
              asked: [],
              now,
            }
            const began = Date.now()
            const decided = yield* Effect.either(brain.decide(situation))
            const ms = Date.now() - began
            times.push(ms)
            total++
            if (Either.isLeft(decided)) {
              yield* Console.log(`  ${phrase.heard}: the model failed after ${seconds(ms)}`)
              writer.write(`${JSON.stringify({ effort, heard: phrase.heard, run, ms, failed: String(decided.left.cause) })}\n`)
              asked++
              continue
            }
            const decision = decided.right
            const listed = desk.threads.find(({ handle }) => handle === decision.target)
            const checked = Brain.check(decision, situation, Persona.plain)
            // Its likeliest thread counts even when it asks, which is held to the four in five instead.
            const asking = checked._tag === "Ask" || decision.act === "clarify"
            // An answer to the question has to be taken as one, never as new work, and settle it: yapd leaves a request it would have to ask about twice.
            const answering = Option.isNone(open) || (decision.pending === "answers" && decision.act !== "start" && !asking)
            const right =
              answering &&
              (phrase.act !== undefined
                ? decision.act === phrase.act
                : phrase.thread === ""
                  ? decision.target === "" || listed !== undefined
                  : fits(listed, phrase.thread))
            if (right) correct++
            if (asking) asked++
            const about = listed?.called ?? "no thread"
            yield* Console.log(`  ${right ? "ok  " : "MISS"} ${seconds(ms)} ${decision.act} → ${about}, ${decision.sure}${asking ? ", asked" : ""}: ${phrase.heard}`)
            writer.write(`${JSON.stringify({ effort, heard: phrase.heard, run, ms, decision, thread: listed?.thread.title ?? null, right, asking })}\n`)
          }
          quiet.push({ heard: phrase.heard, asked })
        }
        return { times, right: correct, total, quiet }
      }),
    ).pipe(Effect.withConfigProvider(provider))
    const median = percentile(outcome.times, 0.5)
    const gate = outcome.right === outcome.total && outcome.quiet.every(({ asked }) => asked * 5 <= runs) && median <= 3600
    // Only the first effort is gated: the others are there to compare it with.
    if (index === 0) passed = gate
    yield* Console.log(
      [
        `Effort ${effort}: the right thread ${outcome.right}/${outcome.total}, median ${seconds(median)}, p90 ${seconds(percentile(outcome.times, 0.9))}.`,
        ...outcome.quiet.filter(({ asked }) => asked * 5 > runs).map(({ heard, asked }) => `  Asked or failed ${asked}/${runs} times: ${heard}`),
        `  The gate ${gate ? "passes" : "doesn't pass"}${index === 0 ? "" : ", which is only for comparison"}.`,
      ].join("\n"),
    )
  }
  yield* Effect.promise(() => Promise.resolve(writer.end()))
  yield* Console.log(`Every answer is in ${results}.`)
  if (!passed) process.exitCode = 1
})

const probe = Effect.gen(function* () {
  const runs = Number(option("runs", "20"))
  const actions = T3Actions.make(T3CodeServer.connect(yield* token))
  const queries = ["Tezos", "Mina", "migration", "yapd review", "transcription upload"]
  const times: Array<number> = []
  for (let run = 0; run < runs; run++) {
    for (const query of queries) {
      const began = performance.now()
      const found = yield* Effect.either(actions.search(query))
      times.push(performance.now() - began)
      if (Either.isLeft(found)) return yield* Console.log(`Searching failed: ${T3Actions.reason(found.left)}`)
    }
  }
  const p90 = percentile(times, 0.9)
  yield* Console.log(
    `searchThreads, ${times.length} searches: median ${percentile(times, 0.5).toFixed(0)} ms, p90 ${p90.toFixed(0)} ms. ${
      p90 < 100 ? "Quick enough to add its hits to every request." : "Too slow to add to every request: find stays the way to search."
    }`,
  )
})

const command = process.argv[2]
const chosen: Effect.Effect<void, unknown> | undefined =
  command === "fixture" ? fixture : command === "run" ? run : command === "probe" ? probe : undefined
if (chosen === undefined) {
  console.error("usage: bun scripts/brain-eval.ts fixture | run [--runs 5] [--effort low,minimal] | probe [--runs 20]")
  process.exit(1)
}
await Effect.runPromise(Effect.flatMap(settled(), (provider) => chosen.pipe(Effect.withConfigProvider(provider))))
