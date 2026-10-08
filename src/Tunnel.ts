import { Deferred, Duration, Effect, Either, Fiber, Option, Redacted, Schedule, Schema } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import * as Home from "./Home.ts"
import { ProcessError, run } from "./Process.ts"
import * as Remote from "./Remote.ts"
import * as Server from "./T3CodeServer.ts"

// Another machine's T3 Code, reached as if it ran on this one. T3 Code only
// listens on its own machine, so yapd keeps an SSH connection there open, asks
// `yapd t3` there where its T3 Code listens and for the token yapd uses with
// it, and forwards a port on this machine to it. Then reading and acting on
// that machine's threads takes about what it does here, instead of an SSH login
// each time. The port only listens on 127.0.0.1, like T3 Code itself, so
// nothing is opened to the network.
//
// The token is only ever kept in memory, as a Redacted, and never logged. An
// answer that doesn't decode is dropped rather than kept as the cause, since
// decoding errors quote what they found, which can be the token.

/** What `yapd t3` answers: where T3 Code listens on that machine and yapd's token for it, or why there's none. */
export const Answer = Schema.Struct({
  origin: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

/** What `yapd t3` says when T3 Code isn't running there. */
const stopped = "T3 Code isn't running."

/** What `yapd t3` says when yapd has no token for T3 Code there. */
const tokenless = "yapd has no T3 Code token here."

/** `yapd t3`: prints where this machine's T3 Code listens and yapd's token for it, for a machine that reaches it over SSH. */
export const serve = (token: Option.Option<Redacted.Redacted>, locate: Effect.Effect<Server.Server, Server.Trouble> = Server.locate) =>
  Option.match(token, {
    onNone: () => Effect.succeed(Answer.make({ reason: tokenless })),
    onSome: (token) =>
      locate.pipe(
        Effect.map(({ origin }) => Answer.make({ origin, token: Redacted.value(token) })),
        Effect.orElseSucceed(() => Answer.make({ reason: stopped })),
      ),
  }).pipe(Effect.map((answer) => JSON.stringify(answer)))

/** Where a machine's T3 Code answers from here, and the token for it. */
export interface Located {
  readonly server: Server.Server
  readonly token: Redacted.Redacted
}

/** What T3 Code is reached through, from wherever `locate` finds it, as T3Actions takes it. */
export const transport = (locate: Effect.Effect<Located, Server.Trouble>): Effect.Effect<Server.Transport, Server.Trouble> =>
  Effect.map(locate, ({ server, token }) => ({ api: Server.api(server, token), call: Server.call(server, token) }))

/**
 * Whether the machine's T3 Code can be reached now. While it can't, the reason
 * is to be said, and `outage` counts the times it went down, so that's said
 * once each time rather than on every try. It's 0 while yapd has just started
 * and is still connecting, which isn't an outage.
 */
export type Status = { readonly _tag: "Up" } | { readonly _tag: "Down"; readonly reason: string; readonly outage: number }

/** Another machine's T3 Code, held open for as long as the scope lasts. */
export interface Tunnel {
  /**
   * Where it answers, as of the last look. Fails at once, with the reason to
   * say, while it can't be reached, and after a second at most while yapd has
   * just started and is still connecting.
   */
  readonly locate: Effect.Effect<Located, Server.Trouble>
  /**
   * Asks the machine again where its T3 Code listens and for the token, for
   * when what `locate` gave stopped working, like after T3 Code restarted there.
   * Right after yapd starts, it waits for the first try however long that
   * takes, which suits what follows T3 Code in the background, not an action.
   */
  readonly refresh: Effect.Effect<Located, Server.Trouble>
  /** Whether it can be reached now, as of the last try. It never waits for one. */
  readonly status: Effect.Effect<Status>
  /** The open connection's socket, for other yapd commands to that machine to go through. */
  readonly master: Remote.Master
}

/**
 * Runs SSH here. Opening the connection leaves it running in the background,
 * and with a ProxyCommand or ProxyJump, the proxy it reaches the machine
 * through stays behind in the group SSH started in, so that's left running too.
 * What the connection answers when told something, SSH says on stderr.
 */
const shell: Remote.Exec = (command, stdin) => run(command, { stdin, leave: command.includes("-M"), both: command.includes("-O") })

/**
 * How the connection is opened. Forwards the user's SSH config sets for the
 * machine are cleared, so the connection only ever carries the one it's given.
 */
export const opening = [
  "-o", "ControlPersist=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-o", "ExitOnForwardFailure=yes", "-o", "ClearAllForwardings=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
]

/** Kills a process here by its pid, for a connection that doesn't exit when asked. */
const kill = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // It may have exited since.
    }
  })

