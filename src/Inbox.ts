import type { Effect } from "effect"
import type { Ticket } from "./ClaudeCode.ts"
import type { Priority } from "./Condenser.ts"
import type { Answer, Question, Update } from "./Conversation.ts"

/** An update that is condensed, rendered, and waiting for its turn to be spoken. */
export interface Ready {
  readonly session: string
  readonly priority: Exclude<Priority, "trivial">
  readonly arrivedAt: number
  readonly update: Update
  /** The session's Stop hook, waiting in case the user replies to this update. */
  readonly hook?: Ticket
  /** For an update heard again, how it was asked for. */
  readonly replay?: Replay
}

/** An update asked for again, by its id among those heard, while yapd was on for the `turns`th time. */
export interface Replay {
  readonly id: string
  readonly turns: number
}

/**
 * Something yapd has to say for itself, like a question about new work or that
 * it started. Questions count as needing the user.
 */
export interface Notice {
  readonly id: string
  /**
   * An answer to what the user asked, what came of something they asked to
   * be done, like work that started, or a question about it, which they're
   * waiting for, so it goes before anything else; or a notice of yapd's own.
   */
  readonly kind: "answer" | "done" | "question" | "notice"
  /** The open question it asks, which is never asked again once it's cut off. */
  readonly open?: string
  readonly priority: Exclude<Priority, "trivial">
  readonly spoken: string
  /** When what it's about came up, like when the user sent the dictation, which is where it goes among updates. */
  readonly at: number
  /** Whether it's no longer worth saying, asked as its turn comes, and again once words said in its place are rendered, just before it's played. */
  readonly stale: Effect.Effect<boolean>
  /**
   * What's said in its place when `when`, asked just before it's played, says
   * so, like the line without "it's on your screen" once no app is there to
   * show its card: rendered only then, and `used` once it's what's played,
   * never when it can't be rendered and its own words go after all, nor when
   * it went stale meanwhile.
   */
  readonly instead?: { readonly spoken: string; readonly when: Effect.Effect<boolean>; readonly used?: Effect.Effect<void> }
  /** Run as it starts being said, which is when the user hears of it: never when it can't be played, and for a question, undone if it breaks off. */
  readonly saying?: Effect.Effect<void>
  /**
   * Run once it's known to be playing, which is as it starts with the audio
   * helper, but with afplay, which can't say, only once it has played to the
   * end: never when it can't be played or breaks off before that's known.
   */
  readonly confirmed?: Effect.Effect<void>
  /** Run once it's been said to the end, or for a question, answered, which is when the user has heard all of it: never when it's cut off, even by a follow-up, dropped or can't be said. */
  readonly heard?: Effect.Effect<void>
  /**
   * Run once it's done with, said or not, like gone stale, dropped or never
   * queued as yapd was off: never while it's put back to be said again.
   */
  readonly gone?: Effect.Effect<void>
  /**
   * For a question: what to do with the answer, and when there's none; and
   * when it can't be asked in full, like when the audio helper quits midway,
   * what undoes its `saying`, since it counts as never said.
   */
  readonly question?: Pick<Question, "answer"> & { readonly unanswered: Effect.Effect<void>; readonly unsaid: Effect.Effect<void> }
  /**
   * For an answer: what to make of what the user says over it, or right
   * after it's said to the end, while the microphone stays open as after an
   * update, like a follow-up about the thread it was about.
   */
  readonly followUp?: Answer["followUp"]
}

/** A notice that is rendered, and waiting for its turn like updates do. */
export interface Said {
  /** The notice's id, which no session has. */
  readonly session: string
  readonly priority: Exclude<Priority, "trivial">
  readonly arrivedAt: number
  readonly notice: Notice
  readonly audio: string
}

export type Entry = Ready | Said

/** What's ready to be said: updates, at most one per session, and notices. */
export type Inbox = ReadonlyMap<string, Entry>

export const empty: Inbox = new Map()

/** The file that's played for it. */
export const audio = (entry: Entry) => ("update" in entry ? entry.update.audio : entry.audio)

/** Adds an update, replacing any older one from the same session. */
export const add = (inbox: Inbox, ready: Entry): Inbox => new Map(inbox).set(ready.session, ready)

export const remove = (inbox: Inbox, session: string): Inbox => {
  const next = new Map(inbox)
  next.delete(session)
  return next
}

/** What the user asked for first, then what needs them, then the rest. */
const rank = (entry: Entry) =>
  "notice" in entry && entry.notice.kind !== "notice" ? 0 : entry.priority === "needs-you" ? 1 : 2

/**
 * What to say next: what the user asked for, then anything that needs them,
 * then oldest first. While an answer is on its way, only what they asked for,
 * so nothing else comes between them and it.
 */
export const next = (inbox: Inbox, answering = false): Entry | undefined => {
  let best: Entry | undefined
  for (const ready of inbox.values()) {
    if (answering && rank(ready) > 0) continue
    if (best === undefined || rank(ready) < rank(best) || (rank(ready) === rank(best) && ready.arrivedAt < best.arrivedAt)) {
      best = ready
    }
  }
  return best
}
