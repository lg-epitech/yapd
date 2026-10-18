import { Database } from "bun:sqlite"
import { Console, Effect, Option, Schema } from "effect"
import { existsSync } from "node:fs"
import { mkdir, readdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join as joinPath } from "node:path"
import * as Config from "./Config.ts"
import * as Home from "./Home.ts"
import { run } from "./Process.ts"
import * as Remote from "./Remote.ts"
import * as Server from "./Server.ts"
import * as Service from "./Service.ts"
import * as Settings from "./Settings.ts"
import * as Store from "./Store.ts"

// The machines that use yapd here as their server, and the phones paired with
// it. A machine joins with `yapd join`, which its `yapd client` runs here over
// SSH before each connection it opens: that connection forwards a socket here
// back to the machine's own SSH, and yapd here listens on a port of its own
// for each, passing what comes in on to that socket. That port is how it
// reaches the machine's threads, follow-ups and new work, whatever network
// it's on. A phone has no SSH, so it's given a token, `yapd pair`, and
// reaches yapd over the tailnet.

/** Whether it's a time zone, as Intl names them, like America/Toronto. */
const zoned = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)
  } catch {
    return false
  }
}

/** What `yapd join` is told: what the machine is called, who to log in as there, and its SSH host key. */
export const Request = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/)),
  user: Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/)),
  key: Schema.String.pipe(Schema.pattern(/^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/)),
  /** Its time zone, which the first to join gives a server that has none set, since its user is where that machine is. */
  zone: Schema.optional(Schema.String.pipe(Schema.filter(zoned))),
})
export type Request = typeof Request.Type

/** What it answers: the socket here it forwards back to its SSH, yapd's port here, and this machine's keys to let in. */
export const Answer = Schema.Struct({
  socket: Schema.optional(Schema.String),
  /** The time zone yapd here tells the time in. */
  zone: Schema.optional(Schema.String),
  server: Schema.optional(Schema.Number),
  keys: Schema.optional(Schema.Array(Schema.String)),
  reason: Schema.optional(Schema.String),
})
export type Answer = typeof Answer.Type

/** The ports here clients' SSH is forwarded to, one each. */
export const ports = { from: 4800, to: 4999 } as const

/** A client as the table keeps it. */
interface Row {
  readonly name: string
  readonly user: string
  readonly port: number
  readonly key: string
}

/** The lowest port in the range no other client has, and nothing else is listening on. */
export const free = (taken: ReadonlySet<number>, listening: (port: number) => boolean) => {
  for (let port: number = ports.from; port <= ports.to; port++) if (!taken.has(port) && !listening(port)) return port
  return undefined
}

/** Whether something listens on a port here. */
const listening = (port: number) => {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data: () => {} } }).stop(true)
    return false
  } catch {
    return true
  }
}

/**
 * Where a client's connection forwards its SSH to here: a socket only this
 * user can open. One left behind by a connection that went away without a
 * word, like a laptop closed, would stand in the way of the next until the
 * network gave up on it, which can take half an hour, so it's taken away first.
 */
export const socket = (name: string) => joinPath(Home.home, "clients", `${name}.sock`)

const knownHosts = joinPath(homedir(), ".ssh", "known_hosts")

/** The client's host key as SSH here will check it, at the port that leads to it, replacing one it had before. */
const pin = (port: number, key: string) =>
  Effect.gen(function* () {
    const host = `[127.0.0.1]:${port}`
    const found = yield* run(["ssh-keygen", "-F", host, "-f", knownHosts]).pipe(Effect.orElseSucceed(() => ""))
    const [type, data] = key.split(" ")
    if (found.split("\n").some((line) => line.includes(` ${type} ${data}`))) return
    if (found.trim() !== "") yield* run(["ssh-keygen", "-R", host, "-f", knownHosts]).pipe(Effect.ignore)
    yield* Effect.tryPromise(async () => {
      const file = Bun.file(knownHosts)
      const had = (await file.exists()) ? await file.text() : ""
      await Bun.write(knownHosts, `${had}${had === "" || had.endsWith("\n") ? "" : "\n"}${host} ${type} ${data}\n`)
    })
  })