/** Whether a process is still running here. */
const running = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

/** The connection's process here, as `ssh -O check` gives it. Never 0 or 1, which would be yapd's own group, or launchd. */
const pidOf = (said: string) => {
  const pid = Number(/Master running \(pid=(\d+)\)/.exec(said)?.[1])
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}

/**
 * A port nothing listens on here right now. Something else could take it
 * before SSH does, and then forwarding fails and the next try connects afresh.
 */
const unused = Effect.try({
  try: () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } })
    const { port } = listener
    listener.stop(true)
    return port
  },
  catch: (cause) => new Server.Trouble({ reason: "I couldn't find a free port here.", cause }),
})

/** How long to wait before trying again, longer each time it fails in a row. */
const again = (failures: number) => Duration.seconds(Math.min(30, 2 ** Math.max(0, failures - 1)))

/** How often the connection is checked on. SSH gives up on one that's gone quiet after 45 seconds. */
const every = "5 seconds"

/** A port here forwarded to one on the machine, through the connection: the one it has. */
interface Forward {
  readonly local: number
  readonly remote: number
}

/** A forward as `ssh -L` takes it, only ever on 127.0.0.1 at both ends. */
const spec = ({ local, remote }: Forward) => `127.0.0.1:${local}:127.0.0.1:${remote}`

/** The port an `http://` origin listens on. */
const port = (origin: string) => {
  try {
    const url = new URL(origin)
    return url.protocol === "http:" ? Number(url.port || 80) : undefined
  } catch {
    return undefined
  }
}

/**
 * Keeps `host`'s T3 Code reachable through an SSH connection to `destination`,
 * connecting again when it drops. `folder` holds the connection's socket,
 * `end` kills a process here, and `alive` says whether one still runs.
 */
