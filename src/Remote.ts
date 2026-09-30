import { type Duration, Effect, Either, Schema } from "effect"
import * as Launcher from "./Launcher.ts"
import { Origin } from "./Origin.ts"
import { Agent } from "./Payload.ts"
import { ProcessError, run } from "./Process.ts"
import { type Relay, RelayError, type Relays, type Thread, Unreachable } from "./Relay.ts"
import * as Research from "./Research.ts"
import * as Threads from "./Threads.ts"

// Agents on other machines reach the daemon through a tunnel the user sets up,
// but their follow-ups have to be sent from where they run: T3 Code's API and
// Codex's queue are local to that machine. So the daemon hands them to
// `yapd relay` there over SSH, which runs the same relays and says how it went.
// New work goes the same way, to `yapd start`, `yapd catalog` says what that
// machine can start, and `yapd research` reads through a project there. The
// threads already running there are listed, read and written to through
// `yapd threads`, `yapd thread`, `yapd opening` and `yapd send`.

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
 * Runs a yapd command on another machine and returns the line it answered
 * with. The command is fixed and what it's given goes over stdin: SSH joins its
 * arguments into a shell command, and what names the machine or fills the
 * request came in over the network, or from a model.
 */
const ask = <E>(
  exec: Exec,
  host: string,
  destination: string,
  command: "relay" | "start" | "catalog" | "research" | "threads" | "thread" | "opening" | "send",
  stdin: string,
  // `silent` and `failed` end the sentences that start with the machine's name.
  wording: { readonly patience: Duration.DurationInput; readonly silent: string; readonly failed: string },
  fail: (reason: string, cause?: unknown) => E,
) =>
  // From /, since Bun would load a .env in the home directory SSH starts in, ahead of the yapd folder's.
  exec(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", destination, `cd / && yapd ${command}`], stdin).pipe(
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
    Effect.timeoutFail({ duration: wording.patience, onTimeout: () => fail(`${host} ${wording.silent}`) }),
    // The remote shell's startup files may print something first.
    Effect.map((stdout) => stdout.trim().split("\n").at(-1) ?? ""),
  )

const unknown = (host: string) => `I don't know how to reach ${host}. It needs adding to YAPD_REMOTES.`

const garbled = (host: string) => `yapd on ${host} answered in a way I don't understand.`

/** Sends another machine's threads through `yapd relay` there. */
export const relay = (remotes: Remotes, self: Self, exec: Exec = ssh): Relay => ({
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
export const launcher = (host: string, destination: string, exec: Exec = ssh): Launcher.Launcher => {
  const refuse = (reason: string, cause?: unknown) => new Launcher.LaunchError({ reason, cause })
  const read = <A, I>(schema: Schema.Schema<A, I>, answer: string) =>
    Schema.decodeUnknown(Schema.parseJson(schema))(answer).pipe(Effect.mapError((cause) => refuse(garbled(host), cause)))
  return {
    start: (request) =>
      Effect.gen(function* () {
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
          refuse,
        )
        const { started, reason } = yield* read(Launcher.Response, answer)
        return started ?? (yield* refuse(reason ?? garbled(host)))
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
      )
      const { catalog, reason } = yield* read(Launcher.Listing, answer)
      return catalog ?? (yield* refuse(reason ?? garbled(host)))
    }),
  }
}

/** Reads through a project on another machine through `yapd research` there, with that machine's own provider. */
export const researcher = (host: string, destination: string, exec: Exec = ssh): Research.Researcher =>
  Research.remote(host, (stdin) =>
    ask(
      exec,
      host,
      destination,
      "research",
      stdin,
      { patience: Research.patience, silent: "isn't answering.", failed: "couldn't read through the project." },
      (reason, cause) => new Research.ResearchError({ reason, cause }),
    ),
  )

/** The threads on one machine, or the reason they can't be listed. */
export const ThreadsListing = Schema.Struct({ threads: Schema.optional(Schema.Array(Threads.Listed)), reason: Schema.optional(Schema.String) })

export const ThreadRequest = Schema.Struct({ id: Schema.String, turns: Schema.Number })
/** `gone` with the reason means the thread itself is out of reach, so asking again won't help. */
export const ThreadResponse = Schema.Struct({
  detail: Schema.optional(Threads.Detail),
  reason: Schema.optional(Schema.String),
  gone: Schema.optional(Schema.Boolean),
})

export const OpeningRequest = Schema.Struct({ id: Schema.String })
export const OpeningResponse = Schema.Struct({
  text: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  gone: Schema.optional(Schema.Boolean),
})

export const SendRequest = Schema.Struct({ id: Schema.String, outgoing: Threads.Outgoing })
export const SendResponse = Schema.Struct({
  sent: Schema.optional(Threads.Sent),
  reason: Schema.optional(Schema.String),
  gone: Schema.optional(Schema.Boolean),
})

/**
 * The threads on another machine, through the same commands there. Reading a
 * thread means T3 Code there reading the whole of it, so it gets longer than a
 * listing.
 */
