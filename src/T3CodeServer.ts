import { Data, type Duration, Effect, Either, Redacted, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

// T3 Code's local server, the one its app talks to. Reading goes over HTTP,
// and everything else over the app's WebSocket, which is the only place it
// takes commands.

/** The orchestration protocol yapd speaks. T3 Code turns away clients that don't name the one it does. */
export const protocol = "2"

/** Where the running server says it listens. T3CODE_HOME moves it, as it does for T3 Code. */
const runtimeState = join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "userdata", "server-runtime.json")
const Server = Schema.parseJson(Schema.Struct({ origin: Schema.String }))
export type Server = Schema.Schema.Type<typeof Server>

/** T3 Code couldn't be asked, or its answer made no sense. */
export class Trouble extends Data.TaggedError("Trouble")<{
  readonly reason: string
  readonly cause?: unknown
  /** The request went out before it went wrong, so T3 Code may have done it. */
  readonly sent?: boolean
}> {}

/** T3 Code was asked and said no, in its own words. */
export class Refusal extends Data.TaggedError("Refusal")<{ readonly tag: string; readonly message: string }> {}

export const locate = Effect.tryPromise(() => Bun.file(runtimeState).text()).pipe(
  Effect.flatMap(Schema.decodeUnknown(Server)),
  Effect.mapError((cause) => new Trouble({ reason: "T3 Code isn't running.", cause })),
)

const misunderstood = (cause: unknown) => new Trouble({ reason: "T3 Code answered in a way I don't understand.", cause })

export const api =
  (server: Server, token: Redacted.Redacted) =>
  <A, I>(path: string, schema: Schema.Schema<A, I>, init: RequestInit = {}) =>
    Effect.tryPromise({
      try: async (signal) => {
        let response: Response
        try {
          response = await fetch(`${server.origin}${path}`, {
            ...init,
            headers: {
              authorization: `Bearer ${Redacted.value(token)}`,
              "content-type": "application/json",
              "x-t3-orchestration-protocol": protocol,
            },
            signal,
          })
        } catch (cause) {
          throw new Trouble({ reason: "T3 Code isn't answering.", cause })
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw response.status === 401 || response.status === 403
            ? new Trouble({ reason: "T3 Code turned down my token. It may have expired." })
            : new Trouble({ reason: "T3 Code wouldn't take it.", cause: `${response.status} from ${path}` })
        }
        try {
          return await response.json()
        } catch (cause) {
          throw misunderstood(cause)
        }
      },
      catch: (cause) => cause instanceof Trouble ? cause : misunderstood(cause),
    }).pipe(
      Effect.flatMap((body) => Effect.mapError(Schema.decodeUnknown(schema)(body), misunderstood)),
      Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => new Trouble({ reason: "T3 Code isn't answering." }) }),
    )

const Failure = Schema.Struct({ _tag: Schema.String, message: Schema.String })

const Exit = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Unknown }),
  Schema.Struct({
    _tag: Schema.Literal("Failure"),
    cause: Schema.Array(Schema.Struct({ _tag: Schema.String, error: Schema.optional(Schema.Unknown) })),
  }),
)

const Message = Schema.parseJson(
  Schema.Struct({ _tag: Schema.String, requestId: Schema.optional(Schema.Unknown), exit: Schema.optional(Schema.Unknown) }),
)

/** How a request ended. Failures T3 Code didn't declare mean the two of us disagree on the protocol. */
export const outcome = (exit: unknown): Either.Either<unknown, Trouble | Refusal> => {
  const decoded = Schema.decodeUnknownEither(Exit)(exit)
  if (Either.isLeft(decoded)) return Either.left(misunderstood(decoded.left))
  if (decoded.right._tag === "Success") return Either.right(decoded.right.value)
  const [first] = decoded.right.cause
  if (first?._tag === "Interrupt") return Either.left(new Trouble({ reason: "T3 Code stopped before it was done." }))
  const failure = first?._tag === "Fail" ? Schema.decodeUnknownEither(Failure)(first.error) : undefined
  if (failure === undefined || Either.isLeft(failure)) {
    return Either.left(new Trouble({ reason: "T3 Code didn't understand me. One of us needs updating.", cause: exit }))
  }
  return Either.left(new Refusal({ tag: failure.right._tag, message: failure.right.message }))
}

const id = "1"

/**
 * One request over the app's WebSocket, which is closed once it's answered.
 * Closing it sooner would stop what the request started. Whatever goes wrong
 * once the request went out, even T3 Code taking too long, says it went out,
 * since T3 Code may have done it all the same.
 */
export const call =
  (server: Server, token: Redacted.Redacted) =>
  <A, I>(method: string, payload: unknown, schema: Schema.Schema<A, I>, patience: Duration.DurationInput = "15 seconds") =>
    Effect.suspend(() => {
      let sent = false
      return asked(server, token, method, payload, schema, patience, () => {
        sent = true
      }).pipe(Effect.mapError((error) => (error._tag === "Trouble" && sent ? new Trouble({ ...error, sent: true }) : error)))
    })

/** The request itself, saying through `went` once it has gone out. */
const asked = <A, I>(
  server: Server,
  token: Redacted.Redacted,
  method: string,
  payload: unknown,
  schema: Schema.Schema<A, I>,
  patience: Duration.DurationInput,
  went: () => void,
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        new WebSocket(`${server.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${protocol}`, {
          headers: { authorization: `Bearer ${Redacted.value(token)}` },
        }),
      catch: (cause) => new Trouble({ reason: "T3 Code isn't answering.", cause }),
    }),
    (socket) =>
      Effect.async<unknown, Trouble | Refusal>((resume) => {
        let open = false
        let refused = false
        let cause: unknown
        socket.onopen = () => {
          open = true
          // Without headers, T3 Code stops answering on this socket and doesn't say why.
          try {
            socket.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }))
            went()
          } catch (cause) {
            resume(Effect.fail(new Trouble({ reason: "T3 Code isn't answering.", cause })))
          }
        }
        // Bun only says which status it got instead of the upgrade, and T3 Code only turns down credentials.
        socket.onerror = (event) => {
          cause = event
          refused = "message" in event && String(event.message).includes("101")
        }
        socket.onclose = () =>
          resume(
            Effect.fail(
              new Trouble({
                cause,
                reason: open
                  ? "T3 Code hung up on me."
                  : refused
                    ? "T3 Code turned down my token. It may have expired."
                    : "T3 Code isn't answering.",
              }),
            ),
          )
        socket.onmessage = (event) => {
          const message = Schema.decodeUnknownEither(Message)(event.data)
          if (Either.isLeft(message)) return resume(Effect.fail(misunderstood(message.left)))
          if (message.right._tag === "Defect") return resume(Effect.fail(misunderstood(event.data)))
          if (message.right._tag === "Exit" && message.right.requestId === id) resume(outcome(message.right.exit))
        }
      }),
    (socket) =>
      Effect.sync(() => {
        socket.onclose = null
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.close()
      }),
  ).pipe(
    Effect.timeoutFail({ duration: patience, onTimeout: () => new Trouble({ reason: "T3 Code is taking too long." }) }),
    Effect.flatMap((value) => Effect.mapError(Schema.decodeUnknown(schema)(value), misunderstood)),
  )

/** How T3 Code is reached, so tests can stand in for it. */
export interface Transport {
  readonly api: ReturnType<typeof api>
  readonly call: ReturnType<typeof call>
}

export const connect = (token: Redacted.Redacted) =>
  Effect.map(locate, (server): Transport => ({ api: api(server, token), call: call(server, token) }))
