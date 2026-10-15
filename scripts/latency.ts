import { createReadStream } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

// How long yapd takes to answer, read back from its log: each thing it said,
// from what it answered to its first sound, with the steps on the way, by
// period, as the M9 plan measures it. It only reads, and prints no words of
// anyone's: the log's measurement lines carry none.
//
//   bun scripts/latency.ts [--log <path>] [--split 2026-10-15,2026-10-17]
//     Reads ~/Library/Logs/yapd.log, or the log given, and prints a period
//     for each stretch between the dates given, one per deploy: the plan's
//     latency rows with n, p50 and p90 and their steps at p50, every kind
//     of line on its own, then Codex's turns by role, launches, dictations
//     and the lines rendered on a guess.

const argument = (name: string) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}
const path = argument("--log") ?? join(homedir(), "Library", "Logs", "yapd.log")
const splits = (argument("--split") ?? "").split(",").map((day) => day.trim()).filter((day) => /^\d{4}-\d\d-\d\d$/.test(day)).toSorted()

/** A line of the log, with the annotations under it. */
interface Entry {
  readonly message: string
  readonly notes: Map<string, string>
}

/** A step and how long it took, in seconds. */
interface Step {
  readonly name: string
  readonly seconds: number
}

interface Timed {
  readonly day: string
  readonly what: string
  readonly from: string
  readonly total: number
  readonly steps: ReadonlyArray<Step>
}

interface Turn {
  readonly day: string
  readonly role: string
  readonly first?: number
  readonly done?: number
  readonly pieces: number
  readonly ordered?: boolean
  readonly buffered: boolean
  readonly spare: boolean
}

const timed: Array<Timed> = []
const turns: Array<Turn> = []
const launches: Array<{ readonly day: string; readonly seconds: number; readonly polls: number }> = []
const dictations: Array<{ readonly day: string; readonly heard: number; readonly first: boolean; readonly gap?: number; readonly speech: number }> = []
const guesses: Array<{ readonly day: string; readonly how: "guessed" | "used" | "missed" | "skipped" }> = []

