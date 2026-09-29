#!/usr/bin/env bun
import { Cause, Effect, Exit, Fiber } from "effect"
import { realpathSync } from "node:fs"
import { dirname } from "node:path"
import * as Codex from "./Codex.ts"
import { hook } from "./Hook.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"
import * as Service from "./Service.ts"
import * as T3Code from "./T3Code.ts"

/** What `yapd relay` sends through, on the machine the session runs on. */
const relay = Effect.gen(function* () {
  const relays = Relay.make([yield* T3Code.relay, Codex.relay])
  const input = yield* Effect.promise(() => Bun.stdin.text())
  console.log(yield* Remote.serve(relays, input))
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

if ((command === "serve" || command === "install" || command === "uninstall") && !(process.platform === "darwin" && process.arch === "arm64")) {
  console.error("yapd only speaks on Macs with Apple silicon. Here it runs hooks and relays follow-ups, which need no service.")
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
} else if (command === "relay") {
  // Bun reads .env from where it starts, which for the daemon is the yapd folder, but SSH starts in the home directory.
  const folder = realpathSync(dirname(import.meta.dir))
  if (realpathSync(process.cwd()) !== folder) {
    const child = Bun.spawnSync([process.execPath, import.meta.path, "relay"], { cwd: folder, stdio: ["inherit", "inherit", "inherit"] })
    process.exit(child.exitCode ?? 1)
  }
  runMain(relay)
} else {
  console.error("usage: yapd serve | yapd install | yapd uninstall | yapd hook <claude|codex> [--wait] | yapd relay")
  // Not 2: Claude Code treats exit code 2 from a Stop hook as "keep going".
  process.exit(1)
}
