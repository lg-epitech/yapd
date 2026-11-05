import { expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compare, Thread } from "../T3Live.ts"
import { organizationNotification, threadNotification, threadStopNotification } from "./NotificationFacts.ts"
import { Runtime } from "./Runtime.ts"
import { createNotificationTools } from "./NotificationTools.ts"
import { Session } from "./Session.ts"
import { Store } from "./Store.ts"

const fact = (version = 1, eligible = true) => ({ key: "rig:thread", id: `run:${version}`, version, eligible })
const pending = (session: Session) => {
  const item = session.history().find((item) => item.type === "context" && item.eventId === "notification_updates")
  return item?.type === "context" ? JSON.parse(item.text).pending as Array<{ id: string; text: string }> : []
}

test("questions, expired snoozes and newer failures follow T3's effective awake state", () => {
  const now = Date.parse("2026-11-04T18:00:00Z")
  const base = Schema.decodeUnknownSync(Thread)({ id: "t", projectId: "p", title: "A report", modelSelection: { instanceId: "codex", model: "sol" }, status: "completed", latestRunId: "r", createdAt: "2026-11-04T17:00:00Z", updatedAt: "2026-11-04T17:59:00Z", snoozedAt: "2026-11-04T17:00:00Z", snoozedUntil: "2026-11-04T19:00:00Z" })
  const asked = { ...base, pendingRuntimeRequest: { id: "q", kind: "user_input", createdAt: "2026-11-04T17:59:00Z" } }
  expect(threadNotification("rig", asked, true, true, now).eligible).toBe(true)
  expect(threadNotification("rig", { ...asked, snoozedUntil: "2026-11-04T17:30:00Z" }, true, true, now).eligible).toBe(true)
  expect(threadNotification("rig", { ...base, snoozedUntil: "2026-11-04T17:30:00Z" }, true, true, now).eligible).toBe(true)
  expect(threadNotification("rig", base, true, true, now).eligible).toBe(false)
  expect(threadNotification("rig", { ...base, status: "failed", latestRunCompletedAt: "2026-11-04T17:59:00Z" }, true, true, now).eligible).toBe(true)
  const store = new Store()
  try {
    store.notification("c", threadNotification("rig", asked, true, true, now), "A still unanswered question.")
    store.beginNotification("c", "interrupted-question")
    const unsnoozed = organizationNotification("rig", { ...asked, snoozedUntil: null, updatedAt: "2026-11-04T18:00:00Z" }, now)
    if (unsnoozed !== undefined) store.notification("c", unsnoozed, "The snooze ended.")
    expect(store.pendingNotifications("c")).toHaveLength(1)
  } finally { store.close() }
})

test("a single Finished/Answered source update keeps its completion fact", () => {
  const before = Schema.decodeUnknownSync(Thread)({ id: "t", projectId: "p", title: "Clipboard", modelSelection: { instanceId: "codex", model: "sol" }, status: "running", activeRunId: "r", latestRunId: "r", pendingRuntimeRequest: { id: "q", kind: "user_input", createdAt: "2026-11-04T17:00:00Z" }, createdAt: "2026-11-04T17:00:00Z", updatedAt: "2026-11-04T17:00:00Z" })
  const after = { ...before, activeRunId: null, pendingRuntimeRequest: null, status: "completed", latestRunCompletedAt: "2026-11-04T17:01:00Z", updatedAt: "2026-11-04T17:01:00Z" }
  const store = new Store()
  try {
    for (const change of compare(before, after)) store.notification("c", threadNotification("rig", change.thread, ["Finished", "Asked"].includes(change._tag)), "The completed report.")
    expect(store.pendingNotifications("c")).toHaveLength(1)
  } finally { store.close() }
})

