// What yapd told the user lately, since new work often builds on it: "follow
// up on what the std agent just finished". An entry is noted before it's read
// out, and counts as heard from the moment it starts playing: until then the
// user knows nothing of it, so "tell that one to" can't mean it. Only the
// latest few heard are kept, to keep what the writer reads short. What still
// waits its turn is all kept, however much piles up while a dictation holds
// playback: each is history from the moment it plays, and one that never
// plays is dropped along with its inbox entry. What a dictation points at is
// what had played when the shortcut was pressed: what plays after, once it lets
// go of the speaker, the user hadn't heard when they spoke. Every start of a
// reading is logged for that, since one the dictation cut off is read again
// after, and where it stood as they spoke is where it stood before that.
//
// Everything yapd says about the user's work is noted: an agent's update, and
// whatever yapd says for itself in answer to a dictation, whether it started
// something, sent a message, summed a thread up, reported across them, asked
// a question, or says why it did nothing. What's noted carries a thread only
// when it's about exactly one that yapd knows. After a report across threads,
// a question about which one, or a failure that names none, "tell it to"
// points at nothing yapd can tell, and it asks rather than reach whatever was
// heard before. What says nothing about any work, like that a dictation
// couldn't be made out or the microphone is off, isn't noted at all: it
// leaves "it" meaning what it did.

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
  /** When it last started being read out: again, after a dictation cut it off. None while it waits its turn. */
  readonly heardAt?: number
}

/** One the user has heard, placed by when it started playing. */
export type Played = Heard & { readonly heardAt: number }

/** One start of a reading. */
interface Play {
  readonly id: string
  readonly at: number
}

/** What was noted, and every time one of them started playing, both the latest first. */
export interface Recent {
  readonly noted: ReadonlyArray<Heard>
  readonly plays: ReadonlyArray<Play>
}

export const empty: Recent = { noted: [], plays: [] }

/** How many heard ones are kept. */
const most = 6
/** Older than this, the user would say more than "what it just finished". */
const lifetime = 3 * 60 * 60_000
/** How many starts are kept: room for each one kept to have been cut off and read again many times over. */
const replays = most * 10

const wasHeard = (heard: Heard): heard is Played => heard.heardAt !== undefined

/**
 * Everything still waiting its turn, and the last `most` heard, with the
 * starts of what's kept. One that waits past `lifetime` is let go of all the
 * same: its notice was never queued, or its update was dropped before it was
 * noted as such, and nothing else will drop it. A start older than `lifetime`
 * is let go of too, since no dictation reaches back that far.
 */
const trim = (recent: Recent, now: number): Recent => {
  const kept = new Set(recent.noted.filter(wasHeard).toSorted((one, other) => other.heardAt - one.heardAt).slice(0, most))
  const noted = recent.noted.filter((heard) => (wasHeard(heard) ? kept.has(heard) : now - heard.at < lifetime))
  const ids = new Set(noted.map(({ id }) => id))
  return { noted, plays: recent.plays.filter((play) => ids.has(play.id) && now - play.at < lifetime).slice(0, replays) }
}

/** Newest first. */
export const add = (recent: Recent, heard: Heard, now: number): Recent => trim({ ...recent, noted: [heard, ...recent.noted] }, now)

const change = (recent: Recent, id: string, changed: (heard: Heard) => Heard): Recent => ({
  ...recent,
  noted: recent.noted.map((heard) => (heard.id === id ? changed(heard) : heard)),
})

/** Marks `id` as being read out from `at`. Read out again after a dictation cut it off, it's the latest thing heard again. */
export const heard = (recent: Recent, id: string, at: number): Recent => {
  if (!recent.noted.some((heard) => heard.id === id)) return recent
  const played = change(recent, id, (heard) => ({ ...heard, heardAt: at }))
  return trim({ ...played, plays: [{ id, at }, ...played.plays] }, at)
}

/** Forgets `id` if it was never read out: its inbox entry is gone, so it won't be. */
export const drop = (recent: Recent, id: string): Recent => ({ ...recent, noted: recent.noted.filter((heard) => heard.id !== id || wasHeard(heard)) })

/** Names the thread `id` was about, once that's known, which can be after it was read out. */
export const about = (recent: Recent, id: string, thread: NonNullable<Heard["thread"]>): Recent =>
  change(recent, id, (heard) => ({ ...heard, thread }))

/**
 * What the user had heard by `at`, the latest first, as it stood then: when
 * they pressed the shortcut, say, what started playing after isn't what they
 * were pointing at. Each is placed by its last start before `at`, since one
 * cut off by that very dictation is read again after, and that mustn't make
 * it the latest thing heard when something else was as they spoke. Inclusive:
 * what started that very millisecond, they've heard the first word of. Not by
 * when it came in: what needs them is read out before what doesn't.
 */
export const heardBy = (recent: Recent, at: number): ReadonlyArray<Played> =>
  recent.noted
    .flatMap((heard) => {
      const play = recent.plays.find((play) => play.id === heard.id && play.at <= at)
      return play === undefined || at - play.at >= lifetime ? [] : [{ ...heard, heardAt: play.at }]
    })
    .toSorted((one, other) => other.heardAt - one.heardAt)
    .slice(0, most)
