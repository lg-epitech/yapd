import { Clock, Data, Effect, FiberSet, Option, Schema, type Scope, Stream } from "effect"
import type { Doing } from "./Audio.ts"
import type * as Icons from "./Icons.ts"
import { type Kind, kinds } from "./Journal.ts"
import * as Mutes from "./Mutes.ts"
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

/** How yapd talks of its own accord: as usual, or holding for later what doesn't need him. */
export const Mode = Schema.Literal("normal", "focus", "quiet")
export type Mode = typeof Mode.Type

/** The furthest off a mode can be set to end through the API: a day. */
const furthest = 24 * 60 * 60_000

/** What `/state` returns, documented in docs/api.md. */
export interface State {
  readonly on: boolean
  readonly activity: Doing
  /** How yapd talks of its own accord. */
  readonly mode?: Mode
  /** ISO 8601, when focus or quiet ends on its own, only while one is on. */
  readonly until?: string
  /** How many threads wait on him, on every machine yapd can see. */
  readonly waiting?: number
  /** How many updates and notices a catch-up would tell him of now, muted threads aside. */
  readonly unheard?: number
  readonly updates: ReadonlyArray<{
    readonly id: string
    readonly project: string
    readonly text: string
    /** ISO 8601, when the agent's turn ended. */
    readonly at: string
  }>
  /** The threads with the latest updates, newest first. */
  readonly recent?: ReadonlyArray<Recent>
  /** The card yapd is showing, or null. */
  readonly showing?: Showing | null
  /**
   * How many times yapd put a card up or took one down since it started, or
   * was asked to take one down: a card asked to go back up at it goes back
   * up only if nothing came since.
   */
  readonly revision?: number
}

/** A thread with a latest update, as `/state` lists it in `recent`. */
export interface Recent {
  /** What it's muted and heard again by. */
  readonly key: string
  readonly machine: string
  /** T3 Code's id for it, or null for a session yapd can't tie to a thread. */
  readonly thread: string | null
  readonly title: string
  readonly project?: {
    readonly name: string
    /** Only for a project T3 Code has. */
    readonly id?: string
    readonly icon?: Icons.Icon
  }
  /** What yapd said of its latest update, or would have. */
  readonly text: string
  /** ISO 8601, when the agent's turn ended. */
  readonly at: string
  readonly muted: boolean
  /** ISO 8601, when the mute ends on its own, if it does. */
  readonly until?: string
  /** Whether it waits on him. */
  readonly waiting: boolean
  /**
   * Whether it can be heard again from the menu: its latest update is still
   * one he heard, or it's a thread yapd can reach. Never a session's row he
   * didn't hear just now, nor an archived thread or one on a machine away.
   */
  readonly replayable: boolean
  /** How many of its updates and notices he hasn't heard, that a catch-up about it would tell him of, muted or not. */
  readonly unheard?: number
}

/** A card as `/state` points at it. */
export interface Showing {
  readonly id: string
  readonly kind: string
  readonly title: string
  /** ISO 8601, when it was put up. */
  readonly at: string
  /**
   * The revision it went up at, this time: put back up, it's up anew, at a
   * later one, so a request to take it down as it was up before, coming
   * late, leaves it up.
   */
  readonly revision: number
}

/** What `/cards/{id}` returns. */
export interface Card extends Omit<Showing, "revision"> {
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
    /** What it's muted by. */
    readonly key: string
    readonly muted: boolean
    readonly project: string
    readonly title: string
    readonly state: string
    /** ISO 8601, when it got to that state. */
    readonly since: string
    readonly pr?: PullRequest
  }>
}

/** A thread's latest pull request, as T3 Code knows it. */
export interface PullRequest {
  readonly number: number
  /** Only ever an https address from T3 Code. */
  readonly url?: string
  readonly state?: string
  readonly checks?: string
  readonly review?: string
  readonly mergeability?: string
}

/** What `/threads/{key}` returns of a thread, for a panel beside its row in `recent`. */
export interface Details {
  readonly key: string
  readonly machine: string
  /** T3 Code's id for it, or null for a session yapd can't tie to a thread. */
  readonly thread: string | null
  /** What it's doing, as `/threads` has it, only for a thread T3 Code has that yapd can see now. */
  readonly state?: string
  /** ISO 8601, when it got to that state. */
  readonly since?: string
  /** The branch it works on, when T3 Code knows it. */
  readonly branch?: string
  readonly pr?: PullRequest
  readonly muted: boolean
  /** ISO 8601, when the mute ends on its own, if it does. */
  readonly until?: string
  /** The latest of what was told of it and what was sent to it for him, from every session of it, newest first. */
  readonly updates: ReadonlyArray<Told>
}

