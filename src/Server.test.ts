import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Scope } from "effect"
import * as Server from "./Server.ts"

const payload = { hook_event_name: "Stop", session_id: "test", cwd: "/tmp", last_assistant_message: "Done." }

describe("Server", () => {
  test("accepts valid events and rejects invalid payloads", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const server = yield* Server.serve(0, () => Effect.succeed("Follow up."))
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
      const server = await Effect.runPromise(Server.serve(0, () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Deferred.await(finish)),
          Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })),
          Effect.as(undefined),
        ),
      ).pipe(Scope.extend(scope)))
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
})
