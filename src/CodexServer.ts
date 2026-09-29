import type { Subprocess } from "bun"
import { Clock, Data, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect"
import { tmpdir } from "node:os"
import { run as command } from "./Process.ts"

// Codex's app-server, kept running between calls, so each summary or reply
// skips starting the CLI. Codex also spends seconds setting up each thread
// before it sends anything to the model, so threads are started ahead of time
// and a call only waits for the model itself.

/** The server itself failed, so `codex exec` can stand in. */
export class ServerError extends Data.TaggedError("ServerError")<{ readonly cause: unknown }> {}

/** The model failed, which `codex exec` wouldn't fix. */
export class TurnError extends Data.TaggedError("TurnError")<{ readonly cause: unknown }> {}

/** What every call runs with. It's fixed for the daemon's lifetime, so threads can start before they're needed. */
export interface Settings {
  readonly model: string | undefined
  readonly effort: string | undefined
  /** Like "priority", Codex's fast tier. */
  readonly tier: string | undefined
}

export interface Turn {
  readonly prompt: string
  /** JSON Schema of the final message. */
  readonly schema: object
}

/**
 * Unlike `codex exec`, the server can't skip the user's config, so this turns
 * off what it would bring along: hooks, which would report yapd's own calls
 * back to it, project instructions, and the command run after each turn.
 */
export const isolated = ["--disable", "hooks", "-c", "project_doc_max_bytes=0", "-c", "notify=[]"]

/** Apps and plugins bring MCP servers of their own, like codex_apps. */
export const features = ["--disable", "apps", "--disable", "plugins"]

const McpServers = Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean }))

/**
 * Config that turns off the user's MCP servers, which would otherwise start
 * with every thread and hold up its first turn. `mcp_servers={}` doesn't: it
 * merges into the user's table instead of replacing it.
 */
export const muted = (servers: typeof McpServers.Type) => {
  const enabled = servers.filter((server) => server.enabled)
  return enabled.length === 0
    ? {}
    : { mcp_servers: Object.fromEntries(enabled.map(({ name }) => [name, { enabled: false }])) }
}

/** Threads kept ready, so a summary and a reply at the same moment both find one. */
const spares = 2

/**
 * Older ready threads are let go rather than trusted. One that waited 25 minutes
 * answered as fast, but after 55 Codex found its connection closed and had to retry.
 */
const freshFor = 20 * 60_000

/** How an app-server that never answered fails. Other flags won't fix it. */
const silent = "didn't start"

interface Message {
  readonly id?: number | string
  readonly method?: string
  readonly params?: { readonly threadId?: string; readonly [key: string]: unknown }
  readonly result?: unknown
  readonly error?: unknown
}

const Started = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const TurnStarted = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) })
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

const connect = (
  codex: ReadonlyArray<string>,
  flags: ReadonlyArray<string>,
  onExit: (process: Subprocess) => void,
) =>
  Effect.gen(function* () {
    const process = yield* Effect.try({
      try: () =>
        Bun.spawn([...codex, "app-server", ...flags], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          cwd: tmpdir(),
          // Belt and braces with disabling hooks, as for `codex exec`.
          env: { ...Bun.env, YAPD_INTERNAL: "1" },
        }),
      catch: (cause) => new ServerError({ cause }),
    })
    let next = 0
    let closed = false
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
        closed = true
        const gone = new ServerError({ cause: "Codex's app-server stopped" })
        for (const request of pending.values()) Deferred.unsafeDone(request, Exit.fail(gone))
        for (const listener of listeners.values()) listener({ method: "yapd/closed" })
        pending.clear()
        onExit(process)
      })

    const call = (method: string, params: object) =>
      Effect.gen(function* () {
        // Nothing would ever answer.
        if (closed) return yield* new ServerError({ cause: "Codex's app-server stopped" })
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
      Effect.timeoutFail({ duration: "15 seconds", onTimeout: () => new ServerError({ cause: silent }) }),
      // Also when interrupted, or nothing would ever stop it.
      Effect.onError(() => Effect.sync(() => process.kill())),
    )
    write({ method: "initialized" })
    return connection
  })

