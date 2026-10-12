import { Clock, Context, Deferred, Effect, Layer, Logger, Option, Stream } from "effect"
import { hostname } from "node:os"
import * as Assistant from "./Assistant.ts"
import { Activity, DeviceAudio } from "./Audio.ts"
import { modeCommand, modeLines, ProviderBrain } from "./Brain.ts"
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
import * as Icons from "./Icons.ts"
import * as Journal from "./Journal.ts"
import * as Latest from "./Latest.ts"
import * as Ledger from "./Ledger.ts"
import * as Modes from "./Modes.ts"
import type * as Missed from "./Missed.ts"
import * as Mutes from "./Mutes.ts"
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
import * as Switching from "./Switching.ts"
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
  const naming = yield* Journal.naming
  // What he muted, kept quiet whoever tells of it, until he unmutes it.
  const mutes = yield* Mutes.make(yield* Store.Store)
  const settings = yield* Settings.Settings
  // How yapd talks, focus and quiet holding for later what a mute would keep quiet, kept across restarts.
  const modes = yield* Modes.make({ settings, journal })
  const persona = yield* Persona.Persona
  /** What tells him what was held once he says he's back over an update, which the assistant does, once it's made. */
  const welcome = yield* Deferred.make<Effect.Effect<void>>()
  // Hooks on this machine are tied to the thread they came from, so what's said of each is kept with it, and what he says over it goes to it.
  // Another machine's are tied to theirs there for what's kept, shown and muted of them only.
  const daemon = yield* Daemon.make({
    link: (session, cwd) => threads.link(machine, session, cwd),
    owner: (host, session, cwd) => threads.link(naming(host), session, cwd),
    hands,
    mutes,
    naming,
    // What went to a thread for him and may have got there: what answers it is his to hear, however he muted the thread.
    sent: (to, since) => ledger.steps(since, { kinds: ["message", "reply", "start"], states: ["prepared", "sent", "unknown"], machine: to.machine, thread: to.id }),
    holding: modes.holding,
    detail: modes.detail,
    // "Focus", "talk shorter" or "I'm back" said over an update, in so many words: done here, never sent to the agent. Back, what was
    // held is told right after, as an answer.
    command: (heard, asks) =>
      Option.map(modeCommand(heard, asks), ({ how, minutes }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const told = modeLines(yield* persona.lines, now)
          switch (how) {
            case "focus":
            case "quiet": {
              const { now: mode } = yield* modes.set(how, minutes === undefined ? undefined : now + minutes * 60_000)
              const ends = mode.until ?? Modes.ending(how, undefined, now)
              return how === "focus" ? told.focus(ends) : told.quiet(ends)
            }
            case "brief":
            case "full":
              yield* modes.setDetail(how)
              return how === "brief" ? told.brief : told.full
            case "normal":
              if ((yield* modes.current).mode.mode !== "normal") yield* modes.set("normal")
              yield* Effect.flatten(Deferred.await(welcome))
              return ""
          }
        }),
      ),
  })
  const icons = yield* Icons.make({ actions: threads.actions })
  /** What he hasn't heard, as the assistant gathers it for a catch-up, once it's made. */
  let missing: Effect.Effect<ReadonlyArray<Missed.Group>> | undefined
  const latest = yield* Latest.make({
    here: machine,
    journal,
    mutes,
    icons,
    threads,
    heard: daemon.latestHeard,
    hearing: Stream.changesWith(
      Stream.map(daemon.state, ({ heard }) => heard.map(({ id }) => id).join("\n")),
      (one, other) => one === other,
    ),
    // Every thread it can see, to count those that wait on him.
    desk: threads.desk(Option.none(), [], Number.MAX_SAFE_INTEGER),
    // What he hasn't heard, to count by thread and in all.
    missed: Effect.suspend(() => missing ?? Effect.succeed([])),
  })
  // Muting from the menu or by voice: never anything that reaches an agent. A thread the menu shows muted by its session is unmuted by it too.
  const controls = Mutes.widened(
    Option.getOrElse(daemon.controls, () => Mutes.controls({ mutes, silence: daemon.silence, journal })),
    latest.under,
  )
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
    telling: daemon.telling,
    // What a thread waits on him for, worded as notices word it, to read back what he answers before he's heard it asked.
    compose: yield* Notices.composer(threads),
    mutes,
    controls,
    naming,
    modes,
  })
  yield* Deferred.succeed(welcome, assistant.welcome)
  missing = Effect.map(assistant.missed, ({ groups }) => groups)
  // What threads need him for, what failed and what finished with no hook, each said once, ever.
  const notices = yield* Notices.make({
    threads,
    journal,
    tell: daemon.tell,
    power: daemon.power,
    stopped: daemon.stopped,
    unheard: daemon.unheard,
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

  /**
   * Off, what he asked that hasn't started yet is dropped, a dictation too,
   * and what was waiting to be said is kept unheard. The shortcut stays: what
   * he asks while it's off is answered, then it's quiet again. On, what was
   * under way for what he asked while it was off is dropped the same way;
   * then what came in meanwhile is offered once, what a restart found while
   * it was off is said, and what waits on him that he wasn't told of. The
   * assistant drops before the daemon turns, so what it was doing for the
   * turns before is stopped like the rest. Only when it really switches:
   * started on, or asked for on while it is, nothing he's asking is dropped.
   */
  const turn = Switching.switcher({
    power: daemon.power,
    drop: Effect.all([dictation.drop, assistant.drop], { discard: true }),
    turn: daemon.turn,
    shortcut: shortcut.toggle(true),
    back: Effect.all([assistant.back, notices.reconcile], { discard: true }),
  })
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

  const state = Stream.zipLatestAll(daemon.state, (yield* Activity).changes, latest.rows, modes.changes, latest.waiting, latest.unheard).pipe(
    Stream.map(([state, activity, recent, { mode }, waiting, unheard]) => ({
      on: state.on,
      activity,
      mode: mode.mode,
      ...(mode.mode === "normal" || mode.until === undefined ? {} : { until: new Date(mode.until).toISOString() }),
      waiting,
      unheard,
      updates: state.heard.map(({ id, update }) => ({
        id,
        project: update.project,
        text: update.spoken,
        at: new Date(update.at).toISOString(),
      })),
      recent,
    })),
  )

  // Focus and quiet end on their own, and what was held is brought up in a digest once it's quiet.
  const running = yield* Modes.run(modes, {
    journal,
    power: daemon.power,
    idle: daemon.idle,
    hold: daemon.hold,
    digest: assistant.digest,
    rundown: assistant.rundown,
  })
  // What the menu does to a thread it lists: mute it, or hear it again.
  const { mute, replayThread } = Latest.menu({ latest, threads, mutes, controls, daemon, mention: assistant.mention, journal })
  yield* Server.serve(yield* Config.port, {
    handle: daemon.handle,
    state: Show.stated(state, show),
    // One at a time, so what's remembered is what's in effect. Noted as of when it was asked, so it comes before what turning off keeps.
    turn: (on) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.zipRight(settings.remember(on), turn(on)).pipe(Effect.zipRight(journal.write({ at, kind: "action", detail: { on } }))),
      ).pipe(switching.withPermits(1)),
    // Ended from the menu, focus or quiet offers the rundown, as when its time runs out.
    mode: (mode, until) =>
      Effect.gen(function* () {
        const { was, now } = yield* modes.set(mode, until)
        if (now.mode === "normal") yield* running.leave(was)
      }),
    replay: daemon.replay,
    // Typed words were never faint, so nothing typed is taken for Whisper hearing words in silence.
    utter: (text) => Effect.flatMap(daemon.power, ({ turns }) => heard(text, "typed", Number.POSITIVE_INFINITY, turns)),
    // Every thread it can see, not only the likeliest, in the order the desk puts them.
    ...Show.served(show, threads.desk(Option.none(), [], Number.MAX_SAFE_INTEGER), journal.page, Effect.map(mutes.list, (all) => new Set(all.map(({ key }) => key)))),
    mute,
    unmute: (key) => Effect.asVoid(controls.unmute(key)),
    replayThread,
    icon: icons.image,
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
