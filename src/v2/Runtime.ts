import { Session } from "./Session.ts"
import { createSpeechOutput, type Recognition, type Recognizer, type SpeechOutput, type SpeechOutputOptions, type Transcript } from "./Speech.ts"
import type { ExternalInput, SessionEvent, ThreadRef } from "./Types.ts"

export interface InputOrigin {
  readonly deviceId?: string
  readonly focus?: ThreadRef
}

export interface CaptureInput extends InputOrigin { readonly captureId: string }
export type CommitReceipt = Awaited<ReturnType<Session["commit"]>>
export type WakeReceipt = Awaited<ReturnType<Session["wake"]>>
export type RuntimeEvent = SessionEvent
  | { readonly type: "transcript_partial"; readonly captureId: string; readonly deviceId?: string; readonly transcript: Transcript }
  | { readonly type: "recognition_final"; readonly captureId: string; readonly deviceId?: string; readonly recognition: Recognition }
  | { readonly type: "runtime_error"; readonly captureId?: string; readonly responseId?: string; readonly message: string }

export interface RuntimeOptions {
  readonly session: Session
  readonly recognize: (input: CaptureInput & {
    readonly onPartial: (transcript: Transcript) => void
    readonly onError: (error: Error) => void
  }) => Recognizer
  readonly speech: Omit<SpeechOutputOptions, "onPlayback" | "onError">
  readonly onEvent?: (event: RuntimeEvent) => void
}

interface Capture {
  readonly input: CaptureInput
  readonly sequence: number
  readonly turnId: string
  readonly recognizer: Recognizer
  readonly cancelled: Promise<void>
  readonly release: () => void
  status: "capturing" | "finishing" | "done" | "cancelled"
  final?: Promise<CommitReceipt | undefined>
}

const snapshot = (input: InputOrigin): InputOrigin => ({
  ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
  ...(input.focus === undefined ? {} : { focus: { ...input.focus } }),
})
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Transport-independent capture/commit/playback orchestration for one conversation. */
export class Runtime {
  private readonly options: RuntimeOptions
  private readonly speech: SpeechOutput
  private readonly unsubscribe: () => void
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  private readonly captures = new Map<string, Capture>()
  private readonly turns = new Map<string, InputOrigin>()
  private readonly responses = new Map<string, InputOrigin>()
  private readonly playback = new Map<string, Extract<SessionEvent, { type: "playback" }>>()
  private pendingWake: InputOrigin | undefined
  private sequence = 0
  private committedSequence = 0
  private closed = false
  private enabled = true
  private epoch = 0
  private closing: Promise<void> | undefined

  constructor(options: RuntimeOptions) {
    this.options = options
    if (options.onEvent !== undefined) this.listeners.add(options.onEvent)
    const player = options.speech.player
    this.speech = createSpeechOutput({
      ...options.speech,
      ...(player === undefined ? {} : { player: { open: (request, signal) => {
        const origin = this.responses.get(request.responseId)
        if (origin === undefined) throw new Error("The speech response has no recorded input origin.")
        return player.open({ ...request, ...(origin.deviceId === undefined ? {} : { deviceId: origin.deviceId }) }, signal)
      } } }),
      onPlayback: (event) => { this.options.session.playback(event) },
      onError: (error, responseId) => {
        this.emit({ type: "runtime_error", responseId, message: error.message })
        this.interrupted(responseId)
      },
    })
    this.unsubscribe = options.session.subscribe((event) => {
      if (event.type === "response_started") {
        const origin = event.authorization === "event" ? this.pendingWake : this.turns.get(event.turnId)
        if (origin !== undefined) this.remember(this.responses, event.responseId, origin)
        if (event.authorization === "event") this.pendingWake = undefined
      }
      if (event.type === "playback") this.remember(this.playback, event.responseId, event)
      this.speech.accept(event)
      this.emit(event)
    })
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The voice runtime is closed.")
  }

  get inputEpoch(): number { return this.epoch }
  get isEnabled(): boolean { return this.enabled }

  setEnabled(on: boolean): void {
    this.ensureOpen()
    if (this.enabled === on) return
    this.enabled = on
    if (!on) this.halt(false)
  }

