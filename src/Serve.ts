import { Effect, Layer, Logger, Stream } from "effect"
import { hostname } from "node:os"
import { Activity, DeviceAudio } from "./Audio.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as CliLauncher from "./CliLauncher.ts"
import * as Codex from "./Codex.ts"
import { ProviderCondenser } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Daemon from "./Daemon.ts"
import { Dictation, WhisperDictation } from "./Dictation.ts"
import * as Drafts from "./Drafts.ts"
import * as Floor from "./Floor.ts"
import * as Journal from "./Journal.ts"
import { machines } from "./Machines.ts"
import { ProviderModel } from "./Model.ts"
import * as Persona from "./Persona.ts"
import * as Preferences from "./Preferences.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"
import { ProviderResponder } from "./Responder.ts"
import * as Server from "./Server.ts"
import * as Settings from "./Settings.ts"
import * as Store from "./Store.ts"
import { Shortcut } from "./Shortcut.ts"
import * as T3Code from "./T3Code.ts"
import { Vocabulary, WhisperTranscriber } from "./Transcriber.ts"
import { SileroVad } from "./Vad.ts"
import { KokoroVoice } from "./Voice.ts"
import { ProviderWriter } from "./Writer.ts"

// `yapd serve`, apart from the other commands, since only the daemon needs the
// models and the native onnxruntime they bring, which hooks would load on every turn.

/**
 * T3 Code first, since it only claims threads it can find, and its sessions
 * must go through it. Then each agent's own way in, whatever it runs in. A
 * waiting Claude Code hook holds its connection wherever it runs, but other
 * machines' T3 Code and Codex are only reachable from there. The sessions yapd
 * started itself come last, as what's left when nothing has them open.
 */
const Relays = Layer.effect(
  Relay.Relays,
  Effect.gen(function* () {
    const remotes = yield* Config.remotes
    const here = Remote.here(hostname)
    return Relay.make([
      here(yield* T3Code.relay),
      yield* ClaudeCode.relay,
      Remote.relay(remotes, hostname),
      here(Codex.relay),
      here(CliLauncher.relay()),
    ])
  }),
)

export const serve = Effect.gen(function* () {
  const daemon = yield* Daemon.make
  const preferences = yield* Preferences.path
  const drafts = yield* Drafts.make({
    machines: yield* machines,
    rules: Preferences.load(preferences),
    recent: daemon.recent,
    note: daemon.note,
    tell: daemon.tell,
    expect: (yield* Vocabulary).expect,
  })
  yield* Effect.logInfo(`Your rules for new work go in ${preferences}`)
  const shortcut = yield* Shortcut
  const dictation = yield* Dictation
  const settings = yield* Settings.Settings

  /**
   * Off, whatever hasn't started yet is dropped, from a dictation to what was
   * waiting to be said. The keys go before the dictations, so none starts in
   * between, and all of it before the daemon waits on anything.
   */
  const turn = (on: boolean) =>
    on
      ? Effect.zipRight(daemon.turn(true), shortcut.toggle(true))
      : Effect.all([shortcut.toggle(false), dictation.drop, drafts.drop, daemon.turn(false)], { discard: true })
  const switching = yield* Effect.makeSemaphore(1)
  // The shortcut waits for this, so nothing is dictated before yapd knows it's on.
  if (yield* settings.on) yield* turn(true)
  else {
    yield* turn(false)
    yield* Effect.logInfo("yapd is off, until it's turned on from the menu bar or the API")
  }

  const state = Stream.zipLatestWith(daemon.state, (yield* Activity).changes, (state, activity): Server.State => ({
    on: state.on,
    activity,
    updates: state.heard.map(({ id, update }) => ({
      id,
      project: update.project,
      text: update.spoken,
      at: new Date(update.at).toISOString(),
    })),
  }))
  yield* Server.serve(yield* Config.port, {
    handle: daemon.handle,
    state,
    // One at a time, so what's remembered is what's in effect.
    turn: (on) => Effect.zipRight(settings.remember(on), turn(on)).pipe(switching.withPermits(1)),
    replay: daemon.replay,
  })
  // Asked as the user starts talking, so it's there by the time they've finished.
  yield* Effect.forkScoped(Stream.runForEach(shortcut.events, (event) => (event._tag === "Started" ? drafts.prepare : Effect.void)))
  yield* Effect.forkScoped(Stream.runForEach(dictation.transcripts, drafts.dictated))
  return yield* daemon.speak
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Layer.mergeAll(ProviderCondenser, ProviderResponder, ProviderWriter).pipe(
        Layer.provideMerge(Persona.layer),
        Layer.provide(ProviderModel),
      ),
      WhisperDictation,
      Relays,
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(KokoroVoice, DeviceAudio, SileroVad, WhisperTranscriber, Floor.layer, Settings.layer, Journal.layer),
      ),
      Layer.provideMerge(Layer.mergeAll(ClaudeCode.WaitingLive, Store.layer)),
    ),
  ),
  // Outermost, so layers log through it too.
  Effect.provide(Logger.pretty),
)
