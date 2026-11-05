import { describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { createStreamingRecognizer } from "./StreamingRecognizer.ts"

const until = async (ready: () => boolean) => {
  const started = performance.now()
  while (!ready()) {
    if (performance.now() - started > 1500) throw new Error("The streaming fixture did not reach its expected state.")
    await Bun.sleep(1)
  }
}
interface Connection {
  readonly socket: ServerWebSocket<undefined>
  readonly order: Array<string>
  readonly frames: Array<Uint8Array>
  session?: Record<string, unknown>
}
const send = (connection: Connection, event: unknown) => connection.socket.send(JSON.stringify(event))
const complete = (connection: Connection, transcript = "  Yes, but don't send it.  ") => {
  send(connection, { type: "conversation.item.input_audio_transcription.completed", transcript })
  send(connection, { type: "input_audio_buffer.committed" })
}
const fixture = (options: { readonly holdReady?: boolean; readonly commit?: (connection: Connection) => void; readonly updated?: (connection: Connection) => void } = {}) => {
  const connections: Array<Connection> = []
  const server = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => {
      expect(new URL(request.url).pathname).toBe("/v1/audio/transcriptions/realtime")
      return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 })
    },
    websocket: {
      open: (socket) => {
        const connection: Connection = { socket, order: [], frames: [] }
        connections.push(connection)
        send(connection, { type: "session.created", event_id: "created" })
      },
      message: (socket, message) => {
        const connection = connections.find((item) => item.socket === socket)!
        if (typeof message !== "string") { connection.order.push("audio"); connection.frames.push(new Uint8Array(message).slice()); return }
        const event = JSON.parse(message) as { type: string; session?: Record<string, unknown> }
        connection.order.push(event.type)
        if (event.type === "session.update") {
          connection.session = event.session!
          if (!options.holdReady) send(connection, { type: "session.updated", session: event.session })
          options.updated?.(connection)
        }
        if (event.type === "input_audio_buffer.commit") (options.commit ?? complete)(connection)
        if (event.type === "input_audio_buffer.clear") send(connection, { type: "input_audio_buffer.cleared" })
      },
    },
  })
  return { url: `ws://127.0.0.1:${server.port}/v1/audio/transcriptions/realtime`, connections, close: () => server.stop(true) }
}
const audio = (samples = 512) => new Float32Array(samples).fill(0.25)

