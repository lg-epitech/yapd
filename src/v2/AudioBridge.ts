import { Effect, Exit, Scope, Stream } from "effect"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Audio, PCMRequest } from "../Audio.ts"
import * as Voice from "../Voice.ts"
import type { PCMFrame, PCMPosition, SpeechOutputOptions, SpeechPlayer } from "./Speech.ts"

const abortError = () => new DOMException("Speech audio was aborted.", "AbortError")
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw abortError() }
const supportedRate = (rate: number): PCMRequest["rate"] => {
  if (rate !== 16_000 && rate !== 24_000 && rate !== 48_000) throw new Error("Speech playback requires mono 16, 24 or 48 kHz audio.")
  return rate
}

/** Keeps the native stream's Effect scope alive until drain or its stop receipt. */
export const createAudioPlayer = (audio: Pick<Audio["Type"], "stream">, options: {
  readonly deviceIdFor?: (responseId: string) => string | undefined
} = {}): SpeechPlayer => ({
  open: async (request, signal) => {
    checkSignal(signal)
    if (audio.stream === undefined) throw new Error("The selected device cannot stream speech audio.")
    const rate = supportedRate(request.rate)
    const deviceId = request.deviceId ?? options.deviceIdFor?.(request.responseId)
    const scope = await Effect.runPromise(Scope.make())
    let close: Promise<void> | undefined
    const closeScope = () => close ??= Effect.runPromise(Scope.close(scope, Exit.void))
    try {
      const playback = await Effect.runPromise(audio.stream({ id: request.responseId, generation: request.generation, rate,
        ...(deviceId === undefined ? {} : { deviceId }),
      }).pipe(Scope.extend(scope)), { signal })
      let samples = 0
      let ended = false
      let stopped: Promise<PCMPosition> | undefined
      let ending: Promise<PCMPosition> | undefined
      let latest: PCMPosition = { samples: 0, rate, certainty: "unknown" }
      const stop = (): Promise<PCMPosition> => stopped ??= (async () => {
        try { latest = await Effect.runPromise(playback.stop); return latest } finally {
          ended = true; signal.removeEventListener("abort", onAbort); await closeScope()
        }
      })()
      const onAbort = () => { void stop().catch(() => {}) }
      await Effect.runPromise(Stream.runForEach(playback.progress, (position) => Effect.sync(() => {
        latest = position
        request.onProgress(position)
      })).pipe(Effect.forkIn(scope)))
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) { await stop(); throw abortError() }
      return {
        write: async (pcm16) => {
          checkSignal(signal)
          if (ended || stopped !== undefined || ending !== undefined) throw new Error("The speech audio stream is closed.")
          if (pcm16.length % 2 !== 0) throw new Error("Speech PCM16 contains an incomplete sample.")
          await Effect.runPromise(playback.write(pcm16), { signal })
          samples += pcm16.length / 2
        },
        end: () => ending ??= (async () => {
          checkSignal(signal)
          if (ended || stopped !== undefined) throw new Error("The speech audio stream has stopped.")
          try {
            // Audio.end succeeds only on the native stream-finished receipt for
            // every submitted sample. Generation completion cannot settle it.
            await Effect.runPromise(playback.end, { signal })
            latest = { samples, rate, certainty: "rendered" }
            ended = true
            return latest
          } finally {
            signal.removeEventListener("abort", onAbort)
            await closeScope()
          }
        })(),
        stop,
      }
    } catch (error) { await closeScope(); throw error }
  },
})

interface Wave {
  readonly rate: PCMRequest["rate"]
  readonly format: 1 | 3
  readonly bits: 16 | 32
  readonly data: Uint8Array
  readonly pcm16: Uint8Array
}

const tag = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))

