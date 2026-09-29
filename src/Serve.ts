import { Effect, Layer, Logger } from "effect"
import { hostname } from "node:os"
import { DeviceAudio } from "./Audio.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as Codex from "./Codex.ts"
import { ProviderCondenser } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Daemon from "./Daemon.ts"
import { ProviderModel } from "./Model.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"
import { ProviderResponder } from "./Responder.ts"
import * as Server from "./Server.ts"
import * as T3Code from "./T3Code.ts"
import { WhisperTranscriber } from "./Transcriber.ts"
import { SileroVad } from "./Vad.ts"
import { KokoroVoice } from "./Voice.ts"

// `yapd serve`, apart from the other commands, since only the daemon needs the
// models and the native onnxruntime they bring, which hooks would load on every turn.

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
    const here = Remote.here(hostname)
    return Relay.make([here(yield* T3Code.relay), yield* ClaudeCode.relay, Remote.relay(remotes, hostname), here(Codex.relay)])
  }),
)

export const serve = Effect.gen(function* () {
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