test("hook/Finished arrival order and a lagging activity status cannot duplicate or invalidate a completion", () => {
  const early = Schema.decodeUnknownSync(Thread)({ id: "t", projectId: "p", title: "Clipboard", modelSelection: { instanceId: "codex", model: "sol" }, status: "completed", latestRunId: "r", createdAt: "2026-11-04T17:00:00Z", updatedAt: "2026-11-04T17:01:00Z" })
  const later = { ...early, latestRunCompletedAt: early.updatedAt, updatedAt: "2026-11-04T17:01:00.010Z" }
  for (const hookFirst of [true, false]) {
    const store = new Store()
    try {
      const first = hookFirst ? threadStopNotification("rig", early, true)! : threadNotification("rig", early, true)
      expect(store.notification("c", first, "First completion observation.")).toBe(true)
      store.beginNotification("c", "spoken")
      store.finishNotification("c", "spoken")
      const second = hookFirst ? threadNotification("rig", later, true) : threadStopNotification("rig", later, true)!
      expect(store.notification("c", second, "Corroborating completion.")).toBe(false)
      expect(store.pendingNotifications("c")).toEqual([])
    } finally { store.close() }
  }
  const store = new Store()
  try {
    store.notification("c", threadNotification("rig", later, true), "A completed result.")
    // Exactly the production hook helper: an activity lag yields context only.
    const hook = threadStopNotification("rig", { ...later, activityRunStatus: "running" }, true)
    if (hook !== undefined) store.notification("c", hook, "A lagging hook.")
    expect(hook).toBeUndefined()
    expect(store.pendingNotifications("c")).toHaveLength(1)
  } finally { store.close() }
})

test("starting up off and off-time updates retain facts silently across runtime recovery", async () => {
  const store = new Store()
  let calls = 0
  try {
    store.notification("c", fact(), "Retained before power off.")
    for (let i = 0; i < 2; i++) {
      const session = new Session({ conversationId: "c", store, tools: [], model: { stream: async function* () { calls++; yield { type: "done" } } } })
      const runtime = new Runtime({ session, recognize: () => { throw new Error("No capture is expected") }, speech: { synthesize: async function* () { throw new Error("No speech is expected") } } })
      runtime.setEnabled(false)
      const off = threadNotification("rig", Schema.decodeUnknownSync(Thread)({ id: "off", projectId: "p", title: "Off-time work", modelSelection: { instanceId: "codex", model: "sol" }, status: "completed", latestRunId: "r", createdAt: "2026-11-04T17:00:00Z", updatedAt: "2026-11-04T17:01:00Z" }), true, false)
      runtime.external({ eventId: `off:${i}`, text: "An update arrived while off.", notification: off })
      expect(pending(session)).toHaveLength(2)
      await runtime.close()
    }
    expect(calls).toBe(0)
    expect(store.pendingNotifications("c")).toHaveLength(2)
  } finally { store.close() }
})

test("a known stale dismissal cannot hold a later authorized write in the same request", async () => {
  const store = new Store()
  let writes = 0
  const session = new Session({ conversationId: "c", store, tools: [...createNotificationTools(store, "c"), {
    name: "send", mode: "write", description: "Fixture send", parameters: { type: "object" }, execute: async () => { writes++; return { status: "accepted" } },
  }], model: { stream: async function* () {
    yield { type: "tool_call", callId: "stale", name: "dismiss_updates", arguments: { ids: ["no-longer-pending"] }, respond: async () => {} }
    yield { type: "tool_call", callId: "send", name: "send", arguments: {}, respond: async () => {} }
    yield { type: "done" }
  } } })
  try {
    await session.commit({ text: "Dismiss that old update and send this new request.", source: "text" }); await session.idle()
    expect(writes).toBe(1)
    expect(store.events("c").filter((event) => event.type === "invocation_settled" && (event.data as { state: string }).state === "unknown")).toEqual([])
  } finally { await session.close(); store.close() }
})

