import { expect, test } from "bun:test"
import { Runtime, type RuntimeEvent } from "./Runtime.ts"
import { Session } from "./Session.ts"
import { Store } from "./Store.ts"
import { createNotificationTools } from "./NotificationTools.ts"
import type { Recognition } from "./Speech.ts"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}
const until = async (ready: () => boolean) => {
  const deadline = performance.now() + 1000
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("The expected playback transition did not arrive.")
    await Bun.sleep(1)
  }
}
const fact = (key: string) => ({ key, id: `${key}:1`, version: 1, eligible: true })

/** Real Session/Runtime/Speech; only the model, PCM and physical player are fixtures. */
const fixture = (catchup = false, options: { readonly generationGate?: Promise<void>; readonly failInitialSpeech?: boolean; readonly stopGate?: Promise<void> } = {}) => {
  const store = new Store()
  const events: RuntimeEvent[] = []
  const opens: string[] = []
  const ends: Array<() => void> = []
  let calls = 0
  let gate: ReturnType<typeof deferred> | undefined
  let entered = deferred(), returned = deferred()
  let failResume = false
  let failInitial = options.failInitialSpeech === true
  const stopping = deferred()
  const session = new Session({ conversationId: "resume", store, tools: createNotificationTools(store, "resume"), model: { stream: async function* () {
    if (catchup) yield { type: "tool_call", name: "report_updates", callId: "report", arguments: { ids: [fact("first").id] }, respond: async () => {} }
    const first = calls++ === 0
    yield { type: "text_delta", delta: first ? "The tests passed." : "Another update arrived." }
    if (first && options.generationGate !== undefined) { await options.generationGate; yield { type: "text_delta", delta: " Final verification finished." } }
    yield { type: "done" }
  } } })
  const runtime = new Runtime({ session, recognize: () => ({ push() {}, abort() {}, finish: () => new Promise<Recognition>(() => {}) }), speech: {
    synthesize: async function* () {
      if (failInitial) { failInitial = false; throw new Error("Initial speech failed") }
      const waiting = gate
      if (waiting !== undefined) { gate = undefined; entered.resolve(); await waiting.promise }
      try {
        if (waiting !== undefined && failResume) { failResume = false; throw new Error("Resumed synthesis failed") }
        yield { rate: 16_000, pcm16: new Uint8Array([1, 0, 2, 0]) }
      } finally { if (waiting !== undefined) returned.resolve() }
    },
    player: { open: async (request) => {
      opens.push(request.responseId)
      let sent = 0, rendered = 0, stops = 0
      const position = (samples: number) => ({ samples, rate: request.rate, certainty: "rendered" as const })
      return {
        write: async (bytes) => { sent += bytes.length / 2; request.onProgress(position(0)) },
        end: () => new Promise((resolve) => { ends.push(() => { rendered = sent; resolve(position(rendered)) }) }),
        stop: async () => { if (++stops === 1 && options.stopGate !== undefined) { stopping.resolve(); await options.stopGate }; return position(rendered) },
      }
    } },
  }, onEvent: (event) => { events.push(event) } })
  return { runtime, session, store, events, opens, ends, stopping: stopping.promise,
    hold: (failure = false) => {
      const held = deferred(); gate = held; entered = deferred(); returned = deferred(); failResume = failure
      return { entered: entered.promise, returned: returned.promise, release: held.resolve }
    },
    finish: () => { for (const end of ends.splice(0)) end() },
    close: async () => { await runtime.close(); for (const end of ends.splice(0)) end(); store.close() },
  }
}

test("a speech failure during live generation followed by a false onset cannot stall later notifications", async () => {
  const generation = deferred()
  const work = fixture(false, { generationGate: generation.promise, failInitialSpeech: true })
  try {
    const first = await work.runtime.text({ text: "Check the current work.", deviceId: "mac" })
    await until(() => work.store.getPlayback("resume", first.responseId)?.state === "interrupted")
    work.runtime.start({ captureId: "noise", deviceId: "mac" })
    work.runtime.cancel({ captureId: "noise" })
    generation.resolve(); await work.runtime.idle()
    work.runtime.external({ eventId: "later", text: "A later completion.", notification: fact("later") })
    expect((await work.runtime.wake({ notificationId: fact("later").id, deviceId: "mac" })).status).toBe("started")
  } finally { generation.resolve(); await work.close() }
})

test("a late stop receipt cannot disarm source invalidation of a resumed notification", async () => {
  const stop = deferred()
  const work = fixture(false, { stopGate: stop.promise })
  try {
    work.runtime.external({ eventId: "first", text: "The report is ready.", notification: fact("first") })
    const first = await work.runtime.wake({ notificationId: fact("first").id, deviceId: "mac" })
    await until(() => work.events.some((event) => event.type === "playback" && event.state === "playing"))
    await work.runtime.idle()
    work.runtime.start({ captureId: "noise", deviceId: "mac" })
    work.runtime.cancel({ captureId: "noise" })
    await work.stopping; stop.resolve()
    await until(() => work.ends.length === 2)
    const before = work.events.filter((event) => event.type === "output_cancelled" && event.reason === "superseded").length
    work.runtime.external({ eventId: "resumed-source", text: "That source resumed work.", notification: { key: "first", id: "first:2", version: 2, eligible: false } })
    expect(work.events.filter((event) => event.type === "output_cancelled" && event.reason === "superseded")).toHaveLength(before + 1)
    expect(work.store.pendingNotifications("resume").some(({ responseId }) => responseId === first.responseId)).toBe(false)
  } finally { stop.resolve(); await work.close() }
})

