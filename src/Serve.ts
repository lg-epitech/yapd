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
import * as Hands from "./Hands.ts"
import * as Journal from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import * as Notices from "./Notices.ts"
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
import * as Tunnel from "./Tunnel.ts"
import { SileroVad } from "./Vad.ts"
import { KokoroVoice } from "./Voice.ts"
import { ProviderWriter } from "./Writer.ts"

// `yapd serve`, apart from the other commands, since only the daemon needs the
// models and the native onnxruntime they bring, which hooks would load on every turn.

/** The tunnel to each machine in `YAPD_REMOTES`, by its hostname in lowercase, held open while yapd serves. */
class Tunnels extends Context.Tag("yapd/Tunnels")<Tunnels, ReadonlyMap<string, Tunnel.Tunnel>>() {}

/**
 * One tunnel to each machine, opened as yapd starts and closed as it stops.
 * None is waited for: a machine that can't be reached is tried again in the
 * background, while everything else goes on as if it weren't there.
 */
const TunnelsLive = Layer.scoped(
  Tunnels,
  Effect.gen(function* () {
    const remotes = yield* Config.remotes
    return new Map(yield* Effect.forEach(remotes, ([host, destination]) => Effect.map(Tunnel.forward(host, destination), (tunnel) => [host, tunnel] as const)))
  }),
)

/**
 * T3 Code first, since it only claims threads it can find, and its sessions
 * must go through it. Then each agent's own way in, whatever it runs in. A
 * waiting Claude Code hook holds its connection wherever it runs, but other
 * machines' T3 Code and Codex are only reachable from there, through the
 * connection the tunnel there keeps open while it's up. The sessions yapd
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
      Remote.relay(remotes, hostname, undefined, Tunnel.masters(yield* Tunnels)),
      here(Codex.relay),
      here(CliLauncher.relay()),
    ])
  }),
)

/** How long the journal is kept: a year of it is about forty thousand entries. */
const remembered = 365 * 24 * 60 * 60_000
/** How long what yapd did to threads is kept. */
const done = 90 * 24 * 60 * 60_000

