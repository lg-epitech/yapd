import { describe, expect, test } from "bun:test"
import { createHttpRecognizer, createSpeechOutput, type PCMPosition, type PlaybackEvent, type SpeechPlayer } from "./Speech.ts"
import type { SessionEvent } from "./Types.ts"

const deferred = <A = void>() => {
  let resolve!: (value: A | PromiseLike<A>) => void
  const promise = new Promise<A>((yes) => { resolve = yes })
  return { promise, resolve }
}
const until = async (ready: () => boolean) => {
  const start = performance.now()
  while (!ready()) {
    if (performance.now() - start > 1500) throw new Error("The test condition did not arrive.")
    await Bun.sleep(1)
  }
}
const audio = (samples: number) => new Float32Array(samples).fill(0.25)

const asr = (respond: (samples: number, index: number, request: Request) => Promise<Response> | Response) => {
  const requests: Array<number> = []
  const uploads: Array<Uint8Array> = []
  let active = 0
  let maximum = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    expect(new URL(request.url).pathname).toBe("/v1/transcribe")
    expect(request.method).toBe("POST")
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) return new Response("missing audio", { status: 400 })
    expect(["audio/wav", "audio/x-wav"]).toContain(file.type)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF")
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    const samples = view.getUint32(40, true) / 2
    expect(bytes.length).toBe(44 + samples * 2)
    uploads.push(bytes)
    requests.push(samples)
    active++; maximum = Math.max(maximum, active)
    try { return await respond(samples, requests.length - 1, request) } finally { active-- }
  } })
  return { url: `http://127.0.0.1:${server.port}/v1/transcribe`, requests, uploads, maximum: () => maximum, close: () => server.stop(true) }
}

