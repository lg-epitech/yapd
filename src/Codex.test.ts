import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Codex from "./Codex.ts"
import type { Thread } from "./Relay.ts"

const thread: Thread = { agent: "codex", session: "test", cwd: "/test", message: "done", origin: {} }

const fakeSocket = () => {
  const sent: Array<{ id?: number; method: string }> = []
  const socket = {
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((cause: unknown) => void) | null,
    onclose: null as (() => void) | null,
    send: (message: string) => { sent.push(JSON.parse(message)) },
    close: () => { closed = true },
  }
  let closed = false
  const constructor = globalThis.WebSocket
  globalThis.WebSocket = class { constructor() { return socket } } as unknown as typeof WebSocket
  const withMessage = async (reply: string) => {
    const result = Effect.runPromise(Effect.flip(Codex.relay.send(thread, "test")))
    while (socket.onopen === null) await Bun.sleep(1)
    socket.onopen()
    socket.onmessage?.({ data: reply })
    expect(await result).toMatchObject({ _tag: "Unreachable" })
    expect(closed).toBe(true)
    expect(socket.onmessage).toBeNull()
  }
  return { sent, withMessage, restore: () => { globalThis.WebSocket = constructor } }
}

describe("Codex daemon protocol", () => {
  test("rejects malformed JSON without throwing out of the socket callback", async () => {
    const socket = fakeSocket()
    try { await socket.withMessage("not JSON") } finally { socket.restore() }
  })

  test("rejects an invalid envelope and closes its connection", async () => {
    const socket = fakeSocket()
    try { await socket.withMessage("null") } finally { socket.restore() }
  })

  test("stops after initialization is refused instead of requesting a thread", async () => {
    const socket = fakeSocket()
    try {
      await socket.withMessage(JSON.stringify({ id: 1, error: { message: "initialization refused" } }))
      expect(socket.sent.map(({ method }) => method)).toEqual(["initialize"])
    } finally { socket.restore() }
  })
})