/** An update or notice of a thread, or a message sent to it for him, as `/threads/{key}` lists it. */
export interface Told {
  readonly id: number
  /** ISO 8601. */
  readonly at: string
  readonly kind: "update" | "notice" | "sent"
  /** All of what yapd said of an update or notice, or kept, its "more" too. */
  readonly said?: string
  /** What he sent, all there is of a message sent. */
  readonly text?: string
  /** ISO 8601, when the user heard it through. */
  readonly heard?: string
  /** For an update yapd didn't read out, why, as `/journal` has it. */
  readonly unsaid?: Entry["unsaid"]
  /** Only for one he hasn't heard that a catch-up would tell him of, as `unheard` in `recent` counts it. */
  readonly unheard?: true
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
  /** For an update yapd didn't read out, why: kept quiet as he muted its thread, or held for focus, quiet, the digest, or as yapd was off. */
  readonly unsaid?: "muted" | "focus" | "quiet" | "progress" | "off"
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
  /** Changes how yapd talks, focus or quiet ending at `until` when given, or else when its default says. */
  readonly mode: (mode: Mode, until?: number) => Effect.Effect<void, unknown>
  readonly replay: (id: string) => Effect.Effect<"queued" | "off" | "unknown", unknown>
  /** Takes what the user typed as if they'd said it, and gives its id once it's worked out. None while yapd is off. */
  readonly utter: (text: string) => Effect.Effect<Option.Option<string>, unknown>
  /** One of the cards shown lately. */
  readonly card: (id: string) => Effect.Effect<Option.Option<Card>>
  /** Takes the card down, or `id` only while it's the one up, and, asked as it was `shown` at a revision, only while it's still up since then. */
  readonly hide: (id?: string, shown?: number) => Effect.Effect<void>
  /** Puts one of the cards shown lately back up, or, asked at a `revision`, only while what's up is still at it, and says whether it did, or why not. */
  readonly back: (id: string, revision?: number) => Effect.Effect<"back" | "changed" | "unknown">
  readonly threads: Effect.Effect<ReadonlyArray<Machine>>
  readonly journal: (page: Page) => Effect.Effect<ReadonlyArray<Entry>>
  /** Counts a UI that follows the state and shows cards as watching for as long as the scope lasts, so yapd knows what it shows is seen. */
  readonly watch: Effect.Effect<void, never, Scope.Scope>
  /** Mutes a thread by its key, until `until` when given: unknown when it's no thread yapd lists or has muted, invalid when it's no key at all. */
  readonly mute: (key: string, until?: number) => Effect.Effect<"muted" | "unknown" | "invalid">
  /** Unmutes a thread by its key, whether it was muted or not. */
  readonly unmute: (key: string) => Effect.Effect<void>
  /** Says a thread's latest update again, by its key: unreachable when it's a row that can't be heard again. */
  readonly replayThread: (key: string) => Effect.Effect<"queued" | "off" | "unknown" | "unreachable", unknown>
  /** What's known of a thread by its key, for a panel beside its row: none when it's no thread yapd knows. Only reads. */
  readonly details: (key: string) => Effect.Effect<Option.Option<Details>>
  /** A project's image, by its machine and id. */
  readonly icon: (machine: string, project: string) => Effect.Effect<Option.Option<Icons.Image>>
  /** Sets aside, unheard, all a catch-up would tell him now, as `unheard` counts it, without saying any of it, while yapd is off too: how many. */
  readonly clearCatchup: Effect.Effect<number>
}

const decodeChange = Schema.decodeUnknownOption(
  Schema.Struct({ on: Schema.optional(Schema.Boolean), mode: Schema.optional(Mode), until: Schema.optional(Schema.String) }),
)

/** What a `PUT /state` changes. */
export interface Change {
  readonly on?: boolean
  readonly mode?: Mode
  readonly until?: number
}

/**
 * What a `PUT /state` body asks to change, as of `now`, or why it can't be
 * done: it names `on`, `mode` or both, and `until` only with focus or quiet,
 * a time to come within a day.
 */
export const changing = (body: unknown, now: number): Change | string => {
  const asked = decodeChange(body)
  if (Option.isNone(asked)) return 'Send {"on": true or false}, {"mode": "normal", "focus" or "quiet"}, or both.'
  const { on, mode, until } = asked.value
  if (on === undefined && mode === undefined) return 'Send {"on": true or false}, {"mode": "normal", "focus" or "quiet"}, or both.'
  if (until === undefined) return { ...(on === undefined ? {} : { on }), ...(mode === undefined ? {} : { mode }) }
  if (mode !== "focus" && mode !== "quiet") return "until only goes with focus or quiet."
  const at = Date.parse(until)
  if (Number.isNaN(at)) return "until is a time, like 2026-10-02T15:00:00.000Z."
  if (at <= now) return "until has gone already."
  if (at - now > furthest) return "until is at most a day off."
  return { ...(on === undefined ? {} : { on }), mode, until: at }
}
const decodeUtterance = Schema.decodeUnknown(Schema.Struct({ text: Schema.String }))
const decodeCard = Schema.decodeUnknown(Schema.Struct({ id: Schema.String, revision: Schema.optional(Schema.NonNegativeInt) }))
const decodeMute = Schema.decodeUnknown(Schema.Struct({ until: Schema.optional(Schema.String) }))

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

