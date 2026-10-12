import { Effect } from "effect"
import type { Held, Journal, Kept } from "./Journal.ts"
import type * as Threads from "./Threads.ts"

// What he hasn't heard, gathered from the journal a thread at a time, for
// catching him up, for what the brain is told he missed, and for the menu's
// counts. Which of it he asks to hear is the brain's to decide from what he
// said: nothing here reads his words.

const day = 24 * 60 * 60_000

/** How far back a catch-up ever looks. */
export const week = 7 * day

/**
 * How far back a catch-up looks, as of `now`: a day, or since he last turned
 * yapd off, `offAt`, when that's longer, like over a weekend, at most a week.
 */
export const since = (now: number, offAt?: number) => Math.max(now - week, Math.min(now - day, offAt ?? now))

/** When he last had yapd off, from when he turned it off, to when he turned it on again, if he has. */
export interface Off {
  readonly from: number
  readonly to?: number
}

const offRow = (kept: Kept) => (kept.detail as { readonly on?: unknown } | undefined)?.on === false

/**
 * When he last had yapd off, from the times it was turned on or off, newest
 * first, as the journal keeps them: from the first "off" of the last time it
 * went off to the first "on" after, as an "on" or "off" asked for again, like
 * from the API, changes nothing. `before` is when it was last on before then,
 * when that's known.
 */
export const off = (switched: ReadonlyArray<Kept>): (Off & { readonly before?: number }) | undefined => {
  const last = switched.findIndex(offRow)
  if (last === -1) return undefined
  let first = last
  while (first + 1 < switched.length && offRow(switched[first + 1]!)) first++
  const turnedOn = last > 0 ? switched[last - 1] : undefined
  const before = switched[first + 1]
  return { from: switched[first]!.at, ...(turnedOn === undefined ? {} : { to: turnedOn.at }), ...(before === undefined ? {} : { before: before.at }) }
}

/** How many times yapd was turned on or off in a week at most, as far as what he missed reads them. */
export const switches = 1000

const detail = (kept: Kept) => (typeof kept.detail === "object" && kept.detail !== null ? (kept.detail as Record<string, unknown>) : {})

/** Whether a row needs him: an update that asks something of him, or a notice of a failure or a limit. */
export const needs = (kept: Kept) => kept.kind === "notice" || detail(kept).priority === "needs-you"

/** Whether a row is said whatever he muted: what needs him, the answer to what he asked its thread, or a turn yapd couldn't sum up. */
export const audible = (kept: Kept) => needs(kept) || detail(kept).audible === true

/** All of what was said of something, its headline and the rest kept for "more", as it's read to him in full. */
export const whole = (said: string, more: unknown) => {
  const headline = said.trim()
  const rest = typeof more === "string" ? more.trim() : ""
  return rest === "" || headline.includes(rest) ? headline : `${headline} ${rest}`.trim()
}

/** All of a row as it was kept, its "more" too, as it's read to him in full: never only its headline. */
export const full = (kept: Kept) => whole(kept.said ?? "", detail(kept).more)

/** Whether a row came in while yapd was off. */
export const whileOff = (kept: Kept) => detail(kept).held === "off"

/** Whether a row was kept quiet, as he muted its thread. */
export const muted = (kept: Kept) => detail(kept).muted === true

/** Whether a row was held for later, for focus, quiet or the digest. */
export const held = (kept: Kept) => typeof detail(kept).held === "string" && !whileOff(kept)

/** Whether a row was read to him and cut off, rather than never read out. */
export const cut = (kept: Kept) => kept.kind === "update" && !muted(kept) && detail(kept).held === undefined

/** Why an update wasn't read out, as the API says it: kept quiet as he muted its thread, or held, and for what. */
export const unsaid = (kept: Kept): "muted" | Held | undefined => {
  if (kept.kind !== "update") return undefined
  if (muted(kept)) return "muted"
  const { held } = detail(kept)
  return held === "focus" || held === "quiet" || held === "progress" || held === "off" ? held : undefined
}

/** What he hasn't heard of one thread or session. */
export interface Group {
  readonly machine: string | undefined
  readonly thread: string | undefined
  readonly project: string | undefined
  /** What it's called aloud, while it's on the desk. */
  readonly called?: string
  /** Its handle: the desk's while it's there, like "t4", or else one of its own, like "u1". */
  readonly handle: string
  /** Oldest first. */
  readonly rows: ReadonlyArray<Kept>
  /** How many of them need him. */
  readonly needs: number
  /** How many came in while yapd was off. */
  readonly off: number
  /** How many were kept quiet, as he muted it. */
  readonly muted: number
  /** How many were held for focus, quiet or the digest. */
  readonly held: number
  /** How many were read to him and cut off. */
  readonly cut: number
  readonly oldest: number
  readonly newest: number
  /** What was said, or would have been, of the newest. */
  readonly latest: string
}