export const threads = (host: string, destination: string, exec: Exec = ssh): Threads.Threads => {
  const refuse = (reason: string, cause?: unknown) => new Threads.ThreadsError({ reason, cause })
  const asked = <A, I>(
    command: "threads" | "thread" | "opening" | "send",
    stdin: string,
    wording: { readonly patience: Duration.DurationInput; readonly silent: string; readonly failed: string },
    schema: Schema.Schema<A, I>,
  ) =>
    ask(exec, host, destination, command, stdin, wording, refuse).pipe(
      Effect.flatMap((answer) =>
        Schema.decodeUnknown(Schema.parseJson(schema))(answer).pipe(Effect.mapError((cause) => refuse(garbled(host), cause))),
      ),
    )
  /** What the machine answered, or its reason as the error, kept `gone` when it said so. */
  const answered = <A>(response: { readonly reason?: string | undefined; readonly gone?: boolean | undefined }, value: A | undefined) =>
    value !== undefined
      ? Effect.succeed(value)
      : Effect.fail(new Threads.ThreadsError({ reason: response.reason ?? garbled(host), ...(response.gone === true ? { gone: true } : {}) }))
  return {
    list: asked(
      "threads",
      "",
      { patience: "15 seconds", silent: "isn't answering.", failed: "couldn't list its threads." },
      ThreadsListing,
    ).pipe(Effect.flatMap((response) => answered(response, response.threads))),
    detail: (id, turns) =>
      asked(
        "thread",
        JSON.stringify(ThreadRequest.make({ id, turns })),
        { patience: "20 seconds", silent: "isn't answering.", failed: "couldn't read the thread." },
        ThreadResponse,
      ).pipe(Effect.flatMap((response) => answered(response, response.detail))),
    opening: (id) =>
      asked(
        "opening",
        JSON.stringify(OpeningRequest.make({ id })),
        { patience: "20 seconds", silent: "isn't answering.", failed: "couldn't read the thread." },
        OpeningResponse,
      ).pipe(Effect.flatMap((response) => answered(response, response.text))),
    send: (id, outgoing) =>
      asked(
        "send",
        JSON.stringify(SendRequest.make({ id, outgoing })),
        { patience: "20 seconds", silent: "isn't answering, so I don't know if it went through.", failed: "couldn't send it." },
        SendResponse,
      ).pipe(Effect.flatMap((response) => answered(response, response.sent))),
  }
}

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
  (remotes: Remotes, self: Self, own: Launcher.Launcher, exec: Exec = ssh, called?: string) =>
  (machine?: string): Launcher.Launcher =>
    pick(remotes, self, called, machine, {
      own,
      remote: (host, destination) => launcher(host, destination, exec),
      unknown: (reason) => {
        const refused = Effect.fail(new Launcher.LaunchError({ reason }))
        return { start: () => refused, catalog: refused }
      },
    })

/** What reads through a machine's projects, picked like its launcher. */
export const researchers =
  (remotes: Remotes, self: Self, own: Research.Researcher, exec: Exec = ssh, called?: string) =>
  (machine?: string): Research.Researcher =>
    pick(remotes, self, called, machine, {
      own,
      remote: (host, destination) => researcher(host, destination, exec),
      unknown: Research.unavailable,
    })

/** The threads of a machine, picked like its launcher. */
export const threadsOn =
  (remotes: Remotes, self: Self, own: Threads.Threads, exec: Exec = ssh, called?: string) =>
  (machine?: string): Threads.Threads =>
    pick(remotes, self, called, machine, {
      own,
      remote: (host, destination) => threads(host, destination, exec),
      unknown: (reason) => {
        const refused = Effect.fail(new Threads.ThreadsError({ reason }))
        return { list: refused, detail: () => refused, opening: () => refused, send: () => refused }
      },
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

const mismatch = "yapd here and on the machine that speaks don't match. Update both."

const reading = <A, I>(schema: Schema.Schema<A, I>, input: string) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(input).pipe(Effect.mapError(() => new Threads.ThreadsError({ reason: mismatch })))

/** Why there's nothing to print, with `gone` when asking again won't help. */
const failed = ({ reason, gone }: Threads.ThreadsError) => ({ reason, ...(gone === true ? { gone } : {}) })

/** `yapd threads`: prints the threads here. */
export const serveThreads = (threads: Threads.Threads) =>
  threads.list.pipe(
    Effect.map((threads) => ThreadsListing.make({ threads })),
    Effect.catchTag("ThreadsError", ({ reason }) => Effect.succeed(ThreadsListing.make({ reason }))),
    Effect.map((listing) => JSON.stringify(listing)),
  )

/** `yapd thread`: prints the thread named on stdin, with its latest turns. */
export const serveThread = (threads: Threads.Threads, input: string) =>
  reading(ThreadRequest, input).pipe(
    Effect.flatMap(({ id, turns }) => threads.detail(id, turns)),
    Effect.map((detail) => ThreadResponse.make({ detail })),
    Effect.catchTag("ThreadsError", (error) => Effect.succeed(ThreadResponse.make(failed(error)))),
    Effect.map((response) => JSON.stringify(response)),
  )

/** `yapd opening`: prints the first message of the thread named on stdin. */
export const serveOpening = (threads: Threads.Threads, input: string) =>
  reading(OpeningRequest, input).pipe(
    Effect.flatMap(({ id }) => threads.opening(id)),
    Effect.map((text) => OpeningResponse.make({ text })),
    Effect.catchTag("ThreadsError", (error) => Effect.succeed(OpeningResponse.make(failed(error)))),
    Effect.map((response) => JSON.stringify(response)),
  )

/** `yapd send`: sends the message on stdin to the thread it names and prints how it went. */
export const serveSend = (threads: Threads.Threads, input: string) =>
  reading(SendRequest, input).pipe(
    Effect.flatMap(({ id, outgoing }) => threads.send(id, outgoing)),
    Effect.map((sent) => SendResponse.make({ sent })),
    Effect.catchTag("ThreadsError", (error) => Effect.succeed(SendResponse.make(failed(error)))),
    Effect.map((response) => JSON.stringify(response)),
  )
