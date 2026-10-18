import type { Socket } from "bun"
import { Console, Duration, Effect, Either, Logger, Option, Runtime, Schedule, Schema } from "effect"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { connect } from "node:net"
import { homedir, tmpdir, userInfo } from "node:os"
import { join as joinPath } from "node:path"
import * as Clients from "./Clients.ts"
import * as Config from "./Config.ts"
import * as Helper from "./Helper.ts"
import * as Home from "./Home.ts"
import * as Origin from "./Origin.ts"
import { run } from "./Process.ts"
import * as Remote from "./Remote.ts"
import * as Service from "./Service.ts"
import * as Setup from "./Setup.ts"
import * as Wire from "./Wire.ts"

// `yapd client`: what runs on a machine that uses yapd on another, its server,
// set up by `yapd setup client`. It keeps one SSH connection to the server,
// which brings the server's port here, so this machine's hooks and menu bar
// app reach yapd as if it ran here, and brings a socket there back to this
// machine's SSH, so yapd there reaches the threads, follow-ups and new work
// here, whatever network this machine is on. On a Mac it also runs the audio
// helper for the server, so yapd speaks and listens here, and takes the
// shortcut: it passes the helper's messages on to the server over `/audio`,
// with the files it's to play sent ahead.

export class ClientError extends Schema.TaggedError<ClientError>()("ClientError", { reason: Schema.String }) {}

/** This machine's SSH host key, as the server pins it: its type and its data. */
export const hostKey = () => {
  for (const type of ["ed25519", "ecdsa", "rsa"]) {
    try {
      const [kind, data] = readFileSync(`/etc/ssh/ssh_host_${type}_key.pub`, "utf8").trim().split(/\s+/)
      if (kind !== undefined && data !== undefined) return `${kind} ${data}`
    } catch {
      // Not this one.
    }
  }
  return undefined
}

/** Whether this machine's SSH answers, which the server reaches back through: Remote Login, on a Mac. */
export const sshd = Effect.async<boolean>((resume) => {
  const socket = connect({ host: "127.0.0.1", port: 22 })
  const done = (up: boolean) => {
    socket.destroy()
    resume(Effect.succeed(up))
  }
  socket.setTimeout(2000, () => done(false))
  socket.once("connect", () => done(true))
  socket.once("error", () => done(false))
})

const decodeAnswer = Schema.decodeUnknown(Schema.parseJson(Clients.Answer))

/** Asks the server to take this machine in, or back, and where to connect. */
export const join = (destination: string, request: Clients.Request) =>
  Remote.ask(
    (command, stdin) => run(command, { stdin }),
    destination,
    destination,
    "join",
    JSON.stringify(request),
    { patience: "30 seconds", silent: "isn't answering.", failed: "couldn't take this machine in." },
    (reason) => new ClientError({ reason }),
  ).pipe(
    Effect.flatMap((answer) => decodeAnswer(answer).pipe(Effect.mapError(() => new ClientError({ reason: `yapd on ${destination} needs updating.` })))),
    Effect.flatMap(({ socket, server, keys, zone, reason }) =>
      socket !== undefined && server !== undefined
        ? Effect.succeed({ socket, server, keys: keys ?? [], zone })
        : Effect.fail(new ClientError({ reason: reason ?? `yapd on ${destination} answered in a way I don't understand.` })),
    ),
  )

/** What this machine tells the server it is. */
export const request = (): Either.Either<Clients.Request, string> => {
  const key = hostKey()
  if (key === undefined) return Either.left("This machine has no SSH host key, so its server can't reach back here. Turn on its SSH server.")
  return Either.right({ name: Origin.clientName(), user: userInfo().username, key, zone: Intl.DateTimeFormat().resolvedOptions().timeZone })
}

/**
 * The connection to the server, opened as `ssh -N` and kept until it drops.
 * Its forwards are only ever on 127.0.0.1 here and the socket there, and SSH
 * gives up on one that's gone quiet after 45 seconds.
 */
export const tunnel = (destination: string, port: number, server: number, socket: string) => [
  "ssh", "-N",
  "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
  "-L", `127.0.0.1:${port}:127.0.0.1:${server}`,
  "-R", `${socket}:127.0.0.1:22`,
  "--", destination,
]

