import { expect, test } from "bun:test"
import { Session } from "./Session.ts"
import { Store } from "./Store.ts"
import { createHistoryTool } from "./HistoryTool.ts"

test("the same tool loop recalls constraints outside its current history window after reconnect", async () => {
  const store = new Store()
  store.commit({ conversationId: "c", turnId: "original", userText: "Only French tests. Do not update snapshots or merge.", source: "voice", responseId: "old-answer" })
  store.append("c", "generated_text", { turnId: "original", responseId: "old-answer", delta: "French tests only. No snapshots or merging." })
  store.playback("c", { responseId: "old-answer", state: "interrupted", playedMs: 800, certainty: "approximate", playedText: "French tests only." })
  for (let n = 0; n < 30; n++) store.appendItem("c", { type: "message", role: "user", text: `Other topic ${n}`, turnId: `other-${n}` })
  let recalled: unknown
  const session = new Session({ conversationId: "c", store, maxItems: 4, tools: [createHistoryTool(store, "c")], model: { stream: async function* ({ items }) {
    const result = items.find((item) => item.type === "function_result")
    if (result?.type === "function_result") recalled = result.result
    else yield { type: "tool_call", callId: "recall", name: "recall_conversation", arguments: { query: "French" } }
    yield { type: "done" }
  } } })
  try {
    expect(session.history().some((item) => item.type === "message" && item.turnId === "original")).toBe(false)
    await session.commit({ text: "What limits did I give you earlier?", source: "text" })
    await session.idle()
    expect(recalled).toMatchObject({ authority: "reference_only", items: [
      { item: { role: "user", text: "Only French tests. Do not update snapshots or merge." } },
      { item: { role: "assistant" }, playback: { state: "interrupted", playedText: "French tests only." } },
    ] })
  } finally { await session.close(); store.close() }
})
