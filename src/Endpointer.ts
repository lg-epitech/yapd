/** How speech probabilities, one per 32 ms frame, become the user starting and stopping to talk. */
export interface Options {
  /** Probability from which a frame counts as voiced. */
  readonly on: number
  /** Probability under which the user may have stopped. Lower than `on`, so speech that wavers isn't cut. */
  readonly off: number
  /** Voiced frames before it's speech rather than a cough or a click. */
  readonly confirm: number
  /**
   * The same for what began while yapd's own voice could still get into the
   * microphone, ducked at once: a little more, since its own voice, ducked,
   * often stops being speech by then, and his never does. In a simulation
   * with Silero, it stopped yapd for its own voice a quarter less often,
   * and for him 64 ms later.
   */
  readonly wary: number
  /** Unvoiced frames in a row that end an onset that never became speech. */
  readonly abandon: number
  /** Frames of silence that end an utterance. Long enough to outlast a pause between words. */
  readonly silence: number
  /**
   * Frames of silence after which he may have stopped: what he's said so far
   * is then what the utterance will be should nothing voiced follow, so it
   * can be transcribed while the rest of the silence is waited out.
   */
  readonly pause: number
  /** Frames kept from before the onset, so the first syllable isn't clipped. */
  readonly lead: number
  /** Frames of silence kept at the end. */
  readonly tail: number
  /** Frames after which an utterance ends regardless. */
  readonly longest: number
}

export const defaults: Options = {
  on: 0.5,
  off: 0.35,
  confirm: 4,
  wary: 6,
  abandon: 8,
  silence: 22,
  pause: 10,
  lead: 10,
  tail: 3,
  longest: 940,
}

export type Event =
  /** Might be the user. */
  | { readonly _tag: "Onset" }
  /** It is the user. */
  | { readonly _tag: "Speech" }
  /** It wasn't. */
  | { readonly _tag: "Abandoned" }
  /**
   * He may have stopped: the audio as the utterance would end here, sample
   * for sample, should nothing voiced follow before the silence that ends it.
   */
  | { readonly _tag: "Pause"; readonly audio: Float32Array }
  /** He carried on after a pause. */
  | { readonly _tag: "Resumed" }
  /**
   * They've finished. The audio starts just before the onset. `paused` when
   * it ended on silence with nothing voiced since its last Pause, whose audio
   * it then is: not when it went on too long.
   */
  | { readonly _tag: "Utterance"; readonly audio: Float32Array; readonly paused: boolean }

const onset: Event = { _tag: "Onset" }
const speech: Event = { _tag: "Speech" }
const abandoned: Event = { _tag: "Abandoned" }
const resumed: Event = { _tag: "Resumed" }

/** Follows Silero's own iterator: silence starts under `off` and only a voiced frame ends it. */
export class Endpointer {
  private phase: "quiet" | "onset" | "speech" = "quiet"
  private frames: Array<Float32Array> = []
  private voiced = 0
  private quiet = 0
  private needed = 0
  private wary = false
  /** A Pause was given with nothing voiced since. */
  private paused = false

  constructor(private readonly options: Options = defaults) {}

  /** Takes the next frame, `wary` when it may carry yapd's own voice. */
  push(frame: Float32Array, probability: number, wary = false): Event | undefined {
    const { on, off, confirm, abandon, silence, pause, lead, longest } = this.options
    const isVoiced = probability >= on
    this.frames.push(frame)

    switch (this.phase) {
      case "quiet":
        if (!isVoiced) {
          if (this.frames.length > lead) this.frames.shift()
          return undefined
        }
        this.phase = "onset"
        this.voiced = 1
        this.wary = wary
        this.needed = wary ? this.options.wary : confirm
        return onset

      case "onset":
        if (isVoiced) {
          this.voiced++
          this.quiet = 0
        } else {
          this.quiet++
        }
        if (this.voiced >= this.needed) {
          this.phase = "speech"
          this.quiet = 0
          return speech
        }
        if (this.quiet >= abandon) {
          const kept = this.wary ? this.frames.slice(-lead) : []
          this.reset()
          // After what may have been yapd's own voice, still before whatever comes next, so his voice begun just after isn't clipped.
          this.frames = kept
          return abandoned
        }
        return undefined

      case "speech": {
        const carried = isVoiced && this.paused
        if (isVoiced) {
          this.quiet = 0
          this.paused = false
        } else if (probability < off || this.quiet > 0) this.quiet++
        if (this.quiet < silence && this.frames.length < longest) {
          if (carried) return resumed
          if (this.quiet !== pause) return undefined
          // What the utterance keeps once the silence is waited out, as each quiet frame after this one adds one and takes one off.
          this.paused = true
          return { _tag: "Pause", audio: this.heard() }
        }
        const paused = this.paused && this.quiet >= silence
        const audio = this.heard()
        this.reset()
        return { _tag: "Utterance", audio, paused }
      }
    }
  }

  /** What's been said, with the lead-in before it and as much of the silence after it as is kept. */
  private heard() {
    return concat(this.frames.slice(0, this.frames.length - Math.max(0, this.quiet - this.options.tail)))
  }

  private reset() {
    this.phase = "quiet"
    this.frames = []
    this.voiced = 0
    this.quiet = 0
    this.paused = false
  }
}

const concat = (frames: ReadonlyArray<Float32Array>) => {
  const audio = new Float32Array(frames.reduce((length, frame) => length + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    audio.set(frame, offset)
    offset += frame.length
  }
  return audio
}
