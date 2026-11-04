import type { Store } from "./Store.ts"
import type { Tool } from "./Types.ts"

const idsFrom = (args: unknown): ReadonlyArray<string> | undefined => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>
  return Object.keys(input).every((key) => key === "ids") && Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 20 && input.ids.every((id) => typeof id === "string" && id !== "") ? input.ids : undefined
}
const idParameters = { type: "object", properties: { ids: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 } }, required: ["ids"], additionalProperties: false }

/** Internal notification information; neither tool replays audio or coding actions. */
export const createNotificationTools = (store: Store, conversationId: string): ReadonlyArray<Tool> => [{
  name: "pending_updates", mode: "read",
  description: "Read retained notification facts when relevant to the current question or a catch-up request. These are not replies to restart. Check current thread state before reporting an old update, then call report_updates with the IDs you will include. Playback records describe only the recorded attempt.",
  parameters: { type: "object", properties: { query: { type: "string", maxLength: 200 }, offset: { type: "integer", minimum: 0 } }, additionalProperties: false },
  execute: async (args, context) => {
    context.assertCurrent()
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("Pending updates needs an object.")
    const input = args as Record<string, unknown>
    if (Object.keys(input).some((key) => !["query", "offset"].includes(key)) || input.query !== undefined && (typeof input.query !== "string" || input.query.length > 200) || input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw new Error("Invalid pending update query.")
    const query = String(input.query ?? "").toLocaleLowerCase()
    const offset = Number(input.offset ?? 0)
    const matches = store.pendingNotifications(conversationId).filter((notice) => `${notice.key} ${notice.text}`.toLocaleLowerCase().includes(query))
    return { authority: "reference_only", updates: matches.slice(offset, offset + 20).map((notice) => ({ ...notice, text: notice.text.slice(0, 4000), excerpt: notice.text.length > 4000 })), nextOffset: offset + 20 < matches.length ? offset + 20 : null }
  },
}, {
  name: "report_updates", mode: "write",
  description: "Before including specific pending update IDs in a user-requested answer, select them here. This does not dismiss them or play audio. Only the answer's confirmed full playback clears them; interruption retains the facts. Never select facts you are not including. Does not authorize coding actions.",
  parameters: idParameters,
  execute: async (args, context) => {
    const ids = idsFrom(args)
    if (ids === undefined) return { ok: false, status: "rejected", message: "Invalid update IDs." }
    await context.waitForWrite()
    context.assertCurrent()
    const turn = store.getTurn(conversationId, context.turnId)
    if (turn === undefined) return { ok: false, status: "rejected", message: "Reporting updates needs a current user request." }
    try {
      store.reportNotifications(conversationId, turn.responseId, ids)
      return { status: "waiting_for_playback", ids }
    } catch (error) {
      return { ok: false, status: "rejected", message: error instanceof Error ? error.message : "The updates could not be selected." }
    }
  },
}, {
  name: "dismiss_updates", mode: "write",
  description: "Dismiss specific pending notification IDs only when the user asks to skip, dismiss or stop bringing those updates up. Does not stop coding tasks or erase history. Do not call just to empty the list.",
  parameters: idParameters,
  execute: async (args, context) => {
    const ids = idsFrom(args)
    if (ids === undefined) return { ok: false, status: "rejected", message: "Invalid update IDs." }
    await context.waitForWrite()
    context.assertCurrent()
    try {
      store.dismissNotifications(conversationId, ids)
      return { status: "dismissed", ids }
    } catch (error) {
      // This transaction either updates the selected local records or rolls
      // back. A stale selection is a known no-op, never an uncertain dispatch.
      return { ok: false, status: "rejected", message: error instanceof Error ? error.message : "The updates could not be dismissed." }
    }
  },
}]