  private ensureInput(expectedEpoch = this.epoch): void {
    if (!this.enabled) throw new Error("yapd is off.")
    if (expectedEpoch !== this.epoch) throw new Error("This input was interrupted before it could be accepted.")
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* A view cannot disrupt the conversation. */ }
    }
  }

  private remember<A>(map: Map<string, A>, id: string, value: A): void {
    map.set(id, value)
    if (map.size > 128) map.delete(map.keys().next().value!)
  }

  private interrupted(responseId: string): void {
    // Failure confirms no additional heard words. Release an idle notification
    // only after Speech has entered its terminal cancellation path.
    queueMicrotask(() => {
      if (this.closed) return
      this.options.session.speechFailed(responseId)
      const previous = this.playback.get(responseId)
      if (previous?.state === "finished" || previous?.state === "interrupted") return
      this.options.session.playback({ responseId, playedMs: previous?.playedMs ?? 0, state: "interrupted", certainty: "approximate", ...(previous?.playedText === undefined ? {} : { playedText: previous.playedText }) })
    })
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Snapshot the response's input origin; device selection must not follow later focus. */
  originFor(responseId: string): InputOrigin | undefined {
    const origin = this.responses.get(responseId)
    return origin === undefined ? undefined : snapshot(origin)
  }

  start(input: CaptureInput): void {
    this.ensureOpen()
    this.ensureInput()
    const previous = this.captures.get(input.captureId)
    if (previous?.status === "capturing") return
    if (previous !== undefined) throw new Error("That capture has already ended.")
    const pinned = { captureId: input.captureId, ...snapshot(input) }
    this.options.session.onset({ captureId: pinned.captureId, ...(pinned.deviceId === undefined ? {} : { device: pinned.deviceId }), ...(pinned.focus === undefined ? {} : { focus: pinned.focus }) })
    let capture: Capture | undefined
    try {
      const recognizer = this.options.recognize({ ...pinned,
        onPartial: (transcript) => {
          if (capture?.status === "capturing" && !this.closed) this.emit({ type: "transcript_partial", captureId: pinned.captureId, ...(pinned.deviceId === undefined ? {} : { deviceId: pinned.deviceId }), transcript })
        },
        onError: (error) => {
          if (capture?.status === "capturing" && !this.closed) this.emit({ type: "runtime_error", captureId: pinned.captureId, message: error.message })
        },
      })
      let release!: () => void
      const cancelled = new Promise<void>((resolve) => { release = resolve })
      capture = { input: pinned, sequence: ++this.sequence, turnId: crypto.randomUUID(), recognizer, cancelled, release, status: "capturing" }
      this.captures.set(input.captureId, capture)
      // Retain completed IDs briefly so duplicate Send cannot replay a turn.
      if (this.captures.size > 128) for (const [id, old] of this.captures) {
        if (old.status === "done" || old.status === "cancelled") { this.captures.delete(id); break }
      }
    } catch (error) {
      this.options.session.abandon({ captureId: input.captureId, uncertain: true })
      this.emit({ type: "runtime_error", captureId: input.captureId, message: message(error) })
      throw error
    }
  }

  push(input: { readonly captureId: string; readonly frame: Float32Array }): void {
    this.ensureOpen()
    const capture = this.captures.get(input.captureId)
    if (capture?.status !== "capturing") throw new Error("The capture is not accepting audio.")
    try { capture.recognizer.push(input.frame) } catch (error) {
      this.cancel({ ...input, reason: "error" })
      this.emit({ type: "runtime_error", captureId: input.captureId, message: message(error) })
      throw error
    }
  }

  /** Send finalizes this exact capture; partial recognition never commits. */
  send(input: { readonly captureId: string }): Promise<CommitReceipt | undefined> {
    this.ensureOpen()
    const capture = this.captures.get(input.captureId)
    if (capture === undefined || capture.status === "cancelled") return Promise.resolve(undefined)
    if (capture.final !== undefined) return capture.final
    capture.status = "finishing"
    capture.final = (async () => {
      try {
        const recognition = await Promise.race([capture.recognizer.finish(), capture.cancelled.then(() => undefined)])
        if (recognition === undefined || capture.status === "cancelled" || this.closed) return undefined
        if (recognition.text.trim() === "" || capture.sequence < this.committedSequence) {
          this.cancel({ ...input, ...(recognition.text.trim() === "" ? { reason: "error" as const } : {}) })
          return undefined
        }
        this.emit({ type: "recognition_final", captureId: input.captureId, ...(capture.input.deviceId === undefined ? {} : { deviceId: capture.input.deviceId }), recognition })
        if (this.captures.get(input.captureId)?.status === "cancelled" || this.closed || capture.sequence < this.committedSequence) return undefined
        const receipt = await this.commit({ text: recognition.text, source: "voice", captureId: input.captureId, turnId: capture.turnId, ...snapshot(capture.input) }, capture.sequence)
        capture.status = "done"
        return receipt
      } catch (error) {
        if (capture.status === "cancelled" || this.closed) return undefined
        this.cancel({ ...input, reason: "error" })
        this.emit({ type: "runtime_error", captureId: input.captureId, message: message(error) })
        throw error
      }
    })()
    return capture.final
  }

  cancel(input: { readonly captureId: string; readonly reason?: "error" | "manual" }): void {
    this.ensureOpen()
    const capture = this.captures.get(input.captureId)
    if (capture === undefined || capture.status === "done" || capture.status === "cancelled") return
    capture.status = "cancelled"
    capture.release()
    try { capture.recognizer.abort() } catch (error) {
      this.emit({ type: "runtime_error", captureId: input.captureId, message: message(error) })
    } finally { this.options.session.abandon({ captureId: input.captureId, ...(input.reason === "error" ? { uncertain: true } : {}), ...(input.reason === "manual" ? { cancelled: true } : {}) }) }
  }

  private async commit(input: InputOrigin & { readonly text: string; readonly source: "text" | "voice"; readonly turnId: string; readonly captureId?: string }, sequence: number): Promise<CommitReceipt> {
    this.ensureInput()
    if (!this.turns.has(input.turnId)) this.remember(this.turns, input.turnId, snapshot(input))
    const receipt = await this.options.session.commit(input)
    if (!receipt.duplicate) {
      this.committedSequence = Math.max(this.committedSequence, sequence)
      // A slow older recognition must never supersede a newer accepted request.
      for (const capture of this.captures.values()) if (capture.sequence < sequence) this.cancel({ captureId: capture.input.captureId })
    }
    return receipt
  }

  text(input: InputOrigin & { readonly text: string; readonly turnId?: string; readonly expectedEpoch?: number }): Promise<CommitReceipt> {
    this.ensureOpen()
    this.ensureInput(input.expectedEpoch)
    return this.commit({ ...snapshot(input), text: input.text, source: "text", turnId: input.turnId ?? crypto.randomUUID() }, ++this.sequence)
  }

  external(input: ExternalInput): boolean {
    this.ensureOpen()
    return this.options.session.external(input)
  }

  wake(input: Pick<InputOrigin, "deviceId"> & { readonly notificationId?: string } = {}): Promise<WakeReceipt> {
    this.ensureOpen()
    this.ensureInput()
    if (!this.options.session.hasQueuedWake) this.pendingWake = undefined
    const previous = this.pendingWake
    const origin = this.pendingWake ?? snapshot(input)
    this.pendingWake = origin
    return this.options.session.wake(input.notificationId).then((receipt) => {
      if (receipt.status === "ignored" && previous === undefined && this.pendingWake === origin) this.pendingWake = undefined
      return receipt
    })
  }

  /** Conversation Stop is distinct from stopping an already dispatched coding run. */
  stop(): void {
    this.halt(true)
  }

  private halt(dismissNotifications: boolean): void {
    this.ensureOpen()
    this.epoch++
    this.pendingWake = undefined
    this.options.session.interrupt(dismissNotifications)
    for (const capture of this.captures.values()) this.cancel({ captureId: capture.input.captureId })
  }

  drained(responseId: string): Promise<void> { return this.speech.drained(responseId) }
  idle(): Promise<void> { return this.options.session.idle() }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.halt(false)
    this.closed = true
    this.closing = (async () => {
      try { await this.speech.close() } finally {
        this.unsubscribe()
        await this.options.session.close()
      }
    })()
    return this.closing
  }
}
