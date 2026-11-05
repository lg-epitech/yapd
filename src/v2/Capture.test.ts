import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Queue, Scope } from "effect"
import { AudioError } from "../Audio.ts"
import { record } from "./Capture.ts"

const fixture = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const frames = yield* Queue.unbounded<Float32Array>()
  const inspected = yield* Deferred.make<void>()
  const stall = yield* Deferred.make<void>()
  const order: string[] = []
  let accepted = 0, sent = 0, cancelled = 0
  let mismatch = false, failure = false
  const received: number[] = []
  const recording = yield* record({
    id: "phone-press", deviceId: "phone",
    audio: { captureFor: (device, id) => Effect.sync(() => {
      expect([device, id]).toEqual(["phone", "phone-press"])
      return {
        frames,
        finish: Effect.gen(function* () {
          order.push("physical-boundary")
          if (failure) return yield* Effect.fail(new AudioError({ message: "Capture overflow" }))
          return { frames: [...yield* Queue.takeAll(frames)], samples: accepted + (mismatch ? 1 : 0) }
        }),
        cancel: Effect.sync(() => { order.push("physical-cancel") }),
      }
    }) },
    runtime: {
      start: () => {}, push: ({ frame }) => { received.push(...frame); order.push(`push:${frame[0]}`) },
      send: async () => { sent++; order.push("recognition-finish"); return undefined },
      cancel: () => { cancelled++; order.push("recognition-cancel") },
    },
    inspect: () => Deferred.succeed(inspected, undefined).pipe(Effect.zipRight(Deferred.await(stall))),
    onError: () => {},
  }).pipe(Scope.extend(scope))
  const push = (value: number) => Effect.sync(() => { accepted++; }).pipe(Effect.zipRight(Queue.offer(frames, new Float32Array([value]))))
  return { scope, recording, received, order, inspected, push, sent: () => sent, cancelled: () => cancelled, mismatch: () => { mismatch = true }, fail: () => { failure = true } }
})

test("Send includes final queued PCM after an atomic take, releases the device, then finalizes recognition", async () => {
  const f = await Effect.runPromise(fixture)
  try {
    await Effect.runPromise(f.push(1))
    await Effect.runPromise(Deferred.await(f.inspected))
    await Effect.runPromise(f.push(2))
    await Effect.runPromise(f.push(3))
    await Effect.runPromise(f.recording.seal)
    expect(f.received).toEqual([1, 2, 3])
    expect(f.sent()).toBe(0)
    await Effect.runPromise(f.recording.send)
    expect(f.sent()).toBe(1)
    expect(f.order.indexOf("physical-boundary")).toBeLessThan(f.order.indexOf("push:3"))
    expect(f.order.indexOf("push:3")).toBeLessThan(f.order.indexOf("recognition-finish"))
  } finally { await Effect.runPromise(Scope.close(f.scope, Exit.void)) }
})

test("a missing final sample or capture overflow rejects Send and cancels recognition", async () => {
  for (const kind of ["mismatch", "overflow"] as const) {
    const f = await Effect.runPromise(fixture)
    try {
      await Effect.runPromise(f.push(1))
      await Effect.runPromise(Deferred.await(f.inspected))
      if (kind === "mismatch") f.mismatch(); else f.fail()
      const result = await Effect.runPromise(Effect.exit(f.recording.send))
      expect(Exit.isFailure(result)).toBe(true)
      expect(f.sent()).toBe(0)
      expect(f.cancelled()).toBe(1)
    } finally { await Effect.runPromise(Scope.close(f.scope, Exit.void)) }
  }
})

test("Cancel releases input before allowing a false-onset response to resume", async () => {
  const f = await Effect.runPromise(fixture)
  try {
    await Effect.runPromise(f.recording.cancel)
    expect(f.sent()).toBe(0)
    expect(f.cancelled()).toBe(1)
    expect(f.order.indexOf("physical-cancel")).toBeLessThan(f.order.indexOf("recognition-cancel"))
  } finally { await Effect.runPromise(Scope.close(f.scope, Exit.void)) }
})

test("a detector outage cancels the physical capture and old proposals instead of completing on silence", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const frames = yield* Queue.unbounded<Float32Array>()
    const failed = yield* Deferred.make<void>()
    let physical = false, sent = 0, reason: string | undefined
    yield* record({ id: "vad-outage", deviceId: "mac", audio: { captureFor: () => Effect.succeed({ frames, finish: Effect.succeed({ frames: [], samples: 0 }), cancel: Effect.sync(() => { physical = true }) }) },
      runtime: { start: () => {}, push: () => {}, send: async () => { sent++; return undefined }, cancel: (input) => { reason = input.reason } },
      inspect: () => Effect.die(new Error("Detector unavailable")), onError: () => { Effect.runSync(Deferred.succeed(failed, undefined)) },
    })
    yield* Queue.offer(frames, new Float32Array(512))
    yield* Deferred.await(failed)
    expect([physical, sent, reason]).toEqual([true, 0, "error"])
  })))
})

test("interrupting capture setup closes its native owner even if ready never arrives", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const entered = await Effect.runPromise(Deferred.make<void>())
  let released = false
  try {
    const fiber = await Effect.runPromise(record({ id: "pending", deviceId: "phone",
      audio: { captureFor: () => Effect.acquireRelease(Deferred.succeed(entered, undefined), () => Effect.sync(() => { released = true })).pipe(Effect.zipRight(Effect.never)) },
      runtime: { start: () => {}, push: () => {}, send: async () => undefined, cancel: () => {} }, onError: () => {},
    }).pipe(Scope.extend(scope), Effect.forkIn(scope)))
    await Effect.runPromise(Deferred.await(entered))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(released).toBe(true)
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
})
