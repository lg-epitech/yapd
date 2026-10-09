/** How speech probabilities, one per 32 ms frame, become the user starting and stopping to talk. */
export interface Options {
  /** Probability from which a frame counts as voiced. */
  readonly on: number
  /** Probability under which the user may have stopped. Lower than `on`, so speech that wavers isn't cut. */
  readonly off: number
  /** Voiced frames before it's speech rather than a cough or a click. */
  readonly confirm: number
  /** Unvoiced frames in a row that end an onset that never became speech. */
  readonly abandon: number
  /** Frames of silence that end an utterance. Long enough to outlast a pause between words. */
  readonly silence: number
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
  abandon: 8,
  silence: 22,
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
  /** They've finished. The audio starts just before the onset. */
  | { readonly _tag: "Utterance"; readonly audio: Float32Array }

const onset: Event = { _tag: "Onset" }
const speech: Event = { _tag: "Speech" }
const abandoned: Event = { _tag: "Abandoned" }

/** Follows Silero's own iterator: silence starts under `off` and only a voiced frame ends it. */
export class Endpointer {
  private phase: "quiet" | "onset" | "speech" = "quiet"
  private frames: Array<Float32Array> = []
  private voiced = 0
  private quiet = 0

  constructor(private readonly options: Options = defaults) {}

  push(frame: Float32Array, probability: number): Event | undefined {
    const { on, off, confirm, abandon, silence, lead, tail, longest } = this.options
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
        return onset

      case "onset":
        if (isVoiced) {
          this.voiced++
          this.quiet = 0
        } else {
          this.quiet++
        }
        if (this.voiced >= confirm) {
          this.phase = "speech"
          this.quiet = 0
          return speech
        }
        if (this.quiet >= abandon) {
          this.reset()
          return abandoned
        }
        return undefined

      case "speech": {
        if (isVoiced) this.quiet = 0
        else if (probability < off || this.quiet > 0) this.quiet++
        if (this.quiet < silence && this.frames.length < longest) return undefined
        const kept = this.frames.slice(0, this.frames.length - Math.max(0, this.quiet - tail))
        this.reset()
        return { _tag: "Utterance", audio: concat(kept) }
      }
    }
  }

  /** What the user has said so far, from just before the onset, while they're still talking. */
  soFar(): Float32Array {
    return concat(this.frames)
  }

  private reset() {
    this.phase = "quiet"
    this.frames = []
    this.voiced = 0
    this.quiet = 0
  }
}

/** Audio in one piece, in order. */
export const concat = (frames: ReadonlyArray<Float32Array>) => {
  const audio = new Float32Array(frames.reduce((length, frame) => length + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    audio.set(frame, offset)
    offset += frame.length
  }
  return audio
}
