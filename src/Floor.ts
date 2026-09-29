import { Context, Effect, Layer, STM, TRef } from "effect"
import type { Audio } from "./Audio.ts"

// Who has the speaker and the microphone: updates, or the user dictating, who
// comes first. An update being read stops the moment a dictation starts, and
// none is read until it's over.

export class Floor extends Context.Tag("yapd/Floor")<
  Floor,
  {
    /**
     * Dictations going on, from the press until yapd has answered it. Usually
     * one, but one being transcribed can overlap the next. Updates wait for all of
     * them: what yapd says back would otherwise cut off an update being read.
     */
    readonly dictations: TRef.TRef<number>
    /** Whether an update is being read, until its playback and microphone are let go. */
    readonly reading: TRef.TRef<boolean>
    /** The speaker and microphone themselves, only ever held through `use`. */
    readonly device: Effect.Semaphore
  }
>() {}

export const layer = Layer.effect(
  Floor,
  Effect.zipWith(
    STM.commit(STM.zipWith(TRef.make(0), TRef.make(false), (dictations, reading) => ({ dictations, reading }))),
    Effect.makeSemaphore(1),
    (refs, device) => ({ ...refs, device }),
  ),
)

export const dictating = (floor: Floor["Type"]) => STM.map(TRef.get(floor.dictations), (count) => count > 0)

/**
 * Holds the speaker and microphone for a dictation, from its first sound until
 * the microphone is off, or to say something, and turns them off before letting
 * go: whoever holds them next turns them on again if it needs them. So nothing
 * one holder does late can reach the next, and they're never left on for nobody.
 */
export const use =
  (floor: Floor["Type"], audio: Audio["Type"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    floor.device.withPermits(1)(Effect.ensuring(effect, audio.rest))

/** Takes the floor for a dictation until the scope closes, once any update being read has let go of it. */
export const take = Effect.gen(function* () {
  const floor = yield* Floor
  yield* Effect.acquireRelease(STM.commit(TRef.update(floor.dictations, (count) => count + 1)), () =>
    STM.commit(TRef.update(floor.dictations, (count) => count - 1)),
  )
  yield* STM.commit(STM.flatMap(TRef.get(floor.reading), (reading) => (reading ? STM.retry : STM.void)))
})
