import { Data, Effect, Either, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { run } from "./Process.ts"
import { type Relay, RelayError, Unreachable } from "./Relay.ts"

// Since 0.157, Codex's terminal sessions run on a shared local app-server
// daemon, and `codex queue` hands one a message, which shows up as the next
// user turn. The daemon doesn't know whether a session is still open, but it
// knows who started it, which tells whether anything is reading its queue.

const socket = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock")

class DaemonError extends Data.TaggedError("DaemonError")<{ readonly cause: unknown }> {}

const Read = Schema.Struct({
  result: Schema.Struct({ thread: Schema.Struct({ originator: Schema.String }) }),
})
const Message = Schema.parseJson(Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
}))

/**
 * Only the terminal picks queued messages up as they arrive. Anything else
 * would leave them waiting until the session is resumed: sessions T3 Code runs
 * on its own server, say, or ones that ran headless with `codex exec`.
 */
export const reads = (originator: string) => originator === "codex-tui"

/** Who started the thread, from the daemon's own API. */
const originator = (thread: string) =>
  Effect.acquireUseRelease(
    Effect.try({ try: () => new WebSocket(`ws+unix://${socket}`), catch: (cause) => new DaemonError({ cause }) }),
    (ws) => Effect.async<string, DaemonError>((resume) => {
      const fail = (cause: unknown) => resume(Effect.fail(new DaemonError({ cause })))
      const send = (message: object) => {
        try {
          ws.send(JSON.stringify(message))
        } catch (cause) {
          fail(cause)
        }
      }
      ws.onopen = () => send({ id: 1, method: "initialize", params: { clientInfo: { name: "yapd", title: "yapd", version: "1" } } })
      ws.onerror = fail
      ws.onclose = () => fail("Codex's daemon closed the connection")
      ws.onmessage = (event) => {
        const decoded = Schema.decodeUnknownEither(Message)(String(event.data))
        if (Either.isLeft(decoded)) return fail(decoded.left)
        const message = decoded.right
        if ((message.id === 1 || message.id === 2) && message.error !== undefined) return fail(message.error)
        if (message.id === 1) {
          send({ method: "initialized" })
          send({ id: 2, method: "thread/read", params: { threadId: thread } })
        } else if (message.id === 2) {
          resume(Schema.decodeUnknown(Read)(message).pipe(
            Effect.map(({ result }) => result.thread.originator),
            Effect.mapError((cause) => new DaemonError({ cause })),
          ))
        }
      }
    }),
    (ws) => Effect.sync(() => {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
    }),
  ).pipe(Effect.timeoutFail({ duration: "3 seconds", onTimeout: () => new DaemonError({ cause: "timed out" }) }))

export const relay: Relay = {
  send: (thread, text) =>
    thread.agent !== "codex"
      ? Effect.fail(new Unreachable())
      : Effect.gen(function* () {
          const owner = yield* originator(thread.session).pipe(Effect.mapError(() => new Unreachable()))
          if (!reads(owner)) return yield* new Unreachable()
          yield* run(["codex", "queue", "--thread", thread.session, "--message", text]).pipe(
            Effect.mapError((cause) => new RelayError({ reason: "Codex wouldn't take it.", cause })),
          )
        }),
}