describe("V2 HTTP speech recognition", () => {
  test("a prompt longer than one minute reaches final recognition intact", async () => {
    const fixture = asr(() => Response.json({ text: "A complete long prompt, including its final correction." }))
    try {
      const capture = createHttpRecognizer({ url: fixture.url })
      for (let frame = 0; frame < 2032; frame++) capture.push(audio(512))
      const samples = 2032 * 512
      expect(await capture.finish()).toMatchObject({ samples, durationMs: samples / 16, text: "A complete long prompt, including its final correction." })
      expect(fixture.requests).toEqual([samples])
    } finally { fixture.close() }
  })

  test("manual finalization sends real multipart PCM WAV and preserves the intact transcript", async () => {
    const fixture = asr(() => Response.json({ text: "  Yes, but don't send it.  " }))
    try {
      const capture = createHttpRecognizer({ url: fixture.url, minPartialAudioMs: 1000 })
      const frame = new Float32Array([1, -1, 0.5, -0.5])
      capture.push(frame); frame.fill(0)
      const result = await capture.finish()
      expect(result).toMatchObject({ text: "  Yes, but don't send it.  ", mode: "prefix_upload", samples: 4, durationMs: 0.25, reusedPrefix: false })
      expect(result.requestMs).toBeGreaterThanOrEqual(0)
      expect(fixture.requests).toEqual([4])
      const bytes = fixture.uploads[0]!
      const view = new DataView(bytes.buffer)
      expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([32767, -32768, 16384])
      expect(capture.finish()).toBe(capture.finish())
      expect(() => capture.push(audio(1))).toThrow("already finishing")
    } finally { fixture.close() }
  })

  test("coalesces newer prefixes behind one upload and reuses the exact in-flight final request", async () => {
    const first = deferred()
    const second = deferred()
    const partials: Array<string> = []
    const fixture = asr(async (_samples, index) => {
      await (index === 0 ? first.promise : second.promise)
      return Response.json({ text: index === 0 ? "Yes" : "Yes, but only the French tests." })
    })
    try {
      const capture = createHttpRecognizer({ url: fixture.url, partialIntervalMs: 5, minPartialAudioMs: 1, onPartial: (item) => { partials.push(item.text) } })
      capture.push(audio(160))
      await until(() => fixture.requests.length === 1)
      capture.push(audio(320)); capture.push(audio(640))
      await Bun.sleep(8)
      expect(fixture.requests).toEqual([160])
      first.resolve()
      await until(() => fixture.requests.length === 2)
      const final = capture.finish()
      second.resolve()
      const result = await final
      expect(result).toMatchObject({ samples: 1120, revision: 2, text: "Yes, but only the French tests.", reusedPrefix: true })
      expect(partials).toEqual(["Yes"])
      expect(fixture.requests).toEqual([160, 1120])
      expect(fixture.maximum()).toBe(1)
    } finally { first.resolve(); second.resolve(); fixture.close() }
  })

  test("prefix transcripts replace earlier hypotheses; an already decoded final prefix needs no upload", async () => {
    const partials: Array<{ text: string; revision: number }> = []
    const fixture = asr((_samples, index) => Response.json({ text: index === 0 ? "Send it" : "Don't send it" }))
    try {
      const capture = createHttpRecognizer({ url: fixture.url, partialIntervalMs: 2, minPartialAudioMs: 1, onPartial: (item) => { partials.push(item) } })
      capture.push(audio(160)); await until(() => partials.length === 1)
      capture.push(audio(160)); await until(() => partials.length === 2)
      expect(partials.map(({ text, revision }) => ({ text, revision }))).toEqual([{ text: "Send it", revision: 1 }, { text: "Don't send it", revision: 2 }])
      expect(await capture.finish()).toMatchObject({ text: "Don't send it", reusedPrefix: true })
      expect(fixture.requests).toHaveLength(2)
    } finally { fixture.close() }
  })

  test("finishing during an older prefix waits, then uploads the complete audio", async () => {
    const release = deferred()
    const fixture = asr(async (_samples, index) => { if (index === 0) await release.promise; return Response.json({ text: index === 0 ? "only" : "only French" }) })
    try {
      const capture = createHttpRecognizer({ url: fixture.url, partialIntervalMs: 2, minPartialAudioMs: 1 })
      capture.push(audio(160)); await until(() => fixture.requests.length === 1)
      capture.push(audio(160)); const final = capture.finish(); release.resolve()
      expect(await final).toMatchObject({ text: "only French", samples: 320, reusedPrefix: false })
      expect(fixture.requests).toEqual([160, 320]); expect(fixture.maximum()).toBe(1)
    } finally { release.resolve(); fixture.close() }
  })

  test("abort rejects finalization and discards a late partial response", async () => {
    const release = deferred()
    const partials: Array<string> = []
    const fixture = asr(async () => { await release.promise; return Response.json({ text: "stale" }) })
    try {
      const capture = createHttpRecognizer({ url: fixture.url, partialIntervalMs: 2, minPartialAudioMs: 1, onPartial: ({ text }) => { partials.push(text) } })
      capture.push(audio(160)); await until(() => fixture.requests.length === 1)
      capture.abort(); release.resolve()
      await expect(capture.finish()).rejects.toThrow("aborted")
      await Bun.sleep(5)
      expect(partials).toEqual([])
      expect(() => capture.push(audio(1))).toThrow("aborted")
    } finally { release.resolve(); fixture.close() }
  })

  test("bounds audio without truncation and reports HTTP, invalid data, and timeout errors", async () => {
    const bounded = createHttpRecognizer({ url: "http://127.0.0.1:1", maxAudioMs: 1 })
    expect(() => bounded.push(audio(17))).toThrow("not truncated")
    const invalid = createHttpRecognizer({ url: "http://127.0.0.1:1" })
    expect(() => invalid.push(new Float32Array([NaN]))).toThrow("finite")
    await expect(invalid.finish()).rejects.toThrow("no audio")
    const fixture = asr((_samples, index) => index === 0 ? new Response("private details", { status: 503 }) : Response.json({ wrong: "shape" }))
    try {
      for (const message of ["503", "no transcript"]) {
        const capture = createHttpRecognizer({ url: fixture.url }); capture.push(audio(1))
        await expect(capture.finish()).rejects.toThrow(message)
      }
    } finally { fixture.close() }
    const release = deferred()
    const slow = asr(async () => { await release.promise; return Response.json({ text: "late" }) })
    try {
      const capture = createHttpRecognizer({ url: slow.url, timeoutMs: 15 }); capture.push(audio(1))
      await expect(capture.finish()).rejects.toThrow()
    } finally { release.resolve(); slow.close() }
  })
})

