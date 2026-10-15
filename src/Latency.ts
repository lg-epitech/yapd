import { Clock, Effect, Option } from "effect"
import type { Woke } from "./Audio.ts"
import { defaults } from "./Endpointer.ts"

// How long each thing yapd says takes to reach him, logged once as it starts
// to play: from what it answers, like an agent stopping, his last word or the
// press that sent a dictation, to its first sound, with how long each step on
// the way took. Plain lines with none of his words, dated, since the log's
// times aren't, so scripts/latency.ts can read a day of them back.

/** A step on the way and how long it took, in milliseconds. */
export interface Stage {
  readonly name: string
  readonly ms: number
}

/** What a line is timed from and what it took on the way so far, carried with it until it plays. */
export interface Timing {
  /** What it is, as the log groups it, like "update in full" or "dictation, model, look". */
  readonly what: string
  /** When it's timed from, by the clock. */
  readonly anchor: number
  /** What that is, as it's logged, like "its stop", "his last word" or "the press". */
  readonly from: string
  readonly stages: ReadonlyArray<Stage>
  /** When it was ready to be said, once it is: what it waited after that was its turn, or the speaker. */
  readonly ready?: number
}

/** How long before what he said comes in he stopped talking: the quiet that tells he has, 22 frames of 32 ms. */
export const quiet = (defaults.silence * 512 * 1000) / 16000

/** What it is, timed from `anchor`, with nothing on the way yet. */
export const from = (what: string, anchor: number, since: string): Timing => ({ what, anchor, from: since, stages: [] })

/** With another step. */
export const stage = (timing: Timing, name: string, ms: number): Timing => ({ ...timing, stages: [...timing.stages, { name, ms: Math.max(0, ms) }] })

const seconds = (ms: number) => (ms / 1000).toFixed(2)

const pad = (value: number) => String(value).padStart(2, "0")

/** The day, as the log dates what it measures: his own, not UTC's. */
export const day = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A measurement's date, at the end of its line. */
export const dated = (at: number) => `on ${day(at)}`

/**
 * Logs a line's first sound, now, taken to be said at `taken`: what it took
 * from its anchor, each step, what waited its turn after it was ready, and
 * the speaker, awake already or woken, how long that took and how much of it
 * the line waited on, as the audio helper says, when it does.
 */
export const played = (timing: Timing, taken: number, woke?: Effect.Effect<Option.Option<Woke>>) =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis
    const last = woke === undefined ? undefined : yield* woke
    const turn = timing.ready === undefined || taken - timing.ready < 50 ? [] : [`waited its turn ${seconds(taken - timing.ready)}`]
    // Woken once it was its turn, it's what the line waited on: before, it was awake for it already.
    const woken = last === undefined ? undefined : Option.filter(last, ({ playing }) => playing > taken)
    const speaker =
      woken === undefined
        ? []
        : Option.match(woken, {
            onNone: () => ["speaker awake"],
            onSome: ({ asked, playing }) => [`speaker woke in ${seconds(playing - asked)} and was waited on ${seconds(playing - taken)}`],
          })
    const started = Option.match(woken ?? Option.none(), { onNone: () => taken, onSome: ({ playing }) => playing })
    const steps = [...timing.stages.map(({ name, ms }) => `${name} ${seconds(ms)}`), ...turn, ...speaker, `started ${seconds(at - started)}`]
    yield* Effect.logInfo(`Latency: ${timing.what}, ${seconds(at - timing.anchor)} s from ${timing.from} to the first sound (${steps.join(", ")}) ${dated(at)}`)
  })
