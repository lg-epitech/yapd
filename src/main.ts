#!/usr/bin/env -S bun --no-env-file
import { Cause, Console, Effect, Exit, Fiber, Option } from "effect"
import { existsSync, realpathSync } from "node:fs"
import { hostname } from "node:os"
import { dirname } from "node:path"
import * as CliLauncher from "./CliLauncher.ts"
import * as Codex from "./Codex.ts"
import * as Config from "./Config.ts"
import * as Home from "./Home.ts"
import { hook } from "./Hook.ts"
import * as Launcher from "./Launcher.ts"
import * as Machines from "./Machines.ts"
import * as Minder from "./Minder.ts"
import { researcher } from "./Model.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"
import * as Research from "./Research.ts"
import * as Service from "./Service.ts"
import * as Setup from "./Setup.ts"
import * as T3Code from "./T3Code.ts"
import * as Tunnel from "./Tunnel.ts"

/**
 * What `yapd relay` sends through, on the machine the session runs on. The
 * sessions yapd started itself come last, as what's left when nothing has
 * them open.
 */
const relay = Effect.gen(function* () {
  const relays = Relay.make([yield* T3Code.relay, Codex.relay, CliLauncher.relay()])
  const input = yield* Effect.promise(() => Bun.stdin.text())
  console.log(yield* Remote.serve(relays, input))
})

/** What starts agents, here or on the machine that's named, by its hostname or by what the user calls it. */
const launcher = (machine: string | undefined) =>
  Effect.gen(function* () {
    const own = yield* Machines.own
    // Over SSH no machine is named, so a machine without remotes of its own never has to read them.
    if (machine === undefined) return own
    return Remote.launchers(yield* Config.remotes, hostname, own, undefined, Option.getOrUndefined(yield* Config.name))(machine)
  })

const start = (machine: string | undefined) =>
  Effect.gen(function* () {
    const input = yield* Effect.promise(() => Bun.stdin.text())
    // On stderr, which comes back over SSH with SSH's own, even when the connection drops before the answer does.
    console.log(yield* Launcher.serve(yield* launcher(machine), input, Console.error(Launcher.asking)))
  })

const catalog = (machine: string | undefined) =>
  Effect.gen(function* () {
    console.log(yield* Launcher.list(yield* launcher(machine)))
  })

/** What `yapd research` reads through a project with, on the machine the project is on. */
const research = Effect.gen(function* () {
  const input = yield* Effect.promise(() => Bun.stdin.text())
  console.log(yield* Research.serve(yield* researcher, input))
})

/** What `yapd t3` tells the machine that speaks, which reaches this one's T3 Code through an SSH tunnel. */
const t3 = Effect.gen(function* () {
  console.log(yield* Tunnel.serve(yield* Config.t3codeToken))
})

const runMain = (effect: Effect.Effect<void, unknown>) => {
  const fiber = Effect.runFork(effect)
  const interrupt = () => Effect.runFork(Fiber.interrupt(fiber))
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  fiber.addObserver((exit) => {
    if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
      console.error(Cause.pretty(exit.cause))
      process.exit(1)
    }
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0)
  })
}

const [command, argument] = process.argv.slice(2)

/** Commands that read the user's settings. Hooks don't, and start wherever the agent runs. */
const settled = ["serve", "setup", "doctor", "install", "uninstall", "relay", "start", "catalog", "research", "mind", "t3"]

/** The environment a bun started with `env` in this folder ends up with, .env files and all. */
const probe = (env: Record<string, string | undefined>): Record<string, string | undefined> =>
  JSON.parse(Bun.spawnSync([process.execPath, "--print", "JSON.stringify(process.env)"], { env }).stdout.toString())

/**
 * What Bun set from .env files in the folder this started in. First which
 * names they set, then what they set them to with everything else as it was,
 * since a value can be built from other variables.
 */
const dotenv = (): Record<string, string | undefined> => {
  if (![".env", ".env.local", ".env.development", ".env.production", ".env.test"].some((name) => existsSync(name))) return {}
  try {
    // NODE_ENV picks the files, so they're read as the caller had it, unless it came from them too.
    const unseeded = probe({})
    const exported = process.env.NODE_ENV !== undefined && unseeded.NODE_ENV !== process.env.NODE_ENV
    const names = Object.keys(exported ? probe({ NODE_ENV: process.env.NODE_ENV }) : unseeded).filter(
      (name) => !(exported && name === "NODE_ENV"),
    )
    const set = probe(Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name))))
    return Object.fromEntries(names.map((name) => [name, set[name]]))
  } catch {
    return {}
  }
}

