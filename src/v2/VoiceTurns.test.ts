import { expect, test } from "bun:test"
import { Effect, Exit, Option, Queue, Scope, SubscriptionRef } from "effect"
import type { Audio, RollingFrame } from "../Audio.ts"
import type { Vad } from "../Vad.ts"
import type { InputOrigin, Runtime } from "./Runtime.ts"
import type { SessionEvent } from "./Types.ts"
import { make, type VoiceTurns } from "./VoiceTurns.ts"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 1500
  while (!condition()) { if (performance.now() > deadline) throw new Error("The voice-turn lifecycle did not settle."); await Bun.sleep(1) }
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }

const fixture = async (options: { readonly openGate?: ReturnType<typeof deferred>; readonly cancelGate?: ReturnType<typeof deferred>; readonly closeGate?: ReturnType<typeof deferred>; readonly vadFails?: boolean; readonly makeFails?: boolean } = {}) => {
  const scope = Effect.runSync(Scope.make())
  const policy = Effect.runSync(SubscriptionRef.make(Option.some({ deviceId: "mac", handsFree: true })))
  const origins = new Map<string, InputOrigin>([["first", { deviceId: "mac", focus: { machine: "rig", id: "thread" } }], ["phone", { deviceId: "phone" }]])
  const errors: Error[] = []
  const starts: Array<{ captureId: string; deviceId?: string; focus?: { machine: string; id: string } }> = []
  const cancels: string[] = [], sends: string[] = []
  const recognized = new Map<string, Float32Array[]>()
  const listeners: Array<{ deviceId: string; queue: Queue.Queue<RollingFrame>; history: RollingFrame[]; opened: boolean; closed: boolean; native?: { id: string; frames: Queue.Queue<Float32Array>; samples: number } }> = []
  const promotions: Array<{ id: string; fromSequence: number }> = []
  let manager!: VoiceTurns
  let activeResponse = "first"
  const emit = (event: SessionEvent) => {
    if (event.type === "response_started") activeResponse = event.responseId
    manager.event(event)
  }
  const runtime: Pick<Runtime, "originFor" | "start" | "push" | "send" | "cancel"> = {
    originFor: (id) => origins.get(id),
    start: (input) => {
      starts.push(input); recognized.set(input.captureId, [])
      emit({ type: "output_cancelled", responseId: activeResponse, reason: "onset" })
      emit({ type: "playback", responseId: activeResponse, playedMs: 0, state: "interrupted", certainty: "approximate" })
    },
    push: ({ captureId, frame }) => { recognized.get(captureId)?.push(frame.slice()) },
    send: async ({ captureId }) => { sends.push(captureId); return { turnId: captureId, revision: 2, responseId: "spoken", duplicate: false } },
    cancel: ({ captureId }) => { cancels.push(captureId); emit({ type: "output_resumed", responseId: activeResponse, text: "Original answer" }) },
  }
  const audio: Pick<Audio["Type"], "listenFor" | "listeningDevice"> = {
    listeningDevice: policy.changes,
    listenFor: (deviceId) => Effect.gen(function* () {
      const state: typeof listeners[number] = { deviceId, queue: yield* Queue.unbounded<RollingFrame>(), history: [], opened: false, closed: false }
      listeners.push(state)
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        await options.closeGate?.promise
        state.closed = true
        Effect.runSync(Queue.shutdown(state.queue))
      }))
      if (options.openGate !== undefined) yield* Effect.promise(() => options.openGate!.promise)
      state.opened = true
      return { frames: state.queue,
        promote: (id, fromSequence) => Effect.gen(function* () {
          promotions.push({ id, fromSequence })
          const initial = state.history.filter((item) => item.sequence >= fromSequence).map(({ frame }) => frame)
          const native = { id, frames: yield* Queue.unbounded<Float32Array>(), samples: initial.length * 512 }
          state.native = native
          yield* Queue.offerAll(native.frames, initial)
          return { frames: native.frames,
            finish: Effect.gen(function* () {
              yield* Queue.offer(native.frames, new Float32Array(512).fill(-0.75)); native.samples += 512
              if (state.native === native) delete state.native
              return { frames: [...yield* Queue.takeAll(native.frames)], samples: native.samples }
            }),
            cancel: Effect.promise(async () => { await options.cancelGate?.promise; if (state.native === native) delete state.native }),
          }
        }),
      }
    }),
  }
  const vad: Vad["Type"] = { make: options.makeFails ? Effect.die(new Error("VAD setup failed")) : Effect.succeed((frame: Float32Array) => options.vadFails ? Effect.die(new Error("VAD inference failed")) : Effect.succeed(frame[0] ?? 0)) }
  manager = await Effect.runPromise(make({ audio, vad, runtime, onError: (error) => { errors.push(error) } }).pipe(Scope.extend(scope)))
  await tick()
  return {
    manager, origins, runtime, listeners, promotions, starts, cancels, sends, recognized, errors, emit,
    policy: async (deviceId: string, handsFree: boolean) => { Effect.runSync(SubscriptionRef.set(policy, Option.some({ deviceId, handsFree }))); await tick() },
    start: async (responseId = "first") => { emit({ type: "response_started", responseId, turnId: responseId }); await tick() },
    push: (probability: number) => {
      const state = listeners.at(-1)!
      const input = { sequence: state.history.length, frame: new Float32Array(512).fill(probability), echoRisk: false }
      state.history.push(input)
      if (state.native !== undefined) { state.native.samples += 512; Effect.runSync(Queue.offer(state.native.frames, input.frame)) }
      Effect.runSync(Queue.offer(state.queue, input))
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

test("a Mac conversation still accepts a complete follow-up after the second reply finishes", async () => {
  const f = await fixture()
  try {
    await f.start(); await until(() => f.listeners[0]?.opened === true)
    f.push(0.9); await until(() => f.promotions.length === 1)
    for (let i = 0; i < 3; i++) f.push(0.9)
    for (let i = 0; i < 38; i++) f.push(0)
    await until(() => f.sends.length === 1)
    f.origins.set("second", { deviceId: "mac" })
    await f.start("second")
    f.emit({ type: "response_done", responseId: "second", turnId: "second", text: "I cannot settle that thread yet." })
    f.emit({ type: "playback", responseId: "second", playedMs: 1800, state: "finished", certainty: "exact" })
    await tick()
    expect(f.listeners.at(-1)?.closed).toBe(false)

    // The user begins after playback, pauses briefly, then completes the turn.
    for (let i = 0; i < 50; i++) f.push(0)
    f.push(0.9); await until(() => f.promotions.length === 2)
    for (let i = 0; i < 3; i++) f.push(0.9)
    for (let i = 0; i < 16; i++) f.push(0)
    await tick(); expect(f.sends).toHaveLength(1)
    for (let i = 0; i < 5; i++) f.push(0.9)
    for (let i = 0; i < 38; i++) f.push(0)
    await until(() => f.sends.length === 2)
    const captured = f.recognized.get(f.sends[1]!)!
    expect(captured.filter((frame) => frame[0]! > 0.8)).toHaveLength(9)
    expect(captured.at(-1)?.[0]).toBe(-0.75)
    expect(f.errors).toEqual([])
    await Effect.runPromise(f.manager.suspend)
    expect(f.listeners.every(({ closed }) => closed)).toBe(true)
  } finally { await f.close() }
})

test("only a pinned eligible Mac conversation opens input and Stop releases it between replies", async () => {
  const f = await fixture()
  try {
    expect(f.listeners).toHaveLength(0)
    await f.policy("phone", false); await f.start("phone")
    expect(f.listeners).toHaveLength(0)
    await f.policy("mac", true); await f.start()
    await until(() => f.listeners[0]?.opened === true)
    f.emit({ type: "response_done", responseId: "first", turnId: "first", text: "Complete generated answer" }); await tick()
    expect(f.listeners[0]!.closed).toBe(false)
    f.emit({ type: "playback", responseId: "first", playedMs: 1000, state: "finished", certainty: "exact" })
    await tick()
    expect(f.listeners[0]!.closed).toBe(false)
    await Effect.runPromise(f.manager.suspend)
    await until(() => f.listeners[0]?.closed === true)
    await tick()
    expect(f.listeners).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { await f.close() }
})

test("a false onset retains input while native cancellation waits, then output_resumed renews the same listener", async () => {
  const gate = deferred()
  const f = await fixture({ cancelGate: gate })
  try {
    await f.start(); await until(() => f.listeners[0]?.opened === true)
    f.push(0); f.push(0.9)
    await until(() => f.promotions.length === 1)
    for (let i = 0; i < 8; i++) f.push(0)
    await tick()
    expect(f.cancels).toEqual([])
    expect(f.listeners[0]!.closed).toBe(false)
    gate.resolve(); await until(() => f.cancels.length >= 1); await tick()
    expect(new Set(f.cancels).size).toBe(1)
    expect(f.listeners[0]!.closed).toBe(false)
    expect(f.listeners).toHaveLength(1)
    expect(f.sends).toEqual([])
  } finally { gate.resolve(); await f.close() }
})

test("promotion uses the existing recognizer and complete final boundary, retaining origin and onset focus", async () => {
  const f = await fixture()
  try {
    await f.start(); await until(() => f.listeners[0]?.opened === true)
    f.push(0); f.push(0.9)
    await until(() => f.promotions.length === 1)
    for (let i = 0; i < 3; i++) f.push(0.9)
    for (let i = 0; i < 38; i++) f.push(0)
    await until(() => f.sends.length === 1)
    const id = f.sends[0]!
    expect(f.starts).toHaveLength(1)
    expect(f.starts[0]).toMatchObject({ deviceId: "mac", focus: { machine: "rig", id: "thread" } })
    expect(f.recognized.get(id)?.at(-1)?.[0]).toBe(-0.75)
    expect(f.promotions[0]!.fromSequence).toBe(0)
    await tick()
    expect(f.listeners[0]!.closed).toBe(false)
    expect(f.errors).toEqual([])
  } finally { await f.close() }
})

test("suspend aborts a pending native open, awaits cleanup, and ignores late old events", async () => {
  const opening = deferred(), cleanup = deferred()
  const f = await fixture({ openGate: opening, closeGate: cleanup })
  try {
    await f.start(); await until(() => f.listeners.length === 1)
    let stopped = false
    const suspend = Effect.runPromise(f.manager.suspend).then(() => { stopped = true })
    await tick(); expect(stopped).toBe(false)
    f.emit({ type: "output_resumed", responseId: "first", text: "Old answer" })
    cleanup.resolve(); await suspend
    opening.resolve(); await tick()
    expect(f.listeners[0]!.opened).toBe(false)
    expect(f.listeners[0]!.closed).toBe(true)
    expect(f.listeners).toHaveLength(1)
    await f.policy("phone", false); await f.start("phone")
    expect(f.listeners).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { opening.resolve(); cleanup.resolve(); await f.close() }
})

test("source replacement invalidates an older pending open and never activates the phone", async () => {
  const opening = deferred()
  const f = await fixture({ openGate: opening })
  try {
    await f.start(); await until(() => f.listeners.length === 1)
    await f.policy("phone", false); await f.start("phone")
    await until(() => f.listeners[0]?.closed === true)
    opening.resolve(); await tick()
    expect(f.listeners[0]!.opened).toBe(false)
    expect(f.listeners).toHaveLength(1)
  } finally { opening.resolve(); await f.close() }
})

test("VAD setup and inference failure cancel listening instead of treating the frame as silence", async () => {
  const setup = await fixture({ makeFails: true })
  try { await setup.start(); await until(() => setup.errors.length === 1); expect(setup.listeners).toHaveLength(0) }
  finally { await setup.close() }
  const f = await fixture({ vadFails: true })
  try {
    await f.start(); await until(() => f.listeners[0]?.opened === true)
    f.push(0.9)
    await until(() => f.listeners[0]?.closed === true)
    expect(f.starts).toEqual([])
    expect(f.sends).toEqual([])
    expect(f.errors).toHaveLength(1)
    await tick(); expect(f.listeners).toHaveLength(1)
  } finally { await f.close() }
})

test("an empty notification releases input even though there is no audio playback receipt", async () => {
  const f = await fixture()
  try {
    f.emit({ type: "response_started", responseId: "first", turnId: "first", authorization: "event" })
    await until(() => f.listeners[0]?.opened === true)
    f.emit({ type: "response_done", responseId: "first", turnId: "first", text: "  " })
    await until(() => f.listeners[0]?.closed === true)
    expect(f.listeners).toHaveLength(1)
  } finally { await f.close() }
})

test("a notification alone closes input after playback, but one during a user conversation preserves it", async () => {
  for (const engaged of [false, true]) {
    const f = await fixture()
    try {
      if (engaged) { await f.start(); await until(() => f.listeners[0]?.opened === true) }
      f.origins.set("notice", { deviceId: "mac" })
      f.emit({ type: "response_started", responseId: "notice", turnId: "notice", authorization: "event" })
      await until(() => f.listeners.some(({ opened, closed }) => opened && !closed))
      f.emit({ type: "response_done", responseId: "notice", turnId: "notice", text: "The tests passed." })
      f.emit({ type: "playback", responseId: "notice", playedMs: 1000, state: "finished", certainty: "exact" })
      await tick()
      expect(f.listeners.at(-1)?.closed).toBe(!engaged)
      expect(f.errors).toEqual([])
    } finally { await f.close() }
  }
})