const header = /^\[\d\d:\d\d:\d\d\.\d{3}\] [A-Z]+ \(#\d+\): (.*)$/
const note = /^ {2}([A-Za-z]+): (.*)$/
const dateAtEnd = / on (\d{4}-\d\d-\d\d)$/

/** The steps of a Latency line, the speaker's split in two: how long it took to wake, and how much of that the line waited on. */
const stepsOf = (text: string): Array<Step> =>
  text.split(", ").flatMap((step): Array<Step> => {
    const woke = /^speaker woke in ([\d.]+) and was waited on ([\d.]+)$/.exec(step)
    if (woke !== null) return [{ name: "speaker woke", seconds: Number(woke[1]) }, { name: "speaker waited", seconds: Number(woke[2]) }]
    if (step === "speaker awake") return [{ name: "speaker waited", seconds: 0 }]
    const plain = /^(.*) ([\d.]+)$/.exec(step)
    return plain === null ? [] : [{ name: plain[1]!, seconds: Number(plain[2]) }]
  })

/** The day of an undated line: that of the last dated one before it. */
let lastDay: string | undefined

const take = (entry: Entry) => {
  const { message } = entry
  const dated = dateAtEnd.exec(message)
  if (dated !== null) lastDay = dated[1]!
  const day = dated?.[1] ?? lastDay
  if (day === undefined) return
  const latency = /^Latency: (.+), ([\d.]+) s from (.+?) to the first sound \((.*)\) on \d{4}-\d\d-\d\d$/.exec(message)
  if (latency !== null) {
    timed.push({ day, what: latency[1]!, total: Number(latency[2]), from: latency[3]!, steps: stepsOf(latency[4]!) })
    return
  }
  if (message.startsWith("Codex turn: ")) {
    const seconds = (pattern: RegExp) => {
      const found = pattern.exec(message)
      return found === null ? undefined : Number(found[1])
    }
    turns.push({
      day,
      role: entry.notes.get("role") ?? "unknown",
      ...(seconds(/first text ([\d.]+) s/) === undefined ? {} : { first: seconds(/first text ([\d.]+) s/)! }),
      ...(seconds(/done ([\d.]+) s/) === undefined ? {} : { done: seconds(/done ([\d.]+) s/)! }),
      pieces: seconds(/(\d+) pieces?/) ?? 0,
      ...(message.includes("keys in order") ? { ordered: true } : message.includes("keys out of order") ? { ordered: false } : {}),
      buffered: message.includes("safety buffering"),
      spare: message.includes("spare thread"),
    })
    return
  }
  const launched = /^Launched in ([\d.]+) s after (\d+) polls?/.exec(message)
  if (launched !== null) {
    launches.push({ day, seconds: Number(launched[1]), polls: Number(launched[2]) })
    return
  }
  const dictation = /^Dictation: \d+ windows?, ([\d.]+) s of speech, (?:([\d.]+) s from the last word to the press|no word), heard in ([\d.]+) s/.exec(message)
  if (dictation !== null) {
    dictations.push({
      day,
      speech: Number(dictation[1]),
      ...(dictation[2] === undefined ? {} : { gap: Number(dictation[2]) }),
      heard: Number(dictation[3]),
      first: message.includes("first since load"),
    })
    return
  }
  if (message.startsWith("Render: guessed and missed")) guesses.push({ day, how: "missed" })
  else if (message.startsWith("Render: guessed,")) guesses.push({ day, how: "guessed" })
  else if (message.startsWith("Render: guess skipped")) guesses.push({ day, how: "skipped" })
  else if (message.startsWith("Render: ") && message.endsWith("guessed and used")) guesses.push({ day, how: "used" })
}

let current: Entry | undefined
for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY })) {
  const started = header.exec(line)
  if (started !== null) {
    if (current !== undefined) take(current)
    current = { message: started[1]!, notes: new Map() }
    continue
  }
  const noted = note.exec(line)
  if (noted !== null && current !== undefined) current.notes.set(noted[1]!, noted[2]!)
}
if (current !== undefined) take(current)

/** The value at `fraction` of the way through, nearest rank. */
const quantile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = values.toSorted((one, other) => one - other)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]
}
const shown = (value: number | undefined) => (value === undefined ? "  -  " : value.toFixed(2).padStart(5))

/** The plan's rows, by what each line is. Starts are told apart by machine and worktree as the log names them. */
const rows: ReadonlyArray<readonly [string, (what: string) => boolean]> = [
  ["Fast reply that acts over an update", (what) => /^reply over an update, fast, (send|mute)$/.test(what)],
  ["Fast reply that only says (\"more\")", (what) => /^reply over an update, fast, (answer|again)$/.test(what)],
  ["Fast answer to a question", (what) => /^reply, fast, (reply|decide)$/.test(what)],
  ["Fast dictation", (what) => /^dictation, fast, /.test(what) && !what.endsWith("meanwhile")],
  ["Model write by reply", (what) => /^reply( over an update)?, model, send$/.test(what)],
  ["Model answer by reply", (what) => /^reply( over an update)?, model, answer$/.test(what)],
  ["Status by dictation", (what) => what === "dictation, model, answer"],
  ["Look (two Brain calls)", (what) => what === "dictation, model, look"],
  ["Start by dictation", (what) => /^dictation, model, start on /.test(what)],
  ["Agent stops, brief", (what) => what === "update brief"],
  ["Agent stops, in full", (what) => what === "update in full"],
]

/** A row: n, p50 and p90 of the total, and each step at p50. */
const row = (name: string, lines: ReadonlyArray<Timed>) => {
  const totals = lines.map(({ total }) => total)
  const names = [...new Set(lines.flatMap(({ steps }) => steps.map(({ name }) => name)))]
  const steps = names.map((step) => `${step} ${quantile(lines.flatMap(({ steps }) => steps.filter(({ name }) => name === step).map(({ seconds }) => seconds)), 0.5)?.toFixed(2)}`)
  console.log(`  ${name.padEnd(44)} ${String(lines.length).padStart(4)} ${shown(quantile(totals, 0.5))} ${shown(quantile(totals, 0.9))}  ${steps.join(", ")}`)
}

