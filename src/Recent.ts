import type * as Journal from "./Journal.ts"

// What yapd told the user lately, since new work often builds on it: "follow
// up on what the std agent just finished". Only the latest few, to keep what
// the writer reads short.

/** Something the user was told, or is about to be. */
export interface Heard {
  readonly project: string
  /** The machine it happened on, as its hooks name it. None for this one's older hooks. */
  readonly host?: string
  readonly directory: string
  /** What yapd said. */
  readonly spoken: string
  /** What it summed up: the agent's message, or the prompt of work yapd started. */
  readonly message: string
  readonly started?: boolean
  readonly at: number
}

/** How many are kept. */
export const most = 6
/** Older than this, the user would say more than "what it just finished". */
export const lifetime = 3 * 60 * 60_000

/** What the journal kept of it. */
export const fromJournal = (entry: Journal.Kept): Heard => ({
  project: entry.project ?? "",
  ...(entry.machine === undefined ? {} : { host: entry.machine }),
  directory: entry.directory ?? "",
  spoken: entry.said ?? "",
  message: entry.text ?? "",
  ...(entry.kind === "started" ? { started: true } : {}),
  at: entry.at,
})
