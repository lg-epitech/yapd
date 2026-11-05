import type { Recognition, Recognizer, Transcript } from "./Speech.ts"

export interface StreamingRecognizerOptions {
  /** Self-hosted NeMo-Speech.cpp v0.3.0 /v1/audio/transcriptions/realtime. */
  readonly url: string
  readonly language?: "en" | "fr" | "auto"
  readonly maxAudioMs?: number
  readonly maxBufferedAudioMs?: number
  readonly connectTimeoutMs?: number
  readonly finalTimeoutMs?: number
  /** Transport injection for deterministic buffer tests, not a model provider. */
  readonly socket?: (url: string) => WebSocket
  /**
   * Reserved for a future full-hypothesis protocol. v0.3.0's delta sometimes
   * means replacement and has no reset flag, so this adapter emits no partial
   * text. Incremental model inference still runs while audio is sent.
   */
  readonly onPartial?: (transcript: Transcript) => void
  readonly onError?: (error: Error) => void
}

const positive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`)
  return value
}
const failure = (value: unknown) => value instanceof Error ? value : new Error(String(value))
const abortError = () => new DOMException("The streaming speech capture was aborted.", "AbortError")

/**
 * Native cache-aware recognition, with one socket per capture and manual commit.
 * Run its server with asr.endpointing.enable=false. A premature final is refused;
 * endpointing_ms=0 is NOT a documented way to disable server-side endpointing.
 */
export const createStreamingRecognizer = (options: StreamingRecognizerOptions): Recognizer => {
  const url = new URL(options.url)
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username !== "" || url.password !== "") throw new Error("Streaming ASR requires a self-hosted ws:// or wss:// endpoint without URL credentials.")
  const maxSamples = positive(options.maxAudioMs ?? 180_000, "maxAudioMs") * 16
  const maxBuffered = positive(options.maxBufferedAudioMs ?? 5_000, "maxBufferedAudioMs") * 32
  const connectTimeout = positive(options.connectTimeoutMs ?? 5_000, "connectTimeoutMs")
  const finalTimeout = positive(options.finalTimeoutMs ?? 15_000, "finalTimeoutMs")
  const language = options.language === "en" ? "en-US" : options.language === "fr" ? "fr-FR" : "auto"
  const started = performance.now()
  let samples = 0
  let queuedBytes = 0
  const queue: Array<Uint8Array> = []
  let created = false
  let ready = false
  let finishing = false
  let commitSent = false
  let settled = false
  let finishStarted = 0
  let finalText: string | undefined
  let error: Error | undefined
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  let resolve!: (result: Recognition) => void
  let reject!: (error: Error) => void
  const result = new Promise<Recognition>((yes, no) => { resolve = yes; reject = no })
  void result.catch(() => {})
  const socket = (options.socket ?? ((address) => new WebSocket(address)))(url.href)
  const cleanup = (reason: string) => {
    clearTimeout(connectionTimer)
    if (finishTimer !== undefined) clearTimeout(finishTimer)
    if (drainTimer !== undefined) clearTimeout(drainTimer)
    queue.length = 0; queuedBytes = 0
    socket.onmessage = null; socket.onerror = null; socket.onclose = null
    try { socket.close(1000, reason) } catch { /* Closing a failed transport is best effort. */ }
  }
  const fail = (cause: unknown, notify = true) => {
    if (settled) return
    error = failure(cause); settled = true
    cleanup("capture failed"); reject(error)
    if (notify) { try { options.onError?.(error) } catch { /* Observers cannot revive a failed capture. */ } }
  }
  const connectionTimer = setTimeout(() => fail(new Error("Streaming ASR did not establish its session before the connection timeout.")), connectTimeout)
  const assertCapturing = () => {
    if (error !== undefined) throw error
    if (finishing || settled) throw new Error("The streaming speech capture is already finishing.")
  }
  const send = (message: object) => socket.send(JSON.stringify(message))
  const flush = () => {
    if (settled || !ready) return
    if (drainTimer !== undefined) { clearTimeout(drainTimer); drainTimer = undefined }
    try {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("The streaming ASR connection closed before audio could be delivered.")
      if (queuedBytes + socket.bufferedAmount > maxBuffered) throw new Error("Streaming ASR exceeded its outgoing audio buffer limit; audio was not truncated.")
      while (queue.length > 0) {
        const chunk = queue[0]!
        if (socket.bufferedAmount + chunk.length > maxBuffered) break
        socket.send(chunk)
        queue.shift(); queuedBytes -= chunk.length
      }
      if (queue.length === 0 && finishing && !commitSent) {
        // WebSocket message ordering keeps this after every complete audio frame.
        commitSent = true
        send({ type: "input_audio_buffer.commit" })
      }
      if (queue.length > 0) drainTimer = setTimeout(flush, 10)
    } catch (cause) { fail(cause) }
  }
  socket.onmessage = (message) => {
    if (settled) return
    try {
      if (typeof message.data !== "string" || message.data.length > 256 * 1024) throw new Error("Streaming ASR returned an invalid control message.")
      const event: unknown = JSON.parse(message.data)
      if (typeof event !== "object" || event === null || !("type" in event) || typeof event.type !== "string") throw new Error("Streaming ASR returned an invalid event.")
      switch (event.type) {
        case "session.created": {
          if (created || ready) throw new Error("Streaming ASR created its session more than once.")
          created = true
          send({ type: "session.update", session: { sample_rate: 16_000, language, verbatim: true, automatic_punctuation: true } })
          break
        }
        case "session.updated": {
          if (!created || ready || !("session" in event) || typeof event.session !== "object" || event.session === null || !("sample_rate" in event.session) || event.session.sample_rate !== 16_000 || !("language" in event.session) || event.session.language !== language) throw new Error("Streaming ASR did not acknowledge the requested audio session.")
          ready = true; clearTimeout(connectionTimer); flush()
          break
        }
        case "conversation.item.input_audio_transcription.delta": {
          if (!ready || !("delta" in event) || typeof event.delta !== "string") throw new Error("Streaming ASR returned an invalid provisional transcript.")
          // v0.3.0 does not distinguish a suffix from a revised full hypothesis.
          // Never concatenate, strip or guess at these provisional words.
          break
        }
        case "conversation.item.input_audio_transcription.completed": {
          if (!commitSent) throw new Error("Streaming ASR finalized before manual Send; disable server-side endpointing.")
          if (finalText !== undefined) throw new Error("Streaming ASR returned multiple final transcripts for one manual capture.")
          if (!("transcript" in event) || typeof event.transcript !== "string" || event.transcript.length > 64_000) throw new Error("Streaming ASR returned an invalid final transcript.")
          finalText = event.transcript
          break
        }
        case "input_audio_buffer.committed": {
          if (!commitSent || finalText === undefined) throw new Error("Streaming ASR acknowledged commit without its final transcript.")
          settled = true
          const now = performance.now()
          cleanup("capture complete")
          resolve({ text: finalText, samples, revision: 1, mode: "native_streaming", requestMs: now - started, durationMs: samples / 16, finalizationMs: now - finishStarted, reusedPrefix: false })
          break
        }
        case "error": {
          // Do not surface provider response bodies or credentials to observers.
          const code = "error" in event && typeof event.error === "object" && event.error !== null && "code" in event.error && typeof event.error.code === "string" ? event.error.code : "unavailable"
          throw new Error(`Streaming ASR failed (${code.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}).`)
        }
        default: throw new Error("Streaming ASR returned an unsupported event.")
      }
    } catch (cause) { fail(cause) }
  }
  socket.onerror = () => fail(new Error("The streaming ASR connection failed."))
  socket.onclose = () => fail(new Error("The streaming ASR connection closed before the final commit receipt."))
  return {
    push: (frame) => {
      assertCapturing()
      if (frame.some((sample) => !Number.isFinite(sample))) throw new Error("Streaming audio frames must contain finite samples.")
      if (samples + frame.length > maxSamples) { fail(new Error("The streaming capture exceeded its audio limit; audio was not truncated.")); throw error }
      if (frame.length === 0) return
      if (queuedBytes + socket.bufferedAmount + frame.length * 2 > maxBuffered) { fail(new Error("Streaming ASR exceeded its outgoing audio buffer limit; audio was not truncated.")); throw error }
      const bytes = new Uint8Array(frame.length * 2)
      const view = new DataView(bytes.buffer)
      for (let sample = 0; sample < frame.length; sample++) {
        const value = Math.max(-1, Math.min(1, frame[sample]!))
        view.setInt16(sample * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      samples += frame.length; queue.push(bytes); queuedBytes += bytes.length
      flush()
    },
    finish: () => {
      if (finishing || settled) return result
      if (samples === 0) { fail(new Error("The streaming speech capture contains no audio.")); return result }
      finishing = true; finishStarted = performance.now()
      finishTimer = setTimeout(() => fail(new Error("Streaming ASR did not return a complete manual-commit receipt before the finalization timeout.")), finalTimeout)
      flush()
      return result
    },
    abort: () => {
      if (settled) return
      if (ready && socket.readyState === WebSocket.OPEN) { try { send({ type: "input_audio_buffer.clear" }) } catch { /* The following close releases its capture state. */ } }
      fail(abortError(), false)
    },
  }
}
