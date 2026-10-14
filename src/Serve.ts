import { Clock, Context, Deferred, Effect, Layer, Logger, Option, Schedule, Stream } from "effect"
import { hostname } from "node:os"
import * as Assistant from "./Assistant.ts"
import { Activity, DeviceAudio } from "./Audio.ts"
import { answersTo, modeCommand, modeLines, ProviderBrain, remembered as inMind } from "./Brain.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as CliLauncher from "./CliLauncher.ts"
import * as Codex from "./Codex.ts"
import { ProviderCondenser } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Daemon from "./Daemon.ts"
import { Ahead, Dictation, Turns, WhisperDictation } from "./Dictation.ts"
import * as Drafts from "./Drafts.ts"
import * as Floor from "./Floor.ts"
import * as Hands from "./Hands.ts"
import * as Icons from "./Icons.ts"
import * as Journal from "./Journal.ts"
import * as Latest from "./Latest.ts"
import * as Ledger from "./Ledger.ts"
import * as Memory from "./Memory.ts"
import * as Modes from "./Modes.ts"
import type * as Missed from "./Missed.ts"
import * as Mutes from "./Mutes.ts"
import * as Notices from "./Notices.ts"
import { machines } from "./Machines.ts"
import { ProviderModel } from "./Model.ts"
import * as Persona from "./Persona.ts"
import * as Preferences from "./Preferences.ts"
import * as Relay from "./Relay.ts"
import * as Reminders from "./Reminders.ts"
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
/** How long a reminder is kept once it's said or cancelled. */
const reminded = 30 * 24 * 60 * 60_000
/** How often what he asked to be reminded of at a time is looked at: a poll, so a restart, the Mac sleeping or its clock changing are all the same. */
const reminding = "15 seconds"
/** How often how much of his limits is used is looked at. */
const usage = "5 minutes"

