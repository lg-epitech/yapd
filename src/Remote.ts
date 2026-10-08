import { type Duration, Effect, Either, Option, Schema } from "effect"
import * as Launcher from "./Launcher.ts"
import { Origin } from "./Origin.ts"
import { Agent } from "./Payload.ts"
import { ProcessError, run } from "./Process.ts"
import { type Relay, RelayError, type Relays, type Thread, Unreachable } from "./Relay.ts"
import * as Research from "./Research.ts"

// Agents on other machines reach the daemon through a tunnel the user sets up,
// but their follow-ups have to be sent from where they run: T3 Code's API and
// Codex's queue are local to that machine. So the daemon hands them to
// `yapd relay` there over SSH, which runs the same relays and says how it went.
// New work goes the same way, to `yapd start`, `yapd catalog` says what that
// machine can start, and `yapd research` reads through a project there. `yapd
// t3` says where its T3 Code listens, for the tunnel to it (`Tunnel.ts`).

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

/**
 * This machine's hostname, read each time: a Mac's changes with the network.
 * Its hooks read theirs as the turn ends, so they agree.
 */
export type Self = () => string

/** Whether a thread runs on another machine. Hooks older than hostnames don't say, and were all local. */
const elsewhere = (self: Self, thread: Thread) =>
  thread.origin.host !== undefined && thread.origin.host.toLowerCase() !== self().toLowerCase()

/**
 * Keeps a relay to threads on this machine: another machine's T3 Code or Codex
 * isn't this one's, even when a thread here has the same path.
 */