const periods = [...splits.map((day, index) => ({ from: splits[index - 1], to: day })), { from: splits.at(-1), to: undefined }]
for (const { from, to } of periods) {
  const within = (day: string) => (from === undefined || day >= from) && (to === undefined || day < to)
  const lines = timed.filter(({ day }) => within(day))
  console.log(`\n${from ?? "start"} to ${to ?? "now"}: ${lines.length} lines timed, in seconds (n, p50, p90, steps at p50)`)
  for (const [name, matches] of rows) {
    const matched = lines.filter(({ what }) => matches(what))
    if (matched.length > 0) row(name, matched)
  }
  // Starts, by machine and worktree, which the plan's rows tell apart.
  for (const what of [...new Set(lines.map(({ what }) => what).filter((what) => what.startsWith("dictation, model, start on ")))].toSorted()) {
    row(`  ${what.replace("dictation, model, ", "")}`, lines.filter((line) => line.what === what))
  }
  console.log("\n  Every kind of line:")
  for (const what of [...new Set(lines.map(({ what }) => what))].toSorted()) row(what, lines.filter((line) => line.what === what))

  const codex = turns.filter(({ day }) => within(day))
  if (codex.length > 0) {
    console.log("\n  Codex turns by role (n, first text p50/p90, done p50/p90, pieces p50, keys in order, safety buffering, spare):")
    for (const role of [...new Set(codex.map(({ role }) => role))].toSorted()) {
      const of = codex.filter((turn) => turn.role === role)
      const firsts = of.flatMap(({ first }) => (first === undefined ? [] : [first]))
      const dones = of.flatMap(({ done }) => (done === undefined ? [] : [done]))
      console.log(
        `  ${role.padEnd(12)} ${String(of.length).padStart(4)} ${shown(quantile(firsts, 0.5))}/${shown(quantile(firsts, 0.9))} ${shown(quantile(dones, 0.5))}/${shown(quantile(dones, 0.9))} ${String(quantile(of.map(({ pieces }) => pieces), 0.5) ?? 0).padStart(5)}  ${of.filter(({ ordered }) => ordered === true).length}/${of.filter(({ ordered }) => ordered !== undefined).length}  ${of.filter(({ buffered }) => buffered).length}  ${of.filter(({ spare }) => spare).length}`,
      )
    }
  }
  const launched = launches.filter(({ day }) => within(day))
  if (launched.length > 0) {
    const seconds = launched.map(({ seconds }) => seconds)
    console.log(`\n  Launches: ${launched.length}, p50 ${shown(quantile(seconds, 0.5))} s, p90 ${shown(quantile(seconds, 0.9))} s, polls p50 ${quantile(launched.map(({ polls }) => polls), 0.5)}`)
  }
  const dictated = dictations.filter(({ day }) => within(day))
  if (dictated.length > 0) {
    const heard = (of: ReadonlyArray<(typeof dictations)[number]>) => of.map(({ heard }) => heard)
    const first = dictated.filter(({ first }) => first)
    const later = dictated.filter(({ first }) => !first)
    console.log(
      `\n  Dictations: ${dictated.length}, heard in p50 ${shown(quantile(heard(dictated), 0.5))} s; first since load ${first.length} at p50 ${shown(quantile(heard(first), 0.5))} s, later ${later.length} at p50 ${shown(quantile(heard(later), 0.5))} s; last word to the press p50 ${shown(quantile(dictated.flatMap(({ gap }) => (gap === undefined ? [] : [gap])), 0.5))} s`,
    )
  }
  const guessed = guesses.filter(({ day }) => within(day))
  if (guessed.length > 0) {
    const count = (how: (typeof guesses)[number]["how"]) => guessed.filter((guess) => guess.how === how).length
    console.log(`\n  Lines rendered on a guess: ${count("guessed")}, used ${count("used")}, missed ${count("missed")}, skipped for another ${count("skipped")}`)
  }
}
