#!/usr/bin/env bun
import { Cause, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { ProviderCondenser } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Daemon from "./Daemon.ts"
import { hook } from "./Hook.ts"
import * as Server from "./Server.ts"
import { KokoroVoice } from "./Voice.ts"

const serve = Effect.gen(function* () {
  const daemon = yield* Daemon.make
  yield* Server.serve(yield* Config.port, daemon.handle)
  return yield* daemon.speak
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(ProviderCondenser, KokoroVoice)),
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
    process.exit(0)
  })
}

const [command, argument] = process.argv.slice(2)

if (command === "serve") {
  runMain(serve)
} else if (command === "hook" && (argument === "claude" || argument === "codex")) {
  runMain(hook(argument))
} else {
  console.error("usage: yapd serve | yapd hook <claude|codex>")
  // Not 2: Claude Code treats exit code 2 from a Stop hook as "keep going".
  process.exit(1)
}
