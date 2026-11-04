import type { SessionEvent } from "./Types.ts"
import { hasFormatting, spokenText } from "./SpokenText.ts"

export interface Transcript {
  /** A complete replacement of the previous prefix, never an append-only delta. */
  readonly text: string
  readonly samples: number
  readonly revision: number
  readonly mode: "prefix_upload" | "native_streaming"
  readonly requestMs: number
}

export interface Recognition extends Transcript {
  readonly durationMs: number
  readonly finalizationMs: number
  readonly reusedPrefix: boolean
}

/** One capture. Only finish() returns text that may become a committed turn. */
export interface Recognizer {
  readonly push: (frame: Float32Array) => void
  readonly finish: () => Promise<Recognition>
  readonly abort: () => void
}

export interface HttpRecognizerOptions {
  readonly url: string
  readonly fetch?: typeof fetch
  readonly language?: string
  readonly context?: string
  readonly partialIntervalMs?: number
  readonly minPartialAudioMs?: number
  readonly maxAudioMs?: number
  readonly timeoutMs?: number
  readonly onPartial?: (transcript: Transcript) => void
  readonly onError?: (error: Error) => void
}

const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
const aborted = () => new DOMException("The speech capture was aborted.", "AbortError")
const positive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`)
  return value
}

/** PCM16 mono WAV for the existing /v1/transcribe multipart endpoint. */
const wav = (frames: ReadonlyArray<Float32Array>, samples: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
  ascii(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, "data"); view.setUint32(40, samples * 2, true)
  let at = 44
  for (const frame of frames) for (const sample of frame) {
    const clipped = Math.max(-1, Math.min(1, sample))
    view.setInt16(at, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true)
    at += 2
  }
  return bytes
}

/**
 * A control path using repeated full-prefix uploads, NOT model-native incremental
 * inference. Uploads are serialized and coalesced while a newer prefix arrives.
 */
export const createHttpRecognizer = (options: HttpRecognizerOptions): Recognizer => {
  const interval = positive(options.partialIntervalMs ?? 750, "partialIntervalMs")
  const minimum = positive(options.minPartialAudioMs ?? 400, "minPartialAudioMs") * 16
  const maximum = positive(options.maxAudioMs ?? 180_000, "maxAudioMs") * 16
  const timeout = positive(options.timeoutMs ?? 30_000, "timeoutMs")
  const controller = new AbortController()
  const frames: Array<Float32Array> = []
  let samples = 0
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: { samples: number; result: Promise<Transcript> } | undefined
  let last: Transcript | undefined
  let finish: Promise<Recognition> | undefined
  let finishing = false
  let failure: Error | undefined
  let lastStarted = -Infinity
  const notifyError = (error: unknown) => { try { options.onError?.(errorOf(error)) } catch { /* Observer errors must not orphan an upload. */ } }
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const assertOpen = () => {
    if (controller.signal.aborted) throw aborted()
    if (failure !== undefined) throw failure
  }
  const request = (): Promise<Transcript> => {
    assertOpen()
    const count = samples
    const snapshot = [...frames]
    const requestRevision = ++revision
    lastStarted = performance.now()
    const requestStart = lastStarted
    const result = (async () => {
      const form = new FormData()
      form.set("file", new Blob([wav(snapshot, count)], { type: "audio/wav" }), "capture.wav")
      if (options.language !== undefined) form.set("language", options.language)
      if (options.context !== undefined) form.set("context", options.context)
      const response = await (options.fetch ?? fetch)(options.url, {
        method: "POST", body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
      })
      if (!response.ok) throw new Error(`ASR request failed (${response.status}).`)
      const body: unknown = await response.json()
      assertOpen()
      if (typeof body !== "object" || body === null || !("text" in body) || typeof body.text !== "string") throw new Error("ASR returned no transcript text.")
      const transcript: Transcript = { text: body.text, samples: count, revision: requestRevision, mode: "prefix_upload", requestMs: performance.now() - requestStart }
      last = transcript
      return transcript
    })()
    flight = { samples: count, result }
    return result
  }
  const schedule = () => {
    if (finishing || controller.signal.aborted || failure !== undefined || samples < minimum || last?.samples === samples || timer !== undefined || flight !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (finishing || controller.signal.aborted) return
      const currentCount = samples
      const current = request()
      void current.then((transcript) => {
        // Prefixes are revisions, including when text changes completely.
        if (!finishing && !controller.signal.aborted) {
          try { options.onPartial?.(transcript) } catch (error) { notifyError(error) }
        }
      }, (error: unknown) => {
        if (!controller.signal.aborted && !finishing) notifyError(error)
      }).finally(() => {
        if (flight?.result === current) flight = undefined
        // Retry only when more audio arrived, not forever on an unchanged error.
        if (samples !== (last?.samples ?? 0) && samples !== currentCount) schedule()
      })
    }, Math.max(0, interval - (performance.now() - lastStarted)))
  }
  return {
    push: (frame) => {
      assertOpen()
      if (finishing) throw new Error("The speech capture is already finishing.")
      if (samples + frame.length > maximum) {
        failure = new Error("The speech capture exceeded its audio limit; it was not truncated.")
        clear(); controller.abort(); throw failure
      }
      if (frame.some((sample) => !Number.isFinite(sample))) throw new Error("Audio frames must contain finite samples.")
      if (frame.length === 0) return
      frames.push(frame.slice()); samples += frame.length
      schedule()
    },
    finish: () => {
      if (finish !== undefined) return finish
      finishing = true; clear()
      const start = performance.now()
      finish = (async () => {
        assertOpen()
        if (samples === 0) throw new Error("The speech capture contains no audio.")
        let transcript: Transcript | undefined
        let reusedPrefix = false
        if (flight !== undefined) {
          const current = flight
          try { transcript = await current.result } catch (error) { if (current.samples === samples || controller.signal.aborted) throw error }
          if (flight === current) flight = undefined
          reusedPrefix = transcript?.samples === samples
        }
        assertOpen()
        if (last?.samples === samples) { transcript = last; reusedPrefix = true }
        if (transcript?.samples !== samples) { transcript = await request(); flight = undefined }
        assertOpen()
        return { ...transcript, durationMs: samples / 16, finalizationMs: performance.now() - start, reusedPrefix }
      })()
      return finish
    },
    abort: () => { clear(); controller.abort(); frames.length = 0 },
  }
}

export interface PCMFrame { readonly pcm16: Uint8Array; readonly rate: number }
export interface PCMPosition { readonly samples: number; readonly rate: number; readonly certainty: "rendered" | "estimated" | "unknown" }
export interface SpeechPlayback {
  readonly write: (pcm16: Uint8Array) => Promise<void>
  /** Resolve only after the device has drained, with its final receipt. */
  readonly end: () => Promise<PCMPosition>
  readonly stop: () => Promise<PCMPosition>
}
export interface SpeechPlayer {
  readonly open: (request: { readonly responseId: string; readonly generation: number; readonly rate: number; readonly deviceId?: string; readonly onProgress: (position: PCMPosition) => void }, signal: AbortSignal) => Promise<SpeechPlayback>
}
export type PlaybackEvent = Extract<SessionEvent, { type: "playback" }>
export interface SpeechOutputOptions {
  readonly synthesize: (text: string, signal: AbortSignal) => AsyncIterable<PCMFrame>
  /** Missing client support is reported as an error, never a successful playback. */
  readonly player?: SpeechPlayer
  readonly onPlayback: (event: PlaybackEvent) => void
  readonly onError: (error: Error, responseId: string) => void
  readonly maxPendingCharacters?: number
  readonly maxPhraseCharacters?: number
  readonly maxResponseCharacters?: number
}
export interface SpeechOutput {
  readonly accept: (event: SessionEvent) => void
  /** Resolves on real drain; rejects on cancellation or unavailable playback. */
  readonly drained: (responseId: string) => Promise<void>
  readonly close: () => Promise<void>
}

interface Output {
  readonly id: string
  raw: string
  projected: number
  /** Only the speakable projection is synthesized, indexed and reported as heard. */
  text: string
  done: boolean
  suspended: boolean
  terminal: boolean
  cursor: number
  heard: number
  playedMs: number
  generation: number
  resumeVersion: number
  controller: AbortController
  playback?: SpeechPlayback
  opening?: Promise<SpeechPlayback>
  stopping?: Promise<void>
  task?: Promise<void>
  sent: number
  position?: PCMPosition
  marks: Array<{ samples: number; character: number }>
  rate?: number
  readonly result: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

const phraseEnd = (text: string, from: number, maximum: number, done: boolean): number => {
  const tail = text.slice(from)
  const boundary = /[.!?;:](?:["')\]]*)(?:\s+|$)|\n+/.exec(tail)
  if (boundary !== null && boundary.index + boundary[0].length <= maximum) return from + boundary.index + boundary[0].length
  if (tail.length > maximum) {
    const space = tail.lastIndexOf(" ", maximum)
    if (space > 0) return from + space + 1
    // A very long token must still have a finite synthesis input.
    return from + maximum
  }
  return done ? text.length : from
}

/** One PCM owner with response-generation cancellation and phrase-level receipts. */
export const createSpeechOutput = (options: SpeechOutputOptions): SpeechOutput => {
  const maxPending = positive(options.maxPendingCharacters ?? 8_000, "maxPendingCharacters")
  const maxPhrase = positive(options.maxPhraseCharacters ?? 240, "maxPhraseCharacters")
  const maxResponse = positive(options.maxResponseCharacters ?? 64_000, "maxResponseCharacters")
  const outputs = new Map<string, Output>()
  let current: Output | undefined
  let owner: Promise<void> = Promise.resolve()
  let closed = false
  const valid = (state: Output, generation: number) => !closed && current === state && !state.suspended && !state.terminal && state.generation === generation && !state.controller.signal.aborted
  const receipt = (state: Output, position: PCMPosition, kind: PlaybackEvent["state"]) => {
    if (!Number.isSafeInteger(position.samples) || position.samples < 0 || position.rate !== state.rate || position.samples > state.sent || (state.position?.certainty === "rendered" && position.samples < state.position.samples)) throw new Error("The player returned an invalid playback position.")
    state.position = position
    if (position.certainty === "rendered") for (const mark of state.marks) if (mark.samples <= position.samples) state.heard = Math.max(state.heard, mark.character)
    options.onPlayback({ type: "playback", responseId: state.id, playedMs: state.playedMs + position.samples / position.rate * 1000, state: kind,
      certainty: position.certainty === "rendered" && state.marks.some((mark) => mark.samples === position.samples) ? "exact" : "approximate",
      playedText: state.text.slice(0, state.heard),
    })
  }
  const halt = (state: Output, reason: Error, terminal: boolean): Promise<void> => {
    state.suspended = true
    state.controller.abort(reason)
    if (terminal) { state.terminal = true; state.reject(reason) }
    const unplayed = () => {
      if (terminal && state.sent === 0) options.onPlayback({ type: "playback", responseId: state.id, playedMs: state.playedMs, state: "interrupted", certainty: "exact", playedText: state.text.slice(0, state.heard) })
    }
    if (state.stopping !== undefined) return state.stopping.then(unplayed)
    const playback = state.playback
    const opening = state.opening
    const stopping = (async () => {
      const handle = playback ?? await opening?.catch(() => undefined)
      if (handle !== undefined) {
        const position = await handle.stop()
        receipt(state, position, "interrupted")
        state.playedMs += position.samples / position.rate * 1000
      } else {
        // No player was opened: cancellation is known, rather than an
        // unconfirmed playback that looks like it might still be pending.
        unplayed()
      }
      delete state.playback; delete state.opening
    })()
    state.stopping = stopping
    // A new owner may not open until the old device has stopped.
    owner = Promise.all([owner, stopping]).then(() => undefined)
    void owner.catch((error: unknown) => options.onError(errorOf(error), state.id))
    return stopping
  }
  const fail = (state: Output, error: unknown) => {
    const failure = errorOf(error)
    if (state.terminal) return
    options.onError(failure, state.id)
    void halt(state, failure, true).catch(() => {})
  }
  const checkBounds = (state: Output) => {
    if (state.raw.length > maxResponse || state.raw.length - state.projected + state.text.length - state.heard > maxPending) throw new Error("Pending speech exceeded its limit.")
  }
  const project = (state: Output) => {
    const tail = state.raw.slice(state.projected)
    if (hasFormatting(tail)) {
      if (!state.done) return
      const spoken = spokenText(tail)
      // The parser removes paragraph-leading whitespace. Keep a boundary
      // between an already streamed sentence and a later formatted section.
      if (state.text !== "" && !/\s$/.test(state.text) && spoken !== "") state.text += " "
      state.text += spoken
      state.projected = state.raw.length
      return
    }
    // Plain replies keep their normal incremental latency. Only stable phrases
    // advance the raw cursor, so later Markdown cannot revise a spoken prefix.
    for (;;) {
      const end = phraseEnd(state.raw, state.projected, maxPhrase, state.done)
      if (end === state.projected) return
      state.text += state.raw.slice(state.projected, end)
      state.projected = end
    }
  }
  const kick = (state: Output) => {
    if (state.task !== undefined || !valid(state, state.generation)) return
    const generation = state.generation
    const signal = state.controller.signal
    const work = (async () => {
      await owner
      while (valid(state, generation)) {
        const end = phraseEnd(state.text, state.cursor, maxPhrase, state.done)
        if (end === state.cursor) break
        const phrase = state.text.slice(state.cursor, end)
        if (phrase.trim() === "") { state.cursor = end; continue }
        let produced = false
        for await (const frame of options.synthesize(phrase, signal)) {
          if (!valid(state, generation)) return
          if (!Number.isSafeInteger(frame.rate) || frame.rate <= 0 || frame.pcm16.length % 2 !== 0) throw new Error("Synthesis returned invalid PCM16 audio.")
          if (frame.pcm16.length === 0) continue
          if (state.rate !== undefined && state.rate !== frame.rate) throw new Error("Synthesis changed sample rate within a response.")
          state.rate = frame.rate
          if (state.playback === undefined) {
            if (options.player === undefined) throw new Error("The selected device cannot stream speech audio.")
            state.opening = options.player.open({ responseId: state.id, generation, rate: frame.rate, onProgress: (position) => {
              if (valid(state, generation)) { try { receipt(state, position, "playing") } catch (error) { fail(state, error) } }
            } }, signal)
            state.playback = await state.opening
            if (!valid(state, generation)) return
          }
          // Count before write: a player may acknowledge synchronously within it.
          state.sent += frame.pcm16.length / 2
          await state.playback.write(frame.pcm16)
          if (!valid(state, generation)) return
          produced = true
        }
        if (!valid(state, generation)) return
        if (!produced) throw new Error("Synthesis returned no audio for a speech phrase.")
        state.cursor = end
        state.marks.push({ samples: state.sent, character: end })
        if (state.position !== undefined) receipt(state, state.position, "playing")
      }
      if (!valid(state, generation) || !state.done || state.cursor !== state.text.length) return
      if (state.playback !== undefined) {
        const position = await state.playback.end()
        if (!valid(state, generation)) return
        if (position.certainty !== "rendered" || position.samples !== state.sent) throw new Error("The player ended without confirming audio drain.")
        receipt(state, position, "finished")
      } else if (state.heard > 0 && state.text.slice(state.heard).trim() === "") {
        // A false onset can stop an already rendered phrase before the model's
        // done event. Resuming that response needs no duplicate audio.
        state.heard = state.text.length
        options.onPlayback({ type: "playback", responseId: state.id, playedMs: state.playedMs, state: "finished", certainty: "exact", playedText: state.text })
      } else if (state.text.trim() !== "") throw new Error("No speech audio was played.")
      else options.onPlayback({ type: "playback", responseId: state.id, playedMs: state.playedMs, state: "finished", certainty: "exact", playedText: "" })
      state.terminal = true; state.resolve()
    })()
    state.task = work
    void work.catch((error: unknown) => { if (valid(state, generation)) fail(state, error) }).finally(() => {
      if (state.task === work) delete state.task
      // Events may have arrived after the worker observed the buffer boundary.
      if (valid(state, generation) && (phraseEnd(state.text, state.cursor, maxPhrase, state.done) > state.cursor || state.done)) kick(state)
    })
  }
  const make = (id: string): Output => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const result = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void result.catch(() => {})
    const state: Output = { id, raw: "", projected: 0, text: "", done: false, suspended: false, terminal: false, cursor: 0, heard: 0, playedMs: 0, generation: 0, resumeVersion: 0, controller: new AbortController(), sent: 0, marks: [], result, resolve, reject }
    outputs.set(id, state)
    // Keep receipt lookup bounded; the active response is never evicted.
    if (outputs.size > 32) for (const [key, old] of outputs) if (old !== current && old.terminal) { outputs.delete(key); break }
    return state
  }
  const activate = (id: string): Output => {
    if (current?.id === id) return current
    if (current !== undefined && !current.terminal) void halt(current, new Error("Speech was superseded."), true).catch(() => {})
    current = outputs.get(id) ?? make(id)
    return current
  }
  return {
    accept: (event) => {
      if (closed) return
      try {
        switch (event.type) {
          case "response_started": if (!outputs.get(event.responseId)?.terminal) activate(event.responseId); break
          case "text_delta": {
            // Late output from a superseded response cannot reclaim the player.
            if (outputs.get(event.responseId)?.terminal) return
            if (current !== undefined && current.id !== event.responseId) return
            const state = activate(event.responseId)
            state.raw += event.delta; checkBounds(state); project(state); kick(state); break
          }
          case "response_done": {
            if (current !== undefined && current.id !== event.responseId) return
            const state = outputs.get(event.responseId) ?? activate(event.responseId)
            if (state.terminal) return
            if (event.text !== state.raw) {
              if (!event.text.startsWith(state.raw)) throw new Error("Final response revised text that was already sent to speech.")
              state.raw = event.text
            }
            state.done = true; checkBounds(state); project(state); kick(state); break
          }
          case "output_cancelled": {
            const state = outputs.get(event.responseId)
            if (state === undefined || state.terminal) return
            state.resumeVersion++
            if (state.suspended && event.reason === "onset") return
            void halt(state, new Error(`Speech was interrupted (${event.reason}).`), event.reason !== "onset").catch(() => {})
            break
          }
          case "output_resumed": {
            const state = outputs.get(event.responseId)
            if (state === undefined || state.terminal || !state.suspended || current !== state) return
            const version = ++state.resumeVersion
            // Restore withheld text before newer model deltas can append while
            // the old device's stop receipt is still in flight.
            if (!event.text.startsWith(state.raw) && !state.raw.startsWith(event.text)) throw new Error("Resumed response changed its generated prefix.")
            if (event.text.length > state.raw.length) state.raw = event.text
            checkBounds(state)
            // Wait for the stopped-device receipt before choosing a phrase boundary.
            void owner.then(() => {
              if (closed || current !== state || state.terminal || state.resumeVersion !== version) return
              state.cursor = state.heard; state.sent = 0; state.marks = []
              delete state.position; delete state.rate; delete state.task
              delete state.stopping
              state.generation++; state.controller = new AbortController(); state.suspended = false
              checkBounds(state); project(state); kick(state)
            }).catch((error: unknown) => fail(state, error))
            break
          }
          case "error": {
            if (event.responseId !== undefined && current?.id === event.responseId) fail(current, new Error(event.message))
            break
          }
        }
      } catch (error) { if (current !== undefined) fail(current, error) }
    },
    drained: (id) => outputs.get(id)?.result ?? Promise.reject(new Error("There is no speech response with that ID.")),
    close: async () => {
      if (closed) return
      closed = true
      if (current !== undefined && !current.terminal) await halt(current, new Error("Speech output was closed."), true)
      await owner
    },
  }
}