/** How long to wait before trying again, longer each time it fails in a row, up to a minute. */
const again = (failures: number) => Duration.seconds(Math.min(60, 2 ** Math.max(0, failures - 1)))

/** Joins the server and keeps the connection to it open, connecting again whenever it drops. */
const link = (destination: string, port: number) =>
  Effect.gen(function* () {
    const asking = request()
    if (Either.isLeft(asking)) return yield* Effect.logWarning(asking.left)
    let failures = 0
    let said: string | undefined
    /** Logs why it's not connected, once until that changes. */
    const trouble = (reason: string) => (reason === said ? Effect.void : Effect.zipRight(Effect.sync(() => void (said = reason)), Effect.logWarning(reason)))
    while (true) {
      const joined = yield* Effect.either(join(destination, asking.right))
      if (Either.isLeft(joined)) {
        failures++
        yield* trouble(joined.left.reason)
        yield* Effect.sleep(again(failures))
        continue
      }
      const opened = Date.now()
      if (said !== "") yield* Effect.logInfo(`Connected to ${destination}`)
      said = ""
      const ended = yield* Effect.either(run(tunnel(destination, port, joined.right.server, joined.right.socket)))
      // One that held for a while dropped, rather than failed to open.
      failures = Date.now() - opened > 60_000 ? 1 : failures + 1
      const why = Either.isLeft(ended) ? ended.left.stderr.trim().split("\n").at(-1) : undefined
      yield* trouble(`The connection to ${destination} dropped${why ? `: ${why}` : ""}`)
      yield* Effect.sleep(again(failures))
    }
  })

