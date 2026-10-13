import { Effect, Queue, Stream } from "effect"

// Turning yapd on or off, from the menu bar, the API, as it starts or by
// voice, kept apart from `yapd serve` so what it drops, and what it doesn't
// wait for, can be checked on its own.

/** What turning yapd on or off goes through, in the order it's done. */
export interface Parts {
  /** Whether yapd is on now. */
  readonly power: Effect.Effect<{ readonly on: boolean }>
  /** Drops what he asked that's under way, a dictation too, as what it was for is stopped. */
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
 * then the shortcut, and then what's said on coming back.
 */
export const switcher = (parts: Parts) => (on: boolean) =>
  Effect.flatMap(parts.power, (power) => {
    const switching = power.on !== on
    const dropping = switching ? [parts.drop, parts.turn(on)] : []
    return Effect.all(on ? [...dropping, parts.shortcut, parts.back] : [parts.shortcut, ...dropping], { discard: true })
  })

/**
 * Hands on what he dictates one at a time, in the order he said it, each
 * once the one before has been dealt with, since one can build on another;
 * but what `switches` yapd off or on, like "Mute.", at once, never waiting
 * behind what's still being worked out for one before, which turning off
 * then stops, as the menu's Turn Off does.
 */
export const dictations = <A>(
  transcripts: Stream.Stream<A>,
  switches: (transcript: A) => Effect.Effect<boolean>,
  hand: (transcript: A) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const waiting = yield* Queue.unbounded<A>()
    yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(waiting), hand))
    return yield* Stream.runForEach(transcripts, (transcript) =>
      Effect.flatMap(switches(transcript), (switching) => (switching ? Effect.asVoid(Effect.forkScoped(hand(transcript))) : Queue.offer(waiting, transcript))),
    )
  })
