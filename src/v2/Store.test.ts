import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Session } from "./Session.ts"
import { json, Store } from "./Store.ts"

describe("V2 Store", () => {
  test("restart exposes prepared/running actions as unknown without re-executing accepted input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "yapd-v2-"))
    const file = join(directory, "history.sqlite")
    let first: Store | undefined
    let reopened: Store | undefined
    try {
      first = new Store(file)
      first.commit({ conversationId: "c", turnId: "u", userText: "Send", source: "text", responseId: "r" })
      first.prepare({ id: "action", conversationId: "c", turnId: "u", revision: 1, callId: "call", name: "send", arguments: { text: "Send" }, mode: "write" })
      first.running("action")
      first.close()
      first = undefined
      reopened = new Store(file)
      let runs = 0
      const session = new Session({ conversationId: "c", store: reopened, tools: [], model: { stream: async function* () { runs++; yield { type: "done" } } } })
      expect(reopened.getInvocation("action")).toMatchObject({ state: "unknown", result: { status: "unknown" } })
      expect(reopened.items("c").filter((item) => item.type === "function_call")).toHaveLength(1)
      expect(reopened.items("c").filter((item) => item.type === "function_result")).toHaveLength(1)
      expect((await session.commit({ text: "Send", source: "text", turnId: "u" })).duplicate).toBe(true)
      expect(runs).toBe(0)
      reopened.recover("c")
      expect(reopened.items("c").filter((item) => item.type === "function_result")).toHaveLength(1)
      await session.close()
    } finally {
      first?.close()
      reopened?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("restores a settled receipt whose model-facing item was not appended before a crash", () => {
    const store = new Store()
    store.commit({ conversationId: "c", turnId: "u", userText: "Send", source: "text", responseId: "r" })
    store.prepare({ id: "action", conversationId: "c", turnId: "u", revision: 1, callId: "call", name: "send", arguments: {}, mode: "write" })
    store.running("action")
    store.settle("action", "completed", { accepted: true, messageId: "m" })
    store.recover("c")
    expect(store.getInvocation("action")?.state).toBe("completed")
    expect(store.items("c").find((item) => item.type === "function_result")).toMatchObject({ result: { accepted: true, messageId: "m" } })
    store.close()
  })

  test("does not silently erase non-JSON receipt fields", () => {
    expect(() => json({ status: "ok", missing: undefined })).toThrow("JSON")
    expect(() => json({ value: Number.NaN })).toThrow("JSON")
    expect(() => json({ callback: () => true })).toThrow("JSON")
  })

  test("recovers generated speech after a process stop without pretending it played", () => {
    const store = new Store()
    store.commit({ conversationId: "c", turnId: "u", userText: "Read it", source: "voice", responseId: "r" })
    store.append("c", "generated_text", { responseId: "r", turnId: "u", delta: "First " })
    store.append("c", "generated_text", { responseId: "r", turnId: "u", delta: "detail." })
    store.recover("c")
    expect(store.items("c").find((item) => item.type === "message" && item.role === "assistant")).toMatchObject({ text: "First detail." })
    expect(store.getPlayback("c", "r")).toBeUndefined()
    store.recover("c")
    expect(store.items("c").filter((item) => item.type === "message" && item.role === "assistant")).toHaveLength(1)
    store.close()
  })

  test("late playback acknowledgments cannot regress the recorded played position", () => {
    const store = new Store()
    expect(store.playback("c", { responseId: "r", playedMs: 800, state: "finished", certainty: "exact" })).toBe(true)
    expect(store.playback("c", { responseId: "r", playedMs: 300, state: "playing", certainty: "exact" })).toBe(false)
    expect(store.getPlayback("c", "r")).toMatchObject({ playedMs: 800, state: "finished" })
    store.close()
  })
})