export const here =
  (self: Self) =>
  (relay: Relay): Relay => ({
    send: (thread, text) => (elsewhere(self, thread) ? Effect.fail(new Unreachable()) : relay.send(thread, text)),
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
 * The socket of an SSH connection to the machine that's open already, while
 * there is one. Going through it saves connecting again, which is most of
 * what a command there takes.
 */
export type Master = Effect.Effect<Option.Option<string>>

/** The open connection to each machine, by its hostname in lowercase. */
export type Masters = (host: string) => Master

const none: Master = Effect.succeed(Option.none())

const nowhere: Masters = () => none

/**
 * Runs a yapd command on another machine and returns the line it answered
 * with. The command is fixed and what it's given goes over stdin: SSH joins its
 * arguments into a shell command, and what names the machine or fills the
 * request came in over the network, or from a model. With `master`, it goes
 * through the connection to the machine that's open already. `fail` is told
 * it was `sent` when the machine stopped answering once it had what it was
 * asked, which it may have done all the same.
 */
export const ask = <E>(
  exec: Exec,
  host: string,
  destination: string,
  command: "relay" | "start" | "catalog" | "research" | "t3",
  stdin: string,
  // `silent` and `failed` end the sentences that start with the machine's name.
  wording: { readonly patience: Duration.DurationInput; readonly silent: string; readonly failed: string },
  fail: (reason: string, cause?: unknown, sent?: boolean) => E,
  master: Master = none,
) =>
  Effect.flatMap(master, (socket) =>
    // From /, since Bun would load a .env in the home directory SSH starts in, ahead of yapd's own. When the
    // connection behind the socket has just gone, SSH connects on its own, as it would without one.
    exec(
      [
        "ssh",
        ...Option.match(socket, { onNone: () => [], onSome: (path) => ["-S", path] }),
        // Forwards the user's SSH config sets for the machine would be asked for again with each command, and clash.
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ClearAllForwardings=yes", "--", destination, `cd / && yapd ${command}`,
      ],
      stdin,
    ),
  ).pipe(
    Effect.catchTag("ProcessError", (error) =>
      Effect.fail(
        fail(
          // 255 is SSH's own failure, 127 the remote shell not finding yapd.
          error.code === 255
            ? `I can't reach ${host}.`
            : error.code === 127
              ? `yapd isn't on ${host}'s path.`
              : error.stderr.includes("usage: yapd")
                ? `yapd on ${host} needs updating.`
                : `yapd on ${host} ${wording.failed}`,
          error,
        ),
      ),
    ),
    Effect.timeoutFail({ duration: wording.patience, onTimeout: () => fail(`${host} ${wording.silent}`, undefined, true) }),
    // The remote shell's startup files may print something first.
    Effect.map((stdout) => stdout.trim().split("\n").at(-1) ?? ""),
  )

const unknown = (host: string) => `I don't know how to reach ${host}. It needs adding to YAPD_REMOTES.`

const garbled = (host: string) => `yapd on ${host} answered in a way I don't understand.`

/** Sends another machine's threads through `yapd relay` there. */
export const relay = (remotes: Remotes, self: Self, exec: Exec = ssh, masters: Masters = nowhere): Relay => ({
  send: (thread, text) =>
    Effect.gen(function* () {
      if (!elsewhere(self, thread)) return yield* new Unreachable()
      const host = thread.origin.host ?? ""
      const destination = remotes.get(host.toLowerCase())
      if (destination === undefined) return yield* new RelayError({ reason: unknown(host) })
      const answer = yield* ask(
        exec,
        host,
        destination,
        "relay",
        JSON.stringify(Request.make({ thread, text })),
        { patience: "30 seconds", silent: "isn't answering, so I don't know if it went through.", failed: "couldn't send it." },
        (reason, cause) => new RelayError({ reason, cause }),
        masters(host.toLowerCase()),
      )
      const response = yield* decodeResponse(answer).pipe(Effect.mapError((cause) => new RelayError({ reason: garbled(host), cause })))
      if (response.reason !== undefined) return yield* new RelayError({ reason: response.reason })
    }),
})

/**
 * Starts work on another machine through `yapd start` there, which follows that
 * machine's own defaults. A worktree can take minutes to fetch and check out,
 * and only a request that rules one out is sure to be quick.
 */
export const launcher = (host: string, destination: string, exec: Exec = ssh, master: Master = none): Launcher.Launcher => {
  const refuse = (reason: string, cause?: unknown) => new Launcher.LaunchError({ reason, cause })
  const read = <A, I>(schema: Schema.Schema<A, I>, answer: string) =>
    Schema.decodeUnknown(Schema.parseJson(schema))(answer).pipe(Effect.mapError((cause) => refuse(garbled(host), cause)))
  return {
    start: (request) =>
      Effect.gen(function* () {
        // Asked for there, it may have started all the same, as T3 Code there says when its answer is lost, or when yapd there stops answering.
        const failing = (reason: string, cause?: unknown, sent?: boolean) => new Launcher.LaunchError({ reason, cause, ...(sent === true ? { sent } : {}) })
        const answer = yield* ask(
          exec,
          host,
          destination,
          "start",
          JSON.stringify(Launcher.Request.make(request)),
          {
            patience: request.worktree === false ? "45 seconds" : "7 minutes",
            silent: "isn't answering, so I don't know if it started.",
            failed: "couldn't start it.",
          },
          failing,
          master,
        )
        const { started, reason, sent } = yield* read(Launcher.Response, answer)
        return started ?? (yield* failing(reason ?? garbled(host), undefined, sent))
      }),
    catalog: Effect.gen(function* () {
      const answer = yield* ask(
        exec,
        host,
        destination,
        "catalog",
        "",
        { patience: "30 seconds", silent: "isn't answering.", failed: "couldn't say what it can start." },
        refuse,
        master,
      )
      const { catalog, reason } = yield* read(Launcher.Listing, answer)
      return catalog ?? (yield* refuse(reason ?? garbled(host)))
    }),
  }
}

/** Reads through a project on another machine through `yapd research` there, with that machine's own provider. */
export const researcher = (host: string, destination: string, exec: Exec = ssh, master: Master = none): Research.Researcher =>
  Research.remote(host, (stdin) =>
    ask(
      exec,
      host,
      destination,
      "research",
      stdin,
      { patience: Research.patience, silent: "isn't answering.", failed: "couldn't read through the project." },
      (reason, cause) => new Research.ResearchError({ reason, cause }),
      master,
    ),
  )

/**
 * Whether a name means this machine: what the user calls it, when they've
 * said, or its hostname, which can carry a domain they wouldn't say, like `.local`.
 */
const local = (self: Self, machine: string, called: string | undefined) => {
  const [name, host] = [machine.trim().toLowerCase(), self().toLowerCase()]
  return name === "" || name === host || name === host.split(".")[0] || name === called?.trim().toLowerCase()
}

/** What stands for a machine: this one's own, or what reaches another over SSH. No name means this one. */
const pick = <A>(
  remotes: Remotes,
  self: Self,
  called: string | undefined,
  machine: string | undefined,
  options: { readonly own: A; readonly remote: (host: string, destination: string) => A; readonly unknown: (reason: string) => A },
) => {
  if (machine === undefined || local(self, machine, called)) return options.own
  const destination = remotes.get(machine.trim().toLowerCase())
  return destination === undefined ? options.unknown(unknown(machine.trim())) : options.remote(machine.trim(), destination)
}

/** The launcher for a machine. `called` is what the user calls this one. */
export const launchers =
  (remotes: Remotes, self: Self, own: Launcher.Launcher, exec: Exec = ssh, called?: string, masters: Masters = nowhere) =>
  (machine?: string): Launcher.Launcher =>
    pick(remotes, self, called, machine, {
      own,
      remote: (host, destination) => launcher(host, destination, exec, masters(host.toLowerCase())),
      unknown: (reason) => {
        const refused = Effect.fail(new Launcher.LaunchError({ reason }))
        return { start: () => refused, catalog: refused }
      },
    })

/** What reads through a machine's projects, picked like its launcher. */
export const researchers =
  (remotes: Remotes, self: Self, own: Research.Researcher, exec: Exec = ssh, called?: string, masters: Masters = nowhere) =>
  (machine?: string): Research.Researcher =>
    pick(remotes, self, called, machine, {
      own,
      remote: (host, destination) => researcher(host, destination, exec, masters(host.toLowerCase())),
      unknown: Research.unavailable,
    })

/** The machines work can start on, this one first by what the user calls it, as `launchers` knows them. */
export const machines = (remotes: Remotes, self: Self, called?: string) => [called?.trim() || self(), ...remotes.keys()]

/** `yapd relay`: sends one follow-up from stdin through this machine's relays and prints how it went. */
export const serve = (relays: Relays["Type"], input: string) =>
  Schema.decodeUnknown(Schema.parseJson(Request))(input).pipe(
    Effect.mapError(() => new RelayError({ reason: "yapd here and on the machine that speaks don't match. Update both." })),
    Effect.flatMap(({ thread, text }) => relays.send(thread, text)),
    Effect.as(Response.make({})),
    Effect.catchTag("RelayError", ({ reason }) => Effect.succeed(Response.make({ reason }))),
    Effect.map((response) => JSON.stringify(response)),
  )
