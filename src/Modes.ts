import { Clock, type Duration, Effect, FiberHandle, Option, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import type { Journal, Kept } from "./Journal.ts"
import type * as Settings from "./Settings.ts"

// How yapd talks of its own accord: normal, or focus and quiet, which hold for
// later whatever a mute would keep quiet, so what needs him and the answer to
// his own message still come through; and whether updates are said in their
// headline, with the rest kept for "more", or in full. Both are kept across
// restarts. While it's on and the mode is normal, what was held as progress is
// brought up in a short digest once things have been quiet a while.

/** The modes that hold what doesn't need him for later. */
export type Hold = "focus" | "quiet"

/** How much of an update is said: its headline, or everything. */
export type Detail = "brief" | "full"

/** The mode, when it ends on its own, and when what it holds began to be held. */
export interface Mode {
  readonly mode: "normal" | Hold
  readonly until?: number
  readonly since?: number
}

export interface State {
  readonly mode: Mode
  readonly detail: Detail
}

const Stored = Schema.parseJson(
  Schema.Struct({
    mode: Schema.Literal("normal", "focus", "quiet"),
    until: Schema.optionalWith(Schema.Number, { exact: true }),
    since: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
)
const stored = Schema.decodeUnknownOption(Stored)

/** How long focus lasts when he doesn't say. */
export const focusing = 60 * 60_000

/** The furthest off a mode can be set to end: a day. */
export const furthest = 24 * 60 * 60_000

/** The next 8:00 in the morning, yapd's time, when quiet ends unless he says. */
export const morning = (now: number) => {
  const at = new Date(now)
  at.setHours(8, 0, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** When a mode set now ends: when he said, if that's to come within a day, or else an hour on for focus and the next morning for quiet. */
export const ending = (mode: Hold, until: number | undefined, now: number) =>
  until !== undefined && until > now && until - now <= furthest ? until : mode === "focus" ? now + focusing : morning(now)

/** When the digest comes, and what it waits for. */
export const digesting = {
  /** At most this often. */
  every: 20 * 60_000,
  /** After this long with nothing said, waiting or being dictated. */
  quiet: 60_000,
  /** Once this many are held, */
  enough: 3,
  /** or once the oldest has waited this long, so a result taken for progress is never stuck. */
  oldest: 20 * 60_000,
  /** How far back what's held counts. */
  window: 12 * 60 * 60_000,
  /** How often it's looked at. */
  look: "15 seconds",
} as const

/** Whether a mode holds now: focus or quiet, until it ends. */
const holds = (mode: Mode, now: number): Option.Option<Hold> =>
  mode.mode !== "normal" && (mode.until === undefined || mode.until > now) ? Option.some(mode.mode) : Option.none()

export interface Modes {
  readonly current: Effect.Effect<State>
  /** The state, then each time it changes. */
  readonly changes: Stream.Stream<State>
  /** Focus or quiet, while one holds. */
  readonly holding: Effect.Effect<Option.Option<Hold>>
  readonly detail: Effect.Effect<Detail>
  /** Changes the mode, ending at `until` if it's to come within a day, or else when its default says, and gives what it was. */
  readonly set: (mode: Mode["mode"], until?: number) => Effect.Effect<{ readonly was: Mode; readonly now: Mode }>
  readonly setDetail: (detail: Detail) => Effect.Effect<void>
  /** When he was last briefed on what was held, which the digest counts from. */
  readonly briefedAt: Effect.Effect<number>
  /** He was briefed on what was held until `at`, or offered it, just now when not said: never earlier than before. */
  readonly briefed: (at?: number) => Effect.Effect<void>
}

/** The modes, as `settings` kept them, each change noted in `journal`. */
export const make = (options: { readonly settings: Settings.Settings["Type"]; readonly journal: Journal["Type"] }) =>
  Effect.gen(function* () {
    const { settings, journal } = options
    /** What was kept under `name`, or none when it can't be read, which is only logged. */
    const read = (name: string) =>
      settings.read(name).pipe(Effect.catchAll((error) => Effect.as(Effect.logWarning(`Could not read my ${name} setting`, error), Option.none<string>())))
    const keep = (name: string, value: string) => settings.write(name, value).pipe(Effect.catchAll((error) => Effect.logWarning(`Could not keep my ${name} setting`, error)))
    const number = (value: Option.Option<string>) => Option.filter(Option.map(value, Number), Number.isFinite)
    const mode = Option.getOrElse(Option.flatMap(yield* read("mode"), stored), (): Mode => ({ mode: "normal" }))
    const detail: Detail = Option.getOrUndefined(yield* read("detail")) === "full" ? "full" : "brief"
    let briefedAt = Option.getOrElse(number(yield* read("briefedAt")), () => 0)
    const state = yield* SubscriptionRef.make<State>({ mode, detail })
    const current = SubscriptionRef.get(state)
    const modes: Modes = {
      current,
      changes: state.changes,
      holding: Effect.flatMap(current, ({ mode }) => Effect.map(Clock.currentTimeMillis, (now) => holds(mode, now))),
      detail: Effect.map(current, ({ detail }) => detail),
      set: (mode, until) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const was = (yield* current).mode
          // Going from focus to quiet, what was held during focus is still held, for the rundown once quiet ends.
          const next: Mode = mode === "normal" ? { mode } : { mode, until: ending(mode, until, now), since: Option.isSome(holds(was, now)) ? (was.since ?? now) : now }
          yield* SubscriptionRef.update(state, (before) => ({ ...before, mode: next }))
          yield* keep("mode", JSON.stringify(next))
          yield* journal.write({ at: now, kind: "action", detail: { mode: next.mode, ...(next.until === undefined ? {} : { until: next.until }) } })
          yield* Effect.logInfo(next.mode === "normal" ? "Back to normal" : `${next.mode === "focus" ? "Focus" : "Quiet"} until ${new Date(next.until ?? now).toISOString()}`)
          return { was, now: next }
        }),
      setDetail: (detail) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(state, (before) => ({ ...before, detail }))
          yield* keep("detail", detail)
          yield* journal.write({ at: yield* Clock.currentTimeMillis, kind: "action", detail: { detail } })
        }),
      briefedAt: Effect.sync(() => briefedAt),
      briefed: (at) =>
        Effect.flatMap(at === undefined ? Clock.currentTimeMillis : Effect.succeed(at), (at) =>
          at <= briefedAt
            ? Effect.void
            : Effect.zipRight(
                Effect.sync(() => {
                  briefedAt = at
                }),
                keep("briefedAt", String(at)),
              ),
        ),
    }
    return modes
  })

/** What the runner needs of the rest of yapd. */
export interface Running {
  readonly journal: Journal["Type"]
  readonly power: Effect.Effect<{ readonly on: boolean; readonly turns: number }>
  /** How long it's been quiet, in ms: none while anything is being said, waits to be, or he's dictating. */
  readonly idle: Effect.Effect<Option.Option<number>>
  /** Holds what waits to be said that a mute could keep quiet, as focus or quiet begins. */
  readonly hold: (why: Hold) => Effect.Effect<void>
  /** Briefs him on what was held, as a digest, of what was held until `at`: once it's said, through `briefed`, as it may never be. */
  readonly digest: (rows: ReadonlyArray<Kept>, at: number) => Effect.Effect<void>
  /** Offers him the rundown of what was held while focus or quiet was on, once. */
  readonly rundown: (count: number, was: Hold) => Effect.Effect<void>
}

/**
 * Runs the modes for as long as the scope lasts: holds what waits as focus or
 * quiet begins, ends either when its time is up, and brings up the digest, looked at every `look`. Gives back what ends a mode
 * as the menu does, which offers the rundown, as its time running out does.
 */
export const run = (modes: Modes, running: Running, look: Duration.DurationInput = digesting.look) =>
  Effect.gen(function* () {
    const { journal } = running
    const scope = yield* Effect.scope
    const expiry = yield* FiberHandle.make()
    /** When a digest was last brought up, said or not, so a model that's down isn't asked every few seconds. */
    let tried = 0

    /**
     * A mode ended other than by "I'm back": the rundown is offered, once,
     * when anything was held since it began and yapd is on, never counting
     * what came in while it was off. Off, it ends without a word, and what
     * was held waits for a catch-up.
     */
    const leave = (was: Mode) =>
      Effect.gen(function* () {
        if (was.mode === "normal") return
        const { on } = yield* running.power
        if (!on) return
        const held = yield* journal.held(was.since ?? 0, 200, { except: ["off"] })
        if (held.length === 0) return
        // What he's offered isn't brought up by the digest as well.
        yield* modes.briefed()
        yield* running.rundown(held.length, was.mode)
      })

    /** Ends the mode once its time is up, unless it changed since. */
    const expire = (mode: Mode) =>
      Effect.gen(function* () {
        const now = (yield* modes.current).mode
        if (now.mode !== mode.mode || now.until !== mode.until) return
        const { was } = yield* modes.set("normal")
        yield* leave(was)
      })

    /** Each time the mode changes: focus or quiet holds what waits, and ends on its own when its time is up. */
    const follow = (mode: Mode) =>
      Effect.gen(function* () {
        if (mode.mode === "normal") return yield* FiberHandle.clear(expiry)
        yield* running.hold(mode.mode)
        const now = yield* Clock.currentTimeMillis
        const left = Math.max(0, (mode.until ?? now) - now)
        // Ended on its own apart from the wait, so going back to normal, which stops the wait, never stops it halfway.
        yield* FiberHandle.run(expiry, Effect.zipRight(Effect.sleep(left), Effect.forkIn(expire(mode), scope)))
      })

    /**
     * Brings up what was held, once it's been quiet a minute and enough waits,
     * at most every twenty minutes, never in focus or quiet, and never what
     * came in while yapd was off, which is for a catch-up.
     */
    const digest = Effect.gen(function* () {
      if (!(yield* running.power).on) return
      const { mode } = yield* modes.current
      if (mode.mode !== "normal") return
      const now = yield* Clock.currentTimeMillis
      const briefedAt = yield* modes.briefedAt
      if (now - Math.max(briefedAt, tried) < digesting.every) return
      const idle = yield* running.idle
      if (Option.isNone(idle) || idle.value < digesting.quiet) return
      const held = yield* journal.held(Math.max(briefedAt, now - digesting.window), 200, { except: ["off"] })
      const oldest = held[0]
      if (oldest === undefined || (held.length < digesting.enough && now - oldest.at < digesting.oldest)) return
      // Spaced from now, whether or not it's said; but what it covers counts as told only once it is, so what a digest that failed, or
      // that focus began ahead of, would have said comes up in the next.
      tried = now
      yield* running.digest(held, now)
    })

    yield* Effect.forkScoped(Stream.runForEach(Stream.changesWith(Stream.map(modes.changes, ({ mode }) => mode), (one, other) => one === other), follow))
    yield* Effect.forkScoped(
      digest.pipe(
        Effect.catchAllCause((cause) => Effect.logWarning("Could not bring up what I held", cause)),
        Effect.repeat(Schedule.spaced(look)),
      ),
    )
    return { leave }
  })
