import { Clock, Effect, Layer, Logger, Option, Schedule, Stream } from "effect"
import { hostname } from "node:os"
import * as Assistant from "./Assistant.ts"
import { Activity, DeviceAudio } from "./Audio.ts"
import { ProviderBrain } from "./Brain.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as CliLauncher from "./CliLauncher.ts"
import * as Codex from "./Codex.ts"
import { ProviderCondenser } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Daemon from "./Daemon.ts"
import { Dictation, WhisperDictation } from "./Dictation.ts"
import * as Drafts from "./Drafts.ts"
import * as Floor from "./Floor.ts"
import * as Hands from "./Hands.ts"
import * as Journal from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
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
import * as T3Actions from "./T3Actions.ts"
import * as T3Code from "./T3Code.ts"
import * as T3CodeServer from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
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

/** How long the journal is kept: a year of it is about forty thousand entries. */
const remembered = 365 * 24 * 60 * 60_000
/** How long what yapd did to threads is kept. */
const done = 90 * 24 * 60 * 60_000
/** How long a restart waits for T3 Code to catch up to look at what never said what came of it, which the next restart looks at otherwise. */
const catchingUp = "15 minutes"

export const serve = Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis
  const daemon = yield* Daemon.make
  const preferences = yield* Preferences.path
  const everywhere = yield* machines
  const journal = yield* Journal.Journal
  const ledger = yield* Ledger.Ledger
  yield* Effect.forkScoped(
    Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.zipRight(journal.prune(now - remembered), ledger.prune(now - done))),
  )
  const token = yield* Config.t3codeToken
  const live = yield* T3Live.T3Live
  const threads = yield* Threads.make({
    // As the machine is called when yapd starts, which is what its threads are known by while it runs.
    machine: everywhere.find(({ here }) => here)?.name ?? hostname(),
    live,
    actions: Option.map(token, (token) => T3Actions.make(T3CodeServer.connect(token))),
    others: everywhere.filter(({ here }) => !here).map(({ name }) => name),
    journal,
    store: yield* Store.Store,
  })
  const drafts = yield* Drafts.make({
    machines: everywhere,
    rules: Preferences.load(preferences),
    recent: daemon.recent,
    expect: (yield* Vocabulary).expect,
    ledger,
    find: (machine, id) => threads.find({ machine, id }),
  })
  yield* Effect.logInfo(`Your rules for new work go in ${preferences}`)
  const hands = Hands.make({ threads, ledger, started })
  const assistant = yield* Assistant.make({
    threads,
    journal,
    drafts,
    hands,
    ledger,
    tell: daemon.tell,
    power: daemon.power,
    lastHeard: daemon.lastHeard,
    coming: daemon.coming,
    awaiting: daemon.awaiting,
    queued: daemon.queued,
  })
  // Once T3 Code has caught up, what never said what came of it before the restart is looked for, and never sent: what didn't get there is offered.
  yield* Effect.forkScoped(
    live.view.pipe(
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: Option.isSome }),
      Effect.timeoutFail({ duration: catchingUp, onTimeout: () => "T3 Code didn't catch up in time" }),
      Effect.zipRight(hands.reconcile),
      Effect.flatMap(({ undelivered, unconfirmed }) => Effect.zipRight(assistant.unconfirmed(unconfirmed), assistant.undelivered(undelivered))),
      Effect.catchAll((reason) => Effect.logInfo(`Not looking for what I sent before restarting: ${reason}`)),
    ),
  )
  const shortcut = yield* Shortcut
  const dictation = yield* Dictation
  const settings = yield* Settings.Settings

  /**
   * Off, whatever hasn't started yet is dropped, from a dictation to what was
   * waiting to be said. The keys go before the dictations, so none starts in
   * between, and all of it before the daemon waits on anything. On, what a
   * restart found while it was off is said.
   */
  const turn = (on: boolean) =>
    on
      ? Effect.all([daemon.turn(true), shortcut.toggle(true), assistant.back], { discard: true })
      : Effect.all([shortcut.toggle(false), dictation.drop, assistant.drop, daemon.turn(false)], { discard: true })
  const switching = yield* Effect.makeSemaphore(1)
  // The shortcut waits for this, so nothing is dictated before yapd knows it's on.
  if (yield* settings.on) yield* turn(true)
  else {
    yield* turn(false)
    yield* Effect.logInfo("yapd is off, until it's turned on from the menu bar or the API")
  }

  /** What the user said to yapd, as heard now, while it's on. */
  const heard = (text: string, via: Assistant.Utterance["via"], voiced: number) =>
    Effect.gen(function* () {
      const power = yield* daemon.power
      if (!power.on) return Option.none<string>()
      const at = yield* Clock.currentTimeMillis
      return Option.some(yield* assistant.heard({ heard: text, via, at, voiced, turns: power.turns }))
    })

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
    turn: (on) =>
      Effect.zipRight(settings.remember(on), turn(on)).pipe(
        Effect.zipRight(Effect.flatMap(Clock.currentTimeMillis, (at) => journal.write({ at, kind: "action", detail: { on } }))),
        switching.withPermits(1),
      ),
    replay: daemon.replay,
    // Typed words were never faint, so nothing typed is taken for Whisper hearing words in silence.
    utter: (text) => heard(text, "typed", Number.POSITIVE_INFINITY),
  })
  // Asked as the user starts talking, so it's there by the time they've finished.
  yield* Effect.forkScoped(Stream.runForEach(shortcut.events, (event) => (event._tag === "Started" ? assistant.prepare : Effect.void)))
  yield* Effect.forkScoped(
    Stream.runForEach(dictation.transcripts, ({ heard: text, voiced }) => (text === "" ? assistant.nothing : heard(text, "shortcut", voiced))),
  )
  // Whatever he says over an update takes the place of a question yapd asked before.
  yield* Effect.forkScoped(Stream.runForEach(daemon.replies, () => assistant.replied))
  return yield* daemon.speak
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Layer.mergeAll(ProviderCondenser, ProviderResponder, ProviderWriter, ProviderBrain).pipe(
        Layer.provideMerge(Persona.layer),
        Layer.provide(ProviderModel),
      ),
      WhisperDictation,
      Relays,
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(KokoroVoice, DeviceAudio, SileroVad, WhisperTranscriber, Floor.layer, Settings.layer, Journal.layer, T3Live.layer, Ledger.layer),
      ),
      Layer.provideMerge(Layer.mergeAll(ClaudeCode.WaitingLive, Store.layer)),
    ),
  ),
  // Outermost, so layers log through it too.
  Effect.provide(Logger.pretty),
)
