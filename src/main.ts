#!/usr/bin/env bun
import { Cause, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { dirname, join } from "node:path"
import { DeviceAudio } from "./Audio.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as Codex from "./Codex.ts"
import { ProviderCondenser } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Daemon from "./Daemon.ts"
import { hook } from "./Hook.ts"
import { ProviderModel } from "./Model.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"
import { ProviderResponder } from "./Responder.ts"
import * as Server from "./Server.ts"
import * as Service from "./Service.ts"
import * as T3Code from "./T3Code.ts"
import { WhisperTranscriber } from "./Transcriber.ts"
import { SileroVad } from "./Vad.ts"
import { KokoroVoice } from "./Voice.ts"

/**
 * T3 Code first, since it only claims threads it can find, and its sessions
 * must go through it. Then each agent's own way in, whatever it runs in. A
 * waiting Claude Code hook holds its connection wherever it runs, but other
 * machines' T3 Code and Codex are only reachable from there.
 */
const Relays = Layer.effect(
  Relay.Relays,
  Effect.gen(function* () {
    const remotes = yield* Config.remotes
    const here = Remote.here(remotes)
    return Relay.make([here(yield* T3Code.relay), yield* ClaudeCode.relay, Remote.relay(remotes), here(Codex.relay)])
  }),
)

/** What `yapd relay` sends through, on the machine the session runs on. */
const relay = Effect.gen(function* () {
  // SSH runs it from the home directory, where Bun won't find the yapd folder's .env.
  const env = Bun.file(join(dirname(import.meta.dir), ".env"))
  if (yield* Effect.promise(() => env.exists())) {
    const variables = Remote.dotenv(yield* Effect.promise(() => env.text()))
    for (const [name, value] of Object.entries(variables)) process.env[name] ??= value
  }
  const relays = Relay.make([yield* T3Code.relay, Codex.relay])
  const input = yield* Effect.promise(() => Bun.stdin.text())
  console.log(yield* Remote.serve(relays, input))
})

const serve = Effect.gen(function* () {
  const daemon = yield* Daemon.make
  yield* Server.serve(yield* Config.port, daemon.handle)
  return yield* daemon.speak
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Layer.mergeAll(ProviderCondenser, ProviderResponder).pipe(Layer.provide(ProviderModel)),
      KokoroVoice,
      DeviceAudio,
      SileroVad,
      WhisperTranscriber,
      Relays,
    ).pipe(Layer.provideMerge(ClaudeCode.WaitingLive)),
  ),
  // Outermost, so layers log through it too.
  Effect.provide(Logger.pretty),
)

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

if ((command === "serve" || command === "install" || command === "uninstall") && process.platform !== "darwin") {
  console.error("yapd only speaks on macOS. Here it runs hooks and relays follow-ups, which need no service.")
  process.exit(1)
} else if (command === "serve") {
  runMain(serve)
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
  runMain(relay)
} else {
  console.error("usage: yapd serve | yapd install | yapd uninstall | yapd hook <claude|codex> [--wait] | yapd relay")
  // Not 2: Claude Code treats exit code 2 from a Stop hook as "keep going".
  process.exit(1)
}