export const serve = Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis
  const preferences = yield* Preferences.path
  const tunnels = yield* Tunnels
  const everywhere = yield* machines(Tunnel.masters(tunnels))
  const journal = yield* Journal.Journal
  const ledger = yield* Ledger.Ledger
  yield* Effect.forkScoped(
    Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.zipRight(journal.prune(now - remembered), ledger.prune(now - done))),
  )
  const token = yield* Config.t3codeToken
  const live = yield* T3Live.T3Live
  // As the machine is called when yapd starts, which is what its threads are known by while it runs.
  const machine = everywhere.find(({ here }) => here)?.name ?? hostname()
  // Each other machine's threads, followed and acted on through the tunnel to its T3 Code, which asks there again where it is and for the
  // token whenever it stops answering, as after T3 Code restarted there. Known by its name in YAPD_REMOTES, as the machine is everywhere else.
  const others = yield* Effect.forEach(tunnels, ([host, tunnel]) =>
    Effect.map(
      T3Live.follow(tunnel.refresh).pipe(Effect.annotateLogs({ machine: host })),
      (live): Threads.Other => ({ machine: host, live, actions: T3Actions.make(Tunnel.transport(tunnel.locate, host)), status: tunnel.status }),
    ),
  )
  const threads = yield* Threads.make({
    machine,
    live,
    actions: Option.map(token, (token) => T3Actions.make(T3CodeServer.connect(token))),
    others,
    journal,
    store: yield* Store.Store,
  })
  const hands = Hands.make({ threads, ledger, started })
  // Hooks on this machine are tied to the thread they came from, so what's said of each is kept with it, and what he says over it goes to it.
  const daemon = yield* Daemon.make({ link: (session, cwd) => threads.link(machine, session, cwd), hands })
  const drafts = yield* Drafts.make({
    machines: everywhere,
    rules: Preferences.load(preferences),
    recent: daemon.recent,
    expect: (yield* Vocabulary).expect,
    ledger,
    find: (machine, id) => threads.find({ machine, id }),
  })
  yield* Effect.logInfo(`Your rules for new work go in ${preferences}`)
  const show = yield* Show.make(threads.detail)
  const assistant = yield* Assistant.make({
    threads,
    journal,
    drafts,
    hands,
    ledger,
    show,
    tell: daemon.tell,
    power: daemon.power,
    lastHeard: daemon.lastHeard,
    coming: daemon.coming,
    awaiting: daemon.awaiting,
    queued: daemon.queued,
    skip: daemon.skip,
    upcoming: daemon.upcoming,
    // What a thread waits on him for, worded as notices word it, to read back what he answers before he's heard it asked.
    compose: yield* Notices.composer(threads),
  })
  // What threads need him for, what failed and what finished with no hook, each said once, ever.
  const notices = yield* Notices.make({
    threads,
    journal,
    tell: daemon.tell,
    power: daemon.power,
    stopped: daemon.stopped,
    finished: daemon.finished,
    overtaken: daemon.overtaken,
    mention: assistant.mention,
    ask: assistant.ask,
    settled: assistant.settled,
    returned: assistant.returned,
    shortest: (yield* Config.minSeconds) * 1000,
  })
  yield* Effect.forkScoped(notices.follow)
  // Once T3 Code has caught up, what never said what came of it before the restart is looked for, and never sent: what didn't get there is offered.
  // New work T3 Code is still getting ready is said once it's waited for, alongside, so none of the rest waits for it. Each machine's once its own
  // T3 Code has, so one that's down holds up none of the rest, and this one's takes in what went to a machine yapd no longer follows.
  const followed = [{ machine, live }, ...others]
  yield* Effect.forEach(
    followed,
    ({ machine: name, live }) =>
      Effect.forkScoped(
        Hands.lookBack(hands, live.view, name, machine, followed.map(({ machine }) => machine)).pipe(
          Effect.flatMap(({ undelivered, unconfirmed, readying }) =>
            Effect.all(
              [Effect.zipRight(assistant.unconfirmed(unconfirmed), assistant.undelivered(undelivered)), Effect.flatMap(readying, assistant.unconfirmed)],
              { concurrency: "unbounded", discard: true },
            ),
          ),
          // Only this machine's look ever gives up waiting.
          Effect.catchAll((reason) => Effect.logInfo(`Not looking for what I sent before restarting: ${reason}`)),
        ),
      ),
    { discard: true },
  )
  // And what still waits on him that was never said is said, each machine's whenever its own T3 Code has caught up, so one that's down
  // holds up none of the rest, and what waits on him there is said once it's back.
  yield* Effect.forEach(followed, ({ machine: name, live }) => Effect.forkScoped(Notices.lookBack(notices, live.view, name)), { discard: true })
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
   * between, and all of it before the daemon waits on anything. On, what a
   * restart found while it was off is said, and what waits on him that he
   * wasn't told of.
   */
  const turn = (on: boolean) =>
    on
      ? Effect.all([daemon.turn(true), shortcut.toggle(true), assistant.back, notices.reconcile], { discard: true })
      : Effect.all([shortcut.toggle(false), dictation.drop, assistant.drop, daemon.turn(false)], { discard: true })
  const switching = yield* Effect.makeSemaphore(1)
  // The shortcut waits for this, so nothing is dictated before yapd knows it's on.
  if (yield* settings.on) yield* turn(true)
  else {
    yield* turn(false)
    yield* Effect.logInfo("yapd is off, until it's turned on from the menu bar or the API")
  }

  /** What the user said to yapd, as heard now, with how many times yapd had been turned on or off as it was said. */
  /** Said at `at`, or now: a dictation was said when he stopped talking, however long it then took to hear and hand on. */
  const heard = (text: string, via: Assistant.Utterance["via"], voiced: number, turns: number, press?: number, at?: number) =>
    Effect.flatMap(at === undefined ? Clock.currentTimeMillis : Effect.succeed(at), (at) => assistant.heard({ heard: text, via, at, voiced, turns }, press))

  const state = Stream.zipLatestAll(daemon.state, (yield* Activity).changes).pipe(
    Stream.map(([state, activity]) => ({
      on: state.on,
      activity,
      updates: state.heard.map(({ id, update }) => ({
        id,
        project: update.project,
        text: update.spoken,
        at: new Date(update.at).toISOString(),
      })),
    })),
  )
  yield* Server.serve(yield* Config.port, {
    handle: daemon.handle,
    state: Show.stated(state, show),
    // One at a time, so what's remembered is what's in effect.
    turn: (on) =>
      Effect.zipRight(settings.remember(on), turn(on)).pipe(
        Effect.zipRight(Effect.flatMap(Clock.currentTimeMillis, (at) => journal.write({ at, kind: "action", detail: { on } }))),
        switching.withPermits(1),
      ),
    replay: daemon.replay,
    // Typed words were never faint, so nothing typed is taken for Whisper hearing words in silence.
    utter: (text) => Effect.flatMap(daemon.power, ({ turns }) => heard(text, "typed", Number.POSITIVE_INFINITY, turns)),
    // Every thread it can see, not only the likeliest, in the order the desk puts them.
    ...Show.served(show, threads.desk(Option.none(), [], Number.MAX_SAFE_INTEGER), journal.page),
  })
  // Asked as the user starts talking, so it's there by the time they've finished.
  yield* Effect.forkScoped(Stream.runForEach(dictation.presses, ({ press, turns, began }) => assistant.prepare(press, turns, began)))
  // Each with the press it began with, which keeps what "it" meant then, however long the dictation took.
  yield* Effect.forkScoped(
    Stream.runForEach(dictation.transcripts, ({ press, turns, heard: text, voiced, at }) =>
      text === "" ? assistant.nothing(press) : heard(text, "shortcut", voiced, turns, press, at),
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
        Layer.mergeAll(KokoroVoice, DeviceAudio, SileroVad, WhisperTranscriber, Floor.layer, Settings.layer, Journal.layer, T3Live.layer, Ledger.layer),
      ),
      Layer.provideMerge(Layer.mergeAll(ClaudeCode.WaitingLive, Store.layer, TunnelsLive)),
    ),
  ),
  // Outermost, so layers log through it too.
  Effect.provide(Logger.pretty),
)
