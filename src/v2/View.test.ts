import { expect, test } from "bun:test"
import { Session } from "./Session.ts"
import { Store } from "./Store.ts"
import { snapshot } from "./View.ts"

test("a provider failure before any text stays failed in a reconnect snapshot", async () => {
  const store = new Store()
  const session = new Session({ conversationId: "c", store, tools: [], model: { stream: async function* () { throw new Error("The provider is unavailable.") } } })
  try {
    const receipt = await session.commit({ text: "Read the task", source: "voice" })
    await session.idle()
    const recovered = snapshot(store, "c", "native_streaming", new Set())
    expect(recovered.responses).toMatchObject([{ responseId: receipt.responseId, done: true, phase: "failed", error: "The provider is unavailable." }])
    expect(recovered.items).toContainEqual(expect.objectContaining({ responseId: receipt.responseId, role: "assistant", text: "" }))
  } finally { await session.close(); store.close() }
})

test("partial failed output keeps its place and error after a process restart", async () => {
  const store = new Store()
  const session = new Session({ conversationId: "c", store, tools: [], model: { stream: async function* () { yield { type: "text_delta", delta: "The first fact." }; throw new Error("Connection lost.") } } })
  try {
    const receipt = await session.commit({ text: "Explain", source: "voice" })
    await session.idle()
    store.recover("c")
    const recovered = snapshot(store, "c", "prefix_upload", new Set())
    expect(recovered.responses).toMatchObject([{ responseId: receipt.responseId, text: "The first fact.", phase: "failed", done: true, error: "Connection lost." }])
    expect(recovered.items.filter((item) => item.type === "message").map((item) => item.text)).toEqual(["Explain", "The first fact."])
  } finally { await session.close(); store.close() }
})
