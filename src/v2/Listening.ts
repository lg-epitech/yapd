import { Endpointer, defaults, type Options as EndpointOptions } from "../Endpointer.ts"
import type { CommitReceipt, Runtime } from "./Runtime.ts"
import type { ThreadRef } from "./Types.ts"

export interface ListeningCaptureInput {
  readonly id: string
  readonly deviceId: string
  readonly focus?: ThreadRef
  /** The first exact native frame to retain, including pre-roll before onset. */
  readonly fromSequence: number
}

export interface ListeningRecording {
  /** Acknowledges the native final input boundary and releases its recording view. */
  readonly seal: () => Promise<void>
  /** Uses the same Runtime recognizer and committed-turn path as a physical Send. */
  readonly send: () => Promise<CommitReceipt | undefined>
  readonly cancel: () => Promise<void>
}

export type ListeningEvent =
  | { readonly type: "onset"; readonly captureId: string; readonly fromSequence: number }
  | { readonly type: "confirmed"; readonly captureId: string }
  | { readonly type: "abandoned"; readonly captureId: string; readonly reason: "false_onset" | "closed" | "limit" | "error" }
  | { readonly type: "committed"; readonly captureId: string; readonly receipt: CommitReceipt }
  | { readonly type: "settled"; readonly captureId: string }

export interface ListeningOptions {
  /** Supplied only after the audio boundary has verified this device supports hands-free capture. */
  readonly deviceId: string
  readonly runtime: Pick<Runtime, "start" | "cancel">
  readonly focus?: () => ThreadRef | undefined
  /** Promote the native rolling view; do not start a separate recognizer here. */
  readonly record: (input: ListeningCaptureInput) => Promise<ListeningRecording>
  readonly endpoint?: Partial<Omit<EndpointOptions, "longest">>
  readonly maxCaptureMs?: number
  readonly onError: (error: Error) => void
  readonly onEvent?: (event: ListeningEvent) => void
}

interface Capture {
  readonly input: ListeningCaptureInput
  readonly ready: Promise<ListeningRecording | undefined>
  readonly release: () => void
  cancelled: boolean
  sealed: boolean
  runtimeReleased: boolean
  job?: Promise<void>
}