/** This machine's public keys, which SSH logs in to clients with. */
const ownKeys = Effect.promise(async () => {
  const folder = joinPath(homedir(), ".ssh")
  const names = await readdir(folder).catch(() => [])
  const order = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]
  const keys = await Promise.all(
    names
      .filter((name) => order.includes(name))
      .toSorted((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((name) => Bun.file(joinPath(folder, name)).text().catch(() => "")),
  )
  return keys.map((key) => key.trim().split(/\s+/).slice(0, 2).join(" ")).filter((key) => key.includes(" "))
})

const decodeRequest = Schema.decodeUnknown(Schema.parseJson(Request))

/**
 * `yapd join`: takes a client in, or back, keeping the port it had, and says
 * where to connect. One that's new, or moved, has yapd here restarted to
 * follow it, once it's been answered.
 */
export const join = (input: string) =>
  Effect.gen(function* () {
    const asked = yield* decodeRequest(input).pipe(Effect.option)
    if (Option.isNone(asked)) return { answer: Answer.make({ reason: "yapd here and on the client don't match. Update both." }), changed: false }
    const { name, user, key, zone } = asked.value
    // yapd here tells the time as its user would, who's where the machines they use are, unless they've said otherwise.
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone
    const zoning = zone !== undefined && zone !== own && !Home.has("TZ")
    if (zoning) Home.set("TZ", zone)
    const store = yield* Store.make(Store.file)
    const kept = yield* store.transaction((database): { readonly row?: Row; readonly changed: boolean } => {
      const had = database.query<Row, [string]>("select name, user, port, key from clients where name = ?").get(name)
      if (had !== null && had.user === user && had.key === key) {
        database.query("update clients set at = ? where name = ?").run(Date.now(), name)
        return { row: had, changed: false }
      }
      const taken = new Set(database.query<{ port: number }, []>("select port from clients").all().map(({ port }) => port))
      const port = had?.port ?? free(taken, listening)
      if (port === undefined) return { changed: false }
      database
        .query("insert into clients (name, user, port, key, at) values (?, ?, ?, ?, ?) on conflict (name) do update set user = excluded.user, key = excluded.key, at = excluded.at")
        .run(name, user, port, key, Date.now())
      return { row: { name, user, port, key }, changed: true }
    })
    if (kept.row === undefined) return { answer: Answer.make({ reason: "There's no port left here for another client." }), changed: false }
    yield* pin(kept.row.port, key)
    const path = socket(name)
    yield* Effect.tryPromise(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await rm(path, { force: true })
    })
    return {
      answer: Answer.make({ socket: path, server: yield* Config.port, keys: yield* ownKeys, zone: zoning ? zone : own }),
      changed: kept.changed || zoning,
    }
  }).pipe(Effect.scoped)

/** Runs `yapd join` and prints its answer, then restarts yapd here if it has a client to follow now. */
export const serveJoin = (input: string) =>
  Effect.gen(function* () {
    const { answer, changed } = yield* join(input)
    console.log(JSON.stringify(answer))
    if (changed) yield* Service.restart
  })

/**
 * The clients that joined, as `YAPD_REMOTES` entries reaching each through
 * its forwarded port, after those the user set, which win: read as yapd
 * starts, from a database that may not have the table yet.
 */
export const remotes = (set: string, file = Store.file): string => {
  if (!existsSync(file)) return set
  let rows: ReadonlyArray<Pick<Row, "name" | "user" | "port">> = []
  try {
    const database = new Database(file, { readonly: true })
    try {
      rows = database.query<Pick<Row, "name" | "user" | "port">, []>("select name, user, port from clients order by name").all()
    } finally {
      database.close()
    }
  } catch {
    return set
  }
  const named = Remote.parse(set).pipe((parsed) => (parsed._tag === "Right" ? new Set(parsed.right.keys()) : new Set<string>()))
  const joined = rows.filter(({ name }) => !named.has(name)).map(({ name, user, port }) => `${name}=ssh://${user}@127.0.0.1:${port}`)
  return [set.trim(), ...joined].filter((part) => part !== "").join(",")
}

/** The clients that joined, by name and the port here that leads to each. */
export const joined = (file = Store.file): ReadonlyArray<{ readonly name: string; readonly port: number }> => {
  if (!existsSync(file)) return []
  try {
    const database = new Database(file, { readonly: true })
    try {
      return database.query<{ name: string; port: number }, []>("select name, port from clients order by name").all()
    } finally {
      database.close()
    }
  } catch {
    return []
  }
}

/** What's written to a socket that hasn't taken it all yet, or isn't connected yet, written out once it drains, in order. */
const queue = () => {
  let waiting: Array<Uint8Array> = []
  let to: { readonly write: (data: Uint8Array) => number; readonly end: () => void } | undefined
  /** Once what's waiting is out, it's ended, as the other side was. */
  let ending = false
  const flush = () => {
    while (to !== undefined && waiting.length > 0) {
      const next = waiting[0]!
      const written = to.write(next)
      if (written < next.length) {
        waiting[0] = next.subarray(Math.max(0, written))
        return
      }
      waiting.shift()
    }
    if (ending && waiting.length === 0) to?.end()
  }
  return {
    // Copied, since the chunk's memory is the socket's to reuse.
    push: (chunk: Uint8Array) => {
      waiting.push(new Uint8Array(chunk))
      if (waiting.length === 1) flush()
    },
    to: (socket: { readonly write: (data: Uint8Array) => number; readonly end: () => void }) => {
      to = socket
      flush()
    },
    flush,
    end: () => {
      ending = true
      flush()
    },
    clear: () => {
      waiting = []
    },
  }
}

