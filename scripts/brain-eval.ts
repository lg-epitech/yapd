import { Database } from "bun:sqlite"
import { ConfigProvider, Console, Context, Effect, Either, Layer, Option, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
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
//     Copies T3 Code's threads, archived ones too, to view.json, reading only,
//     and writes phrases.json to edit if there's none: what was said, and a
//     piece of the title or project of the thread it was about ("" for none).
//   bun scripts/brain-eval.ts run [--runs 5] [--effort low,minimal]
//     Asks the model about each phrase, the runs times over, at each effort,
//     and says whether the gate passes: the right thread every time, no
//     question in at least four runs in five of each phrase, and a median
//     under 3.6 s. Each answer goes to results-<time>.jsonl.
//   bun scripts/brain-eval.ts probe [--runs 20]
//     Times orchestration.searchThreads, which only reads, to tell whether
//     its hits are quick enough to add to every request.

const folder = join(home, "eval")
const viewFile = join(folder, "view.json")
const phrasesFile = join(folder, "phrases.json")

/** The phrases that went wrong in the reverted attempt, and a few everyday ones, to start from. */
const logged = [
  { heard: "Can you please tell me what's the status on MiNAS SV2?", thread: "Mina SSV2" },
  { heard: "What's the status on my Tesla's migration request comparison?", thread: "Tezos" },
  { heard: "Tesla celebration comparison", thread: "Tezos" },
  { heard: "Dazzles migration", thread: "Tezos" },
  { heard: "migrate stasos", thread: "Tezos" },
  { heard: "My grades tezos.", thread: "Tezos" },
  { heard: "The most recent one with Mina.", thread: "Mina" },
  { heard: "What's going on?", thread: "" },
  { heard: "What did I miss?", thread: "" },
  { heard: "How's the yapd review going?", thread: "yapd" },
]

const Phrases = Schema.Array(Schema.Struct({ heard: Schema.String, thread: Schema.String }))
const Shell = Schema.Struct({
  projects: Schema.Array(Schema.Unknown),
  threads: Schema.Array(Schema.Unknown),
  archivedThreads: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
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
  yield* Console.log(`Kept ${shell.threads.length} threads and ${shell.archivedThreads.length} archived ones in ${viewFile}.`)
  if (!(yield* Effect.promise(() => Bun.file(phrasesFile).exists()))) {
    yield* Effect.promise(() => Bun.write(phrasesFile, JSON.stringify(logged, null, 2)))
    yield* Console.log(`Wrote ${phrasesFile}: make each "thread" a piece of the title or project of one of your threads.`)
  }
})

/** The view as T3Live keeps it, archived threads included so phrases about them can still be asked. */
const viewed = Effect.gen(function* () {
  const saved = yield* Effect.promise(() => Bun.file(viewFile).json() as Promise<unknown>)
  const shell = yield* Schema.decodeUnknown(Schema.extend(Shell, Schema.Struct({ at: Schema.Number })))(saved)
  const threads = [...shell.threads, ...shell.archivedThreads].flatMap((thread) =>
    Option.toArray(Option.map(Schema.decodeUnknownOption(T3Live.Thread)(thread), (decoded) => ({ ...decoded, archivedAt: null }))),
  )
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

/** What yapd noted of the work it started, read only. */
const startedWork = (machine: string) =>
  Effect.sync(() => {
    const database = new Database(Store.file, { readonly: true })
    try {
      return new Map(
        database
          .query<{ id: string; dictated: string | null; prompt: string | null; description: string | null; at: string }, [string]>(
            "select id, dictated, prompt, description, at from threads where machine = ? and started = 1",
          )
          .all(machine)
          .map((row) => [row.id, { dictated: row.dictated ?? row.prompt ?? "", description: row.description, at: Date.parse(row.at) || 0 }]),
      )
    } finally {
      database.close()
    }
  }).pipe(Effect.orElseSucceed(() => new Map()))

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
  const results = join(folder, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
  const writer = Bun.file(results).writer()
  yield* Console.log(`${phrases.length} phrases, ${runs} runs each, against the threads as of ${new Date(at).toLocaleString()}.`)
  let passed = true
  for (const effort of efforts) {
    const provider = yield* settled({ YAPD_EFFORT: effort })
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Brain.ProviderBrain.pipe(Layer.provide(ProviderModel)))
        const brain = Context.get(context, Brain.Brain)
        const times: Array<number> = []
        let right = 0
        let total = 0
        const quiet: Array<{ readonly heard: string; readonly asked: number }> = []
        for (const phrase of phrases) {
          let asked = 0
          for (let run = 0; run < runs; run++) {
            const now = Date.now()
            const desk: Threads.Desk = {
              threads: Threads.shortlist({ machine, view, focus: Option.none(), pending: [], most: 30, started, said: new Map(), now }),
              away: [...remotes.keys()].map((other) => ({ machine: other, reason: `I can't see ${other}'s threads yet.` })),
            }
            const situation: Brain.Situation = {
              utterance: { id: `eval-${run}`, heard: phrase.heard, via: "shortcut", at: now, voiced: 3, turns: 0 },
              subject: { _tag: "Nothing" },
              lines: [],
              open: Option.none(),
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
            const asking = checked._tag === "Ask" || decision.act === "clarify"
            const wanted = phrase.thread.toLowerCase()
            const fits =
              !asking &&
              (wanted === ""
                ? decision.target === "" || listed !== undefined
                : listed !== undefined && `${listed.thread.title} ${listed.project} ${listed.called}`.toLowerCase().includes(wanted))
            if (fits) right++
            if (asking) asked++
            const about = listed?.called ?? "no thread"
            yield* Console.log(`  ${fits ? "ok  " : "MISS"} ${seconds(ms)} ${decision.act} → ${about}, ${decision.sure}: ${phrase.heard}`)
            writer.write(`${JSON.stringify({ effort, heard: phrase.heard, run, ms, decision, thread: listed?.thread.title ?? null, fits, asking })}\n`)
          }
          quiet.push({ heard: phrase.heard, asked })
        }
        return { times, right, total, quiet }
      }),
    ).pipe(Effect.withConfigProvider(provider))
    const median = percentile(outcome.times, 0.5)
    const gate = outcome.right === outcome.total && outcome.quiet.every(({ asked }) => asked * 5 <= runs) && median <= 3600
    passed &&= gate
    yield* Console.log(
      [
        `Effort ${effort}: the right thread ${outcome.right}/${outcome.total}, median ${seconds(median)}, p90 ${seconds(percentile(outcome.times, 0.9))}.`,
        ...outcome.quiet.filter(({ asked }) => asked * 5 > runs).map(({ heard, asked }) => `  Asked or failed ${asked}/${runs} times: ${heard}`),
        `  The gate ${gate ? "passes" : "doesn't pass"}.`,
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