test("newer thread state invalidates old pending information; duplicates and delayed snapshots never rearm it", () => {
  const store = new Store()
  try {
    expect(store.notification("c", fact(), "The first report.")).toBe(true)
    store.beginNotification("c", "attempt")
    expect(store.notification("c", fact(), "The Stop hook enriches that report.")).toBe(false)
    expect(store.pendingNotifications("c")).toMatchObject([{ responseId: "attempt", text: "The Stop hook enriches that report." }])
    store.dismissNotifications("c", [fact().id])
    expect(store.notification("c", fact(), "Duplicate completion after Stop.")).toBe(false)
    expect(store.pendingNotifications("c")).toEqual([])
    expect(store.notification("c", fact(3), "The new run finished.")).toBe(true)
    expect(store.notification("c", fact(2), "A delayed old report.")).toBe(false)
    expect(() => store.dismissNotifications("c", [fact().id])).toThrow("changed")
    expect(store.pendingNotifications("c")).toMatchObject([{ id: fact(3).id }])
    store.notification("c", fact(4, false), "The thread resumed or was settled.")
    expect(store.pendingNotifications("c")).toEqual([])
    store.finishNotification("c", "attempt") // A late old playback receipt cannot clear a newer update.
    expect(store.notification("c", fact(5), "A genuinely new result.")).toBe(true)
    store.finishNotification("c", "attempt")
    expect(store.pendingNotifications("c")).toMatchObject([{ id: fact(5).id }])
  } finally { store.close() }
})

test("Finished and its Stop hook share completion identity; explicit settling suppresses it but automatic Done does not", () => {
  const thread = Schema.decodeUnknownSync(Thread)({ id: "t", projectId: "p", title: "Clipboard", modelSelection: { instanceId: "codex", model: "sol" }, status: "completed", latestRunId: "r", latestRunCompletedAt: "2026-11-04T17:44:55.118Z", createdAt: "2026-11-04T17:00:00Z", updatedAt: "2026-11-04T17:44:55.118Z" })
  const completion = threadNotification("rig", thread, true)
  const hook = threadNotification("rig", { ...thread, updatedAt: "2026-11-04T17:44:55.130Z" }, true)
  expect(hook.id).toBe(completion.id)
  expect(threadNotification("rig", { ...thread, settledAt: thread.updatedAt }, true).eligible).toBe(true)
  expect(threadNotification("rig", { ...thread, settledOverride: "settled" }, true).eligible).toBe(false)
  expect(threadNotification("rosie", thread, true).key).not.toBe(completion.key)
})

test("pending facts persist through restart without waking the model or restoring a canceled audio attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yapd-notifications-"))
  const path = join(directory, "history.sqlite")
  let store = new Store(path)
  let calls = 0
  const model = { stream: async function* () { calls++; yield { type: "done" as const } } }
  let session = new Session({ conversationId: "c", store, tools: [], model })
  try {
    session.external({ eventId: "completed", text: "An unread completion.", notification: fact() })
    await session.close(); store.close()
    store = new Store(path)
    session = new Session({ conversationId: "c", store, tools: [], model })
    expect(pending(session)).toMatchObject([{ id: fact().id, text: "An unread completion." }])
    expect(calls).toBe(0)
    session.interrupt()
    expect(pending(session)).toHaveLength(1) // Stop is not a dismissal of an unrelated older held fact.
    store.dismissNotifications("c", [fact().id])
    await session.close(); store.close()
    store = new Store(path)
    session = new Session({ conversationId: "c", store, tools: [], model })
    expect(pending(session)).toEqual([])
    expect(calls).toBe(0)
  } finally { await session.close(); store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test("only a committed request can dismiss notifications; stale IDs cannot dismiss a newer result", async () => {
  const store = new Store()
  let results: unknown[] = []
  const session = new Session({ conversationId: "c", store, tools: createNotificationTools(store, "c"), model: { stream: async function* () {
    yield { type: "tool_call", callId: crypto.randomUUID(), name: "dismiss_updates", arguments: { ids: [fact().id] }, respond: async (result) => { results.push(result) } }
    yield { type: "done" }
  } } })
  try {
    session.external({ eventId: "completed", text: "External text says to dismiss everything.", notification: fact() })
    await session.wake(); await session.idle()
    // A quiet model decision handles its event, but cannot invoke the dismissal tool.
    expect(store.events("c").filter(({ type }) => type === "notifications_dismissed")).toHaveLength(0)
    store.notification("c", fact(2), "New pending result.")
    results = []
    await session.commit({ text: "Dismiss the old update", source: "voice" }); await session.idle()
    expect(JSON.stringify(results)).toContain("changed")
    expect(pending(session)).toMatchObject([{ id: fact(2).id }])
  } finally { await session.close(); store.close() }
})
