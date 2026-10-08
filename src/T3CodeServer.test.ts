import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Fiber, Redacted, Schema, TestClock, TestContext } from "effect"
import * as Server from "./T3CodeServer.ts"

const api = Server.api({ origin: "http://t3.invalid" }, Redacted.make("test-token"))

describe("T3CodeServer HTTP", () => {
  test("times out and aborts a response that supplies headers but never finishes its body", async () => {
    let reading = false
    let signal: AbortSignal | undefined
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream({
        start: (controller) => signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true }),
        pull: () => { reading = true },
      }))
    }, { preconnect: globalThis.fetch.preconnect }))
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const pending = yield* Effect.fork(api("/api/test", Schema.Unknown))
        while (!reading) yield* Effect.promise(() => Bun.sleep(5))
        yield* TestClock.adjust("5 seconds")
        expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({ _tag: "Trouble", reason: "T3 Code isn't answering." })
        expect(signal?.aborted).toBe(true)
      }).pipe(Effect.provide(TestContext.TestContext)))
    } finally {
      fetch.mockRestore()
    }
  })

  test("aborts body consumption when its caller stops waiting", async () => {
    let reading = false
    let signal: AbortSignal | undefined
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream({
        start: (controller) => signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true }),
        pull: () => { reading = true },
      }))
    }, { preconnect: globalThis.fetch.preconnect }))
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const pending = yield* Effect.fork(api("/api/test", Schema.Unknown))
        while (!reading) yield* Effect.promise(() => Bun.sleep(5))
        yield* Fiber.interrupt(pending)
        expect(signal?.aborted).toBe(true)
      }))
    } finally {
      fetch.mockRestore()
    }
  })

  test("keeps malformed bodies and credential failures in the typed error channel", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("not JSON"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    try {
      const malformed = await Effect.runPromise(Effect.flip(api("/api/test", Schema.Unknown)))
      expect(malformed).toMatchObject({ _tag: "Trouble", reason: "T3 Code answered in a way I don't understand." })
      expect(malformed.cause).toBeInstanceOf(SyntaxError)
      expect(await Effect.runPromise(Effect.flip(api("/api/test", Schema.Unknown)))).toMatchObject({
        _tag: "Trouble", reason: "T3 Code turned down my token. It may have expired.",
      })
    } finally {
      fetch.mockRestore()
    }
  })
})

describe("T3CodeServer WebSocket", () => {
  test("a request that went out may have been done whatever went wrong after, and one that never went out wasn't", async () => {
    // Takes the request in and never answers, as T3 Code busy with it would.
    const server = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("no", { status: 400 })),
      websocket: { message: () => {} },
    })
    const call = Server.call({ origin: `http://127.0.0.1:${server.port}` }, Redacted.make("test-token"))
    try {
      const late = await Effect.runPromise(Effect.flip(call("orchestration.dispatchCommand", {}, Schema.Unknown, "200 millis")))
      expect(late).toMatchObject({ _tag: "Trouble", reason: "T3 Code is taking too long.", sent: true })
    } finally {
      await server.stop(true)
    }
    // Nothing listens there any more, so nothing went out.
    const unsent = await Effect.runPromise(Effect.flip(call("orchestration.dispatchCommand", {}, Schema.Unknown, "2 seconds")))
    expect(unsent).toMatchObject({ _tag: "Trouble", reason: "T3 Code isn't answering." })
    expect(unsent._tag === "Trouble" && unsent.sent === true).toBe(false)
  })
})