describe("V2 native NeMo-Speech.cpp v0.3.0 recognizer", () => {
  test("buffers before readiness, sends intact ordered PCM before manual commit, and waits for both final and acknowledgment", async () => {
    const service = fixture({ holdReady: true, commit: () => {} })
    try {
      const capture = createStreamingRecognizer({ url: service.url, language: "fr" })
      const frame = new Float32Array([1, -1, 0.5])
      capture.push(frame); frame.fill(0); capture.push(new Float32Array([-0.5, 0]))
      const final = capture.finish()
      expect(capture.finish()).toBe(final)
      await until(() => service.connections[0]?.session !== undefined)
      const connection = service.connections[0]!
      expect(connection.session).toEqual({ sample_rate: 16_000, language: "fr-FR", verbatim: true, automatic_punctuation: true })
      expect(connection.frames).toEqual([])
      send(connection, { type: "session.updated", session: connection.session })
      await until(() => connection.order.includes("input_audio_buffer.commit"))
      expect(connection.order).toEqual(["session.update", "audio", "audio", "input_audio_buffer.commit"])
      const samples = connection.frames.flatMap((bytes) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        return Array.from({ length: bytes.length / 2 }, (_, index) => view.getInt16(index * 2, true))
      })
      expect(samples).toEqual([32767, -32768, 16384, -16384, 0])
      let settled = false
      void final.then(() => { settled = true })
      send(connection, { type: "conversation.item.input_audio_transcription.completed", transcript: "  Oui, mais ne l'envoie pas.  " })
      await Bun.sleep(2); expect(settled).toBe(false)
      send(connection, { type: "input_audio_buffer.committed" })
      expect(await final).toMatchObject({ text: "  Oui, mais ne l'envoie pas.  ", samples: 5, revision: 1, mode: "native_streaming", durationMs: 5 / 16, reusedPrefix: false })
      expect(() => capture.push(audio())).toThrow("finishing")
    } finally { service.close() }
  })

  test("does not guess whether ambiguous partial deltas append or replace; only the intact final is committed", async () => {
    const partials: Array<string> = []
    const service = fixture({ updated: (connection) => {
      send(connection, { type: "conversation.item.input_audio_transcription.delta", delta: "Send it" })
      send(connection, { type: "conversation.item.input_audio_transcription.delta", delta: "Don't send it" })
    } })
    try {
      const capture = createStreamingRecognizer({ url: service.url, language: "en", onPartial: ({ text }) => { partials.push(text) } })
      capture.push(audio())
      await until(() => service.connections[0]?.frames.length === 1)
      expect(service.connections[0]?.order).not.toContain("input_audio_buffer.commit")
      expect(partials).toEqual([])
      expect(await capture.finish()).toMatchObject({ text: "  Yes, but don't send it.  " })
      expect(service.connections[0]?.session?.language).toBe("en-US")
      expect(partials).toEqual([])
    } finally { service.close() }
  })

  test("rejects unsolicited endpointing, duplicate finals, and acknowledgment without a final", async () => {
    const early = fixture({ updated: (connection) => { send(connection, { type: "conversation.item.input_audio_transcription.completed", transcript: "Yes" }) } })
    try {
      const errors: Array<Error> = []
      const capture = createStreamingRecognizer({ url: early.url, onError: (error) => { errors.push(error) } }); capture.push(audio())
      await until(() => errors.length === 1)
      await expect(capture.finish()).rejects.toThrow("before manual Send")
    } finally { early.close() }
    for (const mode of ["duplicate", "missing"] as const) {
      const service = fixture({ commit: (connection) => {
        if (mode === "duplicate") for (let i = 0; i < 2; i++) send(connection, { type: "conversation.item.input_audio_transcription.completed", transcript: "A final" })
        send(connection, { type: "input_audio_buffer.committed" })
      } })
      try {
        const capture = createStreamingRecognizer({ url: service.url }); capture.push(audio())
        await expect(capture.finish()).rejects.toThrow(mode === "duplicate" ? "multiple final" : "without its final")
      } finally { service.close() }
    }
  })

  test("abort clears its own capture, rejects a late old final, and cannot contaminate a new socket", async () => {
    const service = fixture({ commit: () => {} })
    try {
      const old = createStreamingRecognizer({ url: service.url }); old.push(audio()); const oldFinal = old.finish()
      await until(() => service.connections[0]?.order.includes("input_audio_buffer.commit") === true)
      old.abort()
      await expect(oldFinal).rejects.toThrow("aborted")
      const current = createStreamingRecognizer({ url: service.url }); current.push(audio(128)); const currentFinal = current.finish()
      await until(() => service.connections[1]?.order.includes("input_audio_buffer.commit") === true)
      complete(service.connections[0]!, "Send everything")
      complete(service.connections[1]!, "Only the French tests")
      expect(await currentFinal).toMatchObject({ text: "Only the French tests", samples: 128 })
      expect(() => old.push(audio())).toThrow("aborted")
    } finally { service.close() }
  })

  test("bounds capture and connecting audio without dropping or truncating frames", async () => {
    for (const [options, message] of [
      [{ maxAudioMs: 1 }, "capture exceeded its audio limit"],
      [{ maxBufferedAudioMs: 1 }, "outgoing audio buffer limit"],
    ] as const) {
      const service = fixture({ holdReady: true })
      try {
        const errors: Array<string> = []
        const capture = createStreamingRecognizer({ url: service.url, ...options, onError: (error) => { errors.push(error.message) } })
        expect(() => capture.push(audio(17))).toThrow(message)
        await expect(capture.finish()).rejects.toThrow(message)
        expect(errors).toHaveLength(1)
        expect(service.connections.flatMap(({ frames }) => frames)).toEqual([])
      } finally { service.close() }
    }
  })

  test("includes the real socket's outstanding bytes in its backpressure budget", async () => {
    const service = fixture()
    try {
      const capture = createStreamingRecognizer({ url: service.url, maxBufferedAudioMs: 1, socket: (url) => {
        const socket = new WebSocket(url)
        Object.defineProperty(socket, "bufferedAmount", { get: () => 32 })
        return socket
      } })
      expect(() => capture.push(audio(1))).toThrow("outgoing audio buffer limit")
      await expect(capture.finish()).rejects.toThrow("outgoing audio buffer limit")
    } finally { service.close() }
  })

  test("connection and finalization timeouts fail closed, including a final with no acknowledgment", async () => {
    const waiting = fixture({ holdReady: true })
    try {
      const capture = createStreamingRecognizer({ url: waiting.url, connectTimeoutMs: 15 }); capture.push(audio())
      await expect(capture.finish()).rejects.toThrow("connection timeout")
    } finally { waiting.close() }
    const missing = fixture({ commit: (connection) => { send(connection, { type: "conversation.item.input_audio_transcription.completed", transcript: "No ack" }) } })
    try {
      const capture = createStreamingRecognizer({ url: missing.url, finalTimeoutMs: 20 }); capture.push(audio())
      await expect(capture.finish()).rejects.toThrow("finalization timeout")
    } finally { missing.close() }
  })

  test("reports server errors, disconnects, unknown events, and mismatched session formats", async () => {
    const cases = [
      { callback: (connection: Connection) => send(connection, { type: "error", error: { message: "private provider details", code: "resource_exhausted" } }), expected: "resource_exhausted" },
      { callback: (connection: Connection) => connection.socket.close(), expected: "closed before" },
      { callback: (connection: Connection) => send(connection, { type: "response.done" }), expected: "unsupported event" },
    ]
    for (const scenario of cases) {
      const service = fixture({ commit: scenario.callback })
      try {
        const errors: Array<string> = []
        const capture = createStreamingRecognizer({ url: service.url, onError: (error) => { errors.push(error.message) } }); capture.push(audio())
        await expect(capture.finish()).rejects.toThrow(scenario.expected)
        expect(errors).toHaveLength(1); expect(errors.join()).not.toContain("private provider details")
      } finally { service.close() }
    }
    const mismatch = fixture({ holdReady: true, updated: (connection) => { send(connection, { type: "session.updated", session: { ...connection.session, sample_rate: 24_000 } }) } })
    try {
      const capture = createStreamingRecognizer({ url: mismatch.url }); capture.push(audio())
      await expect(capture.finish()).rejects.toThrow("did not acknowledge")
    } finally { mismatch.close() }
  })

  test("silence may finalize empty, while absent audio and nonfinite PCM are explicit errors", async () => {
    const service = fixture({ commit: (connection) => complete(connection, "") })
    try {
      const silent = createStreamingRecognizer({ url: service.url }); silent.push(new Float32Array(128))
      expect(await silent.finish()).toMatchObject({ text: "", samples: 128 })
      expect(service.connections[0]?.session?.language).toBe("auto")
      const empty = createStreamingRecognizer({ url: service.url })
      await expect(empty.finish()).rejects.toThrow("no audio")
      const invalid = createStreamingRecognizer({ url: service.url })
      expect(() => invalid.push(new Float32Array([NaN]))).toThrow("finite")
      invalid.abort()
      await expect(invalid.finish()).rejects.toThrow("aborted")
    } finally { service.close() }
    expect(() => createStreamingRecognizer({ url: "https://localhost/asr" })).toThrow("ws://")
  })
})