test("a second real onset or Stop during resume synthesis keeps the player closed", async () => {
  for (const action of ["onset", "stop"] as const) {
    const work = fixture()
    let held: ReturnType<typeof work.hold> | undefined
    try {
      work.runtime.external({ eventId: "first", text: "First completed.", notification: fact("first") })
      const first = await work.runtime.wake({ deviceId: "mac", notificationId: fact("first").id })
      await until(() => work.events.some((event) => event.type === "playback" && event.state === "playing"))
      await work.runtime.idle()
      work.runtime.start({ captureId: "noise", deviceId: "mac" })
      await until(() => work.store.getPlayback("resume", first.responseId!)?.state === "interrupted")
      held = work.hold()
      work.runtime.cancel({ captureId: "noise" })
      await held.entered
      const before = work.events.filter((event) => event.type === "output_cancelled").length
      if (action === "onset") work.runtime.start({ captureId: "real", deviceId: "mac" })
      else work.runtime.stop()
      expect(work.events.filter((event) => event.type === "output_cancelled")).toHaveLength(before + 1)
      held.release(); await held.returned
      expect(work.opens).toEqual([first.responseId!])
      if (action === "stop") expect(work.store.pendingNotifications("resume")).toEqual([])
    } finally { held?.release(); await work.close() }
  }
})

test("a queued notification waits through false-onset resume until real audio drain", async () => {
  const work = fixture()
  let held: ReturnType<typeof work.hold> | undefined
  try {
    work.runtime.external({ eventId: "first", text: "First completed.", notification: fact("first") })
    const first = await work.runtime.wake({ deviceId: "mac", notificationId: fact("first").id })
    await until(() => work.events.some((event) => event.type === "playback" && event.state === "playing"))
    await work.runtime.idle()
    work.runtime.external({ eventId: "second", text: "Second completed.", notification: fact("second") })
    expect((await work.runtime.wake({ deviceId: "phone", notificationId: fact("second").id })).status).toBe("queued")
    work.runtime.start({ captureId: "noise", deviceId: "mac" })
    await until(() => work.store.getPlayback("resume", first.responseId!)?.state === "interrupted")
    held = work.hold(); work.runtime.cancel({ captureId: "noise" })
    expect(work.events.filter((event) => event.type === "response_started")).toHaveLength(1)
    await held.entered; held.release(); await held.returned
    await until(() => work.ends.length === 2)
    expect(work.opens).toEqual([first.responseId!, first.responseId!])
    work.finish()
    await until(() => work.events.filter((event) => event.type === "response_started").length === 2)
  } finally { held?.release(); await work.close() }
})

test("synthesis failure during resume releases an independent queued notification", async () => {
  const work = fixture()
  let held: ReturnType<typeof work.hold> | undefined
  try {
    work.runtime.external({ eventId: "first", text: "First completed.", notification: fact("first") })
    const first = await work.runtime.wake({ deviceId: "mac", notificationId: fact("first").id })
    await until(() => work.events.some((event) => event.type === "playback" && event.state === "playing"))
    await work.runtime.idle()
    work.runtime.external({ eventId: "second", text: "Second completed.", notification: fact("second") })
    await work.runtime.wake({ deviceId: "phone", notificationId: fact("second").id })
    work.runtime.start({ captureId: "noise", deviceId: "mac" })
    await until(() => work.store.getPlayback("resume", first.responseId!)?.state === "interrupted")
    held = work.hold(true); work.runtime.cancel({ captureId: "noise" })
    await held.entered; held.release(); await held.returned
    await until(() => work.events.some((event) => event.type === "runtime_error" && event.responseId === first.responseId))
    await until(() => work.events.filter((event) => event.type === "response_started").length === 2)
    expect(work.store.pendingNotifications("resume").some(({ id }) => id === fact("first").id)).toBe(true)
  } finally { held?.release(); await work.close() }
})

test("Stop during a requested catch-up stops audio without dismissing its unheard facts", async () => {
  const work = fixture(true)
  try {
    work.runtime.external({ eventId: "off", text: "A retained off-time report.", notification: { ...fact("first"), automatic: false } })
    await work.runtime.text({ text: "Anything I missed?", deviceId: "mac" })
    await until(() => work.events.some((event) => event.type === "playback" && event.state === "playing"))
    work.runtime.stop()
    expect(work.store.pendingNotifications("resume").map(({ id }) => id)).toEqual([fact("first").id])
  } finally { await work.close() }
})
