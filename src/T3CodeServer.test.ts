import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Fiber, Option, Redacted, Schema, TestClock, TestContext } from "effect"
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

  test("is seen through where nothing can cut it short, like a step once it's written, when what waits on it is stopped", async () => {
    let release: (() => void) | undefined
    let signal: AbortSignal | undefined
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      signal = init?.signal ?? undefined
      await new Promise<void>((resolve) => { release = resolve })
      return new Response(JSON.stringify({ sequence: 7 }))
    }, { preconnect: globalThis.fetch.preconnect }))
    try {
      const aborted = await Effect.runPromise(Effect.gen(function* () {
        const pending = yield* Effect.fork(Effect.uninterruptible(api("/api/test", Schema.Unknown)))
        while (release === undefined) yield* Effect.promise(() => Bun.sleep(5))
        // Turned off meanwhile: whatever waits on it is stopped.
        const stopping = yield* Effect.fork(Fiber.interrupt(pending))
        yield* Effect.promise(() => Bun.sleep(20))
        const before = signal?.aborted
        release?.()
        yield* Fiber.join(stopping)
        return before
      }))
      expect(aborted).toBe(false)
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

  test("a request that went out keeps what went wrong with it as its cause", async () => {
    // Takes the request in, then breaks.
    const server = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("no", { status: 400 })),
      websocket: { message: (socket) => void socket.send(JSON.stringify({ _tag: "Defect", defect: "the orchestrator crashed" })) },
    })
    const call = Server.call({ origin: `http://127.0.0.1:${server.port}` }, Redacted.make("test-token"))
    try {
      const broke = await Effect.runPromise(Effect.flip(call("orchestration.dispatchCommand", {}, Schema.Unknown, "2 seconds")))
      expect(broke).toMatchObject({ _tag: "Trouble", reason: "T3 Code answered in a way I don't understand.", sent: true })
      expect(broke.cause).toBe(JSON.stringify({ _tag: "Defect", defect: "the orchestrator crashed" }))
    } finally {
      await server.stop(true)
    }
  })

  test("a request T3 Code took and never answered is given up on in its time even where nothing can cut it short, like a step once it's written", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("no", { status: 400 })),
      websocket: { message: () => {} },
    })
    const call = Server.call({ origin: `http://127.0.0.1:${server.port}` }, Redacted.make("test-token"))
    try {
      const late = Effect.runPromise(Effect.flip(Effect.uninterruptible(call("orchestration.dispatchCommand", {}, Schema.Unknown, "1 second"))))
      expect(await Promise.race([late, Bun.sleep(4000).then(() => "still waiting")])).toMatchObject({ _tag: "Trouble", reason: "T3 Code is taking too long.", sent: true })
    } finally {
      await server.stop(true)
    }
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

  test("a file T3 Code can't be reached for says so, without what the connection said, which names where it was going", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(() => Promise.reject(new TypeError("Unable to connect to http://127.0.0.1:1/api/assets/secret-path/icon.png")), { preconnect: globalThis.fetch.preconnect }),
    )
    try {
      const failed = await Effect.runPromise(Effect.flip(Server.asset({ origin: "http://127.0.0.1:1" })("/api/assets/secret-path/icon.png")))
      expect(failed.reason).toBe("T3 Code isn't answering.")
      expect(Bun.inspect(failed)).not.toContain("secret-path")
    } finally {
      fetch.mockRestore()
    }
  })
})