/** Whether all a group holds was kept quiet, as he muted its thread, which a catch-up leaves out unless he asks about it. */
export const quiet = (group: Pick<Group, "muted" | "rows">) => group.muted === group.rows.length

/** A group with only the rows `keep` keeps, recounted, or none when it keeps none. */
export const only = (group: Group, keep: (kept: Kept) => boolean): Group | undefined => {
  const rows = group.rows.filter(keep)
  return rows.length === 0 ? undefined : tally(group, rows)
}

const tally = (group: Pick<Group, "machine" | "thread" | "project" | "called" | "handle">, rows: ReadonlyArray<Kept>): Group => {
  const newest = rows.at(-1)!
  return {
    machine: group.machine,
    thread: group.thread,
    project: group.project,
    ...(group.called === undefined ? {} : { called: group.called }),
    handle: group.handle,
    rows,
    needs: rows.filter(needs).length,
    off: rows.filter(whileOff).length,
    muted: rows.filter(muted).length,
    held: rows.filter(held).length,
    cut: rows.filter(cut).length,
    oldest: rows[0]!.at,
    newest: newest.at,
    latest: newest.said ?? "",
  }
}

/** The thread on the desk a row is about, when it's there. */
const listed = (desk: Threads.Desk, kept: Pick<Kept, "machine" | "thread">) =>
  kept.thread === undefined ? undefined : desk.threads.find(({ ref }) => ref.id === kept.thread && (kept.machine === undefined || ref.machine === kept.machine))

/**
 * Rows grouped by their thread or session, what needs him first, then the
 * newest, each named as the desk has it, or else given a handle of its own.
 */
export const group = (rows: ReadonlyArray<Kept>, desk: Threads.Desk): ReadonlyArray<Group> => {
  const threads = new Map<string, Array<Kept>>()
  for (const kept of rows) {
    const key = `${kept.machine ?? ""}\n${kept.thread ?? ""}`
    threads.set(key, [...(threads.get(key) ?? []), kept])
  }
  const sorted = [...threads.values()]
    .map((all) => all.toSorted((one, other) => one.at - other.at || one.id - other.id))
    .toSorted((one, other) => Number(other.some(needs)) - Number(one.some(needs)) || other.at(-1)!.at - one.at(-1)!.at)
  let own = 0
  return sorted.map((all) => {
    const first = all[0]!
    const on = listed(desk, first)
    const project = all.findLast((kept) => kept.project !== undefined)?.project
    return tally({ machine: first.machine, thread: first.thread, project, ...(on === undefined ? {} : { called: on.called }), handle: on?.handle ?? `u${++own}` }, all)
  })
}

/** What he missed, as the brain and a catch-up see it: since when, since when he last spoke, when he last had yapd off, and a group a thread. */
export interface Missed {
  readonly since: number
  /** Since when what was cut off counts: when he last spoke, other than to catch up. */
  readonly spoke: number
  readonly off?: Off
  readonly groups: ReadonlyArray<Group>
}

/**
 * What he missed as of `now`: what he never heard read out since the window
 * began, and what he heard cut off since he last `spoke`, but not what's
 * `coming`, waiting to be read or being read, which he's told of as it is.
 * What came in while yapd was off, what needs him and what he's to hear
 * whatever he muted count for a week, whenever he had yapd off, so a short
 * time off since, or another night off, never makes them drop out unheard.
 */
export const gather = (journal: Pick<Journal["Type"], "missed" | "switched">, given: { readonly now: number; readonly spoke: number; readonly coming: ReadonlyArray<number>; readonly desk: Threads.Desk }) =>
  Effect.gen(function* () {
    const last = off(yield* journal.switched(given.now - week, switches))
    const from = since(given.now, last?.from)
    const rows = (yield* journal.missed(from, Math.max(from, given.spoke), undefined, given.now - week)).filter(({ id }) => !given.coming.includes(id))
    const switched = last === undefined ? undefined : { from: last.from, ...(last.to === undefined ? {} : { to: last.to }) }
    return {
      since: Math.min(from, ...rows.map(({ at }) => at)),
      spoke: given.spoke,
      ...(switched === undefined ? {} : { off: switched }),
      groups: group(rows, given.desk),
    } satisfies Missed
  })

/** How much of it there is, threads and rows. */
export const counted = (groups: ReadonlyArray<Group>) => ({ threads: groups.length, rows: groups.reduce((sum, { rows }) => sum + rows.length, 0) })
