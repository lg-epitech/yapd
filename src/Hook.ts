import { Effect, Fiber, Option, Schema } from "effect"
import { hostname } from "node:os"
import { wake } from "./ClaudeCode.ts"
import * as Config from "./Config.ts"
import * as Origin from "./Origin.ts"
import { type Agent, Stop } from "./Payload.ts"
import * as Project from "./Project.ts"
import * as Seen from "./Seen.ts"

const Reply = Schema.Struct({ reply: Schema.optional(Schema.String) })
const decodeStop = Schema.decodeUnknownOption(Schema.parseJson(Stop))

/** Notes where the agent ran and what with, under a timeout, and without ever failing. */
export const note = (agent: Agent, stop: typeof Stop.Type, path?: string) =>
  Seen.note({ directory: stop.cwd, agent, model: stop.model }, path).pipe(
    Effect.timeoutOption("1 second"),
    Effect.catchAllCause(() => Effect.void),
    Effect.asVoid,
  )

/**
 * Forwards a hook payload from stdin to the daemon and returns the exit code.
 * It never fails and gives up after a few seconds, so a stopped daemon or a stuck
 * or missing git can't slow down or break an agent.
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
    // Only updates announce the project, so prompts don't wait on git. A stuck or missing git leaves it to the daemon.
    const stop = decodeStop(body)
    const project = Option.isSome(stop)
      ? Option.getOrUndefined(
          yield* Project.name(stop.value.cwd).pipe(
            Effect.timeoutOption("1 second"),
            Effect.catchAllCause(() => Effect.succeedNone),
          ),
        )
      : undefined
    // So new work can start where agents have run. Alongside the rest, and given up on if the disk is slow.
    const noting = yield* Effect.fork(Option.match(stop, { onNone: () => Effect.void, onSome: (stop) => note(agent, stop) }))
    yield* Effect.addFinalizer(() => Fiber.await(noting))
    const origin = { ...Origin.fromEnv(process.env), host: hostname(), ...(project ? { project } : {}) }
    const query = new URLSearchParams({ agent, origin: JSON.stringify(origin) })
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
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => 0),
  )