/** Acoustic turn-taking only. Words, intent, tools and authorization stay in Runtime/Session. */
export class Listening {
  private readonly endpointOptions: EndpointOptions
  private readonly maximumFrames: number
  private endpointer: Endpointer
  private readonly captures = new Set<Capture>()
  private readonly tasks = new Set<Promise<void>>()
  private promotion: Promise<void> = Promise.resolve()
  private active: Capture | undefined
  private firstSequence: number | undefined
  private lastSequence: number | undefined
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly options: ListeningOptions) {
    const maximum = options.maxCaptureMs ?? 180_000
    if (!Number.isFinite(maximum) || maximum < 32) throw new Error("The capture limit must be at least one audio frame.")
    this.maximumFrames = Math.ceil(maximum / 32)
    this.endpointOptions = { ...defaults, on: 0.6, silence: 38, pause: 12, ...options.endpoint, longest: this.maximumFrames + (options.endpoint?.lead ?? defaults.lead) + 1 }
    const { on, off, confirm, wary, abandon, silence, pause, lead, tail } = this.endpointOptions
    if (!(on > off && on <= 1 && off >= 0) || [confirm, wary, abandon, silence, pause].some((count) => !Number.isSafeInteger(count) || count < 1) || [lead, tail].some((count) => !Number.isSafeInteger(count) || count < 0) || pause >= silence || wary < confirm) throw new Error("The acoustic endpoint settings are invalid.")
    this.endpointer = new Endpointer(this.endpointOptions)
  }

  /** A reply-window timer must not close input while a capture is still settling. */
  get busy(): boolean { return this.captures.size !== 0 }

  private emit(event: ListeningEvent): void {
    try { this.options.onEvent?.(event) } catch { /* Views cannot interrupt capture bookkeeping. */ }
  }

  private error(error: unknown): void {
    try { this.options.onError(error instanceof Error ? error : new Error(String(error))) } catch { /* The caller owns diagnostics. */ }
  }

  private begin(sequence: number): Capture {
    const focus = this.options.focus?.()
    const input: ListeningCaptureInput = {
      id: crypto.randomUUID(), deviceId: this.options.deviceId,
      fromSequence: Math.max(this.firstSequence!, sequence - this.endpointOptions.lead),
      ...(focus === undefined ? {} : { focus: { ...focus } }),
    }
    // This synchronous onset stops local output and suspends new writes before
    // waiting for the native promotion acknowledgment or a recognizer request.
    this.options.runtime.start({ captureId: input.id, deviceId: input.deviceId, ...(input.focus === undefined ? {} : { focus: input.focus }) })
    const previous = this.promotion
    let release!: () => void
    this.promotion = new Promise<void>((resolve) => { release = resolve })
    let capture!: Capture
    const ready = previous.then(async () => {
      if (capture.cancelled || this.closed) return undefined
      return this.options.record(input)
    }).catch((error: unknown) => {
      this.error(error)
      this.abandon(capture, "error")
      if (this.active === capture) { this.active = undefined; this.endpointer = new Endpointer(this.endpointOptions) }
      return undefined
    })
    capture = { input, ready, release, cancelled: false, sealed: false, runtimeReleased: false }
    this.captures.add(capture)
    this.emit({ type: "onset", captureId: input.id, fromSequence: input.fromSequence })
    return capture
  }

  private finish(capture: Capture, send: boolean): void {
    if (capture.job !== undefined) return
    const work = (async () => {
      let recording: ListeningRecording | undefined
      try {
        recording = await capture.ready
        if (recording === undefined) return
        if (capture.cancelled || !send || this.closed) { await recording.cancel(); return }
        await recording.seal()
        capture.sealed = true
        // A second onset can promote while this complete utterance is being
        // recognized; its first samples remain in the native rolling FIFO.
        capture.release()
        if (capture.cancelled || this.closed) { await recording.cancel(); return }
        const receipt = await recording.send()
        if (receipt !== undefined && !capture.cancelled && !this.closed) this.emit({ type: "committed", captureId: capture.input.id, receipt })
      } catch (error) {
        this.error(error)
        capture.cancelled = true
        this.options.runtime.cancel({ captureId: capture.input.id, reason: "error" })
        capture.runtimeReleased = true
        this.emit({ type: "abandoned", captureId: capture.input.id, reason: "error" })
        try { await recording?.cancel() } catch (cancelError) { this.error(cancelError) }
      } finally {
        if ((capture.cancelled || !send || this.closed) && !capture.runtimeReleased) this.options.runtime.cancel({ captureId: capture.input.id })
        capture.release()
        this.captures.delete(capture)
        this.emit({ type: "settled", captureId: capture.input.id })
      }
    })()
    capture.job = work
    this.tasks.add(work)
    void work.finally(() => { this.tasks.delete(work) }).catch((error: unknown) => this.error(error))
  }

  private abandon(capture: Capture, reason: Extract<ListeningEvent, { type: "abandoned" }>["reason"]): void {
    if (capture.cancelled) return
    capture.cancelled = true
    this.emit({ type: "abandoned", captureId: capture.input.id, reason })
    if (reason === "error" || reason === "limit") {
      this.options.runtime.cancel({ captureId: capture.input.id, reason: "error" })
      capture.runtimeReleased = true
    }
    // After seal the device is already released, so pending recognition can be
    // canceled immediately. Before seal, native cancellation precedes resume.
    if (capture.sealed && !capture.runtimeReleased) {
      this.options.runtime.cancel({ captureId: capture.input.id })
      capture.runtimeReleased = true
    }
    this.finish(capture, false)
  }

  push(input: { readonly sequence: number; readonly frame: Float32Array; readonly probability: number; readonly echo?: boolean }): void {
    if (this.closed) return
    const { sequence, frame, probability } = input
    if (!Number.isSafeInteger(sequence) || sequence < 0 || (this.lastSequence !== undefined && sequence !== this.lastSequence + 1) || frame.length !== 512 || frame.some((sample) => !Number.isFinite(sample)) || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      this.error(new Error("The listening stream is invalid or has a missing frame; no partial utterance was sent."))
      void this.close(true)
      return
    }
    this.firstSequence ??= sequence
    this.lastSequence = sequence
    if (this.active !== undefined && sequence - this.active.input.fromSequence + 1 >= this.maximumFrames) {
      const capture = this.active
      this.active = undefined; this.endpointer = new Endpointer(this.endpointOptions)
      this.error(new Error("The spoken turn exceeded its capture limit; it was canceled without truncation."))
      this.abandon(capture, "limit")
      return
    }
    const event = this.endpointer.push(frame, probability, input.echo)
    if (event === undefined) return
    try {
      if (event._tag === "Onset") this.active = this.begin(sequence)
      else if (event._tag === "Speech" && this.active !== undefined) this.emit({ type: "confirmed", captureId: this.active.input.id })
      else if (event._tag === "Abandoned" && this.active !== undefined) {
        const capture = this.active
        this.active = undefined
        this.abandon(capture, "false_onset")
      } else if (event._tag === "Utterance" && this.active !== undefined) {
        const capture = this.active
        this.active = undefined
        // Endpointer's audio/tail/window slicing is deliberately ignored. The
        // recognizer receives the intact promoted capture through its boundary.
        if (event.paused) this.finish(capture, true)
        else { this.error(new Error("The acoustic endpoint reached its limit; nothing was sent.")); this.abandon(capture, "limit") }
      }
    } catch (error) { this.error(error); void this.close(true) }
  }

  async idle(): Promise<void> { while (this.tasks.size > 0) await Promise.all([...this.tasks]) }

  close(uncertain = false): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    this.active = undefined
    for (const capture of this.captures) this.abandon(capture, uncertain ? "error" : "closed")
    this.closing = this.idle()
    return this.closing
  }
}
