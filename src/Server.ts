import { Data, Effect, Runtime, Schema } from "effect"
import { Agent, Payload } from "./Payload.ts"

export class ServeError extends Data.TaggedError("ServeError")<{ readonly cause: unknown }> {}

const Event = Schema.Struct({ agent: Agent, payload: Payload })
const decode = Schema.decodeUnknown(Event)

/** Accepts hook events on localhost only. */
export const serve = (port: number, handle: (agent: Agent, payload: Payload) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const runPromise = Runtime.runPromise(yield* Effect.runtime<never>())

    const receive = (request: Request) =>
      Effect.gen(function* () {
        const url = new URL(request.url)
        if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
        if (request.method !== "POST" || url.pathname !== "/events") return new Response(null, { status: 404 })

        const payload = yield* Effect.tryPromise(() => request.json())
        const event = yield* decode({ agent: url.searchParams.get("agent"), payload })
        yield* handle(event.agent, event.payload)
        return new Response(null, { status: 202 })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("Rejected event", error).pipe(Effect.as(new Response(null, { status: 400 }))),
        ),
      )

    yield* Effect.acquireRelease(
      Effect.try({
        try: () => Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => runPromise(receive(request)) }),
        catch: (cause) => new ServeError({ cause }),
      }),
      (server) => Effect.promise(() => server.stop(true)),
    )
    yield* Effect.logInfo(`Listening on http://127.0.0.1:${port}`)
  })
