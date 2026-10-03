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
  /** For an update heard again, its id among those heard. */
  readonly replay?: string
}

/**
 * Something yapd has to say for itself, like a question about new work or that
 * it started. Questions count as needing the user.
 */
export interface Notice {
  readonly id: string
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

const rank = { "needs-you": 0, done: 1 } as const

/** What to say next: anything that needs the user first, then oldest first. */
export const next = (inbox: Inbox): Entry | undefined => {
  let best: Entry | undefined
  for (const ready of inbox.values()) {
    if (
      best === undefined ||
      rank[ready.priority] < rank[best.priority] ||
      (rank[ready.priority] === rank[best.priority] && ready.arrivedAt < best.arrivedAt)
    ) {
      best = ready
    }
  }
  return best
}
