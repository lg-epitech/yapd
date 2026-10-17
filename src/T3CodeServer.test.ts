import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Fiber, Option, Redacted, Schema, TestClock, TestContext } from "effect"
import * as Server from "./T3CodeServer.ts"

const api = Server.api({ origin: "http://t3.invalid" }, Redacted.make("test-token"))

describe("T3CodeServer HTTP", () => {
  test("gives up after five seconds even where nothing can cut it short, like a step once it's written, and aborts the request", async () => {
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
        // On its own, so a request that never ends can't hold up the test's own end.
        const pending = yield* Effect.forkDaemon(Effect.uninterruptible(api("/api/test", Schema.Unknown)))
        while (!reading) yield* Effect.promise(() => Bun.sleep(5))
        yield* TestClock.adjust("5 seconds")
        // A moment for it to end, rather than waiting on it for good.
        for (let tries = 0; tries < 100 && Option.isNone(yield* Fiber.poll(pending)); tries++) yield* Effect.promise(() => Bun.sleep(5))
        expect(Option.isSome(yield* Fiber.poll(pending))).toBe(true)
        expect(yield* Effect.flip(Fiber.join(pending))).toMatchObject({ _tag: "Trouble", reason: "T3 Code isn't answering." })
        expect(signal?.aborted).toBe(true)
      }).pipe(Effect.provide(TestContext.TestContext)))
    } finally {
      fetch.mockRestore()
    }
  })

  test("keeps malformed bodies in the typed error channel", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("not JSON"))
    try {
      const malformed = await Effect.runPromise(Effect.flip(api("/api/test", Schema.Unknown)))
      expect(malformed).toMatchObject({ _tag: "Trouble", reason: "T3 Code answered in a way I don't understand." })
      expect(malformed.cause).toBeInstanceOf(SyntaxError)
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

  test("a file at a signed path is fetched without the token, never following a redirect, and nothing that went wrong keeps the path", async () => {
    const seen: Array<{ path: string; authorization: string | null }> = []
    const big = new Uint8Array(Server.largest + 1)
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        seen.push({ path: url.pathname, authorization: request.headers.get("authorization") })
        if (url.pathname.endsWith("/icon.svg")) return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
        if (url.pathname.endsWith("/away.png")) return Response.redirect("https://example.com/x.png", 302)
        if (url.pathname.endsWith("/big.png")) return new Response(big, { headers: { "content-type": "image/png" } })
        // Too large, with no length said up front.
        if (url.pathname.endsWith("/stream.png")) return new Response(new ReadableStream({ start: (controller) => { controller.enqueue(big); controller.close() } }), { headers: { "content-type": "image/png" } })
        return new Response("Not Found", { status: 404 })
      },
    })
    const asset = Server.asset({ origin: `http://127.0.0.1:${server.port}` })
    const secret = "/api/assets/eyJ2ZXJzaW9uIjoxfQ.c2lnbmF0dXJl"
    try {
      const icon = await Effect.runPromise(asset(`${secret}/icon.svg`))
      expect({ type: icon.type, text: new TextDecoder().decode(icon.bytes) }).toEqual({ type: "image/svg+xml", text: "<svg/>" })
      const failures = await Effect.runPromise(
        Effect.forEach(["away.png", "big.png", "stream.png", "gone.png"], (file) => Effect.flip(asset(`${secret}/${file}`))),
      )
      expect(failures.map(({ reason }) => reason)).toEqual([
        "T3 Code wouldn't send the file.",
        "T3 Code sent a file too large to be an icon.",
        "T3 Code sent a file too large to be an icon.",
        "T3 Code no longer has that file.",
      ])
      for (const failure of failures) expect(Bun.inspect(failure)).not.toContain("eyJ2ZXJzaW9uIjoxfQ")
      expect(seen.every(({ authorization }) => authorization === null)).toBe(true)
      // Nothing that isn't T3 Code's own path is ever asked for.
      expect((await Effect.runPromise(Effect.flip(asset("http://example.com/x.png")))).reason).toBe("T3 Code gave me a file I can't fetch.")
    } finally {
      await server.stop(true)
    }
  })
})
