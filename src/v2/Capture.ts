import { Effect, Exit, Fiber, Queue, Scope } from "effect"
import type { Audio, AudioError } from "../Audio.ts"
import type { CommitReceipt, Runtime } from "./Runtime.ts"

export interface Recording {
  readonly id: string
  readonly seal: Effect.Effect<void, unknown>
  readonly send: Effect.Effect<CommitReceipt | undefined, unknown>
  readonly cancel: Effect.Effect<void>
}

/** Owns one device's input through its acknowledged final PCM boundary. */
export const record = (options: {
  readonly id: string
  readonly deviceId: string
  readonly audio: Pick<Audio["Type"], "captureFor">
  readonly runtime: Pick<Runtime, "start" | "push" | "send" | "cancel">
  readonly inspect?: (frame: Float32Array) => Effect.Effect<void>
  readonly onError: (error: unknown) => void
}): Effect.Effect<Recording, AudioError | Error, Scope.Scope> => Effect.gen(function* () {
  const { id, deviceId, runtime } = options
  if (options.audio.captureFor === undefined) return yield* Effect.fail(new Error("This client needs capture-boundary support before V2 can record."))
  const scope = yield* Scope.make()
  let closing: Promise<void> | undefined
  const close = () => closing ??= Effect.runPromise(Scope.close(scope, Exit.void))
  let ended = false
  let samples = 0
  yield* Effect.addFinalizer(() => Effect.promise(close))
  runtime.start({ captureId: id, deviceId })
  const input = yield* options.audio.captureFor(deviceId, id).pipe(Scope.extend(scope), Effect.tapError(() => Effect.sync(() => runtime.cancel({ captureId: id, reason: "error" }))), Effect.onError(() => Effect.promise(close)))
  const push = (frame: Float32Array) => { runtime.push({ captureId: id, frame }); samples += frame.length }
  // Taking a frame and handing it to recognition is indivisible with respect to
  // Send. No stream prefetch may remove words from the final queue drain.
  const take = Effect.uninterruptibleMask((restore) => restore(Queue.take(input.frames)).pipe(Effect.tap((frame) => Effect.sync(() => push(frame)))))
  const consumer = yield* take.pipe(
    Effect.tap((frame) => options.inspect?.(frame) ?? Effect.void), Effect.forever,
    Effect.catchAllCause((cause) => Effect.gen(function* () {
      if (ended) return
      ended = true
      yield* input.cancel
      runtime.cancel({ captureId: id, reason: "error" })
      options.onError(cause)
      // Closing this scope from its own fiber would await itself.
      queueMicrotask(() => { void close() })
    })), Effect.forkIn(scope),
  )
  const cancel = Effect.gen(function* () {
    if (!ended) {
      ended = true
      yield* Fiber.interrupt(consumer)
      yield* input.cancel
      runtime.cancel({ captureId: id })
    }
    yield* Effect.promise(close)
  })
  const seal = yield* Effect.cached(Effect.gen(function* () {
    if (ended) return yield* Effect.fail(new Error("The recording has ended."))
    ended = true
    yield* Fiber.interrupt(consumer)
    const boundary = yield* input.finish
    for (const frame of boundary.frames) push(frame)
    if (samples !== boundary.samples) return yield* Effect.fail(new Error("The complete recording could not be verified. Nothing was sent."))
    yield* Effect.promise(close)
  }).pipe(Effect.onError(() => Effect.gen(function* () {
    yield* input.cancel
    runtime.cancel({ captureId: id, reason: "error" })
    yield* Effect.promise(close)
  }))))
  const send = seal.pipe(Effect.zipRight(Effect.tryPromise(() => runtime.send({ captureId: id }))))
  return { id, seal, send, cancel }
})