export const serve = Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis
  const preferences = yield* Preferences.path
  // His routines in the file, read each time, from the whole of it, so one he adds is there for the next thing he says: never one called
  // as yapd answers to already, which would never be heard as the routine.
  const routines = yield* Preferences.written(preferences, answersTo)
  const tunnels = yield* Tunnels
  const everywhere = yield* machines(Tunnel.masters(tunnels))
  const journal = yield* Journal.Journal
  const ledger = yield* Ledger.Ledger
  const store = yield* Store.Store
  // What he asked to be told later, fired through the journal, in the same database.
  const reminders = Reminders.make(store, journal)
  // What he asked yapd to keep in mind, which every prompt reads: never a routine kept by voice that one in his preferences is called the same as.
  const memories = Memory.make(store, routines)
  yield* Effect.forkScoped(
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.all([journal.prune(now - remembered), ledger.prune(now - done), reminders.prune(now - reminded)], { discard: true }),
    ),
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
    store,
  })
  // Archiving a thread drops what he set on it, and taking that back brings it back.
  const hands = Hands.make({ threads, ledger, started, reminders })
  const naming = yield* Journal.naming
  // What he muted, kept quiet whoever tells of it, until he unmutes it.
  const mutes = yield* Mutes.make(store)
  const settings = yield* Settings.Settings
  // How yapd talks, focus and quiet holding for later what a mute would keep quiet, kept across restarts.
  const modes = yield* Modes.make({ settings, journal })
  const persona = yield* Persona.Persona
  /** What tells him what was held once he says he's back over an update, which the assistant does, once it's made. */
  const welcome = yield* Deferred.make<Effect.Effect<void>>()
  /** What makes a follow-up of what he says right after a line said of an update, as the assistant follows up an answer, once it's made. */
  const following = yield* Deferred.make<Assistant.Assistant["Type"]["following"]>()
  /**
   * Turning yapd on or off as the menu does, once that's made, for "Mute."
   * said to it, and "unmute" by the shortcut while it's off, by the dictation
   * the shortcut's press `press` began: back once it's on or off, never
   * waiting on what's said on coming back.
   */
  const toggling = yield* Deferred.make<(on: boolean, press?: number) => Effect.Effect<void>>()
  const power = (on: boolean, press?: number) => Effect.flatMap(Deferred.await(toggling), (turn) => turn(on, press))
  /** What says notices, once it's made, which says a reminder on its own when the update it led is never said. */
  const noticing = yield* Deferred.make<Effect.Effect.Success<ReturnType<typeof Notices.make>>>()
  // Hooks on this machine are tied to the thread they came from, so what's said of each is kept with it, and what he says over it goes to it.
  // Another machine's are tied to theirs there for what's kept, shown and muted of them only, and either may be one of T3 Code's own
  // subagents, kept to yapd unless he has the thread it's part of read to him.
  const daemon = yield* Daemon.make({
    link: (session, cwd, promising) => threads.link(machine, session, cwd, promising),
    owner: (host, session, cwd, promising) => threads.link(naming(host), session, cwd, promising),
    // Work in T3 Code's scratch folder is in none of his projects, wherever it ran. This machine's by the name its threads are known by.
    outside: (name, directory) => threads.outside(name === naming(hostname()) ? machine : name, directory),
    hands,
    mutes,
    naming,
    // What went to a thread for him and may have got there: what answers it is his to hear, however he muted the thread.
    sent: (to, since) => ledger.steps(since, { kinds: ["message", "reply", "start"], states: ["prepared", "sent", "unknown"], machine: to.machine, thread: to.id }),
    // Which message a thread's latest run began with, so after a restart a later turn isn't taken for the first of work yapd started.
    began: (to) =>
      Option.match(threads.actions(to.machine), {
        onNone: () => Effect.succeedNone,
        onSome: (actions) =>
          Effect.gen(function* () {
            const latest = Option.flatMap(yield* threads.find(to), ({ latestRunId }) => Option.fromNullable(latestRunId))
            if (Option.isNone(latest)) return Option.none<Option.Option<string>>()
            return Option.map(yield* actions.ran(to.id, latest.value), ({ userMessageId }) => userMessageId)
          }).pipe(Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not read which message its latest run began with", error), Option.none()))),
      }),
    // How the turn a Stop told of ended, by its thread's latest run when that's the Stop's own, for what he set on its finishing to say.
    ending: (to, stop) => {
      const unknown: Reminders.Ending = { _tag: "Unknown" }
      return Option.match(threads.actions(to.machine), {
        onNone: () => Effect.succeed(unknown),
        onSome: (actions) =>
          Effect.gen(function* () {
            const thread = yield* threads.find(to)
            const latest = Option.flatMap(thread, ({ latestRunId }) => Option.fromNullable(latestRunId))
            if (Option.isNone(thread) || Option.isNone(latest)) return unknown
            return Option.match(yield* actions.ran(to.id, latest.value), { onNone: () => unknown, onSome: (run) => Notices.ended(stop, run, thread.value) })
          }).pipe(Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not read how its run ended", error), unknown))),
      })
    },
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
    off: power(false),
    // What he asked to hear once a thread finishes leads its update, named as the desk names it, and is said on its own should that never be.
    finishing: Reminders.finishing({
      reminders,
      desk: (ref) => threads.desk(Option.none(), [ref], 1),
      lines: persona.lines,
      announce: (spoken, entry, kept, about) =>
        Effect.flatMap(Deferred.await(noticing), (notices) => notices.announce(spoken, entry, Effect.succeed(true), entry.at, entry.key, Option.getOrUndefined(kept), about)),
    }),
    // Each of his routines by the name it's known by, as the shortcut would send it, read as they are now: said over an update, one is
    // never sent to its agent as the bare words.
    routines: Effect.map(Effect.all([memories.list, routines]), ([kept, written]) =>
      inMind({ memories: { kept, written } }).flatMap(({ name }) => (name === undefined ? [] : [name])),
    ),
    // A late "On it" can be followed up as what was said over its update, which only the assistant works out.
    following: (update, line, done) => (heard, voiced, echo, afterPause, unsaid, carried) =>
      Effect.flatMap(Deferred.await(following), (follow) => follow(update, line, done)(heard, voiced, echo, afterPause, unsaid, carried)),
  })
  const icons = yield* Icons.make({ actions: threads.actions })
  /** What he hasn't heard, as the assistant gathers it for a catch-up, once it's made. */
  let missing: Effect.Effect<ReadonlyArray<Missed.Group>> | undefined
  const missed = Effect.suspend(() => missing ?? Effect.succeed([]))
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
    missed,
  })
  // Muting from the menu or by voice: never anything that reaches an agent. A thread the menu shows muted by its session is unmuted by it too.
  const controls = Mutes.widened(
    Option.getOrElse(daemon.controls, () => Mutes.controls({ mutes, silence: daemon.silence, unread: daemon.unread, journal })),
    latest.under,
  )
  const drafts = yield* Drafts.make({
    machines: everywhere,
    rules: Preferences.load(preferences),
    memories: memories.list,
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
    turn: power,
    reminders,
    memories,
    routines,
  })
  yield* Deferred.succeed(welcome, assistant.welcome)
  yield* Deferred.succeed(following, assistant.following)
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
    // The work it started, whose first turn may have ended while yapd restarted, with no word of it then.
    started: (machine, since) => ledger.steps(since, { kinds: ["start"], states: ["prepared", "sent", "unknown"], machine }),
    shortest: (yield* Config.minSeconds) * 1000,
    reminders,
    offered: assistant.offered,
    holding: modes.holding,
    archiving: hands.archiving,
    // A failure, a limit hit or a reminder about a thread can be followed up about it, while he's at hand.
    following: assistant.following,
  })
  yield* Deferred.succeed(noticing, notices)
  yield* Effect.forkScoped(notices.follow)
  // What he heard none of that was handed over to be said before the restart is said again, then what he set for a time is said as it
  // comes, one due while yapd was down at once.
  yield* Effect.forkScoped(Effect.zipRight(notices.retell, notices.due.pipe(Effect.repeat(Schedule.spaced(reminding)))))
  // How much of his limits is used, asked of this Mac's T3 Code every few minutes, said or kept once a window as it passes 95 or 80 percent.
  yield* Effect.forkScoped(Effect.zipRight(threads.refreshUsage, notices.usage).pipe(Effect.repeat(Schedule.spaced(usage))))
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
  // Built once the daemon is, so each press keeps how many times yapd had been turned on or off by then, however late what was said is handed
  // on, and "Mute." while it's on is handed on at once, never waiting for what he dictated before it to be heard.
  const dictation = Context.get(
    yield* Layer.build(WhisperDictation).pipe(
      Effect.provideService(Turns, Effect.map(daemon.power, ({ turns }) => turns)),
      Effect.provideService(Ahead, (heard) => Switching.urgent(heard, daemon.power)),
    ),
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
   * Turned on by voice, what he's dictating is kept, as he may have pressed
   * again right after, and the presses after that one count as made once
   * it's on.
   */
  const switcher = Switching.switcher({
    power: daemon.power,
    dictations: dictation.drop,
    drop: assistant.drop,
    turn: daemon.turn,
    shortcut: shortcut.toggle(true),
    back: Effect.all([assistant.back, notices.reconcile], { discard: true }),
  })
  const switching = yield* Effect.makeSemaphore(1)
  /**
   * Turns yapd on or off as the menu does, one at a time, so what's
   * remembered is what's in effect, running `switched` once it is. Noted as
   * of when it was asked, so it comes before what turning off keeps.
   */
  const toggle = (on: boolean, press?: number, switched?: Effect.Effect<void>) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      Effect.zipRight(settings.remember(on), switcher.turn(on, press, switched)).pipe(Effect.zipRight(journal.write({ at, kind: "action", detail: { on } }))),
    ).pipe(switching.withPermits(1))
  // By voice, it's back once yapd is on or off, so what he dictated after is handed on once it is, however long what's said on coming
  // back takes; and nothing waits on it to say what went wrong, so that's logged.
  const scope = yield* Effect.scope
  yield* Deferred.succeed(toggling, (on, press) =>
    Switching.promptly(
      (switched) => toggle(on, press, switched).pipe(Effect.catchAllCause((cause) => Effect.logWarning(`Could not turn ${on ? "on" : "off"}`, cause))),
      scope,
    ),
  )
  // The shortcut waits for this, so nothing is dictated before yapd knows it's on.
  if (yield* settings.on) yield* switcher.turn(true)
  else {
    yield* switcher.turn(false)
    yield* Effect.logInfo('yapd is off, until it\'s turned on from the menu bar, the API, or by saying "unmute" with the shortcut')
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
  // What the menu does to a thread it lists: mute it, have its subagents read or not, or hear it again.
  const { mute, subagents, replayThread } = Latest.menu({ latest, threads, mutes, controls, daemon, mention: assistant.mention, journal, following: assistant.following, reminders })
  // Every thread it can see, not only the likeliest, in the order the desk puts them.
  const served = Show.served(
    show,
    threads.desk(Option.none(), [], Number.MAX_SAFE_INTEGER),
    journal.page,
    Effect.map(mutes.list, (all) => new Set(all.map(({ key }) => key))),
    Effect.map(mutes.reading, (all) => new Set(all.map(({ key }) => key))),
  )
  yield* Server.serve(yield* Config.port, {
    handle: daemon.handle,
    state: Show.stated(state, show),
    turn: toggle,
    // Ended from the menu, focus or quiet offers the rundown, as when its time runs out.
    mode: (mode, until) =>
      Effect.gen(function* () {
        const { was, now } = yield* modes.set(mode, until)
        if (now.mode === "normal") yield* running.leave(was)
      }),
    replay: daemon.replay,
    // Typed words were never faint, so nothing typed is taken for Whisper hearing words in silence.
    utter: (text) => Effect.flatMap(daemon.power, ({ turns }) => heard(text, "typed", Number.POSITIVE_INFINITY, turns)),
    ...served,
    mute,
    unmute: (key) => Effect.asVoid(controls.unmute(key)),
    subagents,
    replayThread,
    clearCatchup: assistant.clear,
    // What a panel beside a row shows of its thread, what it's doing and its pull request as /threads has them, and what he hasn't heard as
    // its row counts it.
    details: Latest.details({ latest, threads, mutes, journal, listing: served.threads, missed }),
    icon: icons.image,
  })
  // Asked as the user starts talking, so it's there by the time they've finished.
  yield* Effect.forkScoped(Stream.runForEach(dictation.presses, ({ press, turns, began }) => assistant.prepare(press, switcher.turns(press, turns), began)))
  // Each with the press it began with, which keeps what "it" meant then, however long the dictation took. "Mute." is heard at once, ahead
  // of what's still being heard or worked out; "unmute" in its turn, so what he says after it is handed on once yapd is on.
  yield* Effect.forkScoped(
    Switching.dictations(dictation.transcripts, daemon.power, ({ press, turns, heard: text, voiced, at }) =>
      text === "" ? assistant.nothing(press) : heard(text, "shortcut", voiced, switcher.turns(press, turns), press, at),
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