const delta = (text: string, responseId = "r"): SessionEvent => ({ type: "text_delta", turnId: "u", responseId, delta: text })
const done = (text: string, responseId = "r"): SessionEvent => ({ type: "response_done", turnId: "u", responseId, text })
const player = (options: { readonly drain?: ReturnType<typeof deferred<PCMPosition>>; readonly rendered?: boolean; readonly stopSamples?: number } = {}) => {
  const opened: Array<{ responseId: string; generation: number; chunks: Array<Array<number>>; sent: number; ended: boolean; stopped: boolean }> = []
  const implementation: SpeechPlayer = { open: async (request) => {
    const state = { responseId: request.responseId, generation: request.generation, chunks: [] as Array<Array<number>>, sent: 0, ended: false, stopped: false }
    opened.push(state)
    const position = (samples = state.sent): PCMPosition => ({ samples, rate: request.rate, certainty: "rendered" })
    return {
      write: async (bytes) => {
        if (state.stopped) throw new Error("write after stop")
        state.chunks.push([...bytes]); state.sent += bytes.length / 2
        if (options.rendered) request.onProgress(position())
      },
      end: async () => { state.ended = true; return options.drain === undefined ? position() : options.drain.promise },
      stop: async () => { state.stopped = true; return position(options.stopSamples ?? state.sent) },
    }
  } }
  return { implementation, opened }
}

