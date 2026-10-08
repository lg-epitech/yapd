import type { Effect } from "effect"
import type { Ticket } from "./ClaudeCode.ts"
import type { Priority } from "./Condenser.ts"
import type { Question, Update } from "./Conversation.ts"

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
   * An answer to what the user asked, or a question about it, which they're
   * waiting for, so it goes before anything else; or a notice of yapd's own.
   */
  readonly kind: "answer" | "question" | "notice"
  /** The open question it asks, which is never asked again once it's cut off. */
  readonly open?: string
  readonly priority: Exclude<Priority, "trivial">
  readonly spoken: string
  /** When what it's about came up, like when the user sent the dictation, which is where it goes among updates. */
  readonly at: number
  /** Whether it's no longer worth saying, asked as its turn comes. */
  readonly stale: Effect.Effect<boolean>
  /** For a question: what to do with the answer, and when there's none. */
  readonly question?: Pick<Question, "answer"> & { readonly unanswered: Effect.Effect<void> }
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

/** What to say next: what the user asked for, then anything that needs them, then oldest first. */
export const next = (inbox: Inbox): Entry | undefined => {
  let best: Entry | undefined
  for (const ready of inbox.values()) {
    if (best === undefined || rank(ready) < rank(best) || (rank(ready) === rank(best) && ready.arrivedAt < best.arrivedAt)) {
      best = ready
    }
  }
  return best
}
