import { Deferred, Duration, Effect, Either, Exit, Option, Redacted, Schema } from "effect"
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

/** Kills a process here by its pid, for a connection that doesn't exit when asked. */
const kill = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // It may have exited since.
    }
  })

/** The connection's process here, as `ssh -O check` gives it. Never 0 or 1, which would be yapd's own group, or launchd. */
const pidOf = (said: string) => {
  const pid = Number(/Master running \(pid=(\d+)\)/.exec(said)?.[1])
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}

/**
 * A port nothing listens on here right now. Something else could take it
 * before SSH does, and then forwarding fails and is tried again.
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

/** A port here forwarded to one on the machine, through the connection. */
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
 * connecting again when it drops. `folder` holds the connection's socket, and
 * `end` kills a process here.
 */
export const forward = (
  host: string,
  destination: string,
  exec: Remote.Exec = shell,
  free = unused,
  folder = Home.home,
  end: (pid: number) => Effect.Effect<void> = kill,
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
      Effect.interruptible(exec(["ssh", "-S", socket, ...args, "--", destination], "")).pipe(
        Effect.mapError((cause) => trouble(unreachable, cause)),
        Effect.timeoutFail({ duration: "5 seconds", onTimeout: () => trouble(unreachable) }),
      )

    /** Whether the connection is known to be open. */
    let open = false
    /** Its process here, as SSH last said, to kill it by should it not exit when asked. */
    let pid: number | undefined
    let forwarded: Forward | undefined
    /** Forwards the connection may still have that lead nowhere, to cancel before opening another. */
    const stale: Array<Forward> = []
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
     * open a second connection and leave the first running, with its forwards,
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

    /** Forgets the connection that's gone, and the forwards that went with it. */
    const forget = () => {
      open = false
      pid = undefined
      forwarded = undefined
      stale.length = 0
    }

    /**
     * Closes the connection, and its forwards with it. One that doesn't exit
     * when asked, before long, like one that hangs, is killed by its process
     * instead, and the socket it leaves then removed, so it can neither hold up
     * yapd stopping nor leave a forward listening. Fails when it may still be
     * there and its process isn't known, keeping its socket for SSH to find it
     * by again.
     */
    const close = Effect.gen(function* () {
      const exited = yield* Effect.either(control("-O", "exit"))
      if (Either.isLeft(exited) && !missing(exited.left)) {
        if (pid === undefined) return yield* exited.left
        yield* end(pid)
      }
      forget()
      yield* Effect.ignore(Effect.tryPromise(() => rm(socket, { force: true })))
    })

    /** Fails, with the reason to say, once SSH says the connection is gone. When it can't say, it's asked again next time. */
    const still = Effect.gen(function* () {
      if ((yield* Effect.orElseSucceed(check, () => "open" as const)) === "open") return
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
      // When SSH can't say whether one is there, it's asked again on the next try, rather than one opened beside it.
      if ((yield* check) === "open") yield* close
      forget()
      // A socket left by a connection that's gone would keep the new one from listening.
      yield* Effect.ignore(Effect.tryPromise(() => rm(socket, { force: true })))
      yield* exec(
        [
          "ssh", "-M", "-S", socket,
          "-o", "ControlPersist=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
          "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
          "-N", "--", destination,
        ],
        "",
      ).pipe(
        Effect.mapError((cause) => trouble(unreachable, cause)),
        Effect.timeoutFail({ duration: "20 seconds", onTimeout: () => trouble(unreachable) }),
      )
      open = true
      // For its process. When SSH can't say yet, the next check on it does.
      yield* Effect.ignore(check)
    })

    /**
     * Forwards a free port here to `remote` there, in place of the forward
     * there was. Each forward is kept track of from the moment SSH is asked to
     * open it until cancelling it has been tried, so whatever asked being
     * interrupted can't leave one listening that nothing will cancel, or have
     * the next try open another beside it. Those to cancel go before another
     * is opened: one that may never have opened has a port the new one could
     * get, and cancelling it after would close the new one.
     */
    const reforward = (remote: number) =>
      Effect.gen(function* () {
        // T3 Code there moved to another port: the forward there was leads nowhere.
        if (forwarded !== undefined) stale.push(forwarded)
        forwarded = undefined
        for (let old = stale[0]; old !== undefined; old = stale[0]) {
          yield* Effect.ignore(control("-O", "cancel", "-L", spec(old)))
          stale.shift()
        }
        const fresh = { local: yield* free, remote }
        // When asking fails or is cut short, SSH may have opened it all the same.
        yield* Effect.onExit(control("-O", "forward", "-L", spec(fresh)), (exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) forwarded = fresh
            else stale.push(fresh)
          }),
        )
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
      const { local } = forwarded?.remote === remote ? forwarded : yield* reforward(remote)
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
        const kept = Effect.suspend(() => (open ? Effect.orElse(still, () => connect) : connect))
        const once = Effect.zipRight(kept, look).pipe(Effect.catchAllDefect((defect) => Effect.fail(trouble(unreachable, defect))))
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
