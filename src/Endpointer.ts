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
  /**
   * The same once its own voice has stopped the line it's saying and it
   * picked up again, for the rest of that line's first seconds: about a
   * third of a second of speech, which its own voice ducked lasts less often
   * than his words do. What goes quiet short of that after as much as `wary`
   * is kept whole, as it may be a word of his, like "Yes.". In a simulation
   * with Silero and Whisper, with its own voice dying away over those seconds
   * as the echo cancellation learns it, 8 of 22 lines it stopped stopped more
   * than once, against 14 with no cap; 13 or 16 frames cut that to 3, but let
   * more of his short words run into its own voice and be lost. Held at one
   * level all along, its own voice is speech like his, and still stops most
   * lines more than once.
   */
  readonly capped: number
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
  wary: 6,
  capped: 10,
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
  /**
   * It went quiet short of what makes it surely the user, as only what began
   * `capped` can, but there was as much of it as a word of theirs: it's kept
   * whole, with what may come next, till they've finished.
   */
  | { readonly _tag: "Lapsed" }
  /**
   * They've finished. The audio starts just before the onset. `brief` when it
   * never became surely speech, after it lapsed.
   */
  | { readonly _tag: "Utterance"; readonly audio: Float32Array; readonly brief?: true }

/** How sure to be that it's speech: as ever, `wary` of what may be yapd's own voice, or surer still once that stopped it for nothing, `capped`. */
export type Care = "plain" | "wary" | "capped"

const onset: Event = { _tag: "Onset" }
const speech: Event = { _tag: "Speech" }
const abandoned: Event = { _tag: "Abandoned" }
const lapsed: Event = { _tag: "Lapsed" }

/** Follows Silero's own iterator: silence starts under `off` and only a voiced frame ends it. */
export class Endpointer {
  private phase: "quiet" | "onset" | "lapsed" | "speech" = "quiet"
  private frames: Array<Float32Array> = []
  private voiced = 0
  /** Voiced frames since the onset, over all the times it lapsed. */
  private all = 0
  private quiet = 0
  private needed = 0
  /** Voiced frames from which what goes quiet short of `needed` is kept, as it may be a word of the user's: only for what began `capped`. */
  private keeping = Number.POSITIVE_INFINITY

  constructor(private readonly options: Options = defaults) {}

  /** Takes the next frame, with the care due to what it may carry, which only its first frame decides. */
  push(frame: Float32Array, probability: number, care: Care = "plain"): Event | undefined {
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
        this.all = 1
        this.needed = care === "plain" ? confirm : this.options[care]
        this.keeping = care === "capped" ? this.options.wary : Number.POSITIVE_INFINITY
        return onset

      case "onset": {
        const kept = this.frames
        if (isVoiced) {
          this.voiced++
          this.all++
          this.quiet = 0
        } else {
          this.quiet++
        }
        if (this.voiced >= this.needed) {
          this.phase = "speech"
          this.quiet = 0
          return speech
        }
        if (this.quiet >= abandon && this.all >= this.keeping) {
          this.phase = "lapsed"
          return lapsed
        }
        if (this.quiet >= abandon) {
          this.reset()
          // Still before whatever comes next, as when nothing came, so speech begun just after isn't clipped.
          this.frames = kept.slice(-lead)
          return abandoned
        }
        return undefined
      }

      case "lapsed": {
        // More of it, which takes as much again to be surely speech, with all before it kept.
        if (isVoiced) {
          this.phase = "onset"
          this.voiced = 1
          this.all++
          this.quiet = 0
          return onset
        }
        this.quiet++
        if (this.quiet < silence && this.frames.length < longest) return undefined
        const kept = this.frames.slice(0, this.frames.length - Math.max(0, this.quiet - tail))
        this.reset()
        return { _tag: "Utterance", audio: concat(kept), brief: true }
      }

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

  private reset() {
    this.phase = "quiet"
    this.frames = []
    this.voiced = 0
    this.all = 0
    this.quiet = 0
  }
}

/** Audio, one piece after the other. */
export const concat = (frames: ReadonlyArray<Float32Array>) => {
  const audio = new Float32Array(frames.reduce((length, frame) => length + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    audio.set(frame, offset)
    offset += frame.length
  }
  return audio
}
