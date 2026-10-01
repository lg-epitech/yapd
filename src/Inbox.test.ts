import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import * as Inbox from "./Inbox.ts"

const ready = (session: string, priority: Inbox.Ready["priority"], arrivedAt: number): Inbox.Ready => ({
  session,
  priority,
  arrivedAt,
  update: {
    session,
    project: "yapd",
    turn: { prompt: Option.none(), message: "Done." },
    needsYou: priority === "needs-you",
    spoken: "Done.",
    audio: `${session}.wav`,
    thread: { agent: "claude", session, cwd: "/tmp", message: "Done.", origin: {} },
    at: arrivedAt,
  },
})

describe("Inbox", () => {
  test("speaks the oldest update first", () => {
    const inbox = Inbox.add(Inbox.add(Inbox.empty, ready("b", "done", 2)), ready("a", "done", 1))
    expect(Inbox.next(inbox)?.session).toBe("a")
  })

  test("puts updates that need the user ahead of older ones", () => {
    const inbox = Inbox.add(Inbox.add(Inbox.empty, ready("a", "done", 1)), ready("b", "needs-you", 2))
    expect(Inbox.next(inbox)?.session).toBe("b")
  })

  test("keeps only the latest update per session", () => {
    const inbox = Inbox.add(Inbox.add(Inbox.empty, ready("a", "done", 1)), ready("a", "needs-you", 3))
    expect([...inbox.values()]).toEqual([ready("a", "needs-you", 3)])
  })

  test("is empty once every update is removed", () => {
    const inbox = Inbox.remove(Inbox.add(Inbox.empty, ready("a", "done", 1)), "a")
    expect(Inbox.next(inbox)).toBeUndefined()
  })
})
