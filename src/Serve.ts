import { Clock, Context, Effect, Layer, Logger, Option, Stream } from "effect"
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
import { Dictation, Turns, WhisperDictation } from "./Dictation.ts"
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
import * as Show from "./Show.ts"
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

export const serve = Effect.gen(function* () {
  const daemon = yield* Daemon.make
  const preferences = yield* Preferences.path
  const everywhere = yield* machines
  const journal = yield* Journal.Journal
  yield* Effect.forkScoped(Effect.flatMap(Clock.currentTimeMillis, (now) => journal.prune(now - remembered)))
  const drafts = yield* Drafts.make({
    machines: everywhere,
    rules: Preferences.load(preferences),
    recent: daemon.recent,
    expect: (yield* Vocabulary).expect,
  })
  yield* Effect.logInfo(`Your rules for new work go in ${preferences}`)
  const token = yield* Config.t3codeToken
  const threads = yield* Threads.make({
    // As the machine is called when yapd starts, which is what its threads are known by while it runs.
    machine: everywhere.find(({ here }) => here)?.name ?? hostname(),
    live: yield* T3Live.T3Live,
    actions: Option.map(token, (token) => T3Actions.make(T3CodeServer.connect(token))),
    others: everywhere.filter(({ here }) => !here).map(({ name }) => name),
    journal,
    store: yield* Store.Store,
  })
  const show = yield* Show.make(threads.detail)
  const assistant = yield* Assistant.make({
    threads,
    journal,
    drafts,
    show,
    tell: daemon.tell,
    power: daemon.power,
    lastHeard: daemon.lastHeard,
    coming: daemon.coming,
    awaiting: daemon.awaiting,
    queued: daemon.queued,
    skip: daemon.skip,
    upcoming: daemon.upcoming,
  })
  const shortcut = yield* Shortcut
  // Built once the daemon is, so each press keeps how many times yapd had been turned on or off by then, however late what was said is handed on.
  const dictation = Context.get(
    yield* Layer.build(WhisperDictation).pipe(Effect.provideService(Turns, Effect.map(daemon.power, ({ turns }) => turns))),
    Dictation,
  )
  const settings = yield* Settings.Settings

  /**
   * Off, whatever hasn't started yet is dropped, from a dictation to what was
   * waiting to be said. The keys go before the dictations, so none starts in
   * between, and all of it before the daemon waits on anything.
   */
  const turn = (on: boolean) =>
    on
      ? Effect.zipRight(daemon.turn(true), shortcut.toggle(true))
      : Effect.all([shortcut.toggle(false), dictation.drop, assistant.drop, daemon.turn(false)], { discard: true })
  const switching = yield* Effect.makeSemaphore(1)
  // The shortcut waits for this, so nothing is dictated before yapd knows it's on.
  if (yield* settings.on) yield* turn(true)
  else {
    yield* turn(false)
    yield* Effect.logInfo("yapd is off, until it's turned on from the menu bar or the API")
  }

  /** What the user said to yapd, as heard now, with how many times yapd had been turned on or off as it was said. */
  const heard = (text: string, via: Assistant.Utterance["via"], voiced: number, turns: number, press?: number) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => assistant.heard({ heard: text, via, at, voiced, turns }, press))

  const state = Stream.zipLatestAll(daemon.state, (yield* Activity).changes, show.showing).pipe(
    Stream.map(([state, activity, showing]): Server.State => ({
      on: state.on,
      activity,
      updates: state.heard.map(({ id, update }) => ({
        id,
        project: update.project,
        text: update.spoken,
        at: new Date(update.at).toISOString(),
      })),
      showing: Show.pointer(showing),
    })),
  )
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
    utter: (text) => Effect.flatMap(daemon.power, ({ turns }) => heard(text, "typed", Number.POSITIVE_INFINITY, turns)),
    card: (id) => Effect.map(show.card(id), Option.map(Show.face)),
    hide: Effect.asVoid(show.hide),
    back: show.back,
    // Every thread it can see, not only the likeliest, in the order the desk puts them.
    threads: Effect.map(threads.desk(Option.none(), [], Number.MAX_SAFE_INTEGER), Show.listing),
    journal: (page) => Effect.map(journal.page(page), (kept) => kept.map(Show.entry)),
    watch: show.watch,
  })
  // Asked as the user starts talking, so it's there by the time they've finished.
  yield* Effect.forkScoped(Stream.runForEach(dictation.presses, ({ press, turns }) => assistant.prepare(press, turns)))
  // Each with the press it began with, which keeps what "it" meant then, however long the dictation took.
  yield* Effect.forkScoped(
    Stream.runForEach(dictation.transcripts, ({ press, turns, heard: text, voiced }) =>
      text === "" ? assistant.nothing(press) : heard(text, "shortcut", voiced, turns, press),
    ),
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
      Relays,
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(KokoroVoice, DeviceAudio, SileroVad, WhisperTranscriber, Floor.layer, Settings.layer, Journal.layer, T3Live.layer),
      ),
      Layer.provideMerge(Layer.mergeAll(ClaudeCode.WaitingLive, Store.layer)),
    ),
  ),
  // Outermost, so layers log through it too.
  Effect.provide(Logger.pretty),
)
