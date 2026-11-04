import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { html } from "./Page.ts"

/** A deliberately small DOM: HTML insertion and persistence are unavailable to the page script. */
class Element {
  textContent = ""
  value = ""
  hidden = false
  disabled = false
  className = ""
  dataset: Record<string, string> = {}
  children: Element[] = []
  scrollHeight = 200
  scrollTop = 0
  clientHeight = 200
  private listeners = new Map<string, (event: Record<string, unknown>) => unknown>()
  append(...children: Element[]): void { this.children.push(...children) }
  replaceChildren(): void { this.children = [] }
  focus(): void {}
  addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown): void { this.listeners.set(type, handler) }
  dispatch(type: string, fields: Record<string, unknown> = {}): unknown { return this.listeners.get(type)?.({ preventDefault() {}, ...fields }) }
  requestSubmit(): unknown { return this.dispatch("submit") }
}

const tick = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }
const stream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel() { cancelled = true } })
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    send: (event: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    bytes: (value: Uint8Array) => controller.enqueue(value),
    close: () => controller.close(),
    cancelled: () => cancelled,
  }
}

const browser = (fetcher?: (path: string, init: RequestInit) => Response | Promise<Response>) => {
  const elements = new Map<string, Element>()
  const get = (id: string) => {
    let element = elements.get(id)
    if (!element) { element = new Element(); elements.set(id, element) }
    return element
  }
  for (const id of ["retry", "disconnect", "notice"]) get(id).hidden = true
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let timerId = 0
  const streams: ReturnType<typeof stream>[] = []
  const calls: Array<{ path: string; init: RequestInit }> = []
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  if (!script) throw new Error("Page script missing")
  runInNewContext(script, {
    document: { getElementById: get, createElement: () => new Element() },
    fetch: async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      if (fetcher) return fetcher(path, init)
      const connection = stream(); streams.push(connection); return connection.response
    },
    crypto, AbortController, TextDecoder, Error,
    setTimeout: (callback: () => void, ms: number) => { timers.set(++timerId, { callback, ms }); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
    get localStorage() { throw new Error("The token must not be persisted") },
    get sessionStorage() { throw new Error("The token must not be persisted") },
  })
  return {
    get, calls, streams, timers,
    connect: async (token = "private-token") => { get("token").value = token; get("auth").dispatch("submit"); await tick() },
    runRetry: async () => {
      const timer = timers.entries().next().value
      if (!timer) throw new Error("No retry scheduled")
      timers.delete(timer[0]); timer[1].callback(); await tick()
    },
    words: () => get("transcript").children.map((row) => row.children[1]?.textContent),
  }
}
const snapshot = (items: object[] = [], responses: object[] = []) => ({ type: "snapshot", conversationId: "same-conversation", items, responses, recognitionMode: "batch" })

