import { expect, test } from "bun:test"
import { Effect, Exit, Queue, Scope } from "effect"
import { record } from "./Capture.ts"
import { Listening, type ListeningCaptureInput, type ListeningEvent, type ListeningRecording } from "./Listening.ts"
import { Runtime, type RuntimeEvent } from "./Runtime.ts"
import { Session } from "./Session.ts"
import { Store } from "./Store.ts"
import type { Model, Tool, ToolContext } from "./Types.ts"

const deferred = <A = void>() => {
  let resolve!: (value: A | PromiseLike<A>) => void
  const promise = new Promise<A>((yes) => { resolve = yes })
  return { promise, resolve }
}
const until = async (ready: () => boolean) => {
  const deadline = performance.now() + 1500
  while (!ready()) { if (performance.now() > deadline) throw new Error("The expected listening event did not arrive."); await Bun.sleep(1) }
}
const endpoint = { lead: 2, confirm: 2, wary: 3, abandon: 2, silence: 2, pause: 1 }
const tool = (execute: Tool["execute"]): Tool => ({ name: "send", mode: "write", description: "Send the requested fixture instruction.", parameters: { type: "object", additionalProperties: false }, execute })

const fixture = (model: Model, tools: ReadonlyArray<Tool> = [], options: { readonly cancelGate?: Promise<void>; readonly recognitionGate?: Promise<void>; readonly text?: string } = {}) => {
  const store = new Store()
  const session = new Session({ conversationId: "listening", model, tools, store })
  const events: Array<RuntimeEvent> = []
  const errors: Array<Error> = []
  const listeningEvents: Array<ListeningEvent> = []
  const recognizers = new Map<string, { frames: Array<Float32Array>; finished: number; aborted: boolean }>()
  const played: Array<{ deviceId?: string; stopped: boolean; samples: number }> = []
  const runtime = new Runtime({ session,
    recognize: ({ captureId }) => {
      const state = { frames: [] as Array<Float32Array>, finished: 0, aborted: false }
      recognizers.set(captureId, state)
      return {
        push: (frame) => { state.frames.push(frame.slice()) },
        finish: async () => { state.finished++; await options.recognitionGate; return { text: options.text ?? "Continue the French tests only, no snapshots, no merge.", samples: state.frames.reduce((count, frame) => count + frame.length, 0), revision: 1, mode: "native_streaming", requestMs: 0, durationMs: 0, finalizationMs: 0, reusedPrefix: false } },
        abort: () => { state.aborted = true },
      }
    },
    speech: {
      synthesize: async function* () { yield { rate: 16_000, pcm16: new Uint8Array([1, 0, 2, 0]) } },
      player: { open: async (request) => {
        const state = { ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }), stopped: false, samples: 0 }; played.push(state)
        return {
          write: async (pcm) => { state.samples += pcm.length / 2 },
          end: async () => ({ samples: state.samples, rate: request.rate, certainty: "rendered" }),
          stop: async () => { state.stopped = true; return { samples: state.samples, rate: request.rate, certainty: "rendered" } },
        }
      } },
    },
    onEvent: (event) => { events.push(event) },
  })
  const scope = Effect.runSync(Scope.make())
  const history: Array<{ sequence: number; frame: Float32Array }> = []
  const boundaries: Array<string> = []
  const promotions: Array<ListeningCaptureInput> = []
  let native: { id: string; queue: Queue.Queue<Float32Array>; samples: number } | undefined
  let focus = { machine: "fixture", id: "asr" }
  const listener = new Listening({ deviceId: "mac", runtime, focus: () => focus, endpoint,
    record: async (input) => {
      promotions.push(input)
      const recording = await Effect.runPromise(record({ id: input.id, deviceId: input.deviceId,
        audio: { captureFor: () => Effect.gen(function* () {
          if (native !== undefined) throw new Error("Two native recording views overlapped.")
          const queue = yield* Queue.unbounded<Float32Array>()
          const initial = history.filter(({ sequence }) => sequence >= input.fromSequence).map(({ frame }) => frame)
          const state = { id: input.id, queue, samples: initial.length * 512 }
          native = state
          yield* Queue.offerAll(queue, initial)
          return { frames: queue,
            finish: Effect.gen(function* () {
              // A frame arriving after the endpoint decision still belongs to
              // the acknowledged capture, never to a guessed ASR slice.
              yield* Queue.offer(queue, new Float32Array(512).fill(99)); state.samples += 512
              boundaries.push(`seal:${input.id}`)
              if (native === state) native = undefined
              return { frames: [...yield* Queue.takeAll(queue)], samples: state.samples }
            }),
            cancel: Effect.gen(function* () {
              if (options.cancelGate !== undefined) yield* Effect.promise(() => options.cancelGate!)
              boundaries.push(`cancel:${input.id}`)
              if (native === state) native = undefined
            }),
          }
        }) },
        // Listening already called Runtime.start synchronously at acoustic onset.
        runtime: { start: () => {}, push: (input) => runtime.push(input), send: (input) => runtime.send(input), cancel: (input) => runtime.cancel(input) },
        onError: (error) => { errors.push(error instanceof Error ? error : new Error(String(error))) },
      }).pipe(Scope.extend(scope)))
      return { seal: () => Effect.runPromise(recording.seal), send: () => Effect.runPromise(recording.send), cancel: () => Effect.runPromise(recording.cancel) }
    },
    onError: (error) => { errors.push(error) }, onEvent: (event) => { listeningEvents.push(event) },
  })
  const push = (probability: number, echo = false) => {
    const item = { sequence: history.length, frame: new Float32Array(512).fill(history.length) }
    history.push(item)
    if (native !== undefined) { native.samples += 512; Effect.runSync(Queue.offer(native.queue, item.frame)) }
    listener.push({ ...item, probability, echo })
  }
  return { runtime, session, store, listener, events, errors, listeningEvents, recognizers, played, promotions, boundaries, push,
    changeFocus: () => { focus.id = "unrelated"; focus = { machine: "fixture", id: "new-focus" } },
    close: async () => { await listener.close(); await runtime.close(); await Effect.runPromise(Scope.close(scope, Exit.void)); store.close() },
  }
}

