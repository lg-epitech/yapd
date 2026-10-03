import { Data, Effect, FiberSet, Option, Schema, Stream } from "effect"
import type { Doing } from "./Audio.ts"
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

/** What `/state` returns, documented in docs/api.md. */
export interface State {
  readonly on: boolean
  readonly activity: Doing
  readonly updates: ReadonlyArray<{
    readonly id: string
    readonly project: string
    readonly text: string
    /** ISO 8601, when the agent's turn ended. */
    readonly at: string
  }>
}

/** What hooks and UIs can do. */
export interface Api {
  readonly handle: Handle
  /** The state, then each time it changes. */
  readonly state: Stream.Stream<State>
  readonly turn: (on: boolean) => Effect.Effect<void, unknown>
  readonly replay: (id: string) => Effect.Effect<"queued" | "off" | "unknown", unknown>
}

const decodeTurn = Schema.decodeUnknown(Schema.Struct({ on: Schema.Boolean }))

/** Names for this machine, so a web page can't reach the API through a DNS name of its own that points here. */
const local = new Set(["127.0.0.1", "localhost", "[::1]"])

const failed = (what: string) => (error: unknown) =>
  Effect.logWarning(`Could not ${what}`, error).pipe(Effect.as(new Response(null, { status: 500 })))

/** Takes hook events, and serves the API on localhost only. */
export const serve = (port: number, api: Api) =>
  Effect.gen(function* () {
    const requests = yield* FiberSet.make<Response>()
    const runPromise = yield* FiberSet.runtimePromise(requests)()
    let closing = false
    const current = Effect.map(Stream.runHead(api.state), Option.getOrThrow)

    const receive = (request: Request, server: Bun.Server<undefined>) =>
      Effect.gen(function* () {
        const url = new URL(request.url)
        if (!local.has(url.hostname)) return new Response(null, { status: 403 })
        const route = `${request.method} ${url.pathname}`
        if (route === "GET /health") return new Response("ok")
        if (route === "POST /events") return yield* event(request, url, server)
        if (route === "GET /state") return Response.json(yield* current)
        if (route === "GET /state/stream") {
          // Open for as long as whoever watches wants it.
          server.timeout(request, 0)
          const events = api.state.pipe(
            Stream.map((state) => `data: ${JSON.stringify(state)}\n\n`),
            Stream.encodeText,
          )
          return new Response(Stream.toReadableStream(events), {
            headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
          })
        }
        if (route === "PUT /state") {
          // Turning off can wait on what it stops.
          server.timeout(request, 0)
          const body = yield* Effect.tryPromise(() => request.json()).pipe(Effect.flatMap(decodeTurn), Effect.option)
          if (Option.isNone(body)) return new Response('Send {"on": true} or {"on": false}.', { status: 400 })
          return yield* api.turn(body.value.on).pipe(
            Effect.zipRight(current),
            Effect.map((state) => Response.json(state)),
            Effect.catchAll(failed("turn yapd on or off")),
          )
        }
        const replay = request.method === "POST" ? /^\/updates\/([^/]+)\/replay$/.exec(url.pathname) : null
        if (replay !== null) {
          // Rendering waits its turn, and for the voice to load.
          server.timeout(request, 0)
          return yield* api.replay(decodeURIComponent(replay[1]!)).pipe(
            Effect.map((result) =>
              result === "queued"
                ? new Response(null, { status: 202 })
                : result === "off"
                  ? new Response("yapd is off.", { status: 409 })
                  : new Response("No such update.", { status: 404 }),
            ),
            Effect.catchAll(failed("replay an update")),
          )
        }
        return new Response(null, { status: 404 })
      })

    const event = (request: Request, url: URL, server: Bun.Server<undefined>) =>
      Effect.gen(function* () {
        const payload = yield* Effect.tryPromise(() => request.json())
        const event = yield* decode({ agent: url.searchParams.get("agent"), payload })
        const origin = Option.getOrElse(decodeOrigin(url.searchParams.get("origin")), () => ({}))
        const wait = url.searchParams.get("wait") === "1"
        if (!wait) {
          yield* api.handle(event.agent, event.payload, origin, false)
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
        const reply = yield* Effect.raceFirst(api.handle(event.agent, event.payload, origin, true), gone)
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
