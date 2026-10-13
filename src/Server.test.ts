import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Option, Scope, Stream, SubscriptionRef } from "effect"
import * as Server from "./Server.ts"

const payload = { hook_event_name: "Stop", session_id: "test", cwd: "/tmp", last_assistant_message: "Done." }

const update = { id: "a1", project: "yapd", text: "yapd. The tests pass.", at: "2026-10-02T10:00:00.000Z" }

const card: Server.Card = {
  id: "c1",
  kind: "pr",
  title: "Migrate the Tezos integration",
  markdown: "**#412** in lg-epitech/integration, open",
  url: "https://github.com/lg-epitech/integration/pull/412",
  at: "2026-10-02T10:05:00.000Z",
}

const machines: ReadonlyArray<Server.Machine> = [
  {
    machine: "Rosie",
    threads: [
      { id: "850299f8", key: "t3:Rosie:850299f8", muted: false, subagents: false, project: "integration", title: "Migrate the Tezos integration", state: "running", since: "2026-10-02T09:40:00.000Z" },
    ],
  },
  { machine: "rig", reason: "I can't see rig's threads yet.", threads: [] },
]

/** What's known of the thread it lists, as a panel beside its row shows it. */
const detailed: Server.Details = {
  key: "t3:Rosie:850299f8",
  machine: "Rosie",
  thread: "850299f8",
  state: "running",
  since: "2026-10-02T09:40:00.000Z",
  branch: "t3/tezos",
  pr: { number: 412, url: "https://github.com/lg-epitech/integration/pull/412", state: "open", checks: "passing" },
  muted: false,
  updates: [
    { id: 9, at: "2026-10-02T10:00:00.000Z", kind: "update", said: "integration. The migration is done. Two fixtures needed new rounding.", unsaid: "off" },
    { id: 8, at: "2026-10-02T09:50:00.000Z", kind: "sent", text: "Use TzKT's rounding." },
  ],
}

/** An API that only handles hooks. */
const hooks = (handle: Server.Handle): Server.Api => ({
  handle,
  state: Stream.succeed<Server.State>({ on: true, activity: "idle", updates: [] }),
  turn: () => Effect.void,
  mode: () => Effect.void,
  replay: () => Effect.succeed("unknown"),
  utter: () => Effect.succeed(Option.none()),
  card: () => Effect.succeed(Option.none()),
  hide: () => Effect.void,
  back: () => Effect.succeed("unknown"),
  threads: Effect.succeed([]),
  journal: () => Effect.succeed([]),
  watch: Effect.void,
  mute: () => Effect.succeed("unknown"),
  unmute: () => Effect.void,
  replayThread: () => Effect.succeed("unknown"),
  subagents: () => Effect.succeed("unknown"),
  details: () => Effect.succeedNone,
  icon: () => Effect.succeedNone,
  clearCatchup: Effect.succeed(0),
})

/**
 * An API whose state is turned on and off for real, with one update to hear
 * again and one card up, at a revision that each card put up or taken down
 * moves on, and which counts who watches.
 */