interface Passing {
  readonly up: ReturnType<typeof queue>
  readonly down: ReturnType<typeof queue>
  upstream?: { readonly end: () => void }
  closed: boolean
}

/** Passes what comes in on `port` here on to the socket at `path`, and back, a connection at a time. */
const passOn = (port: number, path: string) =>
  Bun.listen<Passing>({
    hostname: "127.0.0.1",
    port,
    socket: {
      open: (downstream) => {
        const passing: Passing = { up: queue(), down: queue(), closed: false }
        downstream.data = passing
        passing.down.to(downstream)
        Bun.connect({
          unix: path,
          socket: {
            open: (upstream) => {
              if (passing.closed) {
                upstream.end()
                return
              }
              passing.upstream = upstream
              passing.up.to(upstream)
            },
            data: (_, chunk) => passing.down.push(chunk),
            drain: () => passing.up.flush(),
            close: () => passing.down.end(),
            error: () => passing.down.end(),
          },
        }).catch(() => downstream.end())
      },
      data: (downstream, chunk) => downstream.data.up.push(chunk),
      drain: (downstream) => downstream.data.down.flush(),
      close: (downstream) => {
        downstream.data.closed = true
        downstream.data.up.clear()
        downstream.data.upstream?.end()
      },
    },
  })

/**
 * Passes what comes in on each client's port here on to the socket its
 * connection forwards to its SSH, for as long as the scope lasts. While the
 * client is away there's no socket, and SSH from here finds it out of reach.
 */
export const forward = (clients: ReadonlyArray<{ readonly name: string; readonly port: number }>) =>
  Effect.forEach(
    clients,
    ({ name, port }) =>
      Effect.acquireRelease(Effect.try(() => passOn(port, socket(name))), (listener) => Effect.sync(() => listener.stop(true))).pipe(
        Effect.tapError((cause) => Effect.logWarning(`Can't reach ${name} from here: port ${port} is taken`, cause)),
        Effect.option,
      ),
    { discard: true },
  )

/** This machine's name on the tailnet, as Tailscale's MagicDNS has it, or its address there. */
const tailnetName = Effect.gen(function* () {
  const cli = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((path) => Bun.which(path) !== null || existsSync(path))
  const named = cli === undefined
    ? Option.none<string>()
    : yield* run([cli, "status", "--json"]).pipe(
        Effect.map((said) => {
          const name = (JSON.parse(said) as { readonly Self?: { readonly DNSName?: string } }).Self?.DNSName
          return Option.fromNullable(name?.replace(/\.$/, "") || undefined)
        }),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
  if (Option.isSome(named)) return named
  return Option.fromNullable(Server.tailnet().find((address) => !address.includes(":")))
})

/** A token, as long and as random as a key. */
const fresh = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

/**
 * `yapd pair`: the address and token a phone reaches yapd here with, over the
 * tailnet, as a link it opens and a QR code to scan. The first time, or with
 * `again`, it makes a new token, which turns away the one before, and has yapd
 * restarted to listen on the tailnet with it.
 */
export const pair = (again: boolean) =>
  Effect.gen(function* () {
    const name = yield* tailnetName
    const address = Server.tailnet().find((address) => !address.includes(":"))
    if (Option.isNone(name) || address === undefined) {
      return yield* Console.error("This machine isn't on a tailnet that I can see. Start Tailscale, then run yapd pair again.")
    }
    const settings = yield* Settings.make(Store.file)
    const had = again ? Option.none<string>() : yield* settings.read("token")
    const token = Option.getOrElse(had, fresh)
    if (Option.isNone(had)) yield* settings.write("token", token)
    const port = yield* Config.port
    const server = `http://${name.value}:${port}`
    const link = `yapd://pair?${new URLSearchParams({ server, token })}`
    yield* Console.log(`On your phone, with Tailscale on, scan this or open the link:\n\n${link}\n`)
    const code = yield* run(["qrencode", "-t", "ansiutf8", link]).pipe(Effect.option)
    if (Option.isSome(code)) yield* Console.log(code.value)
    yield* Console.log(`Or type it in: the server is ${server} and the token is ${token}`)
    // Restarted to take the token in, unless yapd already answers on the tailnet to it.
    const answers = yield* Effect.promise(() =>
      fetch(`http://${address}:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) }).then(
        (response) => response.ok,
        () => false,
      ),
    )
    if (!answers) {
      yield* Service.restart
      yield* Console.log(again ? "That token replaces the one before." : "yapd now listens on your tailnet, for what bears that token.")
    }
  }).pipe(Effect.scoped)