describe("V2 conversation page", () => {
  test("consumes split UTF-8 SSE with bearer headers and renders only public text, including recovery of an in-flight response", async () => {
    const page = browser()
    await page.connect()
    const connection = page.streams[0]!
    const unsafe = '<img src=x onerror="steal()">'
    const event = snapshot([
      { type: "message", role: "user", text: unsafe, turnId: "u1" },
      { type: "message", role: "assistant", text: "Earlier", turnId: "u1", responseId: "a1" },
      { type: "function_result", result: { secret: "private tool JSON" } },
      { type: "context", text: "private thread context" },
    ], [{ turnId: "u1", responseId: "a1", text: "Earlier", done: true }, { turnId: "u2", responseId: "a2", text: "Caf", done: false }])
    const payload = new TextEncoder().encode(": heartbeat\r\ndata: " + JSON.stringify(event) + "\r\n\r\ndata: " + JSON.stringify({ type: "response_started", responseId: "a2" }) + "\r\n\r\ndata: " + JSON.stringify({ type: "text_delta", responseId: "a2", delta: "é " + unsafe }) + "\r\n\r\n")
    // Every possible byte boundary includes split CRLF and the multibyte é.
    for (const byte of payload) connection.bytes(new Uint8Array([byte]))
    await tick()
    expect(page.get("status").textContent).toBe("Connected")
    expect(page.words()).toEqual([unsafe, "Earlier", "Café " + unsafe])
    expect(page.get("token").value).toBe("")
    expect(page.calls[0]!.path).toBe("/conversation/stream")
    expect(new Headers(page.calls[0]!.init.headers).get("Authorization")).toBe("Bearer private-token")
    expect(page.calls.every(({ path, init }) => !path.includes("private-token") && !String(init.body).includes("private-token"))).toBe(true)
    connection.send({ type: "tool_result", result: { secret: "never display this" } })
    connection.send({ type: "response_done", responseId: "a2", text: "Verified answer" })
    connection.send({ type: "text_delta", responseId: "a2", delta: "stale output" })
    await tick()
    expect(page.words()).toEqual([unsafe, "Earlier", "Verified answer"])
    page.get("disconnect").dispatch("click")
    await tick()
    expect(connection.cancelled()).toBe(true)
    expect(page.words()).toEqual([])
  })

  test("reconnects once with bounded delay, then exposes manual Retry and cancels the previous reader", async () => {
    const page = browser()
    await page.connect()
    page.streams[0]!.send(snapshot()); await tick()
    page.streams[0]!.close(); await tick()
    expect([...page.timers.values()].map(({ ms }) => ms)).toEqual([500])
    await page.runRetry()
    page.streams[1]!.send(snapshot()); await tick()
    page.streams[1]!.close(); await tick()
    expect(page.calls).toHaveLength(2)
    expect(page.timers.size).toBe(0)
    expect(page.get("retry").hidden).toBe(false)
    expect(page.get("send").disabled).toBe(true)
    page.get("retry").dispatch("click"); await tick()
    page.streams[2]!.send(snapshot()); await tick()
    expect(page.get("status").textContent).toBe("Connected")
    page.get("disconnect").dispatch("click"); await tick()
    expect(page.streams[2]!.cancelled()).toBe(true)
  })

  test("late connection completions cannot replace a newer conversation or reintroduce old output", async () => {
    const old = stream(), current = stream()
    let resolve!: (response: Response) => void
    let count = 0
    const page = browser(() => ++count === 1 ? new Promise<Response>((done) => { resolve = done }) : current.response)
    await page.connect("first-token")
    await page.connect("second-token")
    current.send(snapshot([{ type: "message", role: "user", turnId: "new", text: "Current conversation" }]))
    await tick()
    old.send(snapshot([{ type: "message", role: "user", turnId: "old", text: "Old private conversation" }]))
    resolve(old.response); await tick()
    expect(old.cancelled()).toBe(true)
    expect(page.words()).toEqual(["Current conversation"])
    expect((page.calls[0]!.init.signal as AbortSignal).aborted).toBe(true)
    page.get("disconnect").dispatch("click")
  })

  test("retains an unconfirmed message and retries its stable turn ID without inventing transcript entries or stop completion", async () => {
    const connection = stream()
    let postCount = 0
    const page = browser((path, init) => {
      if (path.endsWith("/stream")) return connection.response
      if (path.endsWith("/stop")) return new Response(null, { status: 204 })
      postCount++
      if (postCount === 1) return Promise.reject(new Error("Receipt lost"))
      const request = JSON.parse(String(init.body))
      return Response.json({ turnId: request.turnId, responseId: "answer", revision: 1 }, { status: 202 })
    })
    await page.connect(); connection.send(snapshot()); await tick()
    page.get("draft").value = "Run the French tests"; page.get("draft").dispatch("input")
    await page.get("composer").dispatch("submit"); await tick()
    expect(page.get("draft").value).toBe("Run the French tests")
    expect(page.words()).toEqual([])
    await page.get("composer").dispatch("submit"); await tick()
    const turns = page.calls.filter(({ path }) => path.endsWith("/turns")).map(({ init }) => JSON.parse(String(init.body)))
    expect(turns).toHaveLength(2)
    expect(turns[0].turnId).toBe(turns[1].turnId)
    expect(page.get("draft").value).toBe("")
    expect(page.words()).toEqual([])
    await page.get("stop").dispatch("click")
    expect(page.get("notice").textContent).toBe("Stop requested.")
    page.get("disconnect").dispatch("click")
  })

  test("rejected credentials require fresh entry and cannot fall through to a GET form containing the token", async () => {
    const page = browser(() => new Response(null, { status: 401 }))
    await page.connect()
    expect(page.get("auth").hidden).toBe(false)
    expect(page.get("notice").textContent).toContain("token rejected")
    expect(page.timers.size).toBe(0)
    expect(html).toContain('id="auth" class="auth" method="post"')
    expect(html).not.toContain('name="token"')
    expect(html).not.toContain("innerHTML")
  })

  test("a manual reconnect preserves an unconfirmed message ID until an authoritative snapshot reconciles it", async () => {
    const connections = [stream(), stream(), stream()]
    let streams = 0
    const page = browser((path) => {
      if (path.endsWith("/stream")) return connections[streams++]!.response
      return Promise.reject(new Error("Receipt lost"))
    })
    await page.connect(); connections[0]!.send(snapshot()); await tick()
    page.get("draft").value = "Tell French to continue"; await page.get("composer").dispatch("submit"); await tick()
    const first = JSON.parse(String(page.calls.find(({ path }) => path.endsWith("/turns"))!.init.body))
    connections[0]!.close(); await tick(); await page.runRetry()
    connections[1]!.close(); await tick()
    page.get("retry").dispatch("click"); await tick()
    connections[2]!.send(snapshot([{ type: "message", role: "user", turnId: first.turnId, text: first.text }])); await tick()
    expect(page.get("draft").value).toBe("")
    expect(page.calls.filter(({ path }) => path.endsWith("/turns"))).toHaveLength(1)
    page.get("disconnect").dispatch("click")
  })

  test("a failed response ends Working immediately and retains its failure after resynchronization", async () => {
    const page = browser()
    await page.connect(); const connection = page.streams[0]!
    connection.send(snapshot()); await tick()
    connection.send({ type: "response_started", turnId: "u", responseId: "failed" }); await tick()
    connection.send({ type: "error", responseId: "failed", message: "The provider is unavailable." }); await tick()
    const row = page.get("transcript").children[0]!
    expect(row.children[2]!.textContent).toBe("The provider is unavailable.")
    connection.send(snapshot([{ type: "message", role: "user", turnId: "u", text: "Read it" }, { type: "message", role: "assistant", turnId: "u", responseId: "failed", text: "" }], [{ turnId: "u", responseId: "failed", text: "", done: true, phase: "failed", error: "The provider is unavailable." }])); await tick()
    expect(page.get("transcript").children[1]!.children[2]!.textContent).toBe("The provider is unavailable.")
    page.get("disconnect").dispatch("click")
  })

  test("an old POST finishing after reconnect cannot unlock a newer message still awaiting its receipt", async () => {
    const connections = [stream(), stream()]
    const posts: Array<{ request: { turnId: string }; resolve: (response: Response) => void }> = []
    let connection = 0
    const page = browser((path, init) => {
      if (path.endsWith("/stream")) return connections[connection++]!.response
      return new Promise<Response>((resolve) => posts.push({ request: JSON.parse(String(init.body)), resolve }))
    })
    await page.connect(); connections[0]!.send(snapshot()); await tick()
    page.get("draft").value = "First message"; page.get("composer").dispatch("submit"); await tick()
    connections[0]!.close(); await tick(); await page.runRetry()
    connections[1]!.send(snapshot()); await tick()
    page.get("draft").value = "Second message"; page.get("composer").dispatch("submit"); await tick()
    posts[0]!.resolve(Response.json({ turnId: posts[0]!.request.turnId, responseId: "old", revision: 1 }, { status: 202 })); await tick()
    expect(page.get("draft").disabled).toBe(true)
    expect(page.get("draft").value).toBe("Second message")
    posts[1]!.resolve(Response.json({ turnId: posts[1]!.request.turnId, responseId: "new", revision: 2 }, { status: 202 })); await tick()
    expect(page.get("draft").disabled).toBe(false)
    expect(page.get("draft").value).toBe("")
    page.get("disconnect").dispatch("click")
  })
})