test("Mac speech over playback preserves native pre-roll and final boundary, then uses the same Session tools and pinned origin", async () => {
  const contexts: Array<ToolContext> = []
  const intact = "  The ASR status is available—French tests only, no snapshots, no merge.  "
  const work = fixture({ stream: async function* (request) {
    const user = request.items.findLast((item) => item.type === "message" && item.role === "user")
    if (user?.type === "message" && user.text === "Initial status") {
      yield { type: "text_delta", delta: "The ASR status is available. " }
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
    } else {
      yield { type: "tool_call", callId: "send", name: "send", arguments: {}, respond: async () => {} }
      yield { type: "text_delta", delta: "Sent the constrained request." }
    }
    yield { type: "done" }
  } }, [tool(async (_args, context) => { contexts.push(context); return { accepted: true } })], { text: intact })
  try {
    await work.runtime.text({ text: "Initial status", deviceId: "mac", focus: { machine: "fixture", id: "asr" } })
    await until(() => (work.played[0]?.samples ?? 0) > 0)
    work.push(0); work.push(0); work.push(0.9)
    expect(work.events.some((event) => event.type === "output_cancelled" && event.reason === "onset")).toBe(true)
    work.changeFocus()
    await until(() => work.promotions.length === 1 && work.played[0]?.stopped === true)
    work.push(0.9); work.push(0); work.push(0)
    await work.listener.idle(); await work.runtime.idle()
    const committed = work.listeningEvents.find((event) => event.type === "committed")
    expect(committed?.type).toBe("committed")
    if (committed?.type !== "committed") throw new Error("No spoken turn committed.")
    await work.runtime.drained(committed.receipt.responseId)
    expect(work.promotions[0]).toMatchObject({ deviceId: "mac", fromSequence: 0, focus: { machine: "fixture", id: "asr" } })
    expect(work.recognizers.get(committed.captureId)?.frames.map((frame) => frame[0])).toEqual([0, 1, 2, 3, 4, 5, 99])
    expect(contexts[0]).toMatchObject({ source: "voice", userText: intact, focus: { machine: "fixture", id: "asr" } })
    expect(work.played.map(({ deviceId }) => deviceId)).toEqual(["mac", "mac"])
    expect(work.store.revision("listening")).toBe(2)
    expect(work.errors).toEqual([])
  } finally { await work.close() }
})

test("a false acoustic onset holds writes until native cancellation, then resumes the original request without a user turn", async () => {
  const propose = deferred()
  const cancelled = deferred()
  let writes = 0
  const work = fixture({ stream: async function* () {
    await propose.promise
    yield { type: "tool_call", callId: "send", name: "send", arguments: {}, respond: async () => {} }
    yield { type: "text_delta", delta: "Sent the original request." }
    yield { type: "done" }
  } }, [tool(async () => { writes++; return { accepted: true } })], { cancelGate: cancelled.promise })
  try {
    const turn = await work.runtime.text({ text: "Send the original request", deviceId: "mac" })
    work.push(0); work.push(0.9)
    await until(() => work.promotions.length === 1)
    propose.resolve()
    await until(() => work.store.items("listening").some((item) => item.type === "function_call"))
    expect(writes).toBe(0)
    work.push(0); work.push(0)
    await Bun.sleep(1)
    expect(work.listener.busy).toBe(true)
    expect(writes).toBe(0)
    expect(work.events.some((event) => event.type === "output_resumed")).toBe(false)
    cancelled.resolve(); await work.listener.idle(); await work.runtime.idle(); await work.runtime.drained(turn.responseId)
    expect(writes).toBe(1)
    expect(work.store.revision("listening")).toBe(1)
    expect([...work.recognizers.values()].every(({ finished }) => finished === 0)).toBe(true)
    expect(work.events.some((event) => event.type === "output_resumed")).toBe(true)
    expect(work.errors).toEqual([])
  } finally { propose.resolve(); cancelled.resolve(); await work.close() }
})