/** A thread started ahead of time, waiting for a turn. */
interface Spare {
  readonly thread: string
  readonly server: Connection
  readonly at: number
}

/** One server for the daemon, started right away and again whenever it stops. */
export const make = (settings: Settings, codex: ReadonlyArray<string> = ["codex"]) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    let current: Connection | undefined
    let failedAt = Number.NEGATIVE_INFINITY
    let ready: Array<Spare> = []
    let starting = 0
    let listed = true

    /** Runs in the background for as long as the daemon does. */
    const background = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.ignore, Effect.interruptible, Effect.forkIn(scope), Effect.asVoid)

    const onExit = (process: Subprocess) => {
      if (current?.process === process) current = undefined
      ready = ready.filter((spare) => spare.server.process !== process)
    }
    const start = connect(codex, [...isolated, ...features], onExit).pipe(
      // A Codex that doesn't know these features exits at once. It still runs without them, only slower.
      Effect.catchIf(
        (error) => error.cause !== silent,
        (error) =>
          Effect.logWarning("Codex's app-server didn't start with apps and plugins off, so they stay on", error).pipe(
            Effect.zipRight(connect(codex, isolated, onExit)),
          ),
      ),
    )
    const lock = yield* Effect.makeSemaphore(1)
    const connection = lock.withPermits(1)(
      Effect.suspend(() =>
        current !== undefined
          ? Effect.succeed(current)
          : Effect.gen(function* () {
              // One that won't start would otherwise hold every call up, with no time left for `codex exec`.
              if ((yield* Clock.currentTimeMillis) - failedAt < 60_000) {
                return yield* new ServerError({ cause: "Codex's app-server didn't start a moment ago" })
              }
              return yield* Effect.uninterruptibleMask((restore) =>
                restore(start).pipe(
                  Effect.tap((started) => {
                    current = started
                  }),
                  Effect.tapError(() =>
                    Effect.map(Clock.currentTimeMillis, (now) => {
                      failedAt = now
                    }),
                  ),
                ),
              )
            }),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => current?.process.kill()))

    /** The user's MCP servers, read just before each thread starts, since Codex rereads its config then too. */
    const servers = command([...codex, ...features, "mcp", "list", "--json"], { cwd: tmpdir() }).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(McpServers))),
      // It usually takes a twentieth of a second.
      Effect.timeout("5 seconds"),
      Effect.tap(() => {
        listed = true
      }),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          // Once, and only how it failed: the listing and Codex's errors quote the servers' headers and environment, tokens included.
          if (listed) {
            const how =
              error._tag === "ProcessError"
                ? `it exited with code ${error.code}`
                : error._tag === "TimeoutException"
                  ? "it didn't answer"
                  : "its answer changed shape"
            yield* Effect.logWarning(`Could not list Codex's MCP servers, so they start with each call: ${how}`)
          }
          listed = false
          return []
        }),
      ),
    )

    const startThread = (server: Connection) =>
      Effect.gen(function* () {
        const result = yield* server.call("thread/start", {
          ...(settings.model === undefined ? {} : { model: settings.model }),
          // Set on the thread as well as the turn, so Codex warms it up the way its turn will run.
          ...(settings.tier === undefined ? {} : { serviceTier: settings.tier }),
          config: {
            ...(settings.effort === undefined ? {} : { model_reasoning_effort: settings.effort }),
            ...muted(yield* servers),
          },
          cwd: tmpdir(),
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
        })
        const { thread } = yield* Schema.decodeUnknown(Started)(result).pipe(Effect.mapError((cause) => new ServerError({ cause })))
        return thread.id
      })

    /** Lets the server forget a thread. */
    const release = (server: Connection, thread: string) =>
      background(server.call("thread/unsubscribe", { threadId: thread }))

    /** Keeps a started thread for a later call, unless enough are ready or its server is gone. */
    const keep = (server: Connection, thread: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) => {
        if (server !== current || ready.length >= spares) return release(server, thread)
        ready.push({ thread, server, at })
        return Effect.void
      })

    /** Starts threads in the background until enough are ready. */
    const refill = Effect.suspend(() => {
      const missing = Math.max(0, spares - ready.length - starting)
      starting += missing
      return Effect.forEach(
        Array.from({ length: missing }),
        () =>
          connection.pipe(
            Effect.flatMap((server) => startThread(server).pipe(Effect.flatMap((thread) => keep(server, thread)))),
            Effect.ensuring(
              Effect.sync(() => {
                starting--
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )
    }).pipe(background)

    /** Lets go of ready threads that waited too long. */
    const prune = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const usable = (spare: Spare) => spare.server === current && now - spare.at < freshFor
      const stale = ready.filter((spare) => !usable(spare))
      ready = ready.filter(usable)
      yield* Effect.forEach(stale, (spare) => release(spare.server, spare.thread), { discard: true })
    })

    /** The ready thread that has waited longest. */
    const take = Effect.map(prune, () => {
      const [spare, ...rest] = ready
      ready = rest
      return spare
    })

    /** Has threads ready for a call that's known to be coming, like while the user dictates. */
    const prepare = Effect.zipRight(prune, refill)

    /** A new thread for a call. One the call stops waiting for is kept for the next. */
    const threadFor = (server: Connection) =>
      Effect.gen(function* () {
        const request = yield* Effect.forkIn(startThread(server), scope)
        return yield* Fiber.join(request).pipe(
          Effect.onInterrupt(() => background(Fiber.join(request).pipe(Effect.flatMap((thread) => keep(server, thread))))),
        )
      })

    /**
     * Starts a turn on the thread, and returns what waits for its answer. When the
     * scope closes, it stops a turn that's still going and forgets the thread.
     */
    const begin = (server: Connection, thread: string, turn: Turn) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<string, ServerError | TurnError>()
        let text: string | undefined
        let request: Fiber.RuntimeFiber<unknown, ServerError> | undefined
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            server.listen(thread, (message) => {
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
                  failed
                    ? Exit.fail(new TurnError({ cause: Option.getOrUndefined(completed)?.turn ?? message.params }))
                    : Exit.succeed(text!),
                )
              }
            }),
          ),
          (stop) =>
            Effect.gen(function* () {
              stop()
              // A turn given up on, like when the user carries on talking, would keep the model writing.
              // Its id may still be on its way, so this waits for it in the background.
              const interrupt =
                request === undefined || (yield* Deferred.isDone(done))
                  ? Effect.void
                  : Fiber.join(request).pipe(
                      Effect.flatMap(Schema.decodeUnknown(TurnStarted)),
                      Effect.flatMap(({ turn: { id } }) => server.call("turn/interrupt", { threadId: thread, turnId: id })),
                      Effect.ignore,
                    )
              yield* background(interrupt.pipe(Effect.zipRight(server.call("thread/unsubscribe", { threadId: thread }))))
            }),
        )

        request = yield* Effect.forkIn(
          server.call("turn/start", {
            threadId: thread,
            input: [{ type: "text", text: turn.prompt }],
            outputSchema: turn.schema,
            ...(settings.effort === undefined ? {} : { effort: settings.effort }),
            ...(settings.tier === undefined ? {} : { serviceTier: settings.tier }),
          }),
          scope,
        )
        yield* Fiber.join(request)
        return Deferred.await(done)
      })

    const fresh = (turn: Turn) =>
      connection.pipe(
        Effect.flatMap((server) => threadFor(server).pipe(Effect.flatMap((thread) => begin(server, thread, turn)))),
      )

    // So the first update doesn't wait for the server or a thread.
    yield* refill

    const run = (turn: Turn) =>
      Effect.gen(function* () {
        yield* connection
        const spare = yield* take
        // After the turn, so starting threads doesn't compete with it.
        yield* Effect.addFinalizer(() => refill)
        const answer =
          spare === undefined
            ? yield* fresh(turn)
            : yield* begin(spare.server, spare.thread, turn).pipe(
                // Codex may have let a waiting thread go, so a new one takes its place.
                Effect.catchTag("ServerError", () => fresh(turn)),
              )
        return yield* answer
      }).pipe(Effect.scoped)

    return { run, prepare }
  })
