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
    threads: [{ id: "850299f8", project: "integration", title: "Migrate the Tezos integration", state: "running", since: "2026-10-02T09:40:00.000Z" }],
  },
  { machine: "rig", reason: "I can't see rig's threads yet.", threads: [] },
]

/** An API that only handles hooks. */
const hooks = (handle: Server.Handle): Server.Api => ({
  handle,
  state: Stream.succeed<Server.State>({ on: true, activity: "idle", updates: [] }),
  turn: () => Effect.void,
  replay: () => Effect.succeed("unknown"),
  utter: () => Effect.succeed(Option.none()),
  card: () => Effect.succeed(Option.none()),
  hide: Effect.void,
  back: () => Effect.succeed(false),
  threads: Effect.succeed([]),
  journal: () => Effect.succeed([]),
  watch: Effect.void,
})

/** An API whose state is turned on and off for real, with one update to hear again and one card up, which counts who watches. */
const stateful = Effect.gen(function* () {
  const { id, kind, title, at } = card
  const ref = yield* SubscriptionRef.make<Server.State>({ on: true, activity: "idle", updates: [update], showing: { id, kind, title, at } })
  const pages: Array<Server.Page> = []
  let watching = 0
  return {
    ref,
    pages,
    watching: () => watching,
    api: {
      handle: () => Effect.succeed(undefined),
      state: ref.changes,
      turn: (on) => SubscriptionRef.update(ref, (state) => ({ ...state, on })),
      replay: (id) =>
        Effect.map(SubscriptionRef.get(ref), (state) => (id !== update.id ? "unknown" : state.on ? "queued" : "off")),
      utter: (text) => Effect.map(SubscriptionRef.get(ref), (state) => (state.on ? Option.some(`u-${text.length}`) : Option.none())),
      card: (id) => Effect.succeed(id === card.id ? Option.some(card) : Option.none()),
      hide: SubscriptionRef.update(ref, (state) => ({ ...state, showing: null })),
      back: (id) =>
        id === card.id ? Effect.as(SubscriptionRef.update(ref, (state) => ({ ...state, showing: { id, kind, title, at } })), true) : Effect.succeed(false),
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
    } satisfies Server.Api,
  }
})

describe("Server", () => {
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
        on: true, activity: "idle", updates: [update], showing: { id: "c1", kind: "pr", title: card.title, at: card.at },
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

  test("streams the state as it is, then each change, counting whoever follows it as watching until they go", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { ref, api, watching } = yield* stateful
      const server = yield* Server.serve(0, api)
      const gone = new AbortController()
      const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${server.port}/state/stream`, { signal: gone.signal }))
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      const next = Effect.promise(() => reader.read()).pipe(Effect.map(({ value }) => JSON.parse(value!.replace(/^data: /, ""))))
      expect(yield* next).toMatchObject({ on: true })
      expect(watching()).toBe(1)
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
})
