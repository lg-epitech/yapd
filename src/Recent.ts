// What yapd told the user lately, since new work often builds on it: "follow
// up on what the std agent just finished". Only the latest few, to keep what
// the writer reads short. An entry is noted before it's read out, and counts
// as heard from the moment it starts playing: until then the user knows
// nothing of it, so "tell that one to" can't mean it.

/** Something the user was told, or is about to be. */
export interface Heard {
  /** The inbox entry that reads it out: a notice's id, or one of the update's own. */
  readonly id: string
  readonly project: string
  /** The machine it happened on, as its hooks name it. None for this one's older hooks. */
  readonly host?: string
  readonly directory: string
  /** What yapd said. */
  readonly spoken: string
  /** What it summed up: the agent's message, or the prompt of work yapd started. */
  readonly message: string
  readonly started?: boolean
  /** The T3 Code thread it was about, when yapd knows which. */
  readonly thread?: { readonly machine: string; readonly id: string }
  readonly at: number
  /** When it last started being read out. None while it waits its turn. */
  readonly heardAt?: number
}

/** One the user has heard. */
export type Played = Heard & { readonly heardAt: number }

export type Recent = ReadonlyArray<Heard>

export const empty: Recent = []

/** How many are kept. */
const most = 6
/** Older than this, the user would say more than "what it just finished". */
const lifetime = 3 * 60 * 60_000

/** Newest first. */
export const add = (recent: Recent, heard: Heard): Recent => [heard, ...recent].slice(0, most)

const change = (recent: Recent, id: string, changed: (heard: Heard) => Heard): Recent =>
  recent.map((heard) => (heard.id === id ? changed(heard) : heard))

/** Marks `id` as being read out from `at`. Read out again after a dictation cut it off, it's the latest thing heard again. */
export const heard = (recent: Recent, id: string, at: number): Recent => change(recent, id, (heard) => ({ ...heard, heardAt: at }))

/** Names the thread `id` was about, once that's known, which can be after it was read out. */
export const about = (recent: Recent, id: string, thread: NonNullable<Heard["thread"]>): Recent =>
  change(recent, id, (heard) => ({ ...heard, thread }))

/** What the user has heard, the latest first. Not by when it came in: what needs them is read out before what doesn't. */
export const played = (recent: Recent, now: number): ReadonlyArray<Played> =>
  recent
    .filter((heard): heard is Played => heard.heardAt !== undefined && now - heard.heardAt < lifetime)
    .toSorted((one, other) => other.heardAt - one.heardAt)
