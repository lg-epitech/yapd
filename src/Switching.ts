import { Deferred, Effect, Queue, type Scope, Stream } from "effect"
import { switches } from "./Responder.ts"

// Turning yapd on or off, from the menu bar, the API, as it starts or by
// voice, kept apart from `yapd serve` so what it drops, and what it doesn't
// wait for, can be checked on its own.

/** What turning yapd on or off goes through, in the order it's done. */
export interface Parts {
  /** Whether yapd is on now, and how many times it's been turned on or off. */
  readonly power: Effect.Effect<{ readonly on: boolean; readonly turns: number }>
  /** Drops the dictations not handed on yet, as what they were for is stopped. */
  readonly dictations: Effect.Effect<void>
  /** Drops what he asked that's under way, as what it was for is stopped. */
  readonly drop: Effect.Effect<void>
  /** Turns the daemon on or off. */
  readonly turn: (on: boolean) => Effect.Effect<void>
  /** Keeps the shortcut, which works whether yapd is on or off. */
  readonly shortcut: Effect.Effect<void>
  /** On: what came in while it was off is offered once, what a restart found is said, and what waits on him that he wasn't told of. */
  readonly back: Effect.Effect<void>
}

/**
 * Turns yapd on or off. What he asked is dropped only when yapd really
 * switches: asked to be what it is already, as when it starts on, or a
 * second "on" from the API, nothing he's asking is stopped. Off, the shortcut
 * is kept first, then what's under way is dropped before the daemon turns, so
 * what was begun for the turns before is stopped like the rest. On, the same,
 * then the shortcut, and then what's said on coming back. Turned on by what
 * he said, by the dictation the shortcut's press `press` began, like
 * "unmute", the dictations still under way are kept, as he may have pressed
 * again right after to ask something, and `turns` takes the presses after
 * that one, made while yapd was still off, for made once it's on, so what
 * they began isn't dropped as said while it was off. `switched` runs once
 * it's on or off as asked, before the shortcut is kept and what's said on
 * coming back.
 */
export const switcher = (parts: Parts) => {
  /** The press that last turned yapd on by voice, and how many times it had been turned on or off just before and just after. */
  let woke: { readonly press: number; readonly before: number; readonly after: number } | undefined
  return {
    turn: (on: boolean, press?: number, switched: Effect.Effect<void> = Effect.void) =>
      Effect.flatMap(parts.power, (power) => {
        const switching = power.on !== on
        const voiced = on && press !== undefined
        // Noted as soon as the daemon has turned, so a press after it is taken for made once it's on however soon what it began comes.
        const turned = Effect.zipRight(
          parts.turn(on),
          Effect.flatMap(parts.power, ({ turns }) =>
            Effect.sync(() => {
              if (voiced) woke = { press, before: power.turns, after: turns }
            }),
          ),
        )
        const dropping = switching ? [...(voiced ? [] : [parts.dictations]), parts.drop, turned] : []
        return Effect.all(on ? [...dropping, switched, parts.shortcut, parts.back] : [parts.shortcut, ...dropping, switched], { discard: true })
      }),
    /** How many times yapd had been turned on or off as `press` was made, `turns`, as what it began is to be taken. */
    turns: (press: number, turns: number) => (woke !== undefined && press > woke.press && turns === woke.before ? woke.after : turns),
  }
}

/**
 * Runs `turn` in `scope`, coming back as soon as yapd is on or off, which it
 * tells by running what it's given, or once it's ended however it did: what
 * it does after that, like what's said on coming back, carries on unwaited.
 */
export const promptly = (turn: (switched: Effect.Effect<void>) => Effect.Effect<void>, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const switched = yield* Deferred.make<void>()
    const done = Deferred.succeed(switched, undefined)
    yield* turn(Effect.asVoid(done)).pipe(Effect.ensuring(done), Effect.forkIn(scope))
    yield* Deferred.await(switched)
  })

/** Whether what he said is "Mute." while yapd is on, as `power` has it, which goes ahead of whatever he said before. */
export const urgent = (heard: string, power: Effect.Effect<{ readonly on: boolean }>) => Effect.map(power, ({ on }) => switches(heard, on) === false)

/**
 * Hands on what he dictates one at a time, in the order he said it, each
 * once the one before has been dealt with, since one can build on another,
 * like what he asks right after "unmute" once yapd is on; but "Mute." while
 * yapd is on, as `power` has it, at once, never waiting behind what's still
 * being worked out for one before, which turning off then stops, as the
 * menu's Turn Off does.
 */
export const dictations = <A extends { readonly heard: string }>(
  transcripts: Stream.Stream<A>,
  power: Effect.Effect<{ readonly on: boolean }>,
  hand: (transcript: A) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const waiting = yield* Queue.unbounded<A>()
    yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(waiting), hand))
    return yield* Stream.runForEach(transcripts, (transcript) =>
      Effect.flatMap(urgent(transcript.heard, power), (first) =>
        first ? Effect.asVoid(Effect.forkScoped(hand(transcript))) : Queue.offer(waiting, transcript),
      ),
    )
  })