const stateful = Effect.gen(function* () {
  const { id, kind, title, at } = card
  const ref = yield* SubscriptionRef.make<Server.State>({ on: true, activity: "idle", updates: [update], showing: { id, kind, title, at, revision: 0 }, revision: 0 })
  const pages: Array<Server.Page> = []
  let watching = 0
  /** The threads it lists, and which are muted, until when. */
  const known = new Set(["t3:Rosie:850299f8", "session:rig:claude:s-1"])
  const muted = new Map<string, number | undefined>()
  /** The threads whose subagents are read to him. */
  const reading = new Set<string>()
  return {
    ref,
    pages,
    muted,
    reading,
    watching: () => watching,
    api: {
      mute: (key, until) =>
        Effect.sync(() => {
          if (!/^(t3|session):/.test(key)) return "invalid" as const
          if (!known.has(key) && !muted.has(key)) return "unknown" as const
          muted.set(key, until)
          return "muted" as const
        }),
      unmute: (key) => Effect.sync(() => void muted.delete(key)),
      // A review T3 Code runs for the thread it lists is one of its subagents.
      subagents: (key, on) =>
        Effect.sync(() => {
          if (!key.startsWith("t3:")) return "invalid" as const
          if (key === "t3:Rosie:review") return "subagent" as const
          if (!known.has(key)) return "unknown" as const
          if (on) reading.add(key)
          else reading.delete(key)
          return "done" as const
        }),
      // A session's row it can't say again is turned away, as one yapd can't reach is.
      replayThread: (key) =>
        Effect.map(SubscriptionRef.get(ref), (state) => (!known.has(key) ? "unknown" : key.startsWith("session:") ? "unreachable" : state.on ? "queued" : "off")),
      details: (key) => Effect.sync(() => (key === detailed.key ? Option.some({ ...detailed, muted: muted.has(key) }) : Option.none())),
      icon: (machine, project) =>
        Effect.succeed(
          machine === "Rosie" && project === "p/1" ? Option.some({ bytes: new TextEncoder().encode("<svg/>"), type: "image/svg+xml", revision: "9f2c4e1a7b3d" }) : Option.none(),
        ),
      handle: () => Effect.succeed(undefined),
      state: ref.changes,
      turn: (on) => SubscriptionRef.update(ref, (state) => ({ ...state, on })),
      mode: (mode, until) =>
        SubscriptionRef.update(ref, ({ until: _, ...state }) => ({ ...state, mode, ...(until === undefined ? {} : { until: new Date(until).toISOString() }) })),
      replay: (id) =>
        Effect.map(SubscriptionRef.get(ref), (state) => (id !== update.id ? "unknown" : state.on ? "queued" : "off")),
      utter: (text) => Effect.map(SubscriptionRef.get(ref), (state) => (state.on ? Option.some(`u-${text.length}`) : Option.none())),
      card: (id) => Effect.succeed(id === card.id ? Option.some(card) : Option.none()),
      hide: (id, shown) =>
        SubscriptionRef.update(ref, (state) => ({
          ...state,
          showing: (id === undefined || state.showing?.id === id) && (shown === undefined || state.showing?.revision === shown) ? null : (state.showing ?? null),
          revision: (state.revision ?? 0) + 1,
        })),
      back: (id, revision) =>
        id !== card.id
          ? Effect.succeed("unknown" as const)
          : SubscriptionRef.modify(ref, (state): readonly ["back" | "changed", Server.State] =>
              revision === undefined || state.revision === revision
                ? ["back", { ...state, showing: { id, kind, title, at, revision: (state.revision ?? 0) + 1 }, revision: (state.revision ?? 0) + 1 }]
                : ["changed", state],
            ),
      threads: Effect.succeed(machines),
      journal: (page) =>
        Effect.sync(() => {
          pages.push(page)
          return [{ id: 7, at: "2026-10-02T10:00:00.000Z", kind: "update" as const, project: "yapd", said: "yapd. The tests pass." }]
        }),
      watch: Effect.acquireRelease(
        Effect.sync(() => void watching++),
        () => Effect.sync(() => void watching--),
      ),
      clearCatchup: Effect.succeed(0),
    } satisfies Server.Api,
  }
})