/** Strictly decodes the mono PCM16/Float32 WAV formats produced by local Voice. */
const decodeWave = (bytes: Uint8Array): Wave => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE" || view.getUint32(4, true) + 8 > bytes.length) throw new Error("Synthesis returned an invalid or truncated WAV file.")
  let format: Uint8Array | undefined
  let data: Uint8Array | undefined
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true)
    if (offset + 8 + length > bytes.length) throw new Error("Synthesis returned a truncated WAV chunk.")
    const id = tag(bytes, offset)
    if (id === "fmt ") {
      if (format !== undefined) throw new Error("Synthesis returned multiple WAV formats.")
      format = bytes.subarray(offset + 8, offset + 8 + length)
    }
    if (id === "data") {
      if (data !== undefined) throw new Error("Synthesis returned multiple WAV data chunks.")
      data = bytes.subarray(offset + 8, offset + 8 + length)
    }
    offset += 8 + length + (length % 2)
  }
  if (format === undefined || format.length < 16 || data === undefined) throw new Error("Synthesis returned a WAV without its format or samples.")
  const fmt = new DataView(format.buffer, format.byteOffset, format.byteLength)
  let encoding = fmt.getUint16(0, true)
  const channels = fmt.getUint16(2, true)
  const rate = supportedRate(fmt.getUint32(4, true))
  const bits = fmt.getUint16(14, true)
  if (encoding === 0xfffe) {
    const guidTail = [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
    if (format.length < 40 || fmt.getUint16(16, true) < 22 || fmt.getUint16(18, true) !== bits || guidTail.some((byte, index) => format![28 + index] !== byte)) throw new Error("Synthesis returned an unsupported extensible WAV format.")
    encoding = fmt.getUint32(24, true)
  }
  if (channels !== 1 || !((encoding === 1 && bits === 16) || (encoding === 3 && bits === 32))) throw new Error("Synthesis must produce mono PCM16 or Float32 WAV audio.")
  const frame = bits / 8
  if (fmt.getUint16(12, true) !== frame || fmt.getUint32(8, true) !== rate * frame || data.length % frame !== 0) throw new Error("Synthesis returned invalid WAV sample framing.")
  const pcm16 = encoding === 1 ? data.slice() : new Uint8Array(data.length / 2)
  if (encoding === 3) {
    const floats = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const shorts = new DataView(pcm16.buffer)
    for (let sample = 0; sample < data.length / 4; sample++) {
      const value = floats.getFloat32(sample * 4, true)
      if (!Number.isFinite(value)) throw new Error("Synthesis returned a non-finite audio sample.")
      const clipped = Math.max(-1, Math.min(1, value))
      shorts.setInt16(sample * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true)
    }
  }
  return { rate, format: encoding as 1 | 3, bits: bits as 16 | 32, data, pcm16 }
}

export interface VoiceSynthesizerOptions {
  /** Temporary parent directory; each phrase owns and removes a private child. */
  readonly directory?: string
  readonly chunkSamples?: number
  readonly maxWavBytes?: number
}

/**
 * Adapts Voice.early's actual first-prefix/whole files to ordered PCM. This is
 * file-prefix synthesis, not a claim that Kokoro accepts incremental text.
 */
export const createVoiceSynthesizer = (voice: Voice.Voice["Type"], options: VoiceSynthesizerOptions = {}): SpeechOutputOptions["synthesize"] => {
  const chunkSamples = options.chunkSamples ?? 4096
  const maxBytes = options.maxWavBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples < 1 || chunkSamples > 64_000) throw new Error("The speech PCM chunk limit is invalid.")
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 44) throw new Error("The synthesis WAV size limit is invalid.")
  const read = async (path: string, signal: AbortSignal): Promise<Wave> => {
    checkSignal(signal)
    if ((await stat(path)).size > maxBytes) throw new Error("Synthesis exceeded its WAV size limit.")
    const bytes = await readFile(path, { signal })
    checkSignal(signal)
    if (bytes.length > maxBytes) throw new Error("Synthesis exceeded its WAV size limit.")
    return decodeWave(bytes)
  }
  return async function* (text, signal): AsyncIterable<PCMFrame> {
    checkSignal(signal)
    const directory = await mkdtemp(join(options.directory ?? tmpdir(), "yapd-v2-voice-"))
    const scope = await Effect.runPromise(Scope.make())
    let closed: Promise<void> | undefined
    const cleanup = () => closed ??= Effect.runPromise(Scope.close(scope, Exit.void)).finally(() => rm(directory, { recursive: true, force: true }))
    const onAbort = () => { void cleanup().catch(() => {}) }
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      checkSignal(signal)
      const path = join(directory, "speech.wav")
      // startRender reuses Voice.early and owns both the first and whole files,
      // including first paths outside this directory supplied by a renderer.
      const render = await Effect.runPromise(Voice.startRender(voice, text, path, scope), { signal })
      const firstPath = await Effect.runPromise(render.first, { signal })
      const first = await read(firstPath, signal)
      for (let at = 0; at < first.pcm16.length; at += chunkSamples * 2) {
        checkSignal(signal)
        yield { pcm16: first.pcm16.slice(at, at + chunkSamples * 2), rate: first.rate }
      }
      await Effect.runPromise(render.whole, { signal })
      checkSignal(signal)
      if (firstPath !== path) {
        const whole = await read(path, signal)
        if (whole.rate !== first.rate || whole.format !== first.format || whole.bits !== first.bits) throw new Error("Synthesis changed audio format after its first prefix.")
        if (whole.data.length < first.data.length || first.data.some((byte, index) => whole.data[index] !== byte)) throw new Error("Synthesis whole audio did not preserve its first prefix exactly.")
        for (let at = first.pcm16.length; at < whole.pcm16.length; at += chunkSamples * 2) {
          checkSignal(signal)
          yield { pcm16: whole.pcm16.slice(at, at + chunkSamples * 2), rate: whole.rate }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort)
      await cleanup()
    }
  }
}