/** The revision a query names as `name`, nothing when it names none, or NaN when it isn't a whole number. */
const revisionIn = (query: URLSearchParams, name: string) => {
  const given = query.get(name)
  if (given === null) return undefined
  return /^\d+$/.test(given) && Number.isSafeInteger(Number(given)) ? Number(given) : Number.NaN
}

/** A part of a path as it was meant, or nothing when it can't be decoded, which no card's or update's id is. */
const decoded = Option.liftThrowable(decodeURIComponent)

/** Names for this machine, so a web page can't reach the API through a DNS name of its own that points here. */
const local = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * Whether a web page sent it, which browsers always say, while yapd's hooks,
 * its app and scripts never do: a page could otherwise have yapd act on its
 * behalf, by posting what to do without ever reading the answer.
 */
const fromPage = (request: Request) => {
  const site = request.headers.get("sec-fetch-site")
  return request.headers.has("origin") || (site !== null && site !== "none")
}

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
        if (fromPage(request)) return new Response(null, { status: 403 })
        const route = `${request.method} ${url.pathname}`
        if (route === "GET /health") return new Response("ok")
        if (route === "POST /events") return yield* event(request, url, server)
        if (route === "GET /state") return Response.json(yield* current)
        if (route === "GET /state/stream") {
          // Open for as long as whoever watches wants it. Only one that shows cards, like the menu bar app, is counted as
          // watching until it goes: a status bar module, or a menu bar app from before cards, shows none of them.
          server.timeout(request, 0)
          const watching = url.searchParams.has("cards") ? Stream.unwrapScoped(Effect.as(api.watch, api.state)) : api.state
          const events = watching.pipe(
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
          const body = yield* Effect.tryPromise(() => request.json()).pipe(Effect.option)
          const change = Option.isNone(body) ? "Send the change as JSON." : changing(body.value, yield* Clock.currentTimeMillis)
          if (typeof change === "string") return new Response(change, { status: 400 })
          // Only what it names, on or off first.
          const { on, mode, until } = change
          return yield* (on === undefined ? Effect.void : api.turn(on)).pipe(
            Effect.zipRight(mode === undefined ? Effect.void : api.mode(mode, until)),
            Effect.zipRight(current),
            Effect.map((state) => Response.json(state)),
            Effect.catchAll(failed("change yapd's state")),
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
        if (route === "DELETE /cards/current") {
          // Only the card it names, when it names one, so a request that comes late, like the app's for a card it put away, never takes down one put up since,
          // and only as it was shown at the revision it names, when it names one, so nor does it take down the same card put back up since.
          const id = url.searchParams.get("id")
          const shown = revisionIn(url.searchParams, "shown")
          if (Number.isNaN(shown)) return new Response("shown is the revision in showing, a whole number.", { status: 400 })
          return yield* Effect.as(api.hide(id ?? undefined, shown), new Response(null, { status: 204 }))
        }
        if (route === "PUT /cards/current") {
          const body = yield* Effect.tryPromise(() => request.json()).pipe(Effect.flatMap(decodeCard), Effect.option)
          if (Option.isNone(body)) return new Response('Send {"id": "the card\'s id", "revision": the state\'s revision}, or the id alone.', { status: 400 })
          // At the revision it names, when it names one, so a request that comes late, like the app's for a card it showed again, never undoes a card put up or taken down since.
          const back = yield* api.back(body.value.id, body.value.revision)
          return back === "back"
            ? new Response(null, { status: 204 })
            : back === "changed"
              ? new Response("A card was put up or taken down since.", { status: 409 })
              : new Response("No such card.", { status: 404 })
        }
        const card = request.method === "GET" ? /^\/cards\/([^/]+)$/.exec(url.pathname) : null
        if (card !== null) {
          const found = yield* Option.match(decoded(card[1]!), { onNone: () => Effect.succeed(Option.none<Card>()), onSome: api.card })
          return Option.match(found, {
            onNone: () => new Response("No such card.", { status: 404 }),
            onSome: (card) => Response.json(card),
          })
        }
        // Only marks what a catch-up would tell as heard, so it's done while yapd is off too.
        if (route === "POST /catchup/clear") return Response.json({ cleared: yield* api.clearCatchup })
        if (route === "GET /threads") return Response.json(yield* api.threads)
        if (route === "GET /journal") {
          const asked = paging(url.searchParams)
          if (typeof asked === "string") return new Response(asked, { status: 400 })
          return Response.json(yield* api.journal(asked))
        }
        const replay = request.method === "POST" ? /^\/updates\/([^/]+)\/replay$/.exec(url.pathname) : null
        if (replay !== null) {
          const id = decoded(replay[1]!)
          if (Option.isNone(id)) return new Response("No such update.", { status: 404 })
          // Rendering waits its turn, and for the voice to load.
          server.timeout(request, 0)
          return yield* api.replay(id.value).pipe(
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
        // What a panel beside a row shows of its thread, only ever read.
        const details = request.method === "GET" ? /^\/threads\/([^/]+)$/.exec(url.pathname) : null
        if (details !== null) {
          const key = decoded(details[1]!)
          if (Option.isNone(key) || Option.isNone(Mutes.parse(key.value))) return new Response("That's no thread's key.", { status: 400 })
          return Option.match(yield* api.details(key.value), {
            onNone: () => new Response("No such thread.", { status: 404 }),
            onSome: (details) => Response.json(details),
          })
        }
        const thread = /^\/threads\/([^/]+)\/(mute|replay)$/.exec(url.pathname)
        if (thread !== null) {
          const key = decoded(thread[1]!)
          const route = `${request.method} ${thread[2]}`
          if (route === "PUT mute") {
            if (Option.isNone(key)) return new Response("That's no thread's key.", { status: 400 })
            // A body is optional, and says when the mute ends.
            const text = yield* Effect.tryPromise(() => request.text()).pipe(Effect.option)
            if (Option.isNone(text)) return new Response('Send {"until": "an ISO 8601 time"}, or nothing.', { status: 400 })
            const body =
              text.value.trim() === ""
                ? Option.some<{ readonly until?: string }>({})
                : yield* Effect.try(() => JSON.parse(text.value) as unknown).pipe(Effect.flatMap(decodeMute), Effect.option)
            if (Option.isNone(body)) return new Response('Send {"until": "an ISO 8601 time"}, or nothing.', { status: 400 })
            const until = body.value.until === undefined ? undefined : Date.parse(body.value.until)
            if (until !== undefined && (Number.isNaN(until) || until <= Date.now())) return new Response("until is a time to come, in ISO 8601.", { status: 400 })
            const muted = yield* api.mute(key.value, until)
            return muted === "muted"
              ? new Response(null, { status: 204 })
              : muted === "invalid"
                ? new Response("That's no thread's key.", { status: 400 })
                : new Response("No such thread.", { status: 404 })
          }
          if (route === "DELETE mute") {
            // A key yapd never makes, as one taken apart and put back wrong, was never muted: saying it's no longer muted would hide that.
            if (Option.isNone(key) || Option.isNone(Mutes.parse(key.value))) return new Response("That's no thread's key.", { status: 400 })
            return yield* Effect.as(api.unmute(key.value), new Response(null, { status: 204 }))
          }
          if (route === "POST replay") {
            if (Option.isNone(key)) return new Response("No such thread.", { status: 404 })
            // Rendering waits its turn, and for the voice to load.
            server.timeout(request, 0)
            return yield* api.replayThread(key.value).pipe(
              Effect.map((result) =>
                result === "queued"
                  ? new Response(null, { status: 202 })
                  : result === "off"
                    ? new Response("yapd is off.", { status: 409 })
                    : result === "unreachable"
                      ? new Response("yapd can't reach it from here, so it can't be heard again.", { status: 409 })
                      : new Response("Nothing to say of it.", { status: 404 }),
              ),
              Effect.catchAll(failed("say a thread's update again")),
            )
          }
        }
        const icon = request.method === "GET" ? /^\/projects\/([^/]+)\/([^/]+)\/icon$/.exec(url.pathname) : null
        if (icon !== null) {
          const [machine, project] = [decoded(icon[1]!), decoded(icon[2]!)]
          const image = Option.isNone(machine) || Option.isNone(project) ? Option.none<Icons.Image>() : yield* api.icon(machine.value, project.value)
          if (Option.isNone(image)) return new Response("No such icon.", { status: 404 })
          const etag = `"${image.value.revision}"`
          // Only what the image is, never anything a browser would run, whatever's in it. Asked again each time, as its address never changes
          // when the image does: the ETag spares sending it again.
          const headers = {
            etag,
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'",
          }
          if ((request.headers.get("if-none-match") ?? "").split(",").some((tag) => tag.trim() === etag)) return new Response(null, { status: 304, headers })
          return new Response(image.value.bytes, { headers: { ...headers, "content-type": image.value.type } })
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