// Bun reads .env from the folder it starts in, so these run in yapd's home, wherever they were started from: the
// yapd folder, the home directory an SSH command starts in, or anywhere else. As `yapd`, Bun reads none there. Run
// as `bun main.ts`, what it read is left behind, since the restart would keep it ahead of yapd's settings. A value
// the caller set to something else is theirs, and kept. YAPD_HOME is passed on as it was resolved, even from
// there, so it doesn't resolve again from inside itself.
if (command !== undefined && settled.includes(command)) {
  Home.adopt(dirname(import.meta.dir))
  // As `yapd`, even from its home, since Bun was told to read no .env at all, and then there's nothing to leave behind.
  const unread = process.execArgv.includes("--no-env-file")
  if (unread || realpathSync(process.cwd()) !== realpathSync(Home.home)) {
    const loaded = unread ? {} : dotenv()
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => !(name in loaded) || loaded[name] !== value))
    if (process.env.YAPD_HOME !== undefined) env.YAPD_HOME = Home.home
    const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
      cwd: Home.home,
      env,
      stdio: ["inherit", "inherit", "inherit"],
    })
    // Passed on, so stopping this stops the daemon, rather than leave it holding the port.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal))
    process.exit(await child.exited)
  }
}

/** Says what's wrong, and exits with 1 when anything is broken. */
const doctor = Effect.gen(function* () {
  // Apart from the other commands, since it reads the models' modules, which hooks shouldn't load.
  const Doctor = yield* Effect.promise(() => import("./Doctor.ts"))
  if (yield* Doctor.doctor(Service.bun(), Service.main)) process.exitCode = 1
})

const mac = process.platform === "darwin"
// Intel Macs could run it before, so they can still remove the service.
if ((command === "serve" || command === "install" || (command === "uninstall" && !mac)) && !(mac && process.arch === "arm64")) {
  console.error(
    `yapd only speaks on Macs with Apple silicon. Here it runs hooks and relays follow-ups, which need no service.${
      mac ? " To remove one installed before, run `yapd uninstall`." : ""
    }`,
  )
  process.exit(1)
} else if (command === "serve") {
  runMain(Effect.flatMap(Effect.promise(() => import("./Serve.ts")), ({ serve }) => serve))
} else if (command === "setup") {
  runMain(
    Effect.gen(function* () {
      yield* Setup.setup(Service.bun(), Service.main)
      if (mac && process.arch === "arm64") yield* Service.install
      else yield* Console.log("Here yapd runs hooks and relays follow-ups. It speaks on a Mac with Apple silicon, where setup also starts it.")
      yield* doctor
    }),
  )
} else if (command === "doctor") {
  runMain(doctor)
} else if (command === "install") {
  // The hooks too, since they carry settings like the port.
  runMain(Effect.zipRight(Setup.refresh(Service.bun(), Service.main), Service.install))
} else if (command === "uninstall") {
  runMain(Service.uninstall)
} else if (command === "hook" && (argument === "claude" || argument === "codex")) {
  runMain(
    hook(argument, process.argv.includes("--wait")).pipe(
      Effect.map((code) => {
        process.exitCode = code
      }),
    ),
  )
} else if (command === "mind" && argument !== undefined) {
  // Not for the user to run: it's how a session yapd started is kept an eye on.
  runMain(Minder.mind(argument))
} else if (command === "relay" || command === "start" || command === "catalog" || command === "research") {
  runMain(command === "relay" ? relay : command === "start" ? start(argument) : command === "catalog" ? catalog(argument) : research)
} else if (command === "t3") {
  runMain(t3)
} else {
  console.error("usage: yapd setup | yapd doctor | yapd serve | yapd install | yapd uninstall | yapd hook <claude|codex> [--wait] | yapd relay | yapd start [machine] | yapd catalog [machine] | yapd research | yapd t3")
  // Not 2: Claude Code treats exit code 2 from a Stop hook as "keep going".
  process.exit(1)
}
