import { Effect, Either, Option, Schema } from "effect"
import { Origin } from "./Origin.ts"
import { Agent } from "./Payload.ts"
import { ProcessError, run } from "./Process.ts"
import { type Relay, RelayError, type Relays, type Thread, Unreachable } from "./Relay.ts"

// Agents on other machines reach the daemon through a tunnel the user sets up,
// but their follow-ups have to be sent from where they run: T3 Code's API and
// Codex's queue are local to that machine. So the daemon hands them to
// `yapd relay` there over SSH, which runs the same relays and says how it went.

/** Hostname, as the machine's hooks report it, to SSH destination. */
export type Remotes = ReadonlyMap<string, string>

/**
 * Parses `YAPD_REMOTES`: entries like `rig` or `rig=me@rig.example.com`, separated
 * by commas. A bare name is both the hostname and the destination.
 */
export const parse = (value: string): Either.Either<Remotes, string> => {
  const remotes = new Map<string, string>()
  for (const entry of value.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const [host = "", destination = host, ...rest] = entry.split("=").map((part) => part.trim())
    // A leading dash would be read as an SSH option.
    if (host === "" || destination === "" || destination.startsWith("-") || rest.length > 0) {
      return Either.left(`YAPD_REMOTES has an entry I can't read: "${entry}". Use host or host=destination.`)
    }
    remotes.set(host.toLowerCase(), destination)
  }
  return Either.right(remotes)
}

const remoteOf = (remotes: Remotes, thread: Thread) =>
  thread.origin.host === undefined ? Option.none() : Option.fromNullable(remotes.get(thread.origin.host.toLowerCase()))

/** Keeps a relay to this machine's threads: another machine's T3 Code or Codex isn't this one's. */
export const here =
  (remotes: Remotes) =>
  (relay: Relay): Relay => ({
    send: (thread, text) => (Option.isSome(remoteOf(remotes, thread)) ? Effect.fail(new Unreachable()) : relay.send(thread, text)),
  })

export const Request = Schema.Struct({
  thread: Schema.Struct({ agent: Agent, session: Schema.String, cwd: Schema.String, message: Schema.String, origin: Origin }),
  text: Schema.String,
})

/** No reason means it was sent. */
export const Response = Schema.Struct({ reason: Schema.optional(Schema.String) })

const decodeResponse = Schema.decodeUnknown(Schema.parseJson(Response))

export type Exec = (command: ReadonlyArray<string>, stdin: string) => Effect.Effect<string, ProcessError>

const ssh: Exec = (command, stdin) => run(command, { stdin })

/**
 * Sends another machine's threads through `yapd relay` there. The command is
 * fixed and the message goes over stdin: SSH joins its arguments into a shell
 * command, and the event that named the machine came in over the network.
 */
export const relay = (remotes: Remotes, exec: Exec = ssh): Relay => ({
  send: (thread, text) =>
    Effect.gen(function* () {
      const remote = remoteOf(remotes, thread)
      if (Option.isNone(remote)) return yield* new Unreachable()
      const host = thread.origin.host
      const command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", remote.value, "yapd", "relay"]
      const stdout = yield* exec(command, JSON.stringify(Request.make({ thread, text }))).pipe(
        Effect.timeoutFail({
          duration: "30 seconds",
          onTimeout: () => new RelayError({ reason: `${host} isn't answering, so I don't know if it went through.` }),
        }),
        Effect.catchTag("ProcessError", (error) =>
          Effect.fail(
            new RelayError({
              cause: error,
              reason:
                // 255 is SSH's own failure, 127 the remote shell not finding yapd.
                error.code === 255
                  ? `I can't reach ${host}.`
                  : error.code === 127
                    ? `yapd isn't on ${host}'s path.`
                    : error.stderr.includes("usage: yapd")
                      ? `yapd on ${host} needs updating.`
                      : `yapd on ${host} couldn't send it.`,
            }),
          ),
        ),
      )
      // The remote shell's startup files may print something first.
      const response = yield* decodeResponse(stdout.trim().split("\n").at(-1) ?? "").pipe(
        Effect.mapError((cause) => new RelayError({ reason: `yapd on ${host} answered in a way I don't understand.`, cause })),
      )
      if (response.reason !== undefined) return yield* new RelayError({ reason: response.reason })
    }),
})

/** `yapd relay`: sends one follow-up from stdin through this machine's relays and prints how it went. */
export const serve = (relays: Relays["Type"], input: string) =>
  Schema.decodeUnknown(Schema.parseJson(Request))(input).pipe(
    Effect.mapError(() => new RelayError({ reason: "yapd here and on the machine that speaks don't match. Update both." })),
    Effect.flatMap(({ thread, text }) => relays.send(thread, text)),
    Effect.as(Response.make({})),
    Effect.catchTag("RelayError", ({ reason }) => Effect.succeed(Response.make({ reason }))),
    Effect.map((response) => JSON.stringify(response)),
  )
