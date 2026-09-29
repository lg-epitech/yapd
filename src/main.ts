#!/usr/bin/env bun
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { realpathSync } from "node:fs"
import { hostname } from "node:os"
import { dirname } from "node:path"
import * as CliLauncher from "./CliLauncher.ts"
import * as Codex from "./Codex.ts"
import * as Config from "./Config.ts"
import { hook } from "./Hook.ts"
import * as Launcher from "./Launcher.ts"
import * as Machines from "./Machines.ts"
import * as Minder from "./Minder.ts"
import { researcher } from "./Model.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"
import * as Research from "./Research.ts"
import * as Service from "./Service.ts"
import * as T3Code from "./T3Code.ts"

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
    console.log(yield* Launcher.serve(yield* launcher(machine), input))
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

const mac = process.platform === "darwin"
// Intel Macs could run it before, so they can still remove the service.
if ((command === "serve" || command === "install" || (command === "uninstall" && !mac)) && !(mac && process.arch === "arm64")) {
  console.error(
    `yapd only speaks on Macs with Apple silicon. Here it runs hooks and relays follow-ups, which need no service.${
      mac ? " To remove one installed before, run `bun src/main.ts uninstall`." : ""
    }`,
  )
  process.exit(1)
} else if (command === "serve") {
  runMain(Effect.flatMap(Effect.promise(() => import("./Serve.ts")), ({ serve }) => serve))
} else if (command === "install") {
  runMain(Service.install)
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
  // Bun reads .env from where it starts, which for the daemon is the yapd folder, but SSH starts in the home directory.
  const folder = realpathSync(dirname(import.meta.dir))
  if (realpathSync(process.cwd()) !== folder) {
    const child = Bun.spawnSync([process.execPath, import.meta.path, ...process.argv.slice(2)], { cwd: folder, stdio: ["inherit", "inherit", "inherit"] })
    process.exit(child.exitCode ?? 1)
  }
  runMain(command === "relay" ? relay : command === "start" ? start(argument) : command === "catalog" ? catalog(argument) : research)
} else {
  console.error("usage: yapd serve | yapd install | yapd uninstall | yapd hook <claude|codex> [--wait] | yapd relay | yapd start [machine] | yapd catalog [machine] | yapd research")
  // Not 2: Claude Code treats exit code 2 from a Stop hook as "keep going".
  process.exit(1)
}
