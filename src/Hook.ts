import { Effect } from "effect"
import * as Config from "./Config.ts"
import type { Agent } from "./Payload.ts"

/**
 * Forwards a hook payload from stdin to the daemon. It never fails and gives up
 * after two seconds, so a stopped daemon can't slow down or break an agent.
 */
export const hook = (agent: Agent) =>
  Effect.gen(function* () {
    // yapd's own condensing calls must not report back to it.
    if (process.env.YAPD_INTERNAL) return
    const port = yield* Config.port
    const body = yield* Effect.promise(() => Bun.stdin.text())
    yield* Effect.tryPromise((signal) =>
      fetch(`http://127.0.0.1:${port}/events?agent=${agent}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      }),
    )
  }).pipe(Effect.timeout("2 seconds"), Effect.ignore)