export const forward = (
  host: string,
  destination: string,
  exec: Remote.Exec = shell,
  free = unused,
  folder = Home.home,
  end: (pid: number) => Effect.Effect<void> = kill,
  alive: (pid: number) => Effect.Effect<boolean> = running,
) =>
  Effect.gen(function* () {
    const socket = join(folder, `ssh-${host.toLowerCase().replace(/[^a-z0-9.-]/g, "_")}.sock`)
    const unreachable = `I can't reach ${host} right now.`
    const trouble = (reason: string, cause?: unknown) => new Server.Trouble({ reason, cause })
    /**
     * Tells the open connection what to do, through its socket. SSH can be
     * given up on even where nothing can be interrupted, like when closing the
     * connection as yapd stops: the timeout would wait on it otherwise.
     */
    const control = (...args: ReadonlyArray<string>) =>
      // Without the user's SSH config, which could add a forward of its own to `-O forward`'s.
      Effect.interruptible(exec(["ssh", "-F", "/dev/null", "-S", socket, ...args, "--", destination], "")).pipe(
        Effect.mapError((cause) => trouble(unreachable, cause)),
        Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => trouble(unreachable) }),
      )

    /** Whether the connection is known to be open. */
    let open = false
    /** Its process here, as SSH last said, to kill it by should it not exit when asked. */
    let pid: number | undefined
    let forwarded: Forward | undefined
    let located: Located | undefined
    /** Unset until the first try is over, so starting up isn't taken for an outage. */
    let status: Status | undefined
    let outages = 0
    const first = yield* Deferred.make<void>()
    const lock = yield* Effect.makeSemaphore(1)

    /** Whether SSH failed because nothing listens on the socket, which is how it says the connection is gone. */
    const missing = ({ cause }: Server.Trouble) =>
      cause instanceof ProcessError && /No such file or directory|Connection refused/.test(cause.stderr)

    /**
     * Whether the connection is open or gone, failing when SSH couldn't say,
     * like when it took too long or couldn't start. Only nothing listening on
     * the socket means it's gone. Taking one that's just slow for gone would
     * open a second connection and leave the first running, with its forward,
     * where nothing can reach it or close it. When it's open, SSH says its
     * process, which is kept.
     */
    const check = control("-O", "check").pipe(
      Effect.map((said) => {
        pid = pidOf(said)
        return "open" as const
      }),
      Effect.catchIf(missing, () => Effect.succeed("gone" as const)),
    )

    /** Forgets the connection that's gone, and the forward that went with it. */
    const forget = () => {
      open = false
      pid = undefined
      forwarded = undefined
    }

    /**
     * Closes the connection, and its forward with it. One that doesn't exit
     * when asked, before long, like one that hangs, is killed by its process
     * instead, and the socket it leaves then removed, so it can neither hold up
     * yapd stopping nor leave a forward listening. Fails when it may still be
     * there and its process isn't known, keeping its socket for SSH to find it
     * by again.
     */
    const teardown = Effect.gen(function* () {
      // Whatever comes of it, it isn't used again: what it forwards is in doubt.
      open = false
      // Its own, since what's known of the connection can be forgotten meanwhile, while this one may still be there.
      const leaving = pid
      const exited = yield* Effect.either(control("-O", "exit"))
      if (Either.isLeft(exited) && !missing(exited.left)) {
        if (leaving === undefined) return yield* exited.left
        yield* end(leaving)
      } else if (Either.isRight(exited) && leaving !== undefined) {
        // SSH answers before it's gone, and removes the socket as it goes, which would take the next connection's.
        const gone = yield* alive(leaving).pipe(
          Effect.repeat({ until: (still) => !still, schedule: Schedule.spaced("50 millis") }),
          Effect.timeoutOption("2 seconds"),
          Effect.interruptible,
        )
        if (Option.isNone(gone)) yield* end(leaving)
      }
      forget()
      yield* Effect.ignore(Effect.tryPromise(() => rm(socket, { force: true })))
    })

    /**
     * The close under way. It runs to its end on its own, whoever stops
     * waiting on it, so the connection it retires is never lost track of while
     * it may still be there, and the next connection waits for it. Each of its
     * steps is bounded, so that's never long.
     */
    let closing: Fiber.RuntimeFiber<void, Server.Trouble> | undefined

    const close = Effect.gen(function* () {
      if (closing === undefined || Option.isSome(yield* Fiber.poll(closing))) closing = yield* Effect.forkDaemon(teardown)
      return yield* Fiber.join(closing)
    })

    /** Waits for a close under way, however it ends, before anything is opened in its place. */
    const closed = Effect.suspend(() => (closing === undefined ? Effect.void : Effect.ignore(Fiber.join(closing))))

    /**
     * Fails, with the reason to say, once SSH says the connection is gone, or
     * when it's no longer to be used, like after closing it was cut short.
     * When SSH can't say, it's asked again next time.
     */
    const still = Effect.gen(function* () {
      if (open && (yield* Effect.orElseSucceed(check, () => "open" as const)) === "open") return
      forget()
      return yield* trouble(unreachable)
    })

    /**
     * Opens a fresh connection. Whatever answers on the socket first, like one
     * an earlier yapd left running when it stopped, is closed rather than taken
     * over: what it forwards can't be known. With ControlPersist, SSH goes into
     * the background once it's connected, so opening it is a command that
     * finishes.
     */
    const connect = Effect.gen(function* () {
      yield* closed
      // When SSH can't say whether one is there, it's asked again on the next try, rather than one opened beside it.
      if ((yield* check) === "open") yield* close
      forget()
      // A socket left by a connection that's gone would keep the new one from listening.
      yield* Effect.ignore(Effect.tryPromise(() => rm(socket, { force: true })))
      yield* exec(["ssh", "-M", "-S", socket, ...opening, "-N", "--", destination], "").pipe(
        Effect.mapError((cause) => trouble(unreachable, cause)),
        Effect.timeoutFail({ duration: "20 seconds", onTimeout: () => trouble(unreachable) }),
      )
      open = true
      // For its process. When SSH can't say yet, the next check on it does.
      yield* Effect.ignore(check)
    })

    /**
     * Forwards a free port here to `remote` there: the connection's one
     * forward, never changed or cancelled. When asking fails or is cut short,
     * SSH may have opened it all the same, so rather than keep track of a
     * forward that may be listening, the connection is closed with it, and the
     * next try opens a fresh one: one forward never listens beside another.
     */
    const listen = (remote: number) =>
      Effect.gen(function* () {
        const fresh = { local: yield* free, remote }
        yield* Effect.onError(control("-O", "forward", "-L", spec(fresh)), () => Effect.ignore(close))
        forwarded = fresh
        return fresh
      })

    /** Asks yapd there where its T3 Code listens and for the token, and forwards a port here to it. */
    const look = Effect.gen(function* () {
      const garbled = trouble(`yapd on ${host} answered in a way I don't understand.`)
      const answer = yield* Remote.ask(
        exec,
        host,
        destination,
        "t3",
        "",
        { patience: "15 seconds", silent: "isn't answering.", failed: "couldn't say where its T3 Code is." },
        (reason, cause) => trouble(cause instanceof ProcessError && cause.code === 255 ? unreachable : reason, cause),
        Effect.succeed(Option.some(socket)),
      )
      const decoded = Schema.decodeUnknownEither(Schema.parseJson(Answer))(answer)
      if (Either.isLeft(decoded)) return yield* garbled
      const { origin, token, reason } = decoded.right
      if (reason !== undefined) {
        return yield* trouble(
          reason === stopped ? `${host}'s T3 Code isn't running.` : reason === tokenless ? `yapd on ${host} has no T3 Code token.` : reason,
        )
      }
      const remote = origin === undefined ? undefined : port(origin)
      if (remote === undefined || token === undefined || token === "") return yield* garbled
      // T3 Code there moved to another port. A fresh connection forwards there, and the one there was goes with its forward.
      if (forwarded !== undefined && forwarded.remote !== remote) yield* connect
      const { local } = forwarded ?? (yield* listen(remote))
      located = { server: { origin: `http://127.0.0.1:${local}` }, token: Redacted.make(token) }
      return located
    })

    /** Keeps how it went, and says in the log when that changes: once an outage, rather than on every try. */
    const settle = (effect: Effect.Effect<Located, Server.Trouble>) =>
      effect.pipe(
        Effect.tapBoth({
          onSuccess: (located) =>
            Effect.gen(function* () {
              if (status?._tag !== "Up") yield* Effect.logInfo(`Reaching ${host}'s T3 Code through ${located.server.origin}`)
              status = { _tag: "Up" }
            }),
          onFailure: (error) =>
            Effect.gen(function* () {
              if (status?._tag !== "Down") outages++
              if (status?._tag !== "Down" || status.reason !== error.reason) yield* Effect.logInfo(`${error.reason} I'll keep trying`, error)
              status = { _tag: "Down", reason: error.reason, outage: outages }
            }),
        }),
        Effect.ensuring(Deferred.succeed(first, undefined)),
        lock.withPermits(1),
      )

    /** Until the connection drops, or what's there stops answering as it should. */
    const watch = Effect.gen(function* () {
      while (status?._tag === "Up") {
        yield* Effect.sleep(every)
        const gone = yield* Effect.either(lock.withPermits(1)(still))
        if (Either.isLeft(gone)) yield* Effect.ignore(settle(Effect.fail(gone.left)))
      }
    })

    const loop = Effect.gen(function* () {
      let failures = 0
      while (true) {
        // Whatever goes wrong with one try, the next is made. The connection yapd opened is kept while it's there.
        const once = Effect.zipRight(Effect.orElse(still, () => connect), look).pipe(
          Effect.catchAllDefect((defect) => Effect.fail(trouble(unreachable, defect))),
        )
        const tried = yield* Effect.either(settle(once))
        if (Either.isRight(tried)) {
          failures = 0
          yield* watch
        } else {
          failures++
          yield* Effect.sleep(again(failures))
        }
      }
    })

    // Closed with yapd, rather than left running in the background after it.
    yield* Effect.addFinalizer(() => Effect.ignore(close))
    // A fork takes after where it starts, and opening the tunnel where nothing can be interrupted, like a layer's
    // or acquireRelease's acquisition, would leave closing the scope waiting forever on the loop, and SSH open.
    yield* Effect.forkScoped(Effect.interruptible(loop))

    /** How it stands while yapd has just started and the first try isn't over. */
    const connecting = { _tag: "Down", reason: `I'm still connecting to ${host}.`, outage: 0 } as const
    const reason = () => (status === undefined ? connecting.reason : status._tag === "Down" ? status.reason : unreachable)
    return {
      locate: Effect.gen(function* () {
        // The first try gets a moment, rather than an action failing just before it's done, but no more: it can take a while to give up.
        yield* Effect.ignore(Effect.timeout(Deferred.await(first), "1 second"))
        return status?._tag === "Up" && located !== undefined ? located : yield* trouble(reason())
      }),
      refresh: Effect.gen(function* () {
        yield* Deferred.await(first)
        // Connecting again is the loop's to do, with its backoff.
        if (!open) return yield* trouble(reason())
        // The connection may have gone since it was last checked on, with the forward, while SSH still reaches the machine on its own.
        return yield* settle(Effect.zipRight(still, look))
      }),
      status: Effect.sync((): Status => status ?? connecting),
      master: Effect.sync(() => (open ? Option.some(socket) : Option.none())),
    } satisfies Tunnel
  })