/** Whether an address is one to open: only a secure web page. */
const openable = (url: string) => {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Runs the audio helper here for the server, connected to it over `/audio`
 * on the port the connection brings here. The connection to the server only
 * stands while the helper does, so the server never plays to one that's gone.
 */
const bridge = (port: number, microphone: boolean) =>
  Effect.gen(function* () {
    yield* Helper.build
    const runtime = yield* Effect.runtime<never>()
    const runFork = Runtime.runFork(runtime)
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(joinPath(tmpdir(), "yapd-client-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    )
    const path = joinPath(dir, "socket")
    const files = joinPath(dir, "files")
    mkdirSync(files)
    /** What the server sent to play, by its id. */
    const sent = new Map<string, string>()
    const forget = () => {
      for (const file of sent.values()) rmSync(file, { force: true })
      sent.clear()
    }
    const name = process.env.YAPD_NAME?.trim() || Origin.clientName()
    const client = { id: `mac:${Origin.clientName()}`, name, hotkeys: true, opens: true }

    let helper: Socket<Helper.Decoder> | undefined
    let unsent: Array<Uint8Array> = []
    const flush = () => {
      while (helper !== undefined && unsent.length > 0) {
        const next = unsent[0]!
        const written = helper.write(next)
        if (written < next.length) {
          unsent[0] = next.subarray(Math.max(0, written))
          return
        }
        unsent.shift()
      }
    }
    const tell = (message: object) => {
      if (helper === undefined) return
      unsent.push(Helper.encode(message))
      if (unsent.length === 1) flush()
    }
    /** The helper's hello, as the server is told it once it's connected, with who this is. */
    let hello: string | undefined
    let server: WebSocket | undefined
    let up = false

    /** What the server says, as the helper's commands, with what it's to play put where the helper can read it. */
    const heard = (data: string | ArrayBuffer) => {
      if (typeof data !== "string") {
        const file = Wire.readFile(new Uint8Array(data))
        if (file === undefined) return
        const at = joinPath(files, `${sent.size}-${crypto.randomUUID()}.wav`)
        writeFileSync(at, file.bytes)
        sent.set(file.id, at)
        return
      }
      let message: { readonly type?: unknown; readonly [key: string]: unknown }
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      switch (message.type) {
        case "play": {
          const at = typeof message.file === "string" ? sent.get(message.file) : undefined
          if (at === undefined || helper === undefined) {
            server?.send(JSON.stringify({ type: "failed", id: message.id, message: helper === undefined ? "The audio helper isn't running" : "That file never came" }))
            return
          }
          tell({ type: "play", id: message.id, path: at, from: message.from ?? 0 })
          return
        }
        case "forget": {
          const at = typeof message.file === "string" ? sent.get(message.file) : undefined
          if (at === undefined) return
          sent.delete(message.file as string)
          rmSync(at, { force: true })
          return
        }
        case "open":
          if (typeof message.url === "string" && openable(message.url)) runFork(run(["open", message.url]).pipe(Effect.ignore))
          return
        default:
          tell(message)
      }
    }

    /** Connects to the server once the helper has said hello, and again whenever it drops, while the helper runs. */
    const connectServer = () => {
      if (server !== undefined || hello === undefined || !up) return
      const socket = new WebSocket(`ws://127.0.0.1:${port}/audio`)
      socket.binaryType = "arraybuffer"
      server = socket
      socket.onopen = () => {
        if (hello !== undefined) socket.send(hello)
        runFork(Effect.logInfo("Speaking and listening here for yapd"))
      }
      socket.onmessage = (event) => heard(event.data as string | ArrayBuffer)
      socket.onclose = () => {
        if (server !== socket) return
        server = undefined
        // Nothing it was told to play goes on without it.
        tell({ type: "stop" })
        tell({ type: "rest" })
        forget()
        if (up) setTimeout(connectServer, 2000)
      }
    }

    const fromHelper = (message: Helper.Message) => {
      if (message.kind === Helper.Kind.pcm) {
        if (server?.readyState === WebSocket.OPEN) server.send(Wire.pcm16(new Float32Array(message.payload.buffer)))
        return
      }
      const text = new TextDecoder().decode(message.payload)
      let parsed: { readonly type?: unknown; readonly permission?: unknown }
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      if (parsed.type === "hello" || parsed.type === "permission") {
        hello = JSON.stringify({ type: "hello", permission: parsed.permission, client })
        if (parsed.type === "hello") {
          // A helper that started again holds no keys: the server tells it them again once it hears hello anew.
          server?.close()
          connectServer()
          return
        }
      }
      if (server?.readyState === WebSocket.OPEN) server.send(text)
    }

    yield* Effect.acquireRelease(
      Effect.try(() =>
        Bun.listen<Helper.Decoder>({
          unix: path,
          socket: {
            open: (socket) => {
              socket.data = new Helper.Decoder()
              helper?.end()
              helper = socket
              unsent = []
              up = true
            },
            data: (socket, chunk) => {
              if (socket !== helper) return
              for (const message of socket.data.push(chunk)) fromHelper(message)
            },
            drain: (socket) => {
              if (socket === helper) flush()
            },
            close: (socket) => {
              if (socket !== helper) return
              helper = undefined
              up = false
              hello = undefined
              server?.close()
            },
          },
        }),
      ),
      (listener) =>
        Effect.sync(() => {
          up = false
          server?.close()
          helper?.end()
          listener.stop(true)
        }),
    )
    // Started again whenever it quits, since the shortcut needs it.
    yield* Effect.gen(function* () {
      yield* Helper.launch(path, microphone)
      for (let waited = 0; !up; waited++) {
        if (waited === 50) return yield* new ClientError({ reason: "The audio helper didn't start" })
        yield* Effect.sleep("200 millis")
      }
      while (up) yield* Effect.sleep("1 second")
      return yield* new ClientError({ reason: "The audio helper quit" })
    }).pipe(
      Effect.tapError((error) => Effect.logWarning(`${error.message}, starting it again`)),
      // Longer each time it fails in a row, up to a minute.
      Effect.retry(Schedule.exponential("2 seconds").pipe(Schedule.union(Schedule.spaced("1 minute")))),
      Effect.ignore,
    )
  }).pipe(Effect.scoped)

/** `yapd client`. */
export const client = Effect.gen(function* () {
  const destination = yield* Config.server
  if (Option.isNone(destination)) return yield* new ClientError({ reason: "YAPD_SERVER isn't set. yapd setup client <server> sets it." })
  const port = yield* Config.port
  if (!(yield* sshd)) yield* Effect.logWarning(`This machine's SSH server is off, so ${destination.value} can't reach back here for its threads. On a Mac, turn on Remote Login in System Settings, General, Sharing.`)
  yield* Effect.forkScoped(link(destination.value, port))
  // YAPD_LISTEN=false still plays here, as yapd does on a Mac, with the microphone closed.
  if (process.platform === "darwin") {
    yield* Effect.forkScoped(bridge(port, yield* Config.listen).pipe(Effect.catchAll((error) => Effect.logWarning("yapd can't speak or listen here", error))))
  }
  return yield* Effect.never
}).pipe(Effect.scoped, Effect.provide(Logger.pretty))

/** Whether this is a client of yapd on another machine, by its settings: a server set that's this one's. */
export const isClient = (env = process.env) => (env.YAPD_SERVER?.trim() ?? "") !== ""


/**
 * Whether `authorized_keys` lets one of `keys` in from this machine itself,
 * where the server's connection arrives: on a line with no `from=`, or one
 * that names 127.0.0.1. One kept to other addresses, like a tailnet's, isn't.
 */
export const lets = (authorized: string, keys: ReadonlyArray<string>) =>
  authorized.split("\n").some((line) => {
    const key = keys.find((key) => line.includes(key))
    if (key === undefined || line.trimStart().startsWith("#")) return false
    const from = /(?:^|,)from="([^"]*)"/.exec(line.slice(0, line.indexOf(key)).trim())?.[1]
    return from === undefined || from.split(",").some((pattern) => pattern.trim() === "127.0.0.1")
  })

/** Lets the server in over SSH, by any of its keys, only through its connection to this machine: never from anywhere else. */
const letIn = (keys: ReadonlyArray<string>, destination: string) =>
  Effect.gen(function* () {
    if (keys.length === 0) {
      return yield* Console.log(`${destination} has no SSH key, so it can't reach back here. Make one there with ssh-keygen, then run this again.`)
    }
    const folder = joinPath(homedir(), ".ssh")
    const file = joinPath(folder, "authorized_keys")
    const had = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (lets(had, keys)) return
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    appendFileSync(file, `${had === "" || had.endsWith("\n") ? "" : "\n"}from="127.0.0.1,::1" ${keys[0]} yapd on ${destination}\n`, { mode: 0o600 })
    yield* Console.log(`${destination} can now log in here over SSH, only through its connection to this machine, in ${file}`)
  })

/**
 * `yapd setup client <server>`: has the server take this machine in, lets it
 * back in over SSH, keeps which server it is in the settings, where the hooks
 * read what this machine is called, sets them up, and runs `yapd client` as a
 * service in place of yapd's own.
 */
export const setup = (destination: string, bun: string, main: string) =>
  Effect.gen(function* () {
    if (destination.startsWith("-") || /\s/.test(destination)) return yield* new ClientError({ reason: `${destination} isn't something I can SSH to.` })
    const asking = request()
    if (Either.isLeft(asking)) return yield* new ClientError({ reason: asking.left })
    yield* Console.log(`Asking ${destination} to take this machine in, as ${asking.right.name}`)
    const joined = yield* join(destination, asking.right)
    if (joined.zone !== undefined && joined.zone !== asking.right.zone) {
      yield* Console.log(`${destination} tells the time as ${joined.zone}, while this machine is on ${asking.right.zone}. TZ in its ~/.yapd/.env changes that.`)
    } else if (joined.zone !== undefined) {
      yield* Console.log(`${destination} tells the time as ${joined.zone}, as this machine does.`)
    }
    yield* letIn(joined.keys, destination)
    yield* Effect.sync(() => Home.set("YAPD_SERVER", destination))
    // So the service written next is the client's, as it would be once the settings are read.
    process.env.YAPD_SERVER = destination
    yield* Console.log(`This machine uses yapd on ${destination} now, as YAPD_SERVER in ${Home.settings}`)
    yield* Setup.setup(bun, main)
    if (!(yield* sshd)) {
      yield* Console.log(`This machine's SSH server is off, so ${destination} can't reach back here for its threads. On a Mac, turn on Remote Login in System Settings, General, Sharing.`)
    }
    if (Bun.which("yapd", { PATH: `${joinPath(homedir(), ".bun", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin` }) === null) {
      yield* Console.log(`${destination} runs yapd here over SSH, and can't find it. Install it with bun add -g @launatic/yapd, or run bun link in your clone.`)
    }
    yield* Service.install("client")
  })
