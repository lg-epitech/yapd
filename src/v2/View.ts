import type { Store } from "./Store.ts"
import type { SessionEvent } from "./Types.ts"

interface ResponseView {
  readonly turnId: string
  readonly responseId: string
  text: string
  done: boolean
  phase: "working" | "paused" | "complete" | "interrupted" | "failed"
  error?: string
}

/** Public recovery state comes from durable lifecycle events, not a live socket. */
export const snapshot = (store: Store, conversationId: string, recognitionMode: string, active: ReadonlySet<string>) => {
  const responses = new Map<string, ResponseView>()
  for (const { type, data } of store.events(conversationId)) {
    if (type === "generated_text") {
      const event = data as { turnId: string; responseId: string; delta: string }
      const before = responses.get(event.responseId)
      if (before === undefined) responses.set(event.responseId, { turnId: event.turnId, responseId: event.responseId, text: event.delta, done: false, phase: "working" })
      else before.text += event.delta
    } else if (type === "generation_failed") {
      const event = data as { turnId: string; responseId: string; message: string }
      const before = responses.get(event.responseId)
      responses.set(event.responseId, { turnId: event.turnId, responseId: event.responseId, text: before?.text ?? "", done: true, phase: "failed", error: event.message })
    } else if (type === "session_event") {
      const event = data as SessionEvent
      if (event.type === "response_started") responses.set(event.responseId, { turnId: event.turnId, responseId: event.responseId, text: "", done: false, phase: "working" })
      else if ("responseId" in event && event.responseId !== undefined) {
        const response = responses.get(event.responseId)
        if (response === undefined) continue
        if (event.type === "response_done") { response.text = event.text; response.done = true; response.phase = "complete" }
        else if (event.type === "error") { response.done = true; response.phase = "failed"; response.error = event.message }
        else if (event.type === "output_cancelled") { response.done = event.reason !== "onset"; response.phase = event.reason === "onset" ? "paused" : "interrupted" }
        else if (event.type === "output_resumed") { response.text = event.text; response.done = false; response.phase = "working" }
      }
    } else if (type === "item") {
      const item = data as { role?: string; responseId?: string }
      const response = item.responseId === undefined ? undefined : responses.get(item.responseId)
      // Older logs predate durable lifecycle events.
      if (item.role === "assistant" && response !== undefined && response.phase === "working" && !active.has(response.responseId)) { response.done = true; response.phase = "complete" }
    }
  }
  const items = store.projection(conversationId, 200).filter((item) => !(item.type === "message" && item.role === "assistant" && item.text === "" && item.responseId !== undefined && responses.get(item.responseId)?.phase === "complete"))
  const visible = new Set(items.flatMap((item) => item.type === "message" && item.responseId !== undefined ? [item.responseId] : []))
  const pending = [...responses.values()].filter((response) => visible.has(response.responseId) && response.phase !== "complete").map((response) => {
    if (!response.done && !active.has(response.responseId)) return { ...response, done: true, phase: "interrupted", error: "The previous response was interrupted before it finished." }
    return response
  })
  return { type: "snapshot", conversationId, items, responses: pending, recognitionMode }
}
