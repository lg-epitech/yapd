import { Data, Effect, FiberSet, Option, Schema } from "effect"
import { Origin } from "./Origin.ts"
import { Agent, Payload } from "./Payload.ts"

export class ServeError extends Data.TaggedError("ServeError")<{ readonly cause: unknown }> {}

const Event = Schema.Struct({ agent: Agent, payload: Payload })
const decode = Schema.decodeUnknown(Event)
// Only follow-ups need it, so an event without one, like from a hook older than origins, still counts.
const decodeOrigin = Schema.decodeUnknownOption(Schema.parseJson(Origin))

/** Takes an event and, when its hook waits, the reply to wake the session with. */
export type Handle = (
  agent: Agent,
  payload: Payload,
  origin: Origin,
  wait: boolean,
) => Effect.Effect<string | undefined>

/** Accepts hook events on localhost only. */
export const serve = (port: number, handle: Handle) =>
  Effect.gen(function* () {
    const requests = yield* FiberSet.make<Response>()
    const runPromise = yield* FiberSet.runtimePromise(requests)()
    let closing = false

    const receive = (request: Request, server: Bun.Server<undefined>) =>
      Effect.gen(function* () {
        const url = new URL(request.url)
        if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
        if (request.method !== "POST" || url.pathname !== "/events") return new Response(null, { status: 404 })

        const payload = yield* Effect.tryPromise(() => request.json())
        const event = yield* decode({ agent: url.searchParams.get("agent"), payload })
        const origin = Option.getOrElse(decodeOrigin(url.searchParams.get("origin")), () => ({}))
        const wait = url.searchParams.get("wait") === "1"
        if (!wait) {
          yield* handle(event.agent, event.payload, origin, false)
          return new Response(null, { status: 202 })
        }
        // The hook waits for as long as the update takes, and stops listening if it goes away.
        server.timeout(request, 0)
        const gone = Effect.async<undefined>((resume) => {
          const done = () => resume(Effect.succeed(undefined))
          if (request.signal.aborted) return done()
          request.signal.addEventListener("abort", done, { once: true })
          return Effect.sync(() => request.signal.removeEventListener("abort", done))
        })
        const reply = yield* Effect.raceFirst(handle(event.agent, event.payload, origin, true), gone)
        return Response.json(reply === undefined ? {} : { reply })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("Rejected event", error).pipe(Effect.as(new Response(null, { status: 400 }))),
        ),
      )

    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1", port,
            fetch: (request, server) => closing ? new Response(null, { status: 503 }) : runPromise(receive(request, server)),
          }),
        catch: (cause) => new ServeError({ cause }),
      }),
      (server) => Effect.sync(() => { closing = true }).pipe(
        Effect.zipRight(FiberSet.clear(requests)),
        Effect.zipRight(Effect.promise(() => server.stop(true))),
      ),
    )
    yield* Effect.logInfo(`Listening on http://127.0.0.1:${server.port}`)
    return server
  })
