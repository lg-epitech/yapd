import { busy, type Thread } from "../T3Live.ts"
import type { NotificationFact } from "./Types.ts"

/** Finished and the provider's Stop hook name the same source completion. */
export const effectivelySnoozed = (thread: Thread, now: number): boolean => {
  const until = Date.parse(thread.snoozedUntil ?? "")
  if (!Number.isFinite(until) || until <= now || thread.pendingRuntimeRequest !== null || (thread.pendingGuestMessageCount ?? 0) > 0) return false
  const at = Date.parse(thread.snoozedAt ?? "")
  const completed = Date.parse(thread.latestRunCompletedAt ?? "")
  return !(thread.status === "failed" && (!Number.isFinite(at) || Number.isFinite(completed) && completed > at))
}

export const threadNotification = (machine: string, thread: Thread, eligible: boolean, automatic = true, now = Date.now()): NotificationFact => {
  const key = JSON.stringify([machine, thread.id])
  const current = thread.pendingRuntimeRequest?.id ?? thread.latestRunId
  const version = Date.parse(thread.updatedAt)
  return {
    key, id: `${key}:${eligible ? current : `inactive:${thread.updatedAt}`}`,
    version: Number.isFinite(version) ? version : 0, automatic,
    eligible: eligible && current !== null && Number.isFinite(version) && thread.archivedAt === null && thread.settledOverride !== "settled" && !effectivelySnoozed(thread, now),
  }
}

/** Stop hooks corroborate known idle completions and never invalidate them. */
export const threadStopNotification = (machine: string, thread: Thread, eligible: boolean, automatic = true, now = Date.now()): NotificationFact | undefined => {
  const fact = threadNotification(machine, thread, eligible && !busy(thread), automatic, now)
  return fact.eligible ? fact : undefined
}

/** Unsnoozing/unsettling is not a dismissal of information still pending. */
export const organizationNotification = (machine: string, thread: Thread, now = Date.now()): NotificationFact | undefined =>
  thread.archivedAt !== null || thread.settledOverride === "settled" || effectivelySnoozed(thread, now) ? threadNotification(machine, thread, false, false, now) : undefined