describe("Server", () => {
  test("the state says how much a catch-up would tell of now, and the journal why an update wasn't read out", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const server = yield* Server.serve(0, {
        ...hooks(() => Effect.succeed(undefined)),
        state: Stream.succeed<Server.State>({ on: false, activity: "idle", updates: [], unheard: 6, recent: [] }),
        journal: () =>
          Effect.succeed([
            { id: 9, at: "2026-10-02T10:00:00.000Z", kind: "update" as const, said: "yapd. Distribox migrated.", unsaid: "off" as const },
            { id: 8, at: "2026-10-02T09:00:00.000Z", kind: "update" as const, said: "yapd. The tests pass.", heard: "2026-10-02T09:00:09.000Z" },
          ]),
      })
      const json = (path: string) => Effect.promise(() => fetch(`http://127.0.0.1:${server.port}${path}`).then((response) => response.json()))
      expect(yield* json("/state")).toMatchObject({ on: false, unheard: 6 })
      expect(yield* json("/journal")).toEqual([
        { id: 9, at: "2026-10-02T10:00:00.000Z", kind: "update", said: "yapd. Distribox migrated.", unsaid: "off" },
        { id: 8, at: "2026-10-02T09:00:00.000Z", kind: "update", said: "yapd. The tests pass.", heard: "2026-10-02T09:00:09.000Z" },
      ])
    })))
  })

  test("accepts valid events and rejects invalid payloads", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const server = yield* Server.serve(0, hooks(() => Effect.succeed("Follow up.")))
      const url = `http://127.0.0.1:${server.port}`
      expect((yield* Effect.promise(() => fetch(`${url}/health`))).status).toBe(200)
      const reply = yield* Effect.promise(() => fetch(`${url}/events?agent=claude&wait=1`, {
        method: "POST", body: JSON.stringify(payload),
      }).then((response) => response.json()))
      expect(reply).toEqual({ reply: "Follow up." })
      expect((yield* Effect.promise(() => fetch(`${url}/events?agent=claude`, { method: "POST", body: "{}" }))).status).toBe(400)
    })))
  })

  for (const wait of [false, true]) {
    test(`interrupts outstanding ${wait ? "waiting" : "non-waiting"} handlers before stopping the server`, async () => {
      const scope = await Effect.runPromise(Scope.make())
      const started = await Effect.runPromise(Deferred.make<void>())
      const finish = await Effect.runPromise(Deferred.make<void>())
      let interrupted = false
      const server = await Effect.runPromise(Server.serve(0, hooks(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Deferred.await(finish)),
          Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })),
          Effect.as(undefined),
        ),
      )).pipe(Scope.extend(scope)))
      const request = fetch(`http://127.0.0.1:${server.port}/events?agent=claude${wait ? "&wait=1" : ""}`, {
        method: "POST", body: JSON.stringify(payload),
      }).catch(() => undefined)
      await Effect.runPromise(Deferred.await(started))
      const closed = Effect.runPromise(Scope.close(scope, Exit.void))
      try {
        expect(await Promise.race([closed.then(() => true), Bun.sleep(1000).then(() => false)])).toBe(true)
        expect(interrupted).toBe(true)
      } finally {
        await Effect.runPromise(Deferred.succeed(finish, undefined))
        await closed
        await request
      }
    })
  }

  test("serves the state, turns yapd off and on, and replays an update or takes typed words only while it's on", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api } = yield* stateful
      const server = yield* Server.serve(0, api)
      const url = `http://127.0.0.1:${server.port}`
      const call = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init))
      const turn = (body: string) => call("/state", { method: "PUT", headers: { "content-type": "application/json" }, body })
      const utter = (body: string) => call("/utterances", { method: "POST", headers: { "content-type": "application/json" }, body })

      expect(yield* Effect.promise(() => fetch(`${url}/state`).then((response) => response.json()))).toEqual({
        on: true, activity: "idle", updates: [update], showing: { id: "c1", kind: "pr", title: card.title, at: card.at, revision: 0 }, revision: 0,
      })
      expect((yield* call("/updates/a1/replay", { method: "POST" })).status).toBe(202)
      expect((yield* call("/updates/zz/replay", { method: "POST" })).status).toBe(404)
      const typed = yield* utter('{"text": "who needs me?"}')
      expect(typed.status).toBe(202)
      expect(yield* Effect.promise(() => typed.json())).toEqual({ id: "u-13" })
      expect((yield* utter('{"text": "  "}')).status).toBe(400)

      const off = yield* turn('{"on": false}')
      expect(off.status).toBe(200)
      expect(yield* Effect.promise(() => off.json())).toMatchObject({ on: false })
      expect((yield* call("/updates/a1/replay", { method: "POST" })).status).toBe(409)
      expect((yield* utter('{"text": "who needs me?"}')).status).toBe(409)
      expect((yield* turn('{"on": "no"}')).status).toBe(400)
      expect((yield* turn("{")).status).toBe(400)
      expect((yield* call("/nothing")).status).toBe(404)
    })))
  })

  test("a partial state change changes only what it names, on first, and turns away an empty body, an unknown mode or a time that's gone", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api } = yield* stateful
      const asked: Array<string> = []
      const server = yield* Server.serve(0, {
        ...api,
        turn: (on) => Effect.zipRight(Effect.sync(() => void asked.push(`on ${on}`)), api.turn(on)),
        mode: (mode, until) => Effect.zipRight(Effect.sync(() => void asked.push(`${mode}${until === undefined ? "" : " until"}`)), api.mode(mode, until)),
      })
      const put = (body: string) =>
        Effect.promise(() => fetch(`http://127.0.0.1:${server.port}/state`, { method: "PUT", headers: { "content-type": "application/json" }, body }))
      const state = (response: Response) => Effect.promise(() => response.json() as Promise<Server.State>)
      const soon = new Date(Date.now() + 60 * 60_000).toISOString()

      const focus = yield* put('{"mode": "focus"}')
      expect(focus.status).toBe(200)
      expect(yield* state(focus)).toMatchObject({ on: true, mode: "focus" })
      const until = yield* state(yield* put(JSON.stringify({ mode: "quiet", until: soon })))
      expect(until).toMatchObject({ on: true, mode: "quiet", until: soon })
      const off = yield* state(yield* put('{"on": false}'))
      // Turning off leaves the mode as it was.
      expect(off).toMatchObject({ on: false, mode: "quiet" })
      expect(yield* state(yield* put('{"on": true, "mode": "normal"}'))).toMatchObject({ on: true, mode: "normal" })
      expect(asked).toEqual(["focus", "quiet until", "on false", "on true", "normal"])

      for (const body of [
        "{}",
        "",
        '{"mode": "loud"}',
        '{"on": "yes"}',
        JSON.stringify({ mode: "normal", until: soon }),
        JSON.stringify({ until: soon }),
        JSON.stringify({ mode: "focus", until: "at three" }),
        JSON.stringify({ mode: "focus", until: new Date(Date.now() - 60_000).toISOString() }),
        JSON.stringify({ mode: "focus", until: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString() }),
      ]) {
        expect([body, (yield* put(body)).status]).toEqual([body, 400])
      }
      // Nothing it turned away was done.
      expect(asked).toHaveLength(5)
    })))
  })

  test("streams the state as it is, then each change, counting whoever follows it to show cards as watching until they go", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { ref, api, watching } = yield* stateful
      const server = yield* Server.serve(0, api)
      // A status bar module, or a menu bar app from before cards, which shows none of them.
      const plain = new AbortController()
      const following = yield* Effect.promise(() => fetch(`http://127.0.0.1:${server.port}/state/stream`, { signal: plain.signal }))
      expect(yield* Effect.promise(() => following.body!.pipeThrough(new TextDecoderStream()).getReader().read())).toMatchObject({ done: false })
      expect(watching()).toBe(0)
      const gone = new AbortController()
      const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${server.port}/state/stream?cards`, { signal: gone.signal }))
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      const next = Effect.promise(() => reader.read()).pipe(Effect.map(({ value }) => JSON.parse(value!.replace(/^data: /, ""))))
      expect(yield* next).toMatchObject({ on: true })
      expect(watching()).toBe(1)
      plain.abort()
      yield* SubscriptionRef.update(ref, (state) => ({ ...state, activity: "speaking" as const }))
      expect(yield* next).toMatchObject({ on: true, activity: "speaking" })
      // Like the menu bar app quitting.
      gone.abort()
      for (let tries = 0; tries < 100 && watching() > 0; tries++) yield* Effect.promise(() => Bun.sleep(10))
      expect(watching()).toBe(0)
    })))
  })

  test("serves cards, takes the one up down, lists threads and pages through the journal, with the documented codes", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api, pages } = yield* stateful
      const server = yield* Server.serve(0, api)
      const url = `http://127.0.0.1:${server.port}`
      const call = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init))
      const json = (path: string) => Effect.promise(() => fetch(`${url}${path}`).then((response) => response.json()))

      const shown = yield* call("/cards/c1")
      expect(shown.status).toBe(200)
      expect(yield* Effect.promise(() => shown.json())).toEqual(card)
      expect((yield* call("/cards/c2")).status).toBe(404)
      // An id that can't be decoded is no card's either.
      expect((yield* call("/cards/%E0%A4%A")).status).toBe(404)
      expect((yield* call("/updates/%E0%A4%A/replay", { method: "POST" })).status).toBe(404)
      expect((yield* call("/cards/c1", { method: "DELETE" })).status).toBe(404)
      const hidden = yield* call("/cards/current", { method: "DELETE" })
      expect(hidden.status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: null })
      expect((yield* call("/cards/current", { method: "DELETE" })).status).toBe(204)
      // Put back up, like Show Last Card does, so "hide that" can take it down.
      const back = (body: string) => call("/cards/current", { method: "PUT", headers: { "content-type": "application/json" }, body })
      expect((yield* back('{"id": "c1"}')).status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: { id: "c1" } })
      expect((yield* back('{"id": "c2"}')).status).toBe(404)
      expect((yield* back("{}")).status).toBe(400)
      // At the revision the state gave, only while it's still at it, so a request that comes late never undoes a card taken down since.
      const revision = Effect.map(json("/state"), (state) => (state as Server.State).revision)
      const asked = yield* revision
      yield* call("/cards/current", { method: "DELETE" })
      const late = yield* back(`{"id": "c1", "revision": ${asked}}`)
      expect(late.status).toBe(409)
      expect(yield* json("/state")).toMatchObject({ showing: null })
      expect((yield* back(`{"id": "c1", "revision": ${yield* revision}}`)).status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: { id: "c1" } })
      for (const revision of ['"3"', "-1", "1.5", "null"]) expect((yield* back(`{"id": "c1", "revision": ${revision}}`)).status).toBe(400)
      // Named, only that card goes, and only while it's the one up: a request for one taken down since leaves the one up since.
      const named = (id: string) => call(`/cards/current?id=${id}`, { method: "DELETE" })
      expect((yield* named("c2")).status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: { id: "c1" } })
      expect((yield* named("")).status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: { id: "c1" } })
      expect((yield* named("c1")).status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: null })
      // Named as it was shown, only while it's still up as it went up then: put back up since, it's up anew, and stays.
      const asShown = (query: string) => call(`/cards/current?id=c1&${query}`, { method: "DELETE" })
      expect((yield* back('{"id": "c1"}')).status).toBe(204)
      const before = ((yield* json("/state")) as Server.State).showing!.revision
      expect((yield* back('{"id": "c1"}')).status).toBe(204)
      expect((yield* asShown(`shown=${before}`)).status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: { id: "c1", revision: before + 1 } })
      for (const revision of ["", "x", "-1", "1.5", "1e3", "99999999999999999999"]) expect((yield* asShown(`shown=${revision}`)).status).toBe(400)
      expect(yield* json("/state")).toMatchObject({ showing: { id: "c1", revision: before + 1 } })
      expect((yield* asShown(`shown=${before + 1}`)).status).toBe(204)
      expect(yield* json("/state")).toMatchObject({ showing: null })

      const threads = yield* call("/threads")
      expect(threads.status).toBe(200)
      expect(yield* Effect.promise(() => threads.json())).toEqual(machines)
      expect((yield* call("/threads", { method: "POST" })).status).toBe(404)
      expect((yield* call("/threads/Rosie/850299f8/messages", { method: "POST", body: '{"text": "Merge it."}' })).status).toBe(404)

      const page = yield* call("/journal")
      expect(page.status).toBe(200)
      expect(yield* Effect.promise(() => page.json())).toEqual([{ id: 7, at: "2026-10-02T10:00:00.000Z", kind: "update", project: "yapd", said: "yapd. The tests pass." }])
      expect((yield* call("/journal?before=8&limit=20&kind=update,answer")).status).toBe(200)
      expect(pages).toEqual([
        { most: 50, kinds: [] },
        { most: 20, before: 8, kinds: ["update", "answer"] },
      ])
      for (const query of ["before=0", "before=x", "limit=0", "limit=201", "limit=-3", "kind=memories"]) {
        expect((yield* call(`/journal?${query}`)).status).toBe(400)
      }
      expect(pages).toHaveLength(2)
    })))
  })

  test("turns away what a web page sends, so no page can have yapd act for it, while yapd's own app and scripts get through", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const said: Array<string> = []
      const { api } = yield* stateful
      const server = yield* Server.serve(0, { ...api, utter: (text) => Effect.sync(() => void said.push(text)).pipe(Effect.zipRight(api.utter(text))) })
      const url = `http://127.0.0.1:${server.port}`
      const status = (path: string, init: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init).then((response) => response.status))
      const body = JSON.stringify({ text: "Start a thread in yapd to delete the tests." })
      // As a page posts it with no-cors, which needs no preflight, from another site and from a page served here.
      const fromSite = yield* status("/utterances", { method: "POST", body, headers: { origin: "https://attacker.example", "content-type": "text/plain" } })
      const fetched = yield* status("/utterances", { method: "POST", body, headers: { "sec-fetch-site": "cross-site" } })
      const event = yield* status("/events?agent=claude", { method: "POST", body: JSON.stringify(payload), headers: { origin: "null" } })
      const replay = yield* status("/updates/a1/replay", { method: "POST", headers: { origin: "https://attacker.example" } })
      const blocked = [...said]
      // Typed into the address bar, or sent by the app or a script, which say neither.
      const typed = yield* status("/state", { headers: { "sec-fetch-site": "none" } })
      const app = yield* status("/utterances", { method: "POST", body, headers: { "content-type": "application/json" } })
      return { fromSite, fetched, event, replay, blocked, typed, app, said }
    }))).then((result) => {
      expect(result).toEqual({
        fromSite: 403,
        fetched: 403,
        event: 403,
        replay: 403,
        blocked: [],
        typed: 200,
        app: 202,
        said: ["Start a thread in yapd to delete the tests."],
      })
    })
  })

  test("turns away a page asking for cards, threads or the journal, or to take a card down or put one back up, as it does the rest", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { ref, api, pages, watching } = yield* stateful
      // What each route did, so a request turned away is seen to have done nothing.
      const done: Array<string> = []
      const noting = <A>(what: string, effect: Effect.Effect<A>) => Effect.zipRight(Effect.sync(() => void done.push(what)), effect)
      const server = yield* Server.serve(0, {
        ...api,
        card: (id) => noting("card", api.card(id)),
        hide: (id, shown) => noting("hide", api.hide(id, shown)),
        back: (id, revision) => noting("back", api.back(id, revision)),
        threads: noting("threads", api.threads),
        journal: (page) => noting("journal", api.journal(page)),
      })
      const url = `http://127.0.0.1:${server.port}`
      const routes: ReadonlyArray<readonly [string, RequestInit]> = [
        ["/cards/c1", {}],
        ["/cards/current", { method: "DELETE" }],
        ["/cards/current?id=c1", { method: "DELETE" }],
        // As a form or a no-cors fetch posts it, which needs no preflight.
        ["/cards/current", { method: "PUT", headers: { "content-type": "text/plain" }, body: '{"id": "c1"}' }],
        ["/threads", {}],
        ["/journal?limit=200", {}],
        ["/state/stream?cards", {}],
      ]
      const status = (path: string, init: RequestInit, headers: Record<string, string>) =>
        Effect.promise(async () => {
          // A stream let through would stay open, so it's only read as far as its status.
          const gone = new AbortController()
          const response = await fetch(`${url}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), ...headers }, signal: gone.signal })
          gone.abort()
          return response.status
        })
      // How a browser marks a page's request: from another site, from a page served on this machine, or from a page on yapd's own address.
      const marks = [{ origin: "https://attacker.example" }, { origin: "http://localhost:5173" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "cross-site" }]
      const fromPages = yield* Effect.forEach(marks, (headers) => Effect.forEach(routes, ([path, init]) => status(path, init, headers)))
      const turnedAway = { done: [...done], pages: [...pages], watching: watching(), showing: (yield* SubscriptionRef.get(ref)).showing?.id }
      // The menu bar app and scripts say neither, and get through.
      const app = yield* Effect.forEach(routes.slice(0, -1), ([path, init]) => status(path, init, {}))
      return { fromPages, turnedAway, app, done }
    }))).then((result) => {
      expect(result).toEqual({
        fromPages: Array.from({ length: 4 }, () => [403, 403, 403, 403, 403, 403, 403]),
        turnedAway: { done: [], pages: [], watching: 0, showing: "c1" },
        app: [200, 204, 204, 204, 200, 200],
        done: ["card", "hide", "hide", "back", "threads", "journal"],
      })
    })
  })

  test("turns away requests addressed to another host, like a web page's DNS name pointing here", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api } = yield* stateful
      const server = yield* Server.serve(0, api)
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${server.port}/state`, { headers: { host: `attacker.example:${server.port}` } }),
      )
      expect(response.status).toBe(403)
    })))
  })

  test("turns away what any web page sends, as a browser does without asking first, and takes the rest", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api, watching } = yield* stateful
      const typed: Array<string> = []
      const server = yield* Server.serve(0, { ...api, utter: (text) => Effect.zipRight(Effect.sync(() => typed.push(text)), api.utter(text)) })
      const url = `http://127.0.0.1:${server.port}`
      // What `fetch(url, {method: "POST", mode: "no-cors", body})` sends from a page: a simple request, so nothing asks yapd first.
      const utter = (headers: Record<string, string>) =>
        Effect.promise(() => fetch(`${url}/utterances`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", ...headers }, body: '{"text": "Open that PR."}' }))
      // A page on this machine too, like a dev server's, which runs whatever it loaded.
      for (const origin of ["https://evil.example", "null", "http://127.0.0.1.evil.example:4747", "http://localhost:5173"]) {
        expect((yield* utter({ origin })).status).toBe(403)
      }
      expect((yield* utter({ "sec-fetch-site": "cross-site" })).status).toBe(403)
      // Like an image or a frame that follows the state for as long as the page is open, which would pass for an app showing cards.
      const followed = yield* Effect.promise(() => fetch(`${url}/state/stream?cards`, { headers: { "sec-fetch-site": "cross-site" } }))
      expect(followed.status).toBe(403)
      expect(watching()).toBe(0)
      expect(typed).toEqual([])
      // The hooks, curl and the menu bar app say nowhere.
      expect((yield* utter({})).status).toBe(202)
      expect(typed).toEqual(["Open that PR."])
    })))
  })

  test("mutes and unmutes a thread by its key, with or without when it ends, and turns away what isn't a thread or a time to come", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api, muted } = yield* stateful
      const server = yield* Server.serve(0, api)
      const url = `http://127.0.0.1:${server.port}`
      const call = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init).then((response) => response.status))
      const key = encodeURIComponent("t3:Rosie:850299f8")
      const later = new Date(Date.now() + 60 * 60_000).toISOString()
      const statuses = {
        bare: yield* call(`/threads/${key}/mute`, { method: "PUT" }),
        until: yield* call(`/threads/${encodeURIComponent("session:rig:claude:s-1")}/mute`, { method: "PUT", body: JSON.stringify({ until: later }) }),
        past: yield* call(`/threads/${key}/mute`, { method: "PUT", body: JSON.stringify({ until: "2020-01-01T00:00:00.000Z" }) }),
        garbled: yield* call(`/threads/${key}/mute`, { method: "PUT", body: "{until" }),
        notTime: yield* call(`/threads/${key}/mute`, { method: "PUT", body: JSON.stringify({ until: "soon" }) }),
        unknown: yield* call(`/threads/${encodeURIComponent("t3:Rosie:nope")}/mute`, { method: "PUT" }),
        notKey: yield* call(`/threads/${encodeURIComponent("whatever")}/mute`, { method: "PUT" }),
        undecodable: yield* call("/threads/%E0%A4%A/mute", { method: "PUT" }),
      }
      const mutedThen = [...muted.keys()]
      const unmuted = [
        yield* call(`/threads/${key}/mute`, { method: "DELETE" }),
        yield* call(`/threads/${key}/mute`, { method: "DELETE" }),
        // A key yapd never makes was never muted, nor one that can't be decoded.
        yield* call(`/threads/${encodeURIComponent("whatever")}/mute`, { method: "DELETE" }),
        yield* call("/threads/%E0%A4%A/mute", { method: "DELETE" }),
      ]
      expect(statuses).toEqual({ bare: 204, until: 204, past: 400, garbled: 400, notTime: 400, unknown: 404, notKey: 400, undecodable: 400 })
      expect(mutedThen).toEqual(["t3:Rosie:850299f8", "session:rig:claude:s-1"])
      expect(muted.get("session:rig:claude:s-1")).toBe(Date.parse(later))
      // Unmuted, or not muted at all.
      expect(unmuted).toEqual([204, 204, 400, 400])
      expect([...muted.keys()]).toEqual(["session:rig:claude:s-1"])
    })))
  })

  test("has a thread's subagents read or not by its key, and turns away a session's, a subagent's own, or one it doesn't know", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api, reading } = yield* stateful
      const server = yield* Server.serve(0, api)
      const url = `http://127.0.0.1:${server.port}`
      const call = (path: string, method: string) => Effect.promise(() => fetch(`${url}${path}`, { method }).then((response) => response.status))
      const key = encodeURIComponent("t3:Rosie:850299f8")
      const statuses = {
        on: yield* call(`/threads/${key}/subagents`, "PUT"),
        again: yield* call(`/threads/${key}/subagents`, "PUT"),
        session: yield* call(`/threads/${encodeURIComponent("session:rig:claude:s-1")}/subagents`, "PUT"),
        subagent: yield* call(`/threads/${encodeURIComponent("t3:Rosie:review")}/subagents`, "PUT"),
        unknown: yield* call(`/threads/${encodeURIComponent("t3:Rosie:nope")}/subagents`, "PUT"),
        undecodable: yield* call("/threads/%E0%A4%A/subagents", "PUT"),
      }
      const readThen = [...reading]
      const off = [yield* call(`/threads/${key}/subagents`, "DELETE"), yield* call(`/threads/${key}/subagents`, "DELETE")]
      expect(statuses).toEqual({ on: 204, again: 204, session: 400, subagent: 409, unknown: 404, undecodable: 400 })
      expect(readThen).toEqual(["t3:Rosie:850299f8"])
      expect(off).toEqual([204, 204])
      expect([...reading]).toEqual([])
    })))
  })

  test("tells more of a thread by its key, only reading, and turns away what isn't a key yapd makes", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api, muted } = yield* stateful
      const server = yield* Server.serve(0, api)
      const url = `http://127.0.0.1:${server.port}`
      const call = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init))
      const key = encodeURIComponent("t3:Rosie:850299f8")
      const shown = yield* call(`/threads/${key}`)
      const body = yield* Effect.promise(() => shown.json())
      // Muted since, it says so.
      yield* call(`/threads/${key}/mute`, { method: "PUT" })
      const after = yield* Effect.promise(() => fetch(`${url}/threads/t3:Rosie:850299f8`).then((response) => response.json()))
      const statuses = {
        unknown: (yield* call(`/threads/${encodeURIComponent("t3:Rosie:nope")}`)).status,
        notKey: (yield* call(`/threads/${encodeURIComponent("whatever")}`)).status,
        undecodable: (yield* call("/threads/%E0%A4%A")).status,
        // Nothing else is done to a thread here.
        posted: (yield* call(`/threads/${key}`, { method: "POST", body: '{"text": "Merge it."}' })).status,
        deleted: (yield* call(`/threads/${key}`, { method: "DELETE" })).status,
      }
      expect(shown.status).toBe(200)
      expect(body).toEqual(detailed)
      expect(after).toEqual({ ...detailed, muted: true })
      expect(statuses).toEqual({ unknown: 404, notKey: 400, undecodable: 400, posted: 404, deleted: 404 })
      expect([...muted.keys()]).toEqual(["t3:Rosie:850299f8"])
    })))
  })

  test("tells more of a thread on a machine whose name is encoded in its key, by the key encoded whole, as it's given", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // A machine he named with a space in it, as YAPD_NAME="My Mac" does.
      const key = "t3:My%20Mac:850299f8"
      const asked: Array<string> = []
      const server = yield* Server.serve(0, {
        ...hooks(() => Effect.succeed(undefined)),
        details: (wanted) =>
          Effect.sync(() => {
            asked.push(wanted)
            return wanted === key ? Option.some({ ...detailed, key, machine: "My Mac" }) : Option.none()
          }),
      })
      const call = (path: string) => Effect.promise(() => fetch(`http://127.0.0.1:${server.port}${path}`))
      const shown = yield* call(`/threads/${encodeURIComponent(key)}`)
      const body = (yield* Effect.promise(() => shown.json())) as Server.Details
      // Not encoded whole, its machine's name comes out with a space, which no key yapd makes has.
      const halfway = (yield* call(`/threads/${key}`)).status
      expect({ status: shown.status, key: body.key, machine: body.machine, halfway, asked }).toEqual({ status: 200, key, machine: "My Mac", halfway: 400, asked: [key] })
    })))
  })

  test("says a thread's latest update again by its key only while yapd is on, and serves a project's icon by its machine and id, once until it changes", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api } = yield* stateful
      const server = yield* Server.serve(0, api)
      const url = `http://127.0.0.1:${server.port}`
      const call = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init))
      const replay = (key: string) => Effect.map(call(`/threads/${encodeURIComponent(key)}/replay`, { method: "POST" }), ({ status }) => status)
      const heard = [yield* replay("t3:Rosie:850299f8"), yield* replay("t3:Rosie:nope"), yield* replay("session:rig:claude:s-1")]
      yield* call("/state", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"on": false}' })
      const off = yield* replay("t3:Rosie:850299f8")
      const icon = yield* call(`/projects/Rosie/${encodeURIComponent("p/1")}/icon`)
      const body = yield* Effect.promise(() => icon.text())
      const again = yield* call(`/projects/Rosie/${encodeURIComponent("p/1")}/icon`, { headers: { "if-none-match": '"9f2c4e1a7b3d"' } })
      const changed = yield* call(`/projects/Rosie/${encodeURIComponent("p/1")}/icon`, { headers: { "if-none-match": '"0000"' } })
      const none = yield* call("/projects/rig/p-2/icon")
      const state = (yield* Effect.flatMap(call("/state"), (response) => Effect.promise(() => response.json()))) as Server.State
      expect(heard).toEqual([202, 404, 409])
      expect(off).toBe(409)
      expect({ status: icon.status, body, type: icon.headers.get("content-type"), etag: icon.headers.get("etag") }).toEqual({
        status: 200,
        body: "<svg/>",
        type: "image/svg+xml",
        etag: '"9f2c4e1a7b3d"',
      })
      // Shown as an image, never run as a page, whatever's in it.
      expect(icon.headers.get("x-content-type-options")).toBe("nosniff")
      expect(icon.headers.get("content-security-policy")).toBe("default-src 'none'")
      // Its address stays the same when the image changes, so nothing keeps it without asking yapd again.
      expect(icon.headers.get("cache-control")).toBe("no-cache")
      expect(again.status).toBe(304)
      expect(changed.status).toBe(200)
      expect(none.status).toBe(404)
      // What older apps read is still there.
      expect(state.updates).toEqual([update])
    })))
  })
})
