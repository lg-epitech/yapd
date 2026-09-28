import type { Subprocess } from "bun"
import { Data, Deferred, Effect, Exit, Option, Schema } from "effect"
import { tmpdir } from "node:os"

// Codex's app-server, kept running between calls, so each summary or reply
// skips starting the CLI. That's about two of the eight seconds a reply takes.

/** The server itself failed, so `codex exec` can stand in. */
export class ServerError extends Data.TaggedError("ServerError")<{ readonly cause: unknown }> {}

/** The model failed, which `codex exec` wouldn't fix. */
export class TurnError extends Data.TaggedError("TurnError")<{ readonly cause: unknown }> {}

export interface Turn {
  readonly prompt: string
  readonly model: string | undefined
  readonly effort: string | undefined
  /** Like "priority", Codex's fast tier. */
  readonly tier: string | undefined
  /** JSON Schema of the final message. */
  readonly schema: object
}

/**
 * Unlike `codex exec`, the server can't skip the user's config, so this turns
 * off what it would bring along: hooks, which would report yapd's own calls
 * back to it, MCP servers, project instructions, and the command run after each turn.
 */
export const isolated = ["--disable", "hooks", "-c", "project_doc_max_bytes=0", "-c", "mcp_servers={}", "-c", "notify=[]"]

interface Message {
  readonly id?: number | string
  readonly method?: string
  readonly params?: { readonly threadId?: string; readonly [key: string]: unknown }
  readonly result?: unknown
  readonly error?: unknown
}

const Started = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const Completed = Schema.Struct({
  turn: Schema.Struct({ status: Schema.String, error: Schema.optional(Schema.Unknown) }),
})
const AgentMessage = Schema.Struct({ item: Schema.Struct({ type: Schema.Literal("agentMessage"), text: Schema.String }) })

interface Connection {
  readonly process: Subprocess<"pipe", "pipe", "ignore">
  readonly call: (method: string, params: object) => Effect.Effect<unknown, ServerError>
  /** Notifications about a thread, until the returned function is called. */
  readonly listen: (thread: string, listener: (message: Message) => void) => () => void
}

const connect = (onExit: () => void) =>
  Effect.gen(function* () {
    const process = Bun.spawn(["codex", "app-server", ...isolated], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      cwd: tmpdir(),
      // Belt and braces with disabling hooks, as for `codex exec`.
      env: { ...Bun.env, YAPD_INTERNAL: "1" },
    })
    let next = 0
    const pending = new Map<number, Deferred.Deferred<unknown, ServerError>>()
    const listeners = new Map<string, (message: Message) => void>()
    const write = (message: object) => {
      try {
        process.stdin.write(`${JSON.stringify(message)}\n`)
        process.stdin.flush()
      } catch {
        // It stopped; reading its output ends too, which fails whatever waits on it.
      }
    }

    const receive = (message: Message) => {
      if (message.method === undefined) {
        const request = typeof message.id === "number" ? pending.get(message.id) : undefined
        if (request === undefined) return
        pending.delete(message.id as number)
        Deferred.unsafeDone(
          request,
          message.error === undefined ? Exit.succeed(message.result) : Exit.fail(new ServerError({ cause: message.error })),
        )
      } else if (message.id !== undefined) {
        // Nothing should ask, given the sandbox and approval policy, but a request left unanswered would hang the turn.
        write({ id: message.id, error: { code: -32601, message: "yapd doesn't handle this" } })
      } else if (message.params?.threadId !== undefined) {
        listeners.get(message.params.threadId)?.(message)
      }
    }

    void (async () => {
      let buffered = ""
      const decoder = new TextDecoder()
      for await (const chunk of process.stdout) {
        buffered += decoder.decode(chunk, { stream: true })
        for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
          const line = buffered.slice(0, end).trim()
          buffered = buffered.slice(end + 1)
          if (line !== "") receive(JSON.parse(line) as Message)
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        const gone = new ServerError({ cause: "Codex's app-server stopped" })
        for (const request of pending.values()) Deferred.unsafeDone(request, Exit.fail(gone))
        for (const listener of listeners.values()) listener({ method: "yapd/closed" })
        pending.clear()
        onExit()
      })

    const call = (method: string, params: object) =>
      Effect.gen(function* () {
        const id = ++next
        const response = yield* Deferred.make<unknown, ServerError>()
        pending.set(id, response)
        write({ id, method, params })
        return yield* Deferred.await(response)
      })

    const connection: Connection = {
      process,
      call,
      listen: (thread, listener) => {
        listeners.set(thread, listener)
        return () => void listeners.delete(thread)
      },
    }
    yield* call("initialize", { clientInfo: { name: "yapd", title: "yapd", version: "1" } }).pipe(
      Effect.timeoutFail({ duration: "15 seconds", onTimeout: () => new ServerError({ cause: "didn't start" }) }),
      Effect.tapError(() => Effect.sync(() => process.kill())),
    )
    write({ method: "initialized" })
    return connection
  })

/** One server for the daemon, started right away and again whenever it stops. */
export const make = Effect.gen(function* () {
  let current: Connection | undefined
  const lock = yield* Effect.makeSemaphore(1)
  const connection = lock.withPermits(1)(
    Effect.suspend(() =>
      current !== undefined
        ? Effect.succeed(current)
        : connect(() => {
            current = undefined
          }).pipe(
            Effect.tap((started) => {
              current = started
            }),
          ),
    ),
  )
  yield* Effect.addFinalizer(() => Effect.sync(() => current?.process.kill()))
  // So the first update doesn't wait for it.
  yield* Effect.forkScoped(connection.pipe(Effect.ignore))

  const run = (turn: Turn) =>
    Effect.gen(function* () {
      const server = yield* connection
      const { thread } = yield* server.call("thread/start", {
        ...(turn.model === undefined ? {} : { model: turn.model }),
        cwd: tmpdir(),
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
      }).pipe(Effect.flatMap(Schema.decodeUnknown(Started)), Effect.mapError((cause) => new ServerError({ cause })))

      const done = yield* Deferred.make<string, ServerError | TurnError>()
      let text: string | undefined
      const stop = server.listen(thread.id, (message) => {
        if (message.method === "yapd/closed") {
          Deferred.unsafeDone(done, Exit.fail(new ServerError({ cause: "Codex's app-server stopped" })))
        } else if (message.method === "item/completed") {
          Option.map(Schema.decodeUnknownOption(AgentMessage)(message.params), ({ item }) => {
            text = item.text
          })
        } else if (message.method === "turn/completed") {
          const completed = Schema.decodeUnknownOption(Completed)(message.params)
          const failed = Option.isNone(completed) || completed.value.turn.status !== "completed" || text === undefined
          Deferred.unsafeDone(
            done,
            failed ? Exit.fail(new TurnError({ cause: Option.getOrUndefined(completed)?.turn ?? message.params })) : Exit.succeed(text!),
          )
        }
      })

      return yield* server
        .call("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: turn.prompt }],
          outputSchema: turn.schema,
          ...(turn.effort === undefined ? {} : { effort: turn.effort }),
          ...(turn.tier === undefined ? {} : { serviceTier: turn.tier }),
        })
        .pipe(
          Effect.zipRight(Deferred.await(done)),
          Effect.ensuring(
            Effect.sync(() => {
              stop()
              // Lets the server forget the thread.
              server.call("thread/unsubscribe", { threadId: thread.id }).pipe(Effect.ignore, Effect.runFork)
            }),
          ),
        )
    })

  return { run }
})
