import { Effect, Schema } from "effect"
import { wake } from "./ClaudeCode.ts"
import * as Config from "./Config.ts"
import * as Origin from "./Origin.ts"
import type { Agent } from "./Payload.ts"

const Reply = Schema.Struct({ reply: Schema.optional(Schema.String) })

/**
 * Forwards a hook payload from stdin to the daemon and returns the exit code.
 * It never fails and gives up after two seconds, so a stopped daemon can't slow
 * down or break an agent.
 *
 * With `wait`, meant for a Claude Code Stop hook run in the background with
 * asyncRewake, it then waits for the update to be read out. If the user replies
 * with something for the agent, it prints that and exits 2, which wakes the session.
 */
export const hook = (agent: Agent, wait: boolean) =>
  Effect.gen(function* () {
    // yapd's own condensing calls must not report back to it.
    if (process.env.YAPD_INTERNAL) return 0
    const port = yield* Config.port
    const body = yield* Effect.promise(() => Bun.stdin.text())
    // A session another app drives through the SDK, like T3 Code, is that app's to talk to.
    const waiting = wait && !process.env.CLAUDE_CODE_ENTRYPOINT?.startsWith("sdk")
    const query = new URLSearchParams({ agent, origin: JSON.stringify(Origin.fromEnv(process.env)) })
    if (waiting) query.set("wait", "1")
    const response = yield* Effect.tryPromise((signal) =>
      fetch(`http://127.0.0.1:${port}/events?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
        // The daemon answers once the update has been read out, which can be a while.
        ...(waiting ? { timeout: false } : {}),
      }),
    ).pipe(Effect.timeout(waiting ? "10 minutes" : "2 seconds"))
    if (!waiting) return 0
    const { reply } = yield* Effect.tryPromise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknown(Reply)))
    if (reply === undefined) return 0
    process.stderr.write(wake(reply))
    return 2
  }).pipe(Effect.orElseSucceed(() => 0))
