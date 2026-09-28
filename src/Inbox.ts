import type { Priority } from "./Condenser.ts"

/** An update that is condensed, rendered, and waiting for its turn to be spoken. */
export interface Ready {
  readonly session: string
  readonly priority: Exclude<Priority, "trivial">
  readonly arrivedAt: number
  readonly audio: string
}

/** Ready updates, at most one per session. */
export type Inbox = ReadonlyMap<string, Ready>

export const empty: Inbox = new Map()

/** Adds an update, replacing any older one from the same session. */
export const add = (inbox: Inbox, ready: Ready): Inbox => new Map(inbox).set(ready.session, ready)

export const remove = (inbox: Inbox, session: string): Inbox => {
  const next = new Map(inbox)
  next.delete(session)
  return next
}

const rank = { "needs-you": 0, done: 1 } as const

/** The update to speak next: anything that needs the user first, then oldest first. */
export const next = (inbox: Inbox): Ready | undefined => {
  let best: Ready | undefined
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
