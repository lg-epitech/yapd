import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Option, Scope, Stream, SubscriptionRef } from "effect"
import * as Server from "./Server.ts"

const payload = { hook_event_name: "Stop", session_id: "test", cwd: "/tmp", last_assistant_message: "Done." }

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
  cancelReminder: () => Effect.succeed("unknown"),
})

/** An API whose state is turned on and off for real, and which counts who watches. */
const stateful = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<Server.State>({ on: true, activity: "idle", updates: [] })
  let watching = 0
  return {
    ref,
    watching: () => watching,
    api: {
      ...hooks(() => Effect.succeed(undefined)),
      icon: (machine, project) =>
        Effect.succeed(
          machine === "Rosie" && project === "p/1" ? Option.some({ bytes: new TextEncoder().encode("<svg/>"), type: "image/svg+xml", revision: "9f2c4e1a7b3d" }) : Option.none(),
        ),
      state: ref.changes,
      turn: (on) => SubscriptionRef.update(ref, (state) => ({ ...state, on })),
      mode: (mode, until) =>
        SubscriptionRef.update(ref, ({ until: _, ...state }) => ({ ...state, mode, ...(until === undefined ? {} : { until: new Date(until).toISOString() }) })),
      utter: (text) => Effect.map(SubscriptionRef.get(ref), (state) => (state.on ? Option.some(`u-${text.length}`) : Option.none())),
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
      const reply = yield* Effect.promise(() => fetch(`${url}/events?agent=claude&wait=1`, {
        method: "POST", body: JSON.stringify(payload),
      }).then((response) => response.json()))
      expect(reply).toEqual({ reply: "Follow up." })
      expect((yield* Effect.promise(() => fetch(`${url}/events?agent=claude`, { method: "POST", body: "{}" }))).status).toBe(400)
    })))
  })

  test("interrupts outstanding waiting handlers before stopping the server", async () => {
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
    const request = fetch(`http://127.0.0.1:${server.port}/events?agent=claude&wait=1`, {
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
      const soon = new Date(Date.now() + 60 * 60_000).toISOString()

      expect((yield* put('{"mode": "focus"}')).status).toBe(200)
      yield* put(JSON.stringify({ mode: "quiet", until: soon }))
      yield* put('{"on": false}')
      yield* put('{"on": true, "mode": "normal"}')
      expect(asked).toEqual(["focus", "quiet until", "on false", "on true", "normal"])

      for (const body of [
        "{}",
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

  test("serves a project's icon by its machine and id, once until it changes, never as a page", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { api } = yield* stateful
      const server = yield* Server.serve(0, api)
      const url = `http://127.0.0.1:${server.port}`
      const call = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init))
      const icon = yield* call(`/projects/Rosie/${encodeURIComponent("p/1")}/icon`)
      const again = yield* call(`/projects/Rosie/${encodeURIComponent("p/1")}/icon`, { headers: { "if-none-match": '"9f2c4e1a7b3d"' } })
      const changed = yield* call(`/projects/Rosie/${encodeURIComponent("p/1")}/icon`, { headers: { "if-none-match": '"0000"' } })
      const none = yield* call("/projects/rig/p-2/icon")
      expect({ status: icon.status, etag: icon.headers.get("etag") }).toEqual({ status: 200, etag: '"9f2c4e1a7b3d"' })
      // Shown as an image, never run as a page, whatever's in it.
      expect(icon.headers.get("x-content-type-options")).toBe("nosniff")
      expect(icon.headers.get("content-security-policy")).toBe("default-src 'none'")
      expect(again.status).toBe(304)
      expect(changed.status).toBe(200)
      expect(none.status).toBe(404)
    })))
  })
})