test("a delayed promotion cannot commit a false onset or open a second recording before cancellation releases the first", async () => {
  const opened = deferred<ListeningRecording>()
  const released = deferred()
  const inputs: Array<ListeningCaptureInput> = []
  const starts: Array<string> = [], cancels: Array<string> = []
  const errors: Array<Error> = []
  let sent = 0
  const listener = new Listening({ deviceId: "mac", endpoint,
    runtime: { start: ({ captureId }) => { starts.push(captureId) }, cancel: ({ captureId }) => { cancels.push(captureId) } },
    record: async (input) => {
      inputs.push(input)
      return inputs.length === 1 ? opened.promise : { seal: async () => {}, send: async () => { sent++; return undefined }, cancel: async () => {} }
    }, onError: (error) => { errors.push(error) },
  })
  const push = (sequence: number, probability: number) => listener.push({ sequence, probability, frame: new Float32Array(512) })
  try {
    push(0, 0.9); await until(() => inputs.length === 1)
    push(1, 0); push(2, 0)
    push(3, 0.9); push(4, 0.9); push(5, 0); push(6, 0)
    expect(starts).toHaveLength(2)
    expect(inputs).toHaveLength(1)
    opened.resolve({ seal: async () => {}, send: async () => { sent++; return undefined }, cancel: async () => released.promise })
    await Bun.sleep(1)
    expect(inputs).toHaveLength(1)
    released.resolve(); await listener.idle()
    expect(inputs).toHaveLength(2)
    expect(inputs[1]?.fromSequence).toBe(1)
    expect(cancels).toEqual([starts[0]!])
    expect(sent).toBe(1)
    expect(errors).toEqual([])
  } finally { released.resolve(); opened.resolve({ seal: async () => {}, send: async () => undefined, cancel: async () => {} }); await listener.close() }
})

test("closing after the native seal aborts recognition and prevents a late transcript from committing", async () => {
  const decoded = deferred()
  let requests = 0
  const work = fixture({ stream: async function* () { requests++; yield { type: "done" } } }, [], { recognitionGate: decoded.promise })
  try {
    work.push(0.9); work.push(0.9); work.push(0); work.push(0)
    await until(() => [...work.recognizers.values()].some(({ finished }) => finished === 1))
    await work.listener.close()
    expect([...work.recognizers.values()].every(({ aborted }) => aborted)).toBe(true)
    decoded.resolve(); await work.runtime.idle()
    expect(requests).toBe(0)
    expect(work.store.revision("listening")).toBe(0)
    expect(work.listeningEvents.some((event) => event.type === "committed")).toBe(false)
    expect(work.errors).toEqual([])
  } finally { decoded.resolve(); await work.close() }
})

test("missing frames and duration limits cancel capture without finalizing a partial utterance", async () => {
  for (const kind of ["gap", "limit"] as const) {
    const calls: Array<string> = []
    const errors: Array<Error> = []
    const listener = new Listening({ deviceId: "mac", endpoint, ...(kind === "limit" ? { maxCaptureMs: 96 } : {}),
      runtime: { start: () => { calls.push("onset") }, cancel: ({ reason }) => { calls.push(reason === "error" ? "abandon:error" : "abandon") } },
      record: async () => ({ seal: async () => { calls.push("seal") }, send: async () => { calls.push("send"); return undefined }, cancel: async () => { calls.push("native-cancel") } }),
      onError: (error) => { errors.push(error) },
    })
    try {
      listener.push({ sequence: 0, probability: 0.9, frame: new Float32Array(512) })
      await Bun.sleep(0)
      listener.push({ sequence: kind === "gap" ? 2 : 1, probability: 0.9, frame: new Float32Array(512) })
      if (kind === "limit") listener.push({ sequence: 2, probability: 0.9, frame: new Float32Array(512) })
      await listener.idle()
      expect(calls).toEqual(["onset", "abandon:error", "native-cancel"])
      expect(errors).toHaveLength(1)
    } finally { await listener.close() }
  }
})