describe("V2 local speech output", () => {
  test("Cryptio bold status labels split across model deltas never reach synthesis as markup", async () => {
    const device = player()
    const phrases: string[] = []
    const events: PlaybackEvent[] = []
    const output = createSpeechOutput({ player: device.implementation, onPlayback: (event) => { events.push(event) }, onError: () => {}, synthesize: async function* (text) {
      phrases.push(text); yield { pcm16: new Uint8Array([1, 0]), rate: 16_000 }
    } })
    const raw = "- **Solana errors:** Errors fell from 17–32k to 170.\n- **RTG migrations:** Unichain is blocked by DATA-3064; !272 is still a draft."
    try {
      for (const character of raw) {
        output.accept(delta(character))
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      output.accept(done(raw)); await output.drained("r")
      const spoken = phrases.join("")
      expect(spoken).not.toContain("*")
      expect(spoken).not.toMatch(/(?:^|\n)\s*- /)
      expect(spoken).toContain("Solana errors:")
      expect(spoken).toContain("RTG migrations:")
      for (const fact of ["17–32k", "170", "DATA-3064", "!272", "still a draft"]) expect(spoken).toContain(fact)
      expect(events.at(-1)).toMatchObject({ state: "finished", playedText: spoken })
    } finally { await output.close() }
  })

  test("streams stable phrases before response completion, preserves chunk order, and waits for real drain", async () => {
    const drain = deferred<PCMPosition>()
    const device = player({ drain })
    const phrases: Array<string> = []
    const events: Array<PlaybackEvent> = []
    const errors: Array<Error> = []
    const output = createSpeechOutput({ player: device.implementation, onPlayback: (event) => { events.push(event) }, onError: (error) => { errors.push(error) }, synthesize: async function* (text) {
      phrases.push(text); yield { pcm16: new Uint8Array([1, 0, 2, 0]), rate: 16_000 }; yield { pcm16: new Uint8Array([3, 0]), rate: 16_000 }
    } })
    output.accept(delta("The tests pass. "))
    await until(() => device.opened[0]?.chunks.length === 2)
    expect(phrases).toEqual(["The tests pass. "])
    expect(device.opened[0]?.ended).toBe(false)
    let finished = false
    const finishedPromise = output.drained("r").then(() => { finished = true })
    output.accept(delta("I checked the receipts.")); output.accept(done("The tests pass. I checked the receipts."))
    await until(() => device.opened[0]?.ended === true)
    expect(device.opened).toHaveLength(1)
    expect(device.opened[0]?.chunks).toEqual([[1, 0, 2, 0], [3, 0], [1, 0, 2, 0], [3, 0]])
    expect(finished).toBe(false)
    drain.resolve({ samples: 6, rate: 16_000, certainty: "rendered" })
    await finishedPromise
    expect(events.at(-1)).toMatchObject({ state: "finished", certainty: "exact", playedText: "The tests pass. I checked the receipts." })
    expect(errors).toEqual([])
    await output.close()
  })

  test("formatted speech resumes using spoken phrase offsets and never replays raw markup", async () => {
    const device = player({ rendered: true })
    const phrases: string[] = []
    const events: PlaybackEvent[] = []
    const blocked = deferred()
    let calls = 0
    const output = createSpeechOutput({ player: device.implementation, onPlayback: (event) => { events.push(event) }, onError: () => {}, synthesize: async function* (text) {
      phrases.push(text); calls++
      if (calls === 2) await blocked.promise
      yield { pcm16: new Uint8Array([calls, 0]), rate: 16_000 }
    } })
    const raw = "**Solana is fixed.** **RTG is blocked.**"
    try {
      output.accept(delta(raw)); output.accept(done(raw))
      await until(() => calls === 2)
      output.accept({ type: "output_cancelled", responseId: "r", reason: "onset" })
      await until(() => device.opened[0]?.stopped === true)
      expect(events.at(-1)?.playedText).toBe("Solana is fixed. ")
      output.accept({ type: "output_resumed", responseId: "r", text: raw })
      await output.drained("r"); blocked.resolve()
      expect(phrases).toEqual(["Solana is fixed. ", "RTG is blocked.", "RTG is blocked."])
      expect(events.at(-1)).toMatchObject({ state: "finished", playedText: "Solana is fixed. RTG is blocked." })
    } finally { blocked.resolve(); await output.close() }
  })

  test("an already streamed sentence stays separated from a later formatted section", async () => {
    const phrases: string[] = []
    const output = createSpeechOutput({ player: player().implementation, onPlayback: () => {}, onError: () => {}, synthesize: async function* (text) {
      phrases.push(text); yield { pcm16: new Uint8Array([1, 0]), rate: 16_000 }
    } })
    try {
      output.accept(delta("Here is the status.")); await until(() => phrases.length === 1)
      output.accept(delta("\n\n- **Solana:** fixed.\n- **RTG:** blocked."))
      expect(phrases).toEqual(["Here is the status."])
      output.accept(done("Here is the status.\n\n- **Solana:** fixed.\n- **RTG:** blocked.")); await output.drained("r")
      expect(phrases.join("")).toBe("Here is the status. Solana: fixed.\nRTG: blocked.")
    } finally { await output.close() }
  })

  test("formatting-only replies finish without synthesizing punctuation", async () => {
    const events: PlaybackEvent[] = []
    const output = createSpeechOutput({ onPlayback: (event) => { events.push(event) }, onError: () => {}, synthesize: async function* () { throw new Error("Nothing should be spoken") } })
    try {
      output.accept(delta("---\n")); output.accept(done("---\n")); await output.drained("r")
      expect(events.at(-1)).toMatchObject({ state: "finished", playedText: "", certainty: "exact" })
    } finally { await output.close() }
  })

  test("false onset resumes from a confirmed phrase boundary and rejects old synthesis chunks", async () => {
    const oldRelease = deferred()
    const device = player({ rendered: true })
    const phrases: Array<string> = []
    const events: Array<PlaybackEvent> = []
    let call = 0
    const output = createSpeechOutput({ player: device.implementation, onPlayback: (event) => { events.push(event) }, onError: () => {}, synthesize: async function* (text) {
      const index = ++call; phrases.push(text)
      yield { pcm16: new Uint8Array([index, 0]), rate: 16_000 }
      if (index === 2) { await oldRelease.promise; yield { pcm16: new Uint8Array([99, 0]), rate: 16_000 } }
    } })
    output.accept(delta("First. ")); await until(() => events.some((event) => event.playedText === "First. "))
    output.accept(delta("Second.")); await until(() => call === 2 && device.opened[0]?.chunks.length === 2)
    output.accept({ type: "output_cancelled", responseId: "r", reason: "onset" })
    await until(() => device.opened[0]?.stopped === true)
    expect(events.at(-1)).toMatchObject({ state: "interrupted", playedText: "First. " })
    output.accept({ type: "output_resumed", responseId: "r", text: "First. Second." })
    output.accept(done("First. Second."))
    await output.drained("r")
    oldRelease.resolve(); await Bun.sleep(2)
    expect(phrases).toEqual(["First. ", "Second.", "Second."])
    expect(device.opened.map(({ chunks }) => chunks)).toEqual([[[1, 0], [2, 0]], [[3, 0]]])
    expect(events.at(-1)).toMatchObject({ state: "finished", playedText: "First. Second." })
    await output.close()
  })

  test("supersession stops old playback before a new owner opens and ignores late old deltas", async () => {
    const gate = deferred()
    const device = player()
    const output = createSpeechOutput({ player: device.implementation, onPlayback: () => {}, onError: () => {}, synthesize: async function* (text) {
      yield { pcm16: new Uint8Array([1, 0]), rate: 24_000 }
      if (text === "Old.") { await gate.promise; yield { pcm16: new Uint8Array([9, 0]), rate: 24_000 } }
    } })
    output.accept(delta("Old.", "old")); await until(() => device.opened[0]?.chunks.length === 1)
    output.accept({ type: "response_started", turnId: "new-turn", responseId: "new" })
    output.accept(delta("New.", "new")); output.accept(done("New.", "new"))
    await output.drained("new")
    await expect(output.drained("old")).rejects.toThrow("superseded")
    gate.resolve(); output.accept(delta(" Late.", "old")); await Bun.sleep(2)
    expect(device.opened.map(({ responseId, stopped }) => ({ responseId, stopped }))).toEqual([{ responseId: "old", stopped: true }, { responseId: "new", stopped: false }])
    expect(device.opened[0]?.chunks).toEqual([[1, 0]])
    await output.close()
  })

  test("an in-phrase position reports only the certain completed prefix", async () => {
    const release = deferred()
    const device = player({ stopSamples: 1 })
    const events: Array<PlaybackEvent> = []
    const output = createSpeechOutput({ player: device.implementation, onPlayback: (event) => { events.push(event) }, onError: () => {}, synthesize: async function* () {
      yield { pcm16: new Uint8Array([1, 0, 2, 0]), rate: 16_000 }; await release.promise
    } })
    output.accept(delta("A whole phrase.")); await until(() => device.opened[0]?.chunks.length === 1)
    output.accept({ type: "output_cancelled", responseId: "r", reason: "superseded" })
    await until(() => events.length > 0)
    expect(events.at(-1)).toMatchObject({ state: "interrupted", certainty: "approximate", playedText: "", playedMs: 1 / 16 })
    release.resolve(); await output.close()
  })

  test("false onset after an already heard phrase finishes without replaying it", async () => {
    const device = player({ rendered: true })
    const events: Array<PlaybackEvent> = []
    const errors: Array<string> = []
    const output = createSpeechOutput({ player: device.implementation, onPlayback: (event) => { events.push(event) }, onError: (error) => { errors.push(error.message) }, synthesize: async function* () {
      yield { pcm16: new Uint8Array([1, 0]), rate: 16_000 }
    } })
    output.accept(delta("Already heard."))
    await until(() => events.some((event) => event.playedText === "Already heard."))
    output.accept({ type: "output_cancelled", responseId: "r", reason: "onset" })
    await until(() => device.opened[0]?.stopped === true)
    output.accept({ type: "output_resumed", responseId: "r", text: "Already heard." })
    output.accept(done("Already heard."))
    await output.drained("r")
    expect(device.opened).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ state: "finished", playedText: "Already heard.", certainty: "exact" })
    expect(errors).toEqual([])
    await output.close()
  })

  test("a second onset invalidates a resume waiting on the first stop receipt", async () => {
    const stopped = deferred<PCMPosition>()
    const synthesis = deferred()
    let opens = 0
    let stopCalls = 0
    const output = createSpeechOutput({ player: { open: async () => {
      opens++
      return { write: async () => {}, end: async () => ({ samples: 1, rate: 16_000, certainty: "rendered" }), stop: async () => { stopCalls++; return stopped.promise } }
    } }, onPlayback: () => {}, onError: () => {}, synthesize: async function* () {
      yield { pcm16: new Uint8Array([1, 0]), rate: 16_000 }
      if (opens === 1) await synthesis.promise
    } })
    output.accept(delta("Still speaking.")); await until(() => opens === 1)
    output.accept({ type: "output_cancelled", responseId: "r", reason: "onset" })
    output.accept({ type: "output_resumed", responseId: "r", text: "Still speaking." })
    output.accept({ type: "output_cancelled", responseId: "r", reason: "onset" })
    stopped.resolve({ samples: 0, rate: 16_000, certainty: "rendered" })
    await Bun.sleep(2)
    expect(opens).toBe(1); expect(stopCalls).toBe(1)
    output.accept({ type: "output_resumed", responseId: "r", text: "Still speaking." })
    output.accept(done("Still speaking."))
    await output.drained("r")
    synthesis.resolve()
    expect(opens).toBe(2)
    await output.close()
  })

  test("a model error closes unfinished speech rather than leaving a pending drain", async () => {
    const errors: Array<string> = []
    const output = createSpeechOutput({ synthesize: async function* () {}, onPlayback: () => {}, onError: (error) => { errors.push(error.message) } })
    output.accept(delta("An unfinished fragment"))
    output.accept({ type: "error", responseId: "r", message: "The model disconnected." })
    await expect(output.drained("r")).rejects.toThrow("disconnected")
    expect(errors).toEqual(["The model disconnected."])
    await output.close()
  })

  test("bounds speech backlog and exposes missing streaming devices, empty synthesis, and unconfirmed drain", async () => {
    const cases = [
      { player: undefined, synthesize: async function* () { yield { pcm16: new Uint8Array([1, 0]), rate: 16_000 } }, message: "cannot stream" },
      { player: player().implementation, synthesize: async function* () {}, message: "no audio" },
      { player: { open: async () => ({ write: async () => {}, end: async () => ({ samples: 1, rate: 16_000, certainty: "estimated" as const }), stop: async () => ({ samples: 0, rate: 16_000, certainty: "unknown" as const }) }) }, synthesize: async function* () { yield { pcm16: new Uint8Array([1, 0]), rate: 16_000 } }, message: "confirming audio drain" },
    ]
    for (const fixture of cases) {
      const errors: Array<string> = []
      const output = createSpeechOutput({ ...(fixture.player === undefined ? {} : { player: fixture.player }), synthesize: fixture.synthesize, onPlayback: () => {}, onError: (error) => { errors.push(error.message) } })
      output.accept(delta("Speak.")); output.accept(done("Speak."))
      await expect(output.drained("r")).rejects.toThrow(fixture.message)
      expect(errors).toHaveLength(1)
      await output.close()
    }
    const errors: Array<string> = []
    const output = createSpeechOutput({ maxPendingCharacters: 8, synthesize: async function* () {}, onPlayback: () => {}, onError: (error) => { errors.push(error.message) } })
    output.accept(delta("Too much pending speech"))
    await expect(output.drained("r")).rejects.toThrow("limit")
    expect(errors).toHaveLength(1)
    await output.close()
  })
})
