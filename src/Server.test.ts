import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Option, Scope, Stream, SubscriptionRef } from "effect"
import * as Server from "./Server.ts"

const payload = { hook_event_name: "Stop", session_id: "test", cwd: "/tmp", last_assistant_message: "Done." }

const update = { id: "a1", project: "yapd", text: "yapd. The tests pass.", at: "2026-10-02T10:00:00.000Z" }

/** An API that only handles hooks. */
const hooks = (handle: Server.Handle): Server.Api => ({
  handle,
  state: Stream.succeed<Server.State>({ on: true, activity: "idle", updates: [] }),
  turn: () => Effect.void,
  replay: () => Effect.succeed("unknown"),
  utter: () => Effect.succeed(Option.none()),
})

/** An API whose state is turned on and off for real, with one update to hear again. */
const stateful = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<Server.State>({ on: true, activity: "idle", updates: [update] })
  return {
    ref,
    api: {
      handle: () => Effect.succeed(undefined),
      state: ref.changes,
      turn: (on) => SubscriptionRef.update(ref, (state) => ({ ...state, on })),
      replay: (id) =>
        Effect.map(SubscriptionRef.get(ref), (state) => (id !== update.id ? "unknown" : state.on ? "queued" : "off")),
      utter: (text) => Effect.map(SubscriptionRef.get(ref), (state) => (state.on ? Option.some(`u-${text.length}`) : Option.none())),
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
        on: true, activity: "idle", updates: [update],
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

  test("streams the state as it is, then each change", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { ref, api } = yield* stateful
      const server = yield* Server.serve(0, api)
      const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${server.port}/state/stream`))
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      const next = Effect.promise(() => reader.read()).pipe(Effect.map(({ value }) => JSON.parse(value!.replace(/^data: /, ""))))
      expect(yield* next).toMatchObject({ on: true })
      yield* SubscriptionRef.update(ref, (state) => ({ ...state, activity: "speaking" as const }))
      expect(yield* next).toMatchObject({ on: true, activity: "speaking" })
      yield* Effect.promise(() => reader.cancel())
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
