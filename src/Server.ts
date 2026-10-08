import { Data, Effect, FiberSet, Option, Schema, type Scope, Stream } from "effect"
import type { Doing } from "./Audio.ts"
import { type Kind, kinds } from "./Journal.ts"
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
  /** The card yapd is showing, or null. */
  readonly showing?: Showing | null
}

/** A card as `/state` points at it. */
export interface Showing {
  readonly id: string
  readonly kind: string
  readonly title: string
  /** ISO 8601, when it was put up. */
  readonly at: string
}

/** What `/cards/{id}` returns. */
export interface Card extends Showing {
  readonly markdown: string
  /** Only ever an https address from T3 Code. */
  readonly url?: string
  /** What yapd said with it. */
  readonly caption?: string
}

/** A machine's threads, as `/threads` lists them. */
export interface Machine {
  readonly machine: string
  /** Why its threads can't be seen right now. */
  readonly reason?: string
  readonly threads: ReadonlyArray<{
    readonly id: string
    readonly project: string
    readonly title: string
    readonly state: string
    /** ISO 8601, when it got to that state. */
    readonly since: string
    readonly pr?: {
      readonly number: number
      readonly url: string
      readonly state?: string
      readonly checks?: string
      readonly review?: string
      readonly mergeability?: string
    }
  }>
}

/** A journal entry, as `/journal` returns it. */
export interface Entry {
  readonly id: number
  /** ISO 8601. */
  readonly at: string
  readonly kind: Kind
  readonly machine?: string
  readonly project?: string
  readonly thread?: string
  readonly said?: string
  readonly text?: string
  readonly utterance?: string
  /** ISO 8601, when the user heard it through. */
  readonly heard?: string
}

/** Which of the journal's entries `/journal` returns. */
export interface Page {
  readonly most: number
  readonly before?: number
  readonly kinds: ReadonlyArray<Kind>
}

/** What hooks and UIs can do. */
export interface Api {
  readonly handle: Handle
  /** The state, then each time it changes. */
  readonly state: Stream.Stream<State>
  readonly turn: (on: boolean) => Effect.Effect<void, unknown>
  readonly replay: (id: string) => Effect.Effect<"queued" | "off" | "unknown", unknown>
  /** Takes what the user typed as if they'd said it, and gives its id once it's worked out. None while yapd is off. */
  readonly utter: (text: string) => Effect.Effect<Option.Option<string>, unknown>
  /** One of the cards shown lately. */
  readonly card: (id: string) => Effect.Effect<Option.Option<Card>>
  /** Takes the card down. */
  readonly hide: Effect.Effect<void>
  /** Puts one of the cards shown lately back up, and says whether there was one. */
  readonly back: (id: string) => Effect.Effect<boolean>
  readonly threads: Effect.Effect<ReadonlyArray<Machine>>
  readonly journal: (page: Page) => Effect.Effect<ReadonlyArray<Entry>>
  /** Counts whoever follows the state as watching for as long as the scope lasts, so yapd knows what it shows is seen. */
  readonly watch: Effect.Effect<void, never, Scope.Scope>
}

const decodeTurn = Schema.decodeUnknown(Schema.Struct({ on: Schema.Boolean }))
const decodeUtterance = Schema.decodeUnknown(Schema.Struct({ text: Schema.String }))
const decodeCard = Schema.decodeUnknown(Schema.Struct({ id: Schema.String }))

/** How many journal entries a page has unless asked for fewer, and at most. */
const pages = { usual: 50, most: 200 }

/** The page of the journal a query asks for, or why it can't be read. */
export const paging = (query: URLSearchParams): Page | string => {
  const whole = (name: string) => {
    const given = query.get(name)
    if (given === null || given === "") return undefined
    return /^[1-9]\d*$/.test(given) && Number.isSafeInteger(Number(given)) ? Number(given) : Number.NaN
  }
  const before = whole("before")
  const limit = whole("limit")
  if (Number.isNaN(before)) return "before is the id of an entry."
  if (Number.isNaN(limit) || (limit !== undefined && limit > pages.most)) return `limit is a number from 1 to ${pages.most}.`
  const asked = (query.get("kind") ?? "").split(",").map((kind) => kind.trim()).filter((kind) => kind !== "")
  const unknown = asked.find((kind) => !(kinds as ReadonlyArray<string>).includes(kind))
  if (unknown !== undefined) return `There's no kind ${unknown}: it's one of ${kinds.join(", ")}.`
  return { most: limit ?? pages.usual, ...(before === undefined ? {} : { before }), kinds: asked as ReadonlyArray<Kind> }
}

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
          // Open for as long as whoever watches wants it, and counted as watching until they go.
          server.timeout(request, 0)
          const events = Stream.unwrapScoped(Effect.as(api.watch, api.state)).pipe(
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
        if (route === "POST /utterances") {
          // Worked out before it's answered, which can take the model a few seconds.
          server.timeout(request, 0)
          const body = yield* Effect.tryPromise(() => request.json()).pipe(
            Effect.flatMap(decodeUtterance),
            Effect.option,
            Effect.map(Option.filter(({ text }) => text.trim() !== "")),
          )
          if (Option.isNone(body)) return new Response('Send {"text": "what you would say"}.', { status: 400 })
          return yield* api.utter(body.value.text.trim()).pipe(
            Effect.map(
              Option.match({
                onNone: () => new Response("yapd is off.", { status: 409 }),
                onSome: (id) => Response.json({ id }, { status: 202 }),
              }),
            ),
            Effect.catchAll(failed("take what you typed")),
          )
        }
        if (route === "DELETE /cards/current") return yield* Effect.as(api.hide, new Response(null, { status: 204 }))
        if (route === "PUT /cards/current") {
          const body = yield* Effect.tryPromise(() => request.json()).pipe(Effect.flatMap(decodeCard), Effect.option)
          if (Option.isNone(body)) return new Response('Send {"id": "the card\'s id"}.', { status: 400 })
          return (yield* api.back(body.value.id)) ? new Response(null, { status: 204 }) : new Response("No such card.", { status: 404 })
        }
        const card = request.method === "GET" ? /^\/cards\/([^/]+)$/.exec(url.pathname) : null
        if (card !== null) {
          return Option.match(yield* api.card(decodeURIComponent(card[1]!)), {
            onNone: () => new Response("No such card.", { status: 404 }),
            onSome: (card) => Response.json(card),
          })
        }
        if (route === "GET /threads") return Response.json(yield* api.threads)
        if (route === "GET /journal") {
          const asked = paging(url.searchParams)
          if (typeof asked === "string") return new Response(asked, { status: 400 })
          return Response.json(yield* api.journal(asked))
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
