import { Cause, Clock, Deferred, type Duration, Effect, Exit, Fiber, FiberMap, Option, PubSub, STM, Stream, SubscriptionRef, TRef } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type * as Assistant from "./Assistant.ts"
import { Audio } from "./Audio.ts"
import * as Brain from "./Brain.ts"
import { type Ticket, Waiting, wake } from "./ClaudeCode.ts"
import { Condenser, introduce, speakable, type Summary, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Conversation from "./Conversation.ts"
import * as Floor from "./Floor.ts"
import * as Inbox from "./Inbox.ts"
import * as Hands from "./Hands.ts"
import { type Entry, type Held, Journal, type Kept, type Naming } from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import type * as Modes from "./Modes.ts"
import * as Missed from "./Missed.ts"
import * as Mutes from "./Mutes.ts"
import * as Notices from "./Notices.ts"
import type { Origin } from "./Origin.ts"
import { Agent, key, type Payload } from "./Payload.ts"
import { Persona } from "./Persona.ts"
import * as Project from "./Project.ts"
import * as Recent from "./Recent.ts"
import type * as Reminders from "./Reminders.ts"
import { RelayError, Relays, type Thread } from "./Relay.ts"
import type { Handle } from "./Server.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3Code from "./T3Code.ts"
import * as Threads from "./Threads.ts"
import { extension, Voice } from "./Voice.ts"
import type { Line } from "./Words.ts"

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * An update the user heard, which they can hear again. Its session's Stop hook
 * isn't let go of, so a reply to it heard again still gets there: it waits
 * until the session does something else, or until it gives up.
 */
export interface HeardUpdate {
  readonly id: string
  readonly update: Conversation.Update
}

export interface State {
  /**
   * Off, yapd says nothing of its own accord and opens no microphone to
   * listen for a reply: only what he asks by the shortcut is answered. What
   * finishes meanwhile is kept, unheard, for the menu and for catching up.
   */
  readonly on: boolean
  /** Newest first. */
  readonly heard: ReadonlyArray<HeardUpdate>
}

/** How many updates can be heard again. */
const replayable = 5

/** How many of the updates he heard last are looked through, at startup, allowing for those heard twice or too little was kept of. */
const lookedBack = 2 * replayable

/** What a kept update's detail says of it, as it was kept. */
const remembered = (kept: Kept) => {
  const detail = (typeof kept.detail === "object" && kept.detail !== null ? kept.detail : {}) as Record<string, unknown>
  const text = (name: string) => (typeof detail[name] === "string" ? (detail[name] as string) : undefined)
  return {
    session: text("session"),
    host: text("host"),
    prompt: text("prompt"),
    more: text("more"),
    priority: text("priority"),
    quiet: detail.muted === true || text("held") !== undefined,
    subagent: detail.subagent === true,
    head: text("head"),
  }
}

/**
 * An update he heard before yapd restarted, as it was said, to hear again:
 * under its session, or its hook's session once it was tied to a thread,
 * which is this machine's to reply to through T3 Code, or another's, kept,
 * shown and muted by it, as a subagent's is by the subagent and the thread
 * it's part of. Never one kept quiet or held, which he never heard said, nor
 * one too little was kept of. Its audio is rendered as it's asked for.
 */
export const restored = (kept: Kept, here: string): Option.Option<Conversation.Update> => {
  const was = remembered(kept)
  const session = was.session ?? kept.thread
  if (kept.kind !== "update" || kept.heardAt === undefined || was.quiet || session === undefined || kept.said === undefined) return Option.none()
  const ref = was.session !== undefined && kept.machine !== undefined && kept.thread !== undefined ? { machine: kept.machine, id: kept.thread } : undefined
  const finished = session.startsWith("finished:")
  const [agent, ...rest] = session.split(":")
  const native = finished ? (ref?.id ?? "") : rest.join(":")
  if (!finished && !Agent.literals.some((known) => known === agent)) return Option.none()
  const message = kept.text ?? ""
  return Option.some({
    session,
    project: kept.project ?? "",
    turn: { prompt: Option.fromNullable(was.prompt), message },
    needsYou: was.priority === "needs-you",
    spoken: kept.said,
    ...(was.more === undefined || was.more === "" ? {} : { more: was.more }),
    audio: "",
    thread: {
      agent: finished ? "claude" : (agent as Agent),
      session: native,
      cwd: kept.directory ?? "",
      message,
      origin: finished ? { host: hostname(), app: T3Code.bundle } : was.host === undefined ? {} : { host: was.host },
    },
    at: kept.at,
    ...(ref === undefined
      ? {}
      : was.subagent
        ? { subagent: { child: ref, ...(was.head === undefined ? {} : { head: { ref: { machine: ref.machine, id: was.head } } }) } }
        : ref.machine === here
          ? { about: ref }
          : { owner: ref }),
  })
}

/** How long the speaker stays ready for something that was about to be said, before it rests again. */
const patience = "15 seconds"

/** How long an answer on its way holds everything else back at most, in case it never comes. */
const holding = "20 seconds"

/** How long a Stop is kept in mind: T3 Code says its thread finished well within it. */
const forgotten = 60 * 60_000

/**
 * How long after he last dictated, or something he said back was taken up,
 * he's taken to be at hand, so a line he didn't ask for, like a failure, can
 * be answered: past that, who speaks after it may be a TV, or someone else.
 */
const nearby = 10 * 60_000

/** How long finding the T3 Code thread a hook came from can take, after which its update goes the old way. */
const lookup = "3 seconds"

/**
 * How long after a hook came finding the subagent of T3 Code's own it came
 * from can take at most, while one at work there was still to be read, after
 * which its update goes the old way too.
 */
const longest = 10_000

/** How long a hook's update waits to be told whether its work is outside his projects, which its summary waits on, before it's taken not to be. */
const placing = "1 second"

/** How far back what yapd last said about the same work is looked for, to tell progress from news. */
const lastDay = 24 * 60 * 60_000

/**
 * Updates are condensed and rendered in parallel, then spoken one at a time,
 * along with what yapd has to say for itself. `link` finds the T3 Code thread
 * a hook on this machine came from, if any, so what's said of it is kept
 * with the thread, and `hands` send what the user says over it to that
 * thread, as T3 Code takes it: into the turn under way, or in its queue.
 * `owner` finds the thread a hook on another machine came from, in that
 * machine's T3 Code, for what's kept, shown and muted of it only. Either may
 * find one of T3 Code's own subagents instead, which is kept to yapd unless
 * he has the thread it's part of read to him. What's `mutes` is kept quiet,
 * by the keys `naming` gives an update, but not the answer to what yapd
 * `sent` its thread for him.
 */
export const make = (
  options: {
    /** Told by `promising` once looking among subagents may pay, so it's waited for longer. */
    readonly link?: (session: string, cwd: string, promising: Deferred.Deferred<void>) => Effect.Effect<Option.Option<Threads.Linked>>
    readonly owner?: (host: string, session: string, cwd: string, promising: Deferred.Deferred<void>) => Effect.Effect<Option.Option<Threads.Linked>>
    /**
     * Whether a directory on a machine, by its name, is in the folder behind
     * T3 Code's scratch project there, where work outside his projects goes,
     * whose folders' generated names are no project's.
     */
    readonly outside?: (machine: string, directory: string) => Effect.Effect<boolean>
    readonly hands?: Hands.Hands["Type"]
    readonly mutes?: Mutes.Mutes
    readonly naming?: Naming
    /**
     * What yapd sent a thread for him since then, like a message, an answer to
     * its question or the work it started, by when, in what words, and what
     * it was, with the id of the message it went as.
     */
    readonly sent?: (
      to: Threads.Ref,
      since: number,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly at: number
        readonly digest: string | null
        readonly how?: Ledger.How | null
        readonly kind?: Ledger.Kind
        readonly messageId?: string | null
      }>
    >
    /**
     * The id of the message a thread's latest run began with, none when it
     * began with none, as its machine's T3 Code has it: none at all when that
     * can't be read, as without a T3 Code token.
     */
    readonly began?: (to: Threads.Ref) => Effect.Effect<Option.Option<Option.Option<string>>>
    /** Focus or quiet, while one is on, which holds for later what a mute would keep quiet: none without modes. */
    readonly holding?: Effect.Effect<Option.Option<Modes.Hold>>
    /** How much of an update is said: its headline, or all of it once he asked for everything. The headline without modes. */
    readonly detail?: Effect.Effect<Modes.Detail>
    /**
     * When all he said over an update is to change how yapd talks, in so many
     * words, like "focus" or "talk shorter", how that's done, giving back
     * what's said of it: never anything sent to the agent. Over an update
     * that `asks` him something, only what can't be his answer to it.
     */
    readonly command?: (heard: string, asks: boolean) => Option.Option<Effect.Effect<string>>
    /** Turns yapd off as the menu does, which "Mute." said on its own over anything it says does too. Without it, that's a stop, as it always was. */
    readonly off?: Effect.Effect<void>
    /**
     * What he asked to be told once a thread finishes, as a turn of it is
     * about to be said: its update is led by them, as one, and said whatever
     * he muted or holds, an answer to what he asked. Offers are asked apart.
     * Only those set by `before`, as the turn came: one set since is for the
     * thread's next. Each says how the turn `ended`, read only when there's
     * one.
     */
    readonly finishing?: (about: Threads.Ref, before: number, ended: Effect.Effect<Reminders.Ending>) => Effect.Effect<ReadonlyArray<Reminders.Leading>>
    /**
     * How the turn a Stop hook told of ended, as its thread's run has it, for
     * what he set on its finishing to say: never finished when that can't be
     * read, as on a machine whose T3 Code yapd can't see.
     */
    readonly ending?: (about: Threads.Ref, stop: Notices.Stop) => Effect.Effect<Reminders.Ending>
    /** The names of his routines, as they are now, so one said over an update is never sent to its agent as the bare words. */
    readonly routines?: Effect.Effect<ReadonlyArray<string>>
    /**
     * What makes of what he says right after a line said of an update, `line`,
     * a follow-up about it, as the assistant follows up an answer, `done` when
     * the line says what came of what he said over it, with what went by
     * yapd's own hand, which "scratch that" reaches. Without it, such a line
     * listens only for "Mute.".
     */
    readonly following?: (update: Conversation.Update, line: string, done?: Brain.Done, own?: Brain.Own) => Conversation.Answer["followUp"]
    /**
     * What hands what he says over an update to yapd's assistant, as the
     * Responder took it for yapd's to do, or the mute hook did: with what's
     * known of the update here, whether it's steered, whether he's at hand,
     * and what the line he spoke over or just heard says yapd changed.
     * Without it, that's said to be asked with the shortcut.
     */
    readonly over?: (update: Conversation.Update, lines: ReadonlyArray<Line>, line: string, given: Assistant.Over) => Conversation.Handing
    /** The last change to how yapd talks he asked for, in the last two minutes, which "scratch that" said next takes back: none without modes. */
    readonly modeChange?: Effect.Effect<Option.Option<Modes.Change>>
  } = {},
) => Effect.gen(function* () {
  const lifetime = yield* Effect.scope
  const condenser = yield* Condenser
  const voice = yield* Voice
  const audio = yield* Audio
  const persona = yield* Persona
  const waiting = yield* Waiting
  const relays = yield* Relays
  const floor = yield* Floor.Floor
  const journal = yield* Journal
  const minMillis = (yield* Config.minSeconds) * 1000
  const called: Naming = options.naming ?? ((host) => host.split(".")[0] ?? host)
  /** The mute an update's keys are under, if any. */
  const muting = (keys: ReadonlyArray<string>) => (options.mutes === undefined ? Effect.succeedNone : options.mutes.muted(keys))
  /** Muting from the menu or by voice, which drops what of a thread waits to be said: none without mutes. Never anything sent to an agent. */
  let controls: Mutes.Controls | undefined

  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "yapd-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  )
  const removeFile = (path: string) => Effect.promise(() => rm(path, { force: true }))

  const inbox = yield* STM.commit(TRef.make(Inbox.empty))
  const preparing = yield* FiberMap.make<string>()
  const prompts = new Map<string, { readonly text: string | undefined; readonly at: number }>()
  /** Each session's latest hook, including ones received in the same millisecond. */
  const activity = new Map<string, { readonly chain: object }>()
  const generations = new WeakMap<Conversation.Update, { readonly chain: object }>()
  /** When yapd was last turned on as each update started being read, so what comes of it later can tell. */
  const readSince = new WeakMap<Conversation.Update, number>()
  /** Each update's entry in the journal, to note there once the user has heard it. */
  const rows = new WeakMap<Conversation.Update, number>()
  /** Updates whose Stop hook waits for a reply, like a terminal session resumed from a T3 Code thread, which go back through it. */
  const hooked = new WeakSet<Conversation.Update>()
  /** The requests each update's replies went to its thread under by yapd's own hand, which "scratch that" after word of one takes back. */
  const steeredAs = new WeakMap<Conversation.Update, ReadonlyArray<string>>()
  /** The Stop hooks waiting while their update is summed up, by session, which turning yapd off lets go of at once. */
  const summing = new Map<string, Ticket>()
  /** Hooks let go of already, so none is let go of twice. */
  const released = new WeakSet<Ticket>()
  /**
   * The update being read, or the last one that was, what of it was said
   * last, like an answer over it, and when, which is what "it" means to the
   * user, with how many times yapd had been turned on or off as it was read:
   * once it's turned off, it's no longer what "it" means.
   */
  let latest:
    | {
        readonly update: Conversation.Update
        readonly said: string
        at: number
        playing: boolean
        readonly turns: number
        /** The menu's row it's said again for, by its key, which "mute it" or "unmute it" said over it is about. */
        readonly menu?: string
      }
    | undefined
  /** Follow-ups the user just sent by voice, whose answers they'll want to hear however short. */
  interface FollowUp {
    readonly update: Conversation.Update
    readonly message: string
  }
  interface Replies {
    current?: FollowUp
    /** When the follow-up waiting on its answer was sent, which tells the run that answers it from a later one. */
    sentAt?: number
    thread: Thread
    readonly queued: Array<FollowUp>
    hook?: Ticket
  }
  const followed = new Map<string, Replies>()
  /** Each session's Stops, when they came and what they said last, oldest first, by the agent's own id for it, whether or not they were said, for an hour. */
  const stops = new Map<string, ReadonlyArray<Notices.Stop>>()
  /** Stops not said since a turn said in their hook's place was theirs, which makes them that run's and no other's. */
  const taken = new WeakSet<Notices.Stop>()
  /**
   * Each Stop's, done once what comes of its update is known: said, kept, or
   * dropped, which it then says. T3 Code's word for its turn waits on it, so
   * a turn of work yapd sent whose hook told of nothing is said in its place.
   */
  const deciding = new WeakMap<Notices.Stop, Deferred.Deferred<void>>()
  /**
   * A turn T3 Code said finished that no hook had told of, said in its hook's
   * place, under the session `finished:<machine>:<thread>`: what tells a Stop
   * of its own from another's, which is what decides the turn is its, and
   * whether he's hearing it or heard it, after which a Stop of its own coming
   * late isn't said too; until then, one gives way to it.
   */
  interface Fallback {
    readonly about: Threads.Ref
    readonly session: string
    readonly key: string
    readonly run: Notices.Finished["run"]
    /** Whether it's still the thread's run, which ends once the thread starts again or goes. */
    readonly current: Effect.Effect<boolean>
    readonly at: number
    /**
     * Whether it's being said, or he heard it to the end, answered it or told
     * it to stop. Broken off before then, like by turning yapd off, or put
     * back by a dictation to be read again, it isn't, until it's said again.
     */
    heard: boolean
    /**
     * Whether it was kept quiet rather than said, since he muted its thread:
     * it's the turn's all the same, but a Stop of its own coming late is
     * still said when it needs him.
     */
    quiet: boolean
    /** Its entry in the journal, once it's kept, whose place the entry of a Stop of its own takes, to be heard with it. */
    row?: number
  }
  /** Each turn said in its hook's place, by the key it's said once under, which is its run's, for an hour: only it or its Stop's update is said. */
  const fallbacks = new Map<string, Fallback>()
  /** The turn said in its hook's place that each update is. */
  const standing = new WeakMap<Conversation.Update, Fallback>()
  /**
   * Updates said however he muted their thread: what needs him, what couldn't
   * be summed up, which may, and what answers what he asked of it himself,
   * like a follow-up.
   */
  const audible = new WeakSet<Conversation.Update>()
  /** Updates that are the first turn of work yapd started, which answer what he asked, and which quiet alone holds, for the morning's rundown. */
  const openings = new WeakSet<Conversation.Update>()
  /** The entries of what he asked to be told as a thread finished, which an update is led by, heard with it. */
  const leading = new WeakMap<Conversation.Update, ReadonlyArray<number>>()
  /** What led each update, said on its own should the update be done with before he hears it, as when new work drops it: once. */
  const alone = new WeakMap<Conversation.Update, Effect.Effect<void>>()
  /** Stops whose update was kept quiet, since he muted its thread, so he never heard what they told of. */
  const hushed = new WeakSet<Notices.Stop>()
  /** The Stop each hook's update is of. */
  const stopOf = new WeakMap<Conversation.Update, Notices.Stop>()
  /** A failure left to the Stops that told of it, said after all once what all of them told of is kept quiet. */
  interface Owed {
    readonly stops: ReadonlyArray<Notices.Stop>
    readonly failure: Effect.Effect<void>
    told: boolean
  }
  const owed = new WeakMap<Notices.Stop, Owed>()
  /** The change to what's muted he just made over an update, by when it was made, which "scratch that" said next takes back. */
  const changedOver = new WeakMap<Conversation.Update, number>()
  /** The change to how yapd talks he just made over an update, by when it was made, kept the same way. */
  const modeChangedOver = new WeakMap<Conversation.Update, number>()
  const events = yield* Effect.makeSemaphore(1)
  const workers = yield* Effect.makeSemaphore(3)
  /**
   * Whether yapd is on, and how many times it was turned on or off, so what
   * was under way before can tell it's out of date. `state` is what's shown of it.
   */
  const power = yield* STM.commit(TRef.make({ on: true, turns: 0 }))
  const switched = STM.commit(TRef.get(power))
  /** Something is about to be ready to say, so the speaker can be got ready meanwhile. */
  const coming = yield* STM.commit(TRef.make(false))
  const soon = STM.commit(TRef.set(coming, true))
  // What he heard last, kept through a restart under the ids its entries in the journal have.
  const seeded: Array<HeardUpdate> = []
  // Only what he heard, so however many updates were kept quiet or held since, it's still there.
  for (const kept of yield* journal.heard(lookedBack)) {
    if (seeded.length >= replayable) break
    const update = restored(kept, called(hostname()))
    if (Option.isNone(update) || seeded.some(({ update: other }) => other.session === update.value.session && other.at === update.value.at)) continue
    rows.set(update.value, kept.id)
    seeded.push({ id: String(kept.id), update: update.value })
  }
  const state = yield* SubscriptionRef.make<State>({ on: true, heard: seeded })
  /** Each time something said over an update is taken in. */
  const replied = yield* PubSub.unbounded<void>()
  /**
   * Answers on their way, from when the user asked until they're queued:
   * meanwhile nothing but answers and questions is said, so what they asked
   * for isn't kept waiting behind an update, nor an update put between them
   * and it. Each lapses on its own, in case it never comes.
   */
  const awaited = yield* STM.commit(TRef.make<ReadonlyArray<object>>([]))
  const dictationStarted = STM.commit(
    STM.flatMap(Floor.dictating(floor), (dictating) => (dictating ? STM.void : STM.retry)),
  )
  const dictationOver = STM.commit(
    STM.flatMap(Floor.dictating(floor), (dictating) => (dictating ? STM.retry : STM.void)),
  )
  /**
   * A while after the user last stopped dictating, counted again whenever
   * they start: what they're still saying can't be answered yet, and a long
   * dictation would otherwise use the whole of it up.
   */
  const lapse = (after: Duration.DurationInput) =>
    Effect.gen(function* () {
      while (true) {
        yield* dictationOver
        if (yield* Effect.raceFirst(Effect.as(Effect.sleep(after), true), Effect.as(dictationStarted, false))) return
      }
    })
  /** An answer on its way, holding everything else back for `after` once he's stopped dictating at most. */
  const awaitingFor = (after: Duration.DurationInput) =>
    Effect.gen(function* () {
      const answer = {}
      yield* STM.commit(TRef.update(awaited, (all) => [...all, answer]))
      const arrived = STM.commit(TRef.update(awaited, (all) => all.filter((other) => other !== answer)))
      // Stoppable even when awaited from what can't be stopped, like an answer being taken in, so closing yapd never waits for it.
      yield* lapse(after).pipe(Effect.zipRight(arrived), Effect.interruptible, Effect.forkIn(lifetime))
      return arrived
    })
  const awaiting = awaitingFor(holding)

  /**
   * Whether something yapd has to say answers what he asked, or comes of it,
   * which is said even while it's off, as he asked by the shortcut: never an
   * update, nor anything yapd brings up of its own accord.
   */
  const askedFor = (entry: Inbox.Entry) => "notice" in entry && entry.notice.kind !== "notice"

  /**
   * Queues something to say, unless yapd was turned off or on since `turns`,
   * or is off and it isn't what he asked for, and returns whether it did.
   */
  const enqueue = (entry: Inbox.Entry, turns: number) =>
    STM.commit(
      STM.flatMap(TRef.get(power), (current) =>
        current.turns === turns && (current.on || askedFor(entry))
          ? STM.as(TRef.update(inbox, (queued) => Inbox.add(queued, entry)), true)
          : STM.succeed(false),
      ),
    )

  /**
   * Renders a notice and queues it. One that can't be rendered is only logged.
   * `since` is when what it's about began, if before now, so it isn't said if
   * yapd was turned off since. Never queued, however that ends, it's done with.
   */
  const tell = (notice: Inbox.Notice, since?: number) => {
    /** Whether it was queued, after which it's done with only once it's taken out to be said, or dropped. */
    let queued = false
    // What could give a secret away, like an answer saying back one he dictated, which the journal never keeps, is said, but never logged,
    // nor what came of a request held back as one, whatever its words.
    const revealing = notice.withheld === true || T3Actions.revealing(notice.spoken)
    const what = revealing ? "something that could give a secret away" : `"${notice.spoken}"`
    return Effect.gen(function* () {
      const now = yield* switched
      const turns = since ?? now.turns
      // Off, what yapd would bring up of its own accord isn't even rendered.
      if (notice.kind === "notice" && (!now.on || now.turns !== turns)) return yield* Effect.logInfo(`Not saying ${what}, since yapd is off`)
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      yield* soon
      yield* voice.render(notice.spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const said = { session: notice.id, priority: notice.priority, arrivedAt: notice.at, notice, audio }
      // Noted in the same breath as it's queued, so nothing can stop it in between.
      yield* enqueue(said, turns).pipe(
        Effect.tap((taken) =>
          Effect.sync(() => {
            queued = taken
          }),
        ),
        Effect.uninterruptible,
      )
      if (!queued) {
        yield* removeFile(audio)
        return yield* Effect.logInfo(`Not saying ${what}, since yapd is off`)
      }
      yield* Effect.logInfo(`Ready: ${revealing ? "something that could give a secret away" : notice.spoken}`)
    }).pipe(
      Effect.catchAllCause((cause) => Effect.logError(`Could not say ${what}`, cause)),
      Effect.ensuring(Effect.suspend(() => (queued ? Effect.void : (notice.gone ?? Effect.void)))),
    )
  }

  /**
   * Says how a follow-up went once the update it answers was cut off before
   * yapd could. A plain "On it" or "queued" can be followed up from its end,
   * as what was said over the update; never a line that `quotes` his message
   * back, which taken up could send it twice, nor one that says it may not
   * have gone, which he'd answer with "send it again", words the model could
   * only send the agent as they are. A bare no to it takes back nothing but
   * the reply it says went, and is told as said back to what it did, only
   * when that went by yapd's own hand, which "scratch that" reaches: never
   * through a hook, which leaves nothing to take back, nor what the
   * dictation that cut it off changed since, so the no never reaches
   * anything else without the model.
   */
  const late = (update: Conversation.Update, spoken: string, failed: boolean, quotes = false) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => {
      const line = introduce(update.project, spoken)
      const { following } = options
      return tell(
        {
          id: `late:${crypto.randomUUID()}`,
          kind: "notice",
          priority: failed ? "needs-you" : "done",
          spoken: line,
          at,
          stale: Effect.succeed(false),
          // Only once it's known to play, so a line for going ahead dropped as yapd was turned off, or that afplay couldn't play, never counts as the last one he heard.
          confirmed: persona.said(spoken),
          // Its own thread, which nothing written by yapd's own hand reaches unless it's steered, as a reply over the update itself.
          ...(following === undefined || quotes || failed
            ? {}
            : { followUp: following(update, line, reported(update), ownOf(update)), window: Conversation.linger, after: true }),
        },
        readSince.get(update),
      )
    })

  /**
   * Whether what the user says over an update goes to its T3 Code thread by
   * yapd's own hand, rather than the way hooks have always been answered:
   * only when the update is tied to the thread, and its hook isn't waiting.
   */
  const steered = (update: Conversation.Update) => update.about !== undefined && options.hands !== undefined && !hooked.has(update)

  /** An update's own thread, as what's said over it is held to: none for a subagent's, reached only through its hook. */
  const ownOf = (update: Conversation.Update): Brain.Own => {
    const ref = update.subagent === undefined ? (update.about ?? update.owner) : undefined
    return { ...(ref === undefined ? {} : { ref }), steered: steered(update) }
  }

  /**
   * What a line saying how a reply over an update went says yapd changed:
   * the reply, by the request it went under, when it went by yapd's own
   * hand. With more than one sent over it, which the line is about can't be
   * told, so none is taken back without the model.
   */
  const reported = (update: Conversation.Update): Brain.Done => {
    const [utterance, ...more] = steered(update) ? (steeredAs.get(update) ?? []) : []
    return utterance === undefined || more.length > 0 ? {} : { change: { what: "acted", utterance } }
  }

  /**
   * What the line said of an update that he spoke over or just heard says yapd
   * changed, as `made` tells it: a reply sent by yapd's own hand, alone, a mute
   * or a mode he just made over it, while it's the last of its kind; nothing
   * for the update itself, an answer, a line said again, or a reply through a
   * hook, after which any take-back is asked about first.
   */
  const doneBy = (update: Conversation.Update, made: Conversation.Made): Brain.Done => {
    switch (made) {
      case "sent":
        return reported(update)
      case "mute": {
        const at = changedOver.get(update)
        return at === undefined ? {} : { change: { what: "mute", at } }
      }
      case "mode": {
        const at = modeChangedOver.get(update)
        return at === undefined ? {} : { change: { what: "mode", at } }
      }
      default:
        return {}
    }
  }

  /**
   * Whether the work an update is about moved on since, by its hooks. Not for
   * one sent to its thread by yapd's hand, which T3 Code is asked as it's
   * sent, since yapd's own message makes a hook of its own.
   */
  const moved = (update: Conversation.Update) => !steered(update) && activity.get(update.session)?.chain !== generations.get(update)?.chain

  /** Called with the event lock held, before dispatch, since its reply can arrive immediately. */
  const register = (followUp: FollowUp, channel: Replies) => Effect.gen(function* () {
    const session = followUp.update.session
    const previousPrompt = prompts.get(session)
    const prompt = { text: followUp.message, at: yield* Clock.currentTimeMillis }
    channel.current = followUp
    channel.sentAt = prompt.at
    prompts.set(session, prompt)
    return { followUp, thread: channel.thread, previousPrompt, prompt, generation: activity.get(session) }
  })

  /** A follow-up that didn't go is no longer the session's, unless hooks or another follow-up have consumed or replaced it already. */
  const unregister = (pending: Effect.Effect.Success<ReturnType<typeof register>>) =>
    Effect.sync(() => {
      const { followUp } = pending
      const session = followUp.update.session
      if (activity.get(session) !== pending.generation) return
      const channel = followed.get(session)
      if (channel?.current === followUp) delete channel.current
      if (prompts.get(session) === pending.prompt) {
        if (pending.previousPrompt === undefined) prompts.delete(session)
        else prompts.set(session, pending.previousPrompt)
      }
    }).pipe(events.withPermits(1))

  /** Put back by a dictation that started just as a follow-up to it was sent, an update is answered now, so it isn't read again. */
  const answeredNow = (update: Conversation.Update) =>
    Effect.gen(function* () {
      const answered = yield* STM.commit(
        TRef.modify(inbox, (current) => {
          const queued = current.get(update.session)
          return queued !== undefined && "update" in queued && queued.update === update
            ? [queued, Inbox.remove(current, update.session)] as const
            : [undefined, current] as const
        }),
      )
      if (answered === undefined) return
      yield* removeFile(Inbox.audio(answered))
      yield* release(answered.hook)
    })

  const deliver = (pending: Effect.Effect.Success<ReturnType<typeof register>>) =>
    Effect.gen(function* () {
      const { followUp } = pending
      const { update, message } = followUp
      const session = update.session
      yield* relays.send(pending.thread, message).pipe(Effect.onError(() => unregister(pending)))
      yield* Effect.logInfo(`Delivered: ${T3Actions.revealing(message) ? "something that could give a secret away" : message}`)
      yield* journal.write({
        at: yield* Clock.currentTimeMillis,
        kind: "sent",
        host: pending.thread.origin.host,
        project: update.project,
        thread: session,
        directory: pending.thread.cwd,
        text: message,
      })
      yield* answeredNow(update)
    }).pipe(Effect.tapError(() => Effect.forkIn(sendNext(pending.followUp.update.session), lifetime)))

  /**
   * Sends a follow-up to an update's T3 Code thread by yapd's own hand, once,
   * under ids of its own: T3 Code steers it into the turn under way, or
   * queues it behind one that's waiting. Never once yapd was turned off
   * since, nor once the thread was given something else since the update,
   * which is said, as is anything else that keeps it from going. It's the
   * session's follow-up meanwhile, so the turn it starts is heard however short.
   */
  const steer = (update: Conversation.Update, about: Threads.Ref, hands: Hands.Hands["Type"], message: string) =>
    Effect.gen(function* () {
      const { on, turns } = yield* switched
      if (!on) return yield* new RelayError({ reason: "yapd is off, so I didn't send it." })
      const pending = yield* Effect.gen(function* () {
        let channel = followed.get(update.session)
        if (channel === undefined) {
          channel = { thread: update.thread, queued: [] }
          followed.set(update.session, channel)
        }
        return yield* register({ update, message }, channel)
      }).pipe(events.withPermits(1))
      const at = yield* Clock.currentTimeMillis
      const utterance = `u${at.toString(36)}${crypto.randomUUID().slice(0, 4)}`
      const act: Hands.Act = { _tag: "Message", to: about, text: message, how: "now" }
      const outcome = yield* hands.run({ utterance, step: 0 }, act, {
        wanted: Effect.map(switched, (power) => power.on && power.turns === turns),
        since: update.at,
      })
      const lines = yield* persona.lines
      const settled = yield* Clock.currentTimeMillis
      // Held back since it could give a secret away, the words aren't kept.
      const withheld = Hands.guarded(outcome)
      const noted = (detail: Record<string, unknown>) =>
        journal.write({
          at: settled,
          kind: outcome._tag === "Done" ? "sent" : "action",
          machine: about.machine,
          thread: about.id,
          project: update.project,
          directory: update.thread.cwd,
          ...(withheld ? {} : { text: message }),
          utterance,
          detail: { commandId: Ledger.ids(utterance, 0, false).commandId, outcome: outcome._tag, ...detail },
        })
      if (outcome._tag === "Done") {
        steeredAs.set(update, [...(steeredAs.get(update) ?? []), utterance])
        yield* noted({ how: outcome.how, ...(outcome.waiting === undefined ? {} : { waiting: outcome.waiting }) })
        yield* Effect.logInfo(`Delivered through T3 Code (${outcome.how}): ${withheld || T3Actions.revealing(message) ? "something that could give a secret away" : message}`)
        yield* answeredNow(update)
        if (outcome.waiting !== undefined || Hands.held(outcome)) return { said: Hands.done(act, outcome.how, lines, Option.none(), outcome) }
        return outcome.how === "queued" ? ("queued" as const) : ("sent" as const)
      }
      yield* unregister(pending)
      // The same words went to it lately, may have, or never left yapd: said, never asked about, until replies go through the brain.
      const twin = (row: Ledger.Row) =>
        row.state === "sent" ? Hands.sentBefore(row.at, at, lines, Option.none()) : row.state === "failed" ? Hands.unsentBefore(lines) : Hands.unconfirmedBefore(lines)
      const reason =
        outcome._tag === "Twin"
          ? twin(outcome.row)
          : "reason" in outcome
            ? Hands.failed(act, "again" in outcome ? { ...outcome, again: Option.none<string>() } : outcome, lines, Option.none())
            : `That didn't go through${lines.address.trim() === "" ? "" : `, ${lines.address.trim()}`}.`
      yield* noted("reason" in outcome ? { reason: outcome.reason } : outcome._tag === "Twin" ? { twin: outcome.row.commandId, state: outcome.row.state } : {})
      return yield* new RelayError({ reason })
    })

  /** Dispatches queued replies in order, without holding up incoming hooks or other sessions. */
  const sendNext = (session: string): Effect.Effect<void> => Effect.gen(function* () {
    const pending = yield* Effect.gen(function* () {
      const channel = followed.get(session)
      if (channel === undefined || channel.current !== undefined) return undefined
      const power = yield* switched
      if (!power.on) {
        channel.queued.length = 0
        yield* release(channel.hook)
        return undefined
      }
      const followUp = channel.queued.shift()
      return followUp === undefined ? undefined : yield* register(followUp, channel)
    }).pipe(events.withPermits(1))
    if (pending === undefined) return
    yield* deliver(pending).pipe(
      Effect.zipRight(late(pending.followUp.update, `Sent the queued message: ${pending.followUp.message}`, false, true)),
      Effect.catchAll(({ reason }) => late(pending.followUp.update, `Couldn't send the queued message "${pending.followUp.message}". ${reason}`, true, true)),
    )
  })

  /** Called with the event lock held. Unrelated input cancels queued replies to the old work. */
  const invalidate = (session: string) => Effect.gen(function* () {
    activity.set(session, { chain: {} })
    const channel = followed.get(session)
    followed.delete(session)
    for (const queued of channel?.queued ?? []) {
      yield* Effect.forkIn(late(queued.update, `That work moved on, so I didn't send the queued message "${queued.message}".`, true, true), lifetime)
    }
  })

  /** What's to be said next, if anything is: only answers while one is on its way, and while yapd is off only what he asked. */
  const following = STM.gen(function* () {
    const { on } = yield* TRef.get(power)
    return Inbox.next(yield* TRef.get(inbox), !on || (yield* TRef.get(awaited)).length > 0)
  })

  /** Whether what's being said took the pause between lines already, as the moment after it ended once something waited to be said next. */
  let paused = false

  /** When he last started dictating, or something he said back was taken up, by the clock: never yet since yapd started. */
  let spoke: number | undefined
  /** Notes he's at hand, as he just started dictating, or something he said back was taken up. */
  const heardHim = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.sync(() => {
      spoke = now
    }),
  )
  /** Whether he's at hand, as he dictated or was taken up on a reply lately: kept only in memory, so after a restart, not until he speaks. */
  const present = Effect.map(Clock.currentTimeMillis, (now) => spoke !== undefined && now - spoke < nearby)
  yield* Effect.forkIn(Effect.forever(Effect.zipRight(dictationStarted, Effect.zipRight(heardHim, dictationOver))), lifetime)

  const turnOff = options.off
  const conversation = yield* Conversation.make({
    dir,
    moved: (update) => Effect.sync(() => moved(update)),
    send: (update, message) => update.about !== undefined && options.hands !== undefined && steered(update) ? steer(update, update.about, options.hands, message) : Effect.gen(function* () {
      const pending = yield* Effect.gen(function* () {
        if (moved(update)) return yield* new RelayError({ reason: Conversation.movedOn })
        const { on } = yield* switched
        if (!on) return yield* new RelayError({ reason: "yapd is off, so I didn't send it." })
        const session = update.session
        let channel = followed.get(session)
        if (channel === undefined) {
          channel = { thread: update.thread, queued: [] }
          followed.set(session, channel)
        }
        const followUp = { update, message }
        if (channel.current !== undefined || channel.queued.length > 0) {
          channel.queued.push(followUp)
          return undefined
        }
        return yield* register(followUp, channel)
      }).pipe(events.withPermits(1))
      if (pending === undefined) return "queued" as const
      yield* deliver(pending)
      return "sent" as const
    }),
    late,
    replied: Effect.zipRight(heardHim, PubSub.publish(replied, undefined)),
    saying: (update, line) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.sync(() => {
          if (latest?.update === update) latest = { ...latest, said: line, at, playing: true }
        }),
      ),
    // Only what goes to its thread by yapd's own hand, which is held back when it could give a secret away. Asked of whatever he
    // says for its agent, which a "scratch that" said next is about, never a mute he made over it before.
    withholds: (update, message) =>
      Effect.zipRight(
        Effect.sync(() => changedOver.delete(update)),
        update.about !== undefined && options.hands !== undefined && steered(update) ? options.hands.keeps(update.about, message) : Effect.succeed(false),
      ),
    // "Mute it" said over an update, plainly his and in so many words, is its thread muted: never anything sent to its agent. So is "read
    // me its subagents", or "stop reading its subagents", the thread's whose update it is, or the one a subagent's is part of. "Scratch
    // that" said next takes it back, rather than be the model's to make something of, which could take it for something to tell the
    // agent. What he says in between that isn't for its agent, like a cough heard as "Thank you." or the "Scratch" of "Scratch...
    // that", leaves it to be taken back, for as long as it's the last change he made.
    mute: (update, heard, voiced, echo): Option.Option<Conversation.Hooked> => {
      const muted = controls
      const plain = echo === undefined && voiced >= Brain.faintest
      const made = changedOver.get(update)
      // How yapd talks, like "focus" or "talk shorter", plainly his and in so many words, is changed here, and never reaches the agent:
      // what it changed, if it did, is what "scratch that" handed over next takes back.
      const commanded = plain && options.command !== undefined ? options.command(heard, update.needsYou) : Option.none()
      if (Option.isSome(commanded)) {
        changedOver.delete(update)
        modeChangedOver.delete(update)
        return Option.some({
          _tag: "Done",
          made: "mode",
          doing: Effect.gen(function* () {
            const before = yield* Clock.currentTimeMillis
            const said = yield* commanded.value
            const last = options.modeChange === undefined ? Option.none<Modes.Change>() : yield* options.modeChange
            if (Option.isSome(last) && last.value.at >= before) modeChangedOver.set(update, last.value.at)
            return said
          }),
        })
      }
      if (muted === undefined || !plain) return Option.none()
      if (made !== undefined && Brain.takesBack(heard)) {
        changedOver.delete(update)
        return Option.some({
          _tag: "Done",
          made: "mute",
          doing: Effect.gen(function* () {
            const [lines, now] = [yield* persona.lines, yield* Clock.currentTimeMillis]
            // Only while it's still the last change he made, made in the last two minutes.
            const last = options.mutes === undefined ? Option.none<Mutes.Change>() : yield* options.mutes.last
            if (!Option.exists(last, ({ at }) => at === made)) return Brain.muteLines(lines, "it", now).unchanged
            return Brain.takenBack(lines, yield* muted.undo, now)
          }),
        })
      }
      const asked = Mutes.command(heard)
      // Anything else about mutes, like "mute the Tezos one", "mute it for a bit" or "what's muted?", or about which subagents are read,
      // like "can you read me its subagents", is yapd's assistant's to work out, which knows his threads, never the Responder's, which
      // knows only this one, and could take it for something to tell the agent. Without the assistant, it's the shortcut's.
      if (Option.isNone(asked)) {
        if (Mutes.aboutSubagents(heard)) return Option.some({ _tag: "Over", line: Effect.map(persona.lines, (lines) => Brain.subagentLines(lines, "it").elsewhere) })
        return Mutes.aboutMuting(heard) ? Option.some({ _tag: "Over", line: Effect.map(persona.lines, (lines) => Brain.muteLines(lines, "it", 0).elsewhere) }) : Option.none()
      }
      changedOver.delete(update)
      const { how, minutes } = asked.value
      /** What he changed over it, for "scratch that" right after to take back. */
      const noted = (changed: boolean) =>
        Effect.gen(function* () {
          const last = options.mutes === undefined || !changed ? Option.none<Mutes.Change>() : yield* options.mutes.last
          if (Option.isSome(last)) changedOver.set(update, last.value.at)
          return changed
        })
      return Option.some({
        _tag: "Done",
        made: "mute",
        doing: Effect.gen(function* () {
          const lines = yield* persona.lines
          const now = yield* Clock.currentTimeMillis
          const said = Brain.muteLines(lines, "it", now)
          if (how === "clear") return said.cleared(yield* noted((yield* muted.clear).length > 0))
          if (how === "subagents" || how === "nosubagents") {
            const reading = Brain.subagentLines(lines, "it")
            // A subagent's are the thread's it's part of, which is the only one he can have them read to him of.
            const head = update.subagent === undefined ? (update.about ?? update.owner) : update.subagent.head?.ref
            if (head === undefined) return update.subagent === undefined ? reading.session : lines.cantTell
            const on = how === "subagents"
            const changed = yield* noted(
              yield* muted.subagents({ key: Mutes.key.thread(head), ...(update.subagent?.head?.called === undefined ? {} : { called: update.subagent.head.called }), project: update.project }, on),
            )
            if (!on) return changed ? reading.off : reading.notOn
            if (!changed) return reading.already
            // A lasting setting, which reads nothing now: what they said so far is for him to ask about.
            return (yield* Missed.keptBy(journal, head, now)) ? `${reading.on} ${reading.kept}` : reading.on
          }
          // Said again for the menu's row, it's that row's, which is what he asked to hear. Otherwise by its thread when it's tied to one,
          // else by its session.
          const menu = latest?.update === update ? latest.menu : undefined
          const row = menu === undefined ? Option.none<Mutes.About>() : Mutes.parse(menu)
          const keys = Mutes.keysOf(update, called)
          const [key, ...also] = menu !== undefined && Option.isSome(row) ? [menu, ...keys.filter((other) => other !== menu)] : keys
          if (key === undefined) return lines.cantTell
          // Muted by its session too, before it was found to be its thread's.
          if (how === "unmute") return (yield* noted(yield* muted.unmute(key, also))) ? said.unmuted : said.notMuted
          const ends = minutes === undefined ? undefined : now + minutes * 60_000
          const session = Option.isSome(row) ? row.value._tag === "Session" : update.about === undefined && update.owner === undefined && update.subagent === undefined
          const agent = update.thread.agent === "codex" ? "Codex" : "Claude"
          const machine = Option.match(row, {
            onNone: () => (update.thread.origin.host === undefined ? undefined : called(update.thread.origin.host)),
            onSome: (row) => (row._tag === "Session" ? row.machine : row.ref.machine),
          })
          const where = machine === undefined || machine === called(hostname()) ? "" : ` on ${machine}`
          // A subagent, which is never on the desk, by what it's called.
          const child = update.subagent !== undefined && key === Mutes.key.thread(update.subagent.child) ? update.subagent.called : undefined
          const name = session ? `the ${agent} session ${Threads.inProject(update.project)}${where}` : child
          const done = yield* muted.mute({ key, project: update.project, ...(name === undefined ? {} : { called: name }) }, ends)
          return (yield* noted(done)) ? said.muted(ends) : said.already
        }),
      })
    },
    // What's yapd's to do, handed over, with what's known of the update here: whether what's said over it goes to its thread by yapd's
    // own hand, whether he's at hand, and what the line he spoke over or just heard says yapd changed, which "scratch that" reaches.
    // Acted on while he's at hand, he's still at hand, as when anything he says back is taken up. Handed over while he isn't, as a TV's
    // talk may be, it never puts him at hand: what it came to may be no more than what only his word does turned down, and the next
    // such talk would be acted on.
    ...(options.over === undefined
      ? {}
      : {
          over: (update: Conversation.Update, lines: ReadonlyArray<Line>, line: string, made: Conversation.Made, muting: boolean): Conversation.Handing =>
            (heard, voiced, echo, afterPause, unsaid) =>
              Effect.gen(function* () {
                const given: Assistant.Over = { steered: steered(update), present: yield* present, done: doneBy(update, made), ...(muting ? { muting: true } : {}) }
                const handed = yield* options.over!(update, lines, line, given)(heard, voiced, echo, afterPause, unsaid)
                return handed._tag === "Act" && given.present
                  ? { ...handed, run: (running: Conversation.Running) => Effect.zipRight(heardHim, handed.run(running)) }
                  : handed
              }),
        }),
    ...(options.routines === undefined ? {} : { routines: options.routines }),
    // "Mute." said on its own over anything yapd says, or right after, is his emergency off. It's turned off from outside what's being
    // said, as the menu turns it off, which cuts that off as it does anything being said, keeping it unheard: so this waits to be cut
    // off, and comes back only should yapd stay on.
    ...(turnOff === undefined
      ? {}
      : {
          off: Effect.gen(function* () {
            yield* Effect.logInfo("Turned off: he said mute")
            yield* Fiber.join(yield* Effect.forkIn(turnOff, lifetime))
            if (!(yield* switched).on) yield* Effect.never
          }),
        }),
    // Once something waits to be said next, the moment after a line played through for "Mute." alone, like a notice, is over after the
    // pause between lines, so what's next starts then, with no pause of its own.
    queued: STM.commit(STM.flatMap(following, (ready) => (ready === undefined ? STM.retry : STM.void))).pipe(
      Effect.zipRight(
        Effect.sync(() => {
          paused = true
        }),
      ),
    ),
    // Once an answer he asked for waits to be said next, the wait for a reply after an answer, or after a line listened to from its end,
    // is over soon after it ended, and the answer follows with no pause of its own.
    asked: STM.commit(
      STM.flatMap(TRef.get(inbox), (waiting) => ([...waiting.values()].some((entry) => "notice" in entry && entry.notice.kind === "answer") ? STM.void : STM.retry)),
    ).pipe(
      Effect.zipRight(
        Effect.sync(() => {
          paused = true
        }),
      ),
    ),
  })

  const unsummarized = (project: string): Summary => ({
    priority: "done",
    spoken: `${project.trim() !== "" && speakable(project) ? project : "One of your threads"} finished a turn, but I couldn't summarize it.`,
  })

  /** A turn that finished, to sum up and queue, and what it's for. */
  interface Finished {
    readonly session: string
    readonly project: string
    /** For a hook's, whether its work is outside his projects all the same, worked out before it's summed up: then it's in none. */
    readonly outside?: Effect.Effect<boolean>
    readonly turn: Turn
    readonly thread: Thread
    readonly arrivedAt: number
    readonly generation: { readonly chain: object }
    readonly hook: Ticket | undefined
    /** Whether its Stop hook waits for a reply, which then goes back through it, even once a queued follow-up holds it. */
    readonly hooked: boolean
    readonly needsYou: boolean
    readonly turns: number
    /**
     * For a hook's, finding the T3 Code thread it came from, alongside the
     * summary: here, or on another machine, for what's kept, shown and muted
     * of it only, or one of T3 Code's own subagents, on either.
     */
    readonly finding?: Finding
    /**
     * The T3 Code thread it's known to be from before anything is worked out,
     * like a turn T3 Code told of, which it's then about, and to find what was
     * said of it last.
     */
    readonly known?: Threads.Ref
    /** For a turn no hook told of, said in its hook's place, which is said once, ever, under its key. */
    readonly fallback?: Fallback
    /** Whether it answers what he asked of it himself, a follow-up by voice or a message yapd sent it, which is said however he muted its thread. */
    readonly answering: boolean
    /**
     * For a turn said in its hook's place, the id of the message its run
     * began with, as T3 Code has it, none when it began with none: what alone
     * tells whether it's the first turn of work yapd started, which is what
     * he asked for, however slight.
     */
    readonly began?: Option.Option<string>
    /** The prompt its turn began with, through the hooks or as T3 Code has its run, and when, to tell whether it's one yapd sent its thread. */
    readonly prompted?: { readonly text: string | undefined; readonly at: number }
    /**
     * For a Stop whose turn was said in its hook's place, but kept quiet as
     * he muted its thread, held or kept as yapd was off, that turn: the Stop
     * is said only if it needs him, as otherwise the turn was kept quiet
     * already, and not even then once he heard that turn since.
     */
    readonly over?: Fallback
    /**
     * For a Stop, the turn said in its hook's place that it is by its own
     * words, whose entry its own takes the place of: that turn is read and
     * counted once, as this, and heard with it, never before.
     */
    readonly replaced?: Fallback
    /** The Stop it's of, for a hook's. */
    readonly stop?: Notices.Stop
    /** For a hook's, whether its turn began before yapd started, as no hook of its session came since, so its prompt isn't known. */
    readonly unprompted?: boolean
  }

  /** Finding the T3 Code thread a hook came from, here or on another machine, with what's logged when its answer doesn't come in time. */
  interface Finding {
    readonly here: boolean
    readonly find: (promising: Deferred.Deferred<void>) => Effect.Effect<Option.Option<Threads.Linked>>
    readonly late: string
  }

  /** A failure is owed once what all the Stops it was left to told of is kept quiet. */
  const due = (owing: Owed) => !owing.told && owing.stops.every((stop) => hushed.has(stop))

  /** What a Stop told of was kept quiet: a failure left to it, and to no Stop he heard, is said after all. */
  const quieten = (stop: Notices.Stop | undefined) =>
    Effect.suspend(() => {
      if (stop === undefined) return Effect.void
      hushed.add(stop)
      const owing = owed.get(stop)
      if (owing === undefined || !due(owing)) return Effect.void
      owing.told = true
      return Effect.asVoid(Effect.forkIn(owing.failure, lifetime))
    })

  /**
   * What he asked to hear of a thread's finishing, fired to lead an update he
   * never heard after all, said on its own, each under the entry it was
   * fired under: apart from what dropped the update, so nothing waits on it.
   */
  const apart = (led: Effect.Effect<void> | undefined) =>
    led === undefined ? Effect.void : Effect.asVoid(Effect.forkIn(Effect.zipRight(Effect.logInfo("Saying on its own what he asked to hear of its finishing, as its update won't be"), led), lifetime))

  /** An update done with before he heard it: what led it is said on its own, once. */
  const parted = (update: Conversation.Update) =>
    Effect.suspend(() => {
      const led = alone.get(update)
      alone.delete(update)
      return apart(led)
    })

  /** A failure left to these Stops: said at once if what they told of was kept quiet already, or else once it is, if it ever is. */
  const unheardFailure = (stops: ReadonlyArray<Notices.Stop>, failure: Effect.Effect<void>) =>
    Effect.suspend(() => {
      const owing: Owed = { stops, failure, told: false }
      if (stops.length > 0 && due(owing)) {
        owing.told = true
        return failure
      }
      for (const stop of stops) owed.set(stop, owing)
      return Effect.void
    })

  /** A Stop whose turn was said, or kept quiet, in its hook's place from T3 Code's word, kept as such, so the journal still has what its hook told of. */
  const passedThrough = (at: number, thread: Thread, project: string, over: Fallback, session: string) =>
    journal.write({
      at,
      kind: "action",
      host: thread.origin.host,
      project,
      machine: over.about.machine,
      thread: over.about.id,
      directory: thread.cwd,
      text: thread.message,
      detail: { through: over.key, session },
    })

  /**
   * Why an update is kept quiet: he muted its thread, or it's held for later,
   * by focus or quiet, or as progress for the digest, or it's one of T3 Code's
   * own subagents', whose thread he doesn't have them read to him of.
   */
  type Quieting =
    | { readonly _tag: "Muted"; readonly mute: Mutes.Mute }
    | { readonly _tag: "Held"; readonly why: Held }
    | { readonly _tag: "Subagent"; readonly child: Threads.Ref; readonly head: Option.Option<Threads.Head> }

  /**
   * Keeps quiet an update whose thread he muted, that's held for later, as
   * when yapd is off, or that's a subagent's he doesn't have read to him: its
   * Stop hook is let go of at once, and it's kept, marked as kept quiet or
   * held, for what he missed, but never said; a turn said in a hook's place,
   * kept so under its key, is the turn's, so its own Stop coming late isn't
   * said either, unless it needs him. Muted by its session, the mute becomes
   * its thread's, `keys` its own; never one of the thread a subagent is part
   * of. `claimed` is its entry under its key, when it was kept already, as
   * when the mute, the mode or turning yapd off came while it was being
   * rendered.
   */
  const hush = (finished: Finished, entry: Entry, detail: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>, quieting: Quieting, claimed?: Option.Option<number>) =>
    Effect.gen(function* () {
      const { fallback, hook, project } = finished
      yield* release(hook)
      const quiet = quieting._tag === "Held" ? { ...detail, held: quieting.why } : { ...detail, muted: true }
      if (fallback === undefined) yield* journal.write({ ...entry, detail: quiet })
      else if (claimed !== undefined) yield* quieting._tag === "Held" ? journal.hold(Option.toArray(claimed), quieting.why) : journal.mute(Option.toArray(claimed))
      else {
        // Given way since to a Stop of its own, or its thread started again or went, it's left to that.
        if (fallbacks.get(fallback.key) !== fallback || !(yield* fallback.current)) {
          return yield* Effect.logInfo("Skipped a turn no hook told of, since its hook came or its thread started again")
        }
        const kept = yield* Effect.uninterruptible(journal.claim({ ...entry, detail: quiet, key: fallback.key }))
        if (Option.isNone(kept)) return yield* Effect.logInfo("Skipped update, kept already")
        const row = Option.flatten(kept)
        if (Option.isSome(row)) fallback.row = row.value
      }
      // Kept quiet in its hook's place, it's the turn's, as one he told to stop is, but what of it needs him is still said.
      if (fallback !== undefined) {
        fallback.heard = true
        fallback.quiet = true
      }
      // What its Stop told of isn't said now, so a failure left to it is handed on after all: while yapd is off, or was turned off since,
      // that keeps it unheard, apart, so it leads a catch-up, and muting the thread later never keeps it quiet.
      yield* quieten(finished.stop)
      if (quieting._tag === "Held") return yield* Effect.logInfo(`Held update for ${project}, for later (${quieting.why})`)
      if (quieting._tag === "Subagent") {
        return yield* Effect.logInfo(
          Option.match(quieting.head, {
            onNone: () => `Held update from a subagent whose thread can't be found on ${quieting.child.machine}`,
            onSome: ({ ref, called }) => `Held update from a subagent of ${called} on ${ref.machine}`,
          }),
        )
      }
      // Only a session's mute is moved, so the mute of the thread a subagent is part of is never moved onto the subagent.
      const thread = keys.find((key) => key.startsWith("t3:"))
      if (thread !== undefined && quieting.mute.key !== thread && quieting.mute.key.startsWith("session:") && options.mutes !== undefined) {
        yield* options.mutes.rekey(quieting.mute.key, thread)
      }
      yield* Effect.logInfo(`Muted update for ${project}`)
    })

  /** Focus or quiet, while one is on. */
  const holdingNow = options.holding ?? Effect.succeedNone

  /**
   * Why an update a mute could keep quiet is held for later instead, if it
   * is: focus or quiet, or, said only in its headline, that it's progress,
   * for the digest. Never what a mute couldn't keep quiet.
   */
  const holds = (priority: Inbox.Ready["priority"], full: boolean) =>
    Effect.map(holdingNow, (mode): Option.Option<Held> =>
      Option.isSome(mode) ? mode : priority === "progress" && !full ? Option.some("progress") : Option.none(),
    )

  /**
   * Why an update is held for later, if it is: what a mute could keep quiet,
   * as `holds` says; and the first turn of work yapd started, which answers
   * what he asked, only by quiet, for the morning's rundown, unless it needs
   * him. Nothing else he asked for is held.
   */
  const heldFor = (priority: Inbox.Ready["priority"], full: boolean, mutable: boolean, opening: boolean) =>
    mutable
      ? holds(priority, full)
      : opening && priority !== "needs-you"
        ? Effect.map(holdingNow, Option.filter((mode): mode is "quiet" => mode === "quiet"))
        : Effect.succeedNone

  /**
   * Whether a hook's turn whose prompt came before yapd started answers what
   * he said by voice back through its hook before then: the journal has it
   * sent to the session after the last update kept of it, within the hour.
   */
  const repliedBefore = (session: string, arrivedAt: number) =>
    Effect.map(journal.since(arrivedAt - forgotten, { kinds: ["sent", "update"], most: 200 }), (kept) => {
      const ours = kept.filter(
        (row) =>
          row.at <= arrivedAt &&
          (row.thread === session || (row.kind === "update" && (row.detail as { readonly session?: unknown } | undefined)?.session === session)),
      )
      return ours.at(-1)?.kind === "sent"
    })

  /** Whether yapd is off, or was turned off or on since `turns`, so nothing that came in by then is said. */
  const offSince = (turns: number) => Effect.map(switched, (power) => !power.on || power.turns !== turns)

  /** How long before a turn's prompt came what yapd sent its thread still counts as what began it, as it's kept before it goes out. */
  const sending = 60_000

  /** What yapd sent a thread that a turn arriving at `arrivedAt` may answer: the work it started within the day, the rest within the hour. */
  const answerable = (to: Threads.Ref, arrivedAt: number) =>
    options.sent === undefined
      ? Effect.succeed([])
      : Effect.map(options.sent(to, arrivedAt - lastDay), (rows) =>
          rows.filter(({ at, kind }) => at <= arrivedAt && (kind === "start" || at >= arrivedAt - forgotten)),
        )

  /** What a turn answers, out of what it was matched with: the work yapd started over anything sent it since. */
  const answered = (rows: ReadonlyArray<{ readonly kind?: Ledger.Kind }>): Option.Option<"start" | "sent"> =>
    rows.some(({ kind }) => kind === "start") ? Option.some("start") : rows.length > 0 ? Option.some("sent") : Option.none()

  /**
   * What of what yapd sent its thread for him a hook's turn answers, if any:
   * sent a little before its prompt came, or steered into it since, or sent
   * in its prompt's words, as a message that waited in T3 Code's queue, or the
   * work it started, by its words, however long it took to get ready. One
   * that went into the queue once the turn was under way waits for a turn of
   * its own, which it begins in its words: the turn it waited behind isn't
   * his. For a turn said in its hook's place, its run's prompt and start, as
   * T3 Code has them. A hook's turn whose prompt never came through the
   * hooks, as when it began before yapd restarted, goes by what's kept:
   * the work yapd started, while nothing of the thread was kept since, or what
   * it sent after the last that was. Wherever T3 Code says which message
   * began its run, as its run has it for a turn said in its hook's place,
   * the work yapd started is answered only by the turn its own message began,
   * whatever when it came or its words say: a first turn that was stopped,
   * or left nothing kept, isn't answered by the next, nor is the work by a
   * follow-up sent soon after. With it, whether that told by id whether it's
   * the first turn of work yapd started: not when what yapd sent its thread
   * couldn't be read, nor, with that work among what it may answer, which
   * message began its run.
   */
  const asked = (to: Threads.Ref, finished: Finished) =>
    Effect.gen(function* () {
      const { prompted, arrivedAt } = finished
      const rows = yield* answerable(to, arrivedAt)
      if (rows.length === 0) return { answers: Option.none(), told: true }
      const last = prompted === undefined ? ((yield* journal.byThread(to.machine, to.id, 1, ["update"]))[0]?.at ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY
      const candidates = rows.filter(({ at }) => at > last)
      // Which message its run began with, as T3 Code has it, read only when it may be the work yapd started that it answers.
      const began =
        finished.began !== undefined
          ? Option.some(finished.began)
          : options.began !== undefined && candidates.some(({ kind }) => kind === "start")
            ? yield* options.began(to)
            : Option.none()
      /** Whether a row is the work yapd started, begun with the message its run began with, when T3 Code says which: none when it can't. */
      const opened = ({ messageId }: { readonly messageId?: string | null }) =>
        Option.map(began, (id) => Option.exists(id, (began) => began === messageId))
      const told = Option.isSome(began) || !candidates.some(({ kind }) => kind === "start")
      if (prompted === undefined) {
        return { answers: answered(candidates.filter((row) => row.kind !== "start" || Option.getOrElse(opened(row), () => true))), told }
      }
      const words = prompted.text === undefined ? "" : Ledger.digest(prompted.text)
      const answers = answered(
        candidates.filter((row) =>
          Option.getOrElse(
            row.kind === "start" ? opened(row) : Option.none(),
            () => (words !== "" && row.digest === words) || (row.at >= prompted.at - sending && (row.at <= prompted.at || row.how !== "queued")),
          ),
        ),
      )
      return { answers, told }
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.as(Effect.logWarning("Could not tell whether it answers what I sent it", cause), { answers: Option.none<"start" | "sent">(), told: false }),
      ),
    )

  /**
   * Whether he heard since the entry of a turn kept quiet in its hook's
   * place, as in a catch-up, from the menu or in a digest, so its Stop come
   * late, of `priority`, tells him nothing new. Never when the Stop needs him
   * and what he heard didn't, which asked him nothing, nor when it was held
   * as progress, which is put aside unheard once newer work is heard.
   */
  const heardSince = (row: number, priority: Summary["priority"], all: string) =>
    Effect.map(journal.rows([row]), (kept) =>
      kept.some((entry) => {
        const { heardAt, detail } = entry
        const { held, priority: was } = (typeof detail === "object" && detail !== null ? detail : {}) as { readonly held?: unknown; readonly priority?: unknown }
        return heardAt !== undefined && held !== "progress" && (priority !== "needs-you" || was === "needs-you") && sameWords(Missed.full(entry), all)
      }),
    )

  /** Whether two lines say the same, word for word, whatever their case, spacing or punctuation: only then is one surely all of the other. */
  const sameWords = (one: string, other: string) => {
    const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    return words(one) !== "" && words(one) === words(other)
  }

  /**
   * Whether a Stop come late, of `priority`, summed up or not, tells at least
   * what the entry of its turn kept in its hook's place did, so it may take
   * that entry's place: summed up, needing him when that did, and said
   * whatever he mutes when that was. Otherwise both are kept, told twice at
   * worst, never one hidden behind a line that says less.
   */
  const outranks = (row: number, priority: Summary["priority"], summarized: boolean, mutable: boolean, all: string) =>
    summarized
      ? Effect.map(
          journal.rows([row]),
          (kept) =>
            kept.length > 0 &&
            kept.every((entry) => {
              const { priority: was, audible } = (typeof entry.detail === "object" && entry.detail !== null ? entry.detail : {}) as {
                readonly priority?: unknown
                readonly audible?: unknown
              }
              return (was !== "needs-you" || priority === "needs-you") && (audible !== true || !mutable) && sameWords(Missed.full(entry), all)
            }),
        )
      : Effect.succeed(false)

  /**
   * An update that couldn't be got ready, so nothing of it was said or kept:
   * its Stop told of nothing, and a turn said in its hook's place is let go
   * of, so T3 Code's word for either, heard again, tries it again, said once
   * all the same under its run's key.
   */
  const unprepared = (finished: Finished) =>
    Effect.sync(() => {
      if (finished.stop !== undefined) finished.stop.skipped = "dropped"
      const { fallback } = finished
      if (fallback !== undefined && fallbacks.get(fallback.key) === fallback && !fallback.heard) fallbacks.delete(fallback.key)
    })

  /** What a hook's lookup gave, or nothing, should it have failed after all. */
  const found = (looking: Fiber.RuntimeFiber<Option.Option<Threads.Linked>>) =>
    Effect.map(Fiber.await(looking), Exit.match({ onFailure: () => Option.none<Threads.Linked>(), onSuccess: (linked) => linked }))

  /**
   * What a hook's lookup came to, `first` being what it said within three
   * seconds, if it did, as ever: what it says later counts only for a
   * subagent of T3 Code's own, once the summary is in too, and, while one at
   * work there was still to be read when it was last looked at, until ten
   * seconds after the hook came. Past that, it's taken for none, and so goes
   * the way hooks always have.
   */
  const settled = (
    finding: Finding,
    looking: Fiber.RuntimeFiber<Option.Option<Threads.Linked>>,
    first: Option.Option<Option.Option<Threads.Linked>>,
    promising: Deferred.Deferred<void>,
    arrivedAt: number,
  ) =>
    Effect.gen(function* () {
      if (Option.isSome(first)) return first.value
      /** A subagent's answer, which counts late; a thread's came too late, as ever. */
      const helper = (linked: Option.Option<Threads.Linked>) =>
        Option.exists(linked, ({ _tag }) => _tag === "Subagent") ? Effect.succeed(linked) : Effect.as(Effect.logInfo(finding.late), Option.none<Threads.Linked>())
      const now = yield* Fiber.poll(looking)
      if (Option.isSome(now)) return yield* helper(Exit.match(now.value, { onFailure: () => Option.none<Threads.Linked>(), onSuccess: (linked) => linked }))
      if (!(yield* Deferred.isDone(promising))) return yield* helper(Option.none())
      const left = arrivedAt + longest - (yield* Clock.currentTimeMillis)
      const later = left <= 0 ? Option.none() : yield* Effect.timeoutOption(found(looking), left)
      if (Option.isSome(later)) return yield* helper(later.value)
      yield* Effect.logInfo("Not linked: ran out of time looking among subagents")
      return Option.none<Threads.Linked>()
    })

  /** Whether he has the subagents of this thread read to him: never without one, or without mutes to keep the setting. */
  const reads = (head: Option.Option<Threads.Ref>) =>
    Option.isNone(head) || options.mutes === undefined ? Effect.succeed(false) : options.mutes.reads(Mutes.key.thread(head.value))

  const prepare = (finished: Finished) => {
    const { session, turn, thread, arrivedAt, generation, hook, needsYou, turns } = finished
    if (hook !== undefined) summing.set(session, hook)
    /** What he asked to hear of its finishing, once fired to lead it, until it's queued or kept: said on its own should it be neither. */
    let unsaid: Effect.Effect<void> | undefined
    return Effect.gen(function* () {
      // What was said or held of the same work lately, by its session or its thread, read here rather than once its thread is found,
      // which can take seconds: so "another review round" is told from news. Meanwhile, whether it's in T3 Code's scratch folder,
      // where it's in none of his projects, and what its hook names it, the folder's generated name, isn't one.
      const [outside, earlier] = yield* Effect.all([finished.outside ?? Effect.succeed(false), journal.previous(arrivedAt - lastDay, session, finished.known)], {
        concurrency: 2,
      })
      const project = outside ? "" : finished.project
      const previous = Option.map(earlier, (kept) => ({
        said: kept.said ?? "",
        ago: (arrivedAt - kept.at) / 60_000,
      }))
      // Its thread is looked for once, alongside its summary, and told when looking among subagents may pay.
      const { finding } = finished
      const promising = yield* Deferred.make<void>()
      const looking = finding === undefined ? undefined : yield* Effect.fork(finding.find(promising))
      const [[summary, summarized], first] = yield* Effect.all(
        [
          condenser.condense(project, Option.match(previous, { onNone: () => turn, onSome: (previous) => ({ ...turn, previous }) })).pipe(
            Effect.retry({ times: 1 }),
            Effect.map((summary) => [summary, true] as const),
            Effect.catchAll((error) => Effect.logWarning("Could not condense", error).pipe(Effect.as([unsummarized(project), false] as const))),
          ),
          looking === undefined ? Effect.succeedSome(Option.none<Threads.Linked>()) : Effect.timeoutOption(found(looking), lookup),
        ],
        { concurrency: 2 },
      )
      const linked = finding === undefined || looking === undefined ? Option.none<Threads.Linked>() : yield* settled(finding, looking, first, promising, arrivedAt)
      const threadOf = Option.flatMap(linked, (linked) => (linked._tag === "Thread" ? Option.some(linked.ref) : Option.none()))
      /** The thread it's from, here or, only for what's kept, shown and muted, on another machine. */
      const about = finding === undefined ? Option.fromNullable(finished.known) : finding.here ? threadOf : Option.none<Threads.Ref>()
      const owner = finding !== undefined && !finding.here ? threadOf : Option.none<Threads.Ref>()
      const tied = Option.orElse(about, () => owner)
      /** The subagent of T3 Code's own it's from, here or on another machine, for what's kept, shown and muted of it only. */
      const part = Option.flatMap(linked, (linked) => (linked._tag === "Subagent" ? Option.some(linked) : Option.none()))
      // What it answers of what yapd sent its thread for him, if anything: the first turn of work yapd started is what he asked for. And
      // whether that was told by id, which it can't be with no thread found in time.
      const { answers, told } = Option.isSome(tied) ? yield* asked(tied.value, finished) : { answers: Option.none<"start" | "sent">(), told: false }
      const opening = Option.contains(answers, "start")
      // What he asked to hear once it finishes leads it, as one: then it's what he asked for, however slight, and never kept quiet or held.
      // Saying how its turn ended: a turn T3 Code said finished did; a hook's goes by its run, and is never said to have finished when
      // that can't be read. One he stopped leaves it for the thread's next.
      const ended = (about: Threads.Ref): Effect.Effect<Reminders.Ending> =>
        finished.fallback !== undefined
          ? Effect.succeed({ _tag: "Finished" })
          : finished.stop !== undefined && options.ending !== undefined
            ? options.ending(about, finished.stop)
            : Effect.succeed({ _tag: "Unknown" })
      const reminders = Option.isSome(tied) && options.finishing !== undefined ? yield* options.finishing(tied.value, arrivedAt, ended(tied.value)) : []
      const reminded = reminders.length > 0
      // Whatever needs him is said in full, question and all, and so is everything once he asked to hear everything, when nothing is held
      // as progress. Otherwise only the headline is said, and the rest is kept for when he asks for more.
      const full = needsYou || summary.priority === "needs-you" || (yield* options.detail ?? Effect.succeed<Modes.Detail>("brief")) === "full"
      // Whoever sent it knows it needs the user, whatever the summary makes of it, and the first turn of work yapd started is never slight.
      const priority =
        needsYou ? "needs-you" : (full && summary.priority === "progress") || ((opening || reminded) && summary.priority === "trivial") ? "done" : summary.priority
      const more = full ? "" : (summary.more ?? "").trim()
      // What answers what yapd sent its thread for him, as a message by the shortcut or the work it started, is his own ask too, and so is
      // what answers what he said back through its hook before yapd restarted, when its prompt came before then.
      const answering =
        finished.answering ||
        (priority !== "needs-you" && Option.isSome(answers)) ||
        (priority !== "needs-you" && finished.unprompted === true && (yield* repliedBefore(session, arrivedAt)))
      // What needs him is said whatever he muted, and so is what answers what he asked of the thread himself. A turn that couldn't be
      // summed up may be either, as far as yapd can tell, so it's said.
      const mutable = priority !== "needs-you" && !answering && summarized && !reminded
      const summed = full ? [summary.spoken, summary.more ?? ""].map((part) => part.trim()).filter((part) => part !== "").join(" ") : summary.spoken
      // A subagent's, led by the thread it's part of rather than the project, which says whose it is.
      const head = Option.flatMap(part, ({ head }) => head)
      const spoken = Option.match(head, { onNone: () => introduce(project, summed), onSome: ({ called }) => `For ${called}: ${summed}` })
      // All it would tell, its rest too, as what was kept of its turn is weighed against it word for word.
      const all = Missed.whole(spoken, more)
      // Its turn was kept quiet in its hook's place, then heard since, as in a catch-up, from the menu or in a digest: it's said already.
      // Only by its own words, and only when what he heard was word for word what it tells: anything more, or else, is said.
      if (finished.over !== undefined && finished.replaced?.row !== undefined && (yield* heardSince(finished.replaced.row, priority, all))) {
        yield* release(hook)
        yield* passedThrough(arrivedAt, thread, project, finished.over, session)
        return yield* Effect.logInfo("Skipped update, heard already from T3 Code's word that it finished")
      }
      // Its turn was kept quiet in its hook's place: only what needs him of it, or may, or answers what he asked, is said now.
      if (finished.over !== undefined && mutable) {
        yield* release(hook)
        yield* passedThrough(arrivedAt, thread, project, finished.over, session)
        yield* quieten(finished.stop)
        return yield* Effect.logInfo("Skipped update, kept quiet already from T3 Code's word that it finished")
      }
      // Even a reply to a follow-up, since yapd already said it passed that on. When it couldn't be told by id whether it's the first turn
      // of work yapd started, its thread not found in time or what it was sent, or which message began its run, not read, its Stop told
      // of nothing: T3 Code's word, which can tell, says a turn of work yapd sent in its place, as what he asked for when it is. Otherwise
      // it's slight, and its Stop stands, so T3 Code's word leaves it to its hook.
      if (priority === "trivial") {
        yield* release(hook)
        if (finished.stop !== undefined && !told) finished.stop.skipped = "dropped"
        return yield* Effect.logInfo("Skipped trivial update")
      }

      // It takes the place of what was kept of its turn only when it tells word for word the same: otherwise both are kept, told twice at
      // worst, never one hidden behind the other, which may have told more, like a question asked before the last.
      const replaces =
        finished.replaced?.row !== undefined && (yield* outranks(finished.replaced.row, priority, summarized, mutable, all)) ? finished.replaced.row : undefined
      // Kept under the thread T3 Code knows it by, when it's linked, so what was said of it is found with the thread. What's said for more is
      // kept with it, so it's there once yapd restarts.
      const detail = {
        priority,
        ...Option.match(turn.prompt, { onNone: () => ({}), onSome: (prompt) => ({ prompt }) }),
        ...(Option.isSome(tied) || Option.isSome(part) ? { session } : {}),
        // A subagent's, kept under it, with the thread it's part of, by which a thread's subagents are found together.
        ...(Option.isSome(part) ? { subagent: true, ...Option.match(head, { onNone: () => ({}), onSome: ({ ref }) => ({ head: ref.id }) }) } : {}),
        ...(more === "" ? {} : { more }),
        // Said whatever he mutes, though it doesn't need him: the answer to what he asked its thread, or a turn yapd couldn't sum up. So
        // held as yapd was off, it isn't kept quiet when he mutes its thread later.
        ...(mutable || priority === "needs-you" ? {} : { audible: true }),
        // A Stop come late for a turn kept in its hook's place, by its own words: it takes the place of what was kept of that turn, so the
        // turn is read and counted once, as this, and what was kept is heard with it, never before.
        ...(replaces === undefined ? {} : { replaces }),
      }
      const entry: Entry = {
        at: arrivedAt,
        kind: "update",
        host: thread.origin.host,
        project,
        ...Option.match(Option.orElse(tied, () => Option.map(part, ({ child }) => child)), {
          onNone: () => ({ thread: session }),
          onSome: ({ machine, id }) => ({ machine, thread: id }),
        }),
        directory: thread.cwd,
        said: spoken,
        text: turn.message,
        detail,
      }
      const ties = {
        ...Option.match(about, { onNone: () => ({}), onSome: (about) => ({ about }) }),
        ...(Option.isSome(about) ? {} : Option.match(owner, { onNone: () => ({}), onSome: (owner) => ({ owner }) })),
        ...Option.match(part, {
          onNone: () => ({}),
          onSome: ({ child, called, head }) => ({
            subagent: { child, called, ...Option.match(head, { onNone: () => ({}), onSome: (head) => ({ head }) }) },
          }),
        }),
      }
      // Its own keys, which a session's mute moves to, and those that keep it quiet, a subagent's by the thread it's part of too.
      const own = Mutes.keysOf({ session, thread, ...ties }, called)
      const keys = Mutes.covering({ session, thread, ...ties }, called)
      // One of T3 Code's own subagents' is kept to yapd unless he has the thread it's part of read to him, whatever it is, as yapd is off,
      // in focus or quiet too, or its chain can't be followed up to one: before anything else, so it never leads a catch-up as what came in
      // while yapd was off, nor goes into the digest.
      const unread = Effect.map(reads(Option.map(head, ({ ref }) => ref)), (read) => Option.isSome(part) && !read)
      if (yield* unread) return yield* hush(finished, entry, detail, own, { _tag: "Subagent", child: Option.getOrThrow(part).child, head })
      const muted = mutable ? yield* muting(keys) : Option.none<Mutes.Mute>()
      if (Option.isSome(muted)) return yield* hush(finished, entry, detail, own, { _tag: "Muted", mute: muted.value })
      // Off, or turned off since it came, it's kept unheard, what needs him and the answer to what he asked too, for him to catch up on:
      // nothing that came in around turning off is said late. What he asked to hear of its finishing is kept so too.
      if (yield* offSince(turns)) {
        yield* Effect.forEach(reminders, ({ fire }) => fire(true), { discard: true })
        return yield* hush(finished, entry, detail, own, { _tag: "Held", why: "off" })
      }
      // Muted first, then kept as yapd is off, then held by the mode, then held as progress: kept the same way, by the same rule, and never rendered.
      const held: Option.Option<Held> = reminded ? Option.none() : yield* heldFor(priority, full, mutable, opening)
      if (Option.isSome(held)) return yield* hush(finished, entry, detail, own, { _tag: "Held", why: held.value })

      // Each fired as it's about to be said, once: one said on its own meanwhile is left out. Fired, each is said on its own should this
      // never be queued, as when its hook came or its thread started again meanwhile, or it can't be rendered.
      const led = yield* Effect.uninterruptible(
        Effect.tap(
          Effect.map(
            Effect.forEach(reminders, ({ line, fire, apart: own }) => Effect.map(fire(false), Option.map((row) => ({ line, row, own: own(row) })))),
            (fired) => fired.flatMap(Option.toArray),
          ),
          (led) =>
            Effect.sync(() => {
              if (led.length > 0) unsaid = Effect.forEach(led, ({ own }) => own, { discard: true })
            }),
        ),
      )
      const remindRows = led.flatMap(({ row }) => Option.toArray(row))
      const said = led.length === 0 ? spoken : [...led.map(({ line }) => line), spoken].join(" ")
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      // Rendering takes about as long as the speaker takes to get ready.
      yield* soon
      yield* voice.render(said, audio).pipe(Effect.onError(() => removeFile(audio)))
      const update: Conversation.Update = {
        session,
        project,
        turn,
        needsYou: priority === "needs-you",
        spoken: said,
        ...(more === "" ? {} : { more }),
        audio,
        thread,
        at: arrivedAt,
        ...ties,
      }
      generations.set(update, generation)
      if (finished.hooked) hooked.add(update)
      if (finished.stop !== undefined) stopOf.set(update, finished.stop)
      if (!mutable) audible.add(update)
      if (opening && !reminded) openings.add(update)
      if (remindRows.length > 0) leading.set(update, remindRows)
      // Said once ever: one already kept under its key was said, or held, before.
      const { fallback } = finished
      // Given way since to a Stop of its own, or its thread started again or went, it isn't said.
      if (fallback !== undefined && (fallbacks.get(fallback.key) !== fallback || !(yield* fallback.current))) {
        yield* removeFile(audio)
        return yield* Effect.logInfo("Skipped a turn no hook told of, since its hook came or its thread started again")
      }
      // Its entry is noted as it's kept, so giving way to a Stop of its own notes it as dealt with, however soon that comes.
      const claimed =
        fallback === undefined
          ? undefined
          : yield* Effect.uninterruptible(
              Effect.tap(journal.claim({ ...entry, key: fallback.key }), (claimed) =>
                Effect.sync(() => {
                  const row = Option.flatten(claimed)
                  if (Option.isSome(row)) fallback.row = row.value
                }),
              ),
            )
      if (claimed !== undefined && Option.isNone(claimed)) {
        yield* removeFile(audio)
        return yield* Effect.logInfo(`Skipped update, said already: ${spoken}`)
      }
      // Its subagents no longer read to him while it was rendered, a subagent's is kept to yapd all the same.
      if (yield* unread) {
        yield* removeFile(audio)
        return yield* hush(finished, entry, detail, own, { _tag: "Subagent", child: Option.getOrThrow(part).child, head }, claimed === undefined ? undefined : Option.flatten(claimed))
      }
      // Muted while it was rendered, it's kept quiet all the same, and held all the same once focus or quiet began meanwhile.
      const late = mutable ? yield* muting(keys) : Option.none<Mutes.Mute>()
      if (Option.isSome(late)) {
        yield* removeFile(audio)
        return yield* hush(finished, entry, detail, own, { _tag: "Muted", mute: late.value }, claimed === undefined ? undefined : Option.flatten(claimed))
      }
      // Turned off meanwhile, it's held for when he catches up, whatever mode began too, which would otherwise have the digest say it, and
      // what he asked to hear of its finishing with it.
      const off = { _tag: "Held", why: "off" } as const
      if (yield* offSince(turns)) {
        yield* removeFile(audio)
        yield* journal.hold(remindRows, "off")
        unsaid = undefined
        return yield* hush(finished, entry, detail, own, off, claimed === undefined ? undefined : Option.flatten(claimed))
      }
      const lateHeld: Option.Option<Held> = reminded ? Option.none() : yield* heldFor(priority, full, mutable, opening)
      if (Option.isSome(lateHeld)) {
        yield* removeFile(audio)
        return yield* hush(finished, entry, detail, own, { _tag: "Held", why: lateHeld.value }, claimed === undefined ? undefined : Option.flatten(claimed))
      }
      if (fallback !== undefined) standing.set(update, fallback)
      if (unsaid !== undefined) alone.set(update, unsaid)
      // Queued, what led it is said on its own only once it's done with unheard, which is noted in the same breath.
      const queued = yield* enqueue({ session, priority, arrivedAt, update, ...(hook === undefined ? {} : { hook }) }, turns).pipe(
        Effect.tap((queued) =>
          Effect.sync(() => {
            if (queued) unsaid = undefined
          }),
        ),
        Effect.uninterruptible,
      )
      if (!queued) {
        // Turned off just now, it's kept unheard all the same.
        yield* removeFile(audio)
        yield* journal.hold(remindRows, "off")
        unsaid = undefined
        return yield* hush(finished, entry, detail, own, off, claimed === undefined ? undefined : Option.flatten(claimed))
      }
      const row = claimed === undefined ? yield* journal.write(entry) : Option.flatten(claimed)
      if (Option.isSome(row)) rows.set(update, row.value)
      yield* Effect.logInfo(`Ready: ${spoken}`)
    }).pipe(
      workers.withPermits(1),
      // Its hook is let go of at once should yapd be turned off meanwhile, while it's still summed up and kept.
      Effect.ensuring(
        Effect.sync(() => {
          if (hook !== undefined && summing.get(session) === hook) summing.delete(session)
        }),
      ),
      // Never queued nor kept, however it ended, even stopped from outside, what was fired to lead it is said on its own.
      Effect.ensuring(
        Effect.suspend(() => {
          const led = unsaid
          unsaid = undefined
          return apart(led)
        }),
      ),
      // Stopped from outside, like when newer work of the same session comes in, which skips what's caught below.
      Effect.onInterrupt(() => release(hook)),
      Effect.catchAllCause((cause) =>
        Effect.zipRight(
          release(hook),
          Cause.isInterruptedOnly(cause) ? Effect.void : Effect.zipRight(unprepared(finished), Effect.logError("Could not prepare update", cause)),
        ),
      ),
      Effect.annotateLogs({ project: finished.project }),
    )
  }

  /** Lets a waiting Stop hook go without a reply, once. */
  const release = (hook: Ticket | undefined) =>
    Effect.suspend(() => {
      if (hook === undefined || released.has(hook)) return Effect.void
      released.add(hook)
      return waiting.close(hook)
    })

  /** Drops a session's pending update, whether it's still being prepared or already waiting. */
  const discard = (session: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(preparing, session)
      const dropped = yield* STM.commit(
        TRef.modify(inbox, (current) => [current.get(session), Inbox.remove(current, session)] as const),
      )
      if (dropped !== undefined) yield* removeFile(Inbox.audio(dropped))
      // What led it, he never heard, so it's said on its own.
      if (dropped !== undefined && "update" in dropped) yield* parted(dropped.update)
      // Its hook, if one waits, won't be getting a reply.
      yield* waiting.drop(session)
    })

  /** Whether a hook came from this machine. Read each time, since a Mac's hostname changes with the network. */
  const fromHere = (origin: Origin) => origin.host !== undefined && origin.host.toLowerCase() === hostname().toLowerCase()

  /**
   * How the T3 Code thread a hook came from is found: on this machine, where
   * what he says over it goes to it, or another's, for what's kept, shown and
   * muted of it only, either of them maybe one of T3 Code's own subagents.
   * None when there's no telling, which keeps its update on the old path.
   */
  const finding = (session: string, cwd: string, origin: Origin): Option.Option<Finding> => {
    const { link, owner } = options
    if (fromHere(origin)) {
      if (link === undefined) return Option.none()
      return Option.some({ here: true, find: (promising) => link(session, cwd, promising), late: "Not linked: T3 Code took too long to say which thread it is" })
    }
    const elsewhere = link === undefined ? Effect.void : Effect.logInfo(`Not linked: it came from ${origin.host ?? "a machine that didn't say"}`)
    const host = origin.host
    if (owner === undefined || host === undefined) return link === undefined ? Option.none() : Option.some({ here: false, find: () => Effect.as(elsewhere, Option.none()), late: "" })
    return Option.some({
      here: false,
      find: (promising) => Effect.zipRight(elsewhere, owner(host, session, cwd, promising)),
      late: `Not tied: ${host}'s T3 Code took too long to say which thread it is`,
    })
  }

  /**
   * Whether a hook's work is outside his projects, in the folder behind T3
   * Code's scratch project on the machine it ran on: by what's known of it,
   * never asked for here, and not when an answer on its way doesn't come in
   * a moment, so its summary is never held up for long.
   */
  const scratched = (cwd: string, origin: Origin): Effect.Effect<boolean> => {
    const { outside } = options
    if (outside === undefined) return Effect.succeed(false)
    return outside(called(origin.host ?? hostname()), cwd).pipe(
      Effect.timeoutOption(placing),
      Effect.map(Option.getOrElse(() => false)),
    )
  }

  /**
   * The Stops of these sessions in the last hour, oldest first, by the
   * agent's own ids for them, but those taken for a turn said in their hook's
   * place, which are its run's: a newer run that ended on the same words had
   * none of its own, and is said from T3 Code's word.
   */
  const stopsOf = (sessions: ReadonlyArray<string>) =>
    sessions
      .flatMap((session) => stops.get(session) ?? [])
      .filter((stop) => !taken.has(stop))
      .toSorted((a, b) => a.at - b.at)

  /** Turns said in a hook's place under this session that he isn't hearing and didn't hear, which are dropped with what's waiting under it. */
  const forsake = (session: string) => {
    for (const [key, fallback] of fallbacks) if (fallback.session === session && !fallback.heard) fallbacks.delete(key)
  }

  /**
   * A Stop came for a turn T3 Code's word may have been said of in its hook's
   * place, by the session its run had, `prompted` last through the hooks. One
   * he hasn't heard, still to be said or broken off, gives way to a Stop of
   * its own, or to one whose words can't be told, which is then dealt with,
   * as the Stop's own update is said in its stead. One he's hearing or heard
   * was the turn's, so such a Stop is given back for its update not to be,
   * and is that run's from then on: any of its own or whose words can't be
   * told while nothing started since (the thread is still on that run, and
   * no prompt came through the hooks since it was taken on); after, only one
   * with enough of its own words to tell its run by, as when its Stop comes
   * late, and not once a newer run's turn gave way to it. Anything else, like
   * a short "Done.", is the newer turn's, and said. Called with the event
   * lock held.
   */
  const giveWay = (session: string, stop: Notices.Stop, prompted: number | undefined) =>
    Effect.gen(function* () {
      /** The turn of the run its thread is still on that the Stop is, and the newest of a run the thread moved on from that it's by its words. */
      let still: Fallback | undefined
      let late: Fallback | undefined
      /** The newest turn he hasn't heard that gave way to it by its own words. */
      let instead: Fallback | undefined
      let withdrawn = false
      for (const fallback of [...fallbacks.values()].filter((fallback) => fallback.run.natives.includes(session))) {
        const whose = Notices.whose(stop, fallback.run)
        if (whose === "another") continue
        if (fallback.heard) {
          const moved = !(yield* fallback.current) || (prompted !== undefined && prompted > fallback.at)
          if (!moved && (still === undefined || whose === "own")) still = fallback
          if (moved && whose === "own" && Notices.telling(stop.message) && (late === undefined || fallback.at > late.at)) late = fallback
          continue
        }
        withdrawn = true
        if (whose === "own" && (instead === undefined || fallback.at > instead.at)) instead = fallback
        fallbacks.delete(fallback.key)
        yield* discard(fallback.session)
        yield* Effect.logInfo("Not saying a turn no hook told of, since its hook came after all")
      }
      // A turn still to be said gave way to it, like a newer run's that ended on the same words: whose Stop it is can't be told, so the hook wins.
      const through = still ?? (withdrawn ? undefined : late)
      if (through !== undefined) taken.add(stop)
      // What was kept of the turn it is by its own words is heard only with the Stop's entry, which takes its place. Nothing is noted as heard
      // now: should the Stop leave no entry, as a quick or trivial turn, or one cut short by newer work, a turn he heard was noted as he did,
      // and one he didn't is still to hear. One in words that can't be told keeps its own entry, as it may be another turn: told twice at worst.
      const replaced = through === undefined ? instead : Notices.whose(stop, through.run) === "own" ? through : undefined
      return { through, replaced }
    })

  /**
   * A turn said in its hook's place, as its turn to be said comes: being
   * heard, it's the turn's, so a Stop of its own coming later isn't said too;
   * unless it gave way to one already, or its thread is on another run by
   * now. Taken with the event lock held, so it's one or the other.
   */
  const begin = (fallback: Fallback) =>
    Effect.gen(function* () {
      if (fallbacks.get(fallback.key) !== fallback) return false
      if (!(yield* fallback.current)) {
        fallbacks.delete(fallback.key)
        return false
      }
      fallback.heard = true
      fallback.quiet = false
      return true
    }).pipe(events.withPermits(1))

  /**
   * A turn said in its hook's place that he didn't hear after all, like one
   * broken off by turning yapd off, or put back by a dictation to be read
   * again: it isn't the turn's until it's said again, so a Stop of its own
   * coming before then is said in its stead. Taken with the event lock held,
   * like `begin`, so a Stop coming as it ends finds it one or the other.
   */
  const unheard = (fallback: Fallback) =>
    Effect.sync(() => {
      fallback.heard = false
    }).pipe(events.withPermits(1))

  /**
   * A turn T3 Code says one of its threads finished, which no hook told of,
   * like one run by an agent yapd has no hooks for: summed up and said like a
   * hook's update, once ever under its `key`, unless a Stop of its own came,
   * said or skipped, or its thread started again or went. It's the thread's
   * own session to yapd, and a reply to it can only go through T3 Code. The
   * turn is its, or its Stop's, as decided with the event lock held, so
   * neither is said once the other is. For a turn of work yapd sent, a Stop
   * of its own whose update is still being got ready may yet tell of
   * nothing, which leaves it to T3 Code's word after all: what comes of it is
   * waited for, without the lock, and it's decided again.
   */
  const finished = (input: Notices.Finished): Effect.Effect<void> =>
    Effect.flatMap(handing(input), (undecided) =>
      undecided.length === 0 ? Effect.void : Effect.zipRight(Effect.forEach(undecided, Deferred.await, { discard: true }), finished(input)),
    )

  /** What `finished` does with the event lock held, giving the Stops it's left to whose updates are still being got ready, if any. */
  const handing = (input: Notices.Finished) =>
    Effect.gen(function* () {
      const none: ReadonlyArray<Deferred.Deferred<void>> = []
      // Not what notices about the thread go under, so neither takes the other's place.
      const session = `finished:${input.about.machine}:${input.about.id}`
      if (!(yield* input.current)) return yield* Effect.as(Effect.logInfo("Not saying a turn no hook told of, since its thread started again"), none)
      // A Stop of its own came, said or skipped, even since T3 Code's word was looked into: what it said, or why it wasn't, stands, once
      // it's known for a turn of work yapd sent.
      const hooks = Notices.hooking(stopsOf(input.run.natives), input.run, input.run.startedAt)
      if (hooks.length > 0) {
        const undecided = Notices.sent(input.run)
          ? yield* Effect.filter(
              hooks.flatMap((stop) => Option.toArray(Option.fromNullable(deciding.get(stop)))),
              (decided) => Effect.negate(Deferred.isDone(decided)),
            )
          : none
        if (undecided.length > 0) return undecided
        return yield* Effect.as(Effect.logInfo("Left to its hook"), none)
      }
      // Heard of twice, as after a reconnect, it's said the once, and the one on its way isn't put aside for it.
      if (fallbacks.has(input.key)) return none
      const at = yield* Clock.currentTimeMillis
      for (const [key, kept] of fallbacks) if (at - kept.at > forgotten) fallbacks.delete(key)
      const fallback: Fallback = {
        about: input.about,
        session,
        key: input.key,
        run: input.run,
        current: input.current,
        at,
        heard: false,
        quiet: false,
      }
      // What he said by voice back through the hook of one of its run's sessions, still waiting on its answer, is answered by it, as its Stop would be,
      // but only when it was sent a little before the run began or while it ran: one sent for an earlier run, whose Stop never came, isn't this one's.
      const followedUp = [...followed.values()].some(
        ({ current, sentAt }) =>
          current !== undefined &&
          sentAt !== undefined &&
          sentAt >= input.run.startedAt - sending &&
          sentAt <= input.at &&
          input.run.natives.includes(current.update.thread.session),
      )
      forsake(session)
      fallbacks.set(input.key, fallback)
      // A newer one for the thread takes the place of one waiting to be said, and a reply to that one is held back.
      const generation = { chain: {} }
      yield* invalidate(session)
      activity.set(session, generation)
      yield* discard(session)
      const thread: Thread = {
        agent: "claude",
        session: input.about.id,
        cwd: input.cwd,
        message: input.turn.message,
        origin: { host: hostname(), app: T3Code.bundle },
      }
      yield* FiberMap.run(
        preparing,
        session,
        prepare({
          session,
          project: input.project,
          turn: input.turn,
          thread,
          arrivedAt: input.at,
          generation,
          hook: undefined,
          hooked: false,
          needsYou: false,
          turns: input.turns,
          known: input.about,
          fallback,
          answering: input.answering === true || followedUp,
          // The message its run began with, which alone tells the first turn of work yapd started, by the message it started with.
          began: input.run.userMessageId,
          // Its run's prompt and start, so a message yapd sent the thread for him, steered into it or begun in its words, is told as a hook's is.
          prompted: { text: Option.getOrUndefined(input.turn.prompt), at: input.run.startedAt },
        }),
      )
      return none
    }).pipe(events.withPermits(1))

  /**
   * A thread T3 Code said finished a turn no hook told of started again, or
   * went: that turn, if it's still to be said, isn't, as a hook's update
   * isn't once the next prompt comes.
   */
  const overtaken = (about: Threads.Ref) =>
    Effect.suspend(() => {
      const session = `finished:${about.machine}:${about.id}`
      forsake(session)
      return discard(session)
    }).pipe(events.withPermits(1))

  /** Returns the ticket of the session's Stop hook when it waits for a reply. */
  const receive = (agent: Agent, payload: Payload, origin: Origin, wait: boolean) => {
    /** A Stop's, until its update is being got ready, which then says what came of it: otherwise nothing will, so it's known at once. */
    let undecided: Deferred.Deferred<void> | undefined
    return Effect.gen(function* () {
      const session = key(agent, payload.session_id)
      const arrivedAt = yield* Clock.currentTimeMillis
      // Nothing heard of the session since yapd started, a Stop's turn began before, so what it answers can't be told.
      const first = !activity.has(session)
      const sent = followed.get(session)?.current
      const prompt = payload.hook_event_name === "UserPromptSubmit" ? squash(payload.prompt ?? "") : undefined
      const own = sent !== undefined && (payload.hook_event_name === "Stop" || prompt === squash(sent.message) || prompt === squash(wake(sent.message)))
      const currentGeneration = { chain: own ? activity.get(session)!.chain : {} }
      if (!own) yield* invalidate(session)
      activity.set(session, currentGeneration)
      // Any new activity makes the session's pending update stale.
      yield* discard(session)

      switch (payload.hook_event_name) {
        case "UserPromptSubmit": {
          prompts.set(session, { text: payload.prompt, at: arrivedAt })
          return undefined
        }
        case "Stop": {
          const stop: Notices.Stop = { at: arrivedAt, message: payload.last_assistant_message?.trim() ?? "" }
          const decided = yield* Deferred.make<void>()
          deciding.set(stop, decided)
          undecided = decided
          // Every one, even one that's never said, so T3 Code's word that its thread finished leaves it to the hook.
          for (const [other, kept] of stops) {
            const recent = kept.filter(({ at }) => arrivedAt - at <= forgotten)
            if (recent.length === 0) stops.delete(other)
            else stops.set(other, recent)
          }
          for (const [key, fallback] of fallbacks) if (arrivedAt - fallback.at > forgotten) fallbacks.delete(key)
          stops.set(payload.session_id, [...(stops.get(payload.session_id) ?? []), stop])
          // Off, it's still summed up and kept, unheard, but nothing waits on yapd: its hook is let go of at once.
          const { on, turns } = yield* switched
          const hook = wait && on ? yield* waiting.open(session) : undefined
          const message = payload.last_assistant_message?.trim()
          const channel = followed.get(session)
          const followedUp = channel?.current !== undefined
          if (channel !== undefined) delete channel.current
          // Hooks older than project names leave it to the daemon, which only sees its own machine's directories.
          const project = origin.project ?? (yield* Project.name(payload.cwd))
          const prompt = prompts.get(session)
          if (!message) {
            yield* invalidate(session)
            yield* release(hook)
            return hook
          }
          // Said already in its place from T3 Code's word, it isn't said again; still to be said that way, it's said this way instead.
          const { through, replaced } = yield* giveWay(payload.session_id, stop, prompt?.at)
          const needsYou = payload.needs_you === true
          // Nobody watches a session yapd started, so it's heard from however quick its turn, as is one that needs the user.
          const watched = !needsYou && origin.launched !== true
          // The user is probably still looking at a turn this short. Without a prompt there's no telling, so it's spoken. Skipped, it tells
          // of nothing he heard, so a turn of work yapd started or a message it sent is still said from T3 Code's word.
          if (watched && !followedUp && prompt !== undefined && arrivedAt - prompt.at < minMillis) {
            stop.skipped = "quick"
            yield* release(hook)
            yield* Effect.logInfo("Skipped quick turn").pipe(Effect.annotateLogs({ project }))
            return hook
          }
          const turn = { prompt: Option.fromNullable(prompt?.text), message }
          const thread = { agent, session: payload.session_id, cwd: payload.cwd, message, origin }
          if (channel !== undefined) channel.thread = thread
          yield* Effect.forkIn(sendNext(session), lifetime)
          // Queued delivery owns the waiting hook. A trivial summary mustn't close it before dispatch.
          const queued = channel !== undefined && channel.queued.length > 0
          if (queued && hook !== undefined) channel.hook = hook
          const summaryHook = queued ? undefined : hook
          // Kept quiet in its place, since he muted its thread, it's summed up all the same, and said if it needs him.
          if (through !== undefined && !through.quiet) {
            yield* release(summaryHook)
            yield* Effect.logInfo("Skipped update, said already from T3 Code's word that it finished").pipe(Effect.annotateLogs({ project }))
            yield* passedThrough(arrivedAt, thread, project, through, session)
            return hook
          }
          const summed = prepare({
            session,
            project,
            turn,
            thread,
            arrivedAt,
            generation: currentGeneration,
            hook: summaryHook,
            hooked: hook !== undefined,
            needsYou,
            turns,
            outside: scratched(payload.cwd, origin),
            ...Option.match(finding(payload.session_id, payload.cwd, origin), { onNone: () => ({}), onSome: (finding) => ({ finding }) }),
            answering: followedUp,
            ...(prompt === undefined ? {} : { prompted: prompt }),
            ...(through === undefined ? {} : { over: through }),
            ...(replaced === undefined ? {} : { replaced }),
            stop,
            ...(prompt === undefined && first ? { unprompted: true } : {}),
          })
          // What came of it is known once that's done, however it ends, even stopped before it began.
          yield* Effect.uninterruptible(
            Effect.flatMap(FiberMap.run(preparing, session, summed), (fiber) => {
              undecided = undefined
              return Effect.forkIn(Effect.interruptible(Effect.zipRight(Fiber.await(fiber), Deferred.succeed(decided, undefined))), lifetime)
            }),
          )
          return hook
        }
      }
    }).pipe(
      Effect.ensuring(Effect.suspend(() => (undecided === undefined ? Effect.void : Deferred.succeed(undecided, undefined)))),
      events.withPermits(1),
    )
  }

  /** The reply waits outside the lock, so other sessions' events keep coming in. */
  const handle: Handle = (agent, payload, origin, wait) =>
    receive(agent, payload, origin, wait).pipe(
      Effect.flatMap((hook) => (hook === undefined ? Effect.succeed(undefined) : waiting.reply(hook))),
    )

  /**
   * Nothing is read while the user dictates, only answers while one is on
   * its way, and while yapd is off only what he asked. Taken with when yapd
   * was last turned on or off, and whether it's on.
   */
  const takeNext = STM.gen(function* () {
    const { on, turns } = yield* TRef.get(power)
    if (yield* Floor.dictating(floor)) return yield* STM.retry
    const ready = yield* following
    if (ready === undefined) return yield* STM.retry
    yield* TRef.set(inbox, Inbox.remove(yield* TRef.get(inbox), ready.session))
    yield* TRef.set(floor.reading, true)
    yield* TRef.set(coming, false)
    return { ready, turns, on }
  })

  /** Something about to be ready, while nobody is dictating, like the answer to what he asked even while yapd is off. Taken once. */
  const expected = STM.gen(function* () {
    if ((yield* Floor.dictating(floor)) || !(yield* TRef.get(coming))) return yield* STM.retry
    yield* TRef.set(coming, false)
  })

  /**
   * Puts back what a dictation cut off, to be said again from the start: an
   * update unless it was read to the end, like when the dictation only cut
   * off the wait for a reply, or the session has moved on or been answered
   * since, even by a follow-up that's still on its way; and a notice unless it
   * has been dealt with. Never a question yapd asked: what's dictated is the
   * answer to it, or takes its place. Nor an answer: talking over it, the user
   * moved on, and "say that again" still has it. What came of something they
   * asked to be done, like work that started, they still need to hear, but
   * after whatever the dictation brings, so it goes back as a notice of yapd's own.
   */
  const keep = (ready: Inbox.Entry, done: boolean, turns: number) =>
    Effect.gen(function* () {
      // Muted since it began, even while what cut it off was being said, it's kept quiet from then on, rather than read again, and held for
      // later once focus or quiet began.
      const why = !done && "update" in ready ? yield* quieted(ready) : Option.none<"muted" | Modes.Hold>()
      if (Option.isSome(why) && "update" in ready) {
        const row = rows.get(ready.update)
        if (row !== undefined) yield* why.value === "muted" ? journal.mute([row]) : journal.hold([row], why.value)
        yield* quieten(stopOf.get(ready.update))
        return false
      }
      // An update's own session, since one heard again waits under another key.
      const over =
        done ||
        ("update" in ready
          ? activity.get(ready.update.session) !== generations.get(ready.update) ||
            followed.get(ready.update.session)?.current !== undefined ||
            (yield* conversation.sending(ready.update.session, ready.update))
          : ready.notice.open !== undefined || ready.notice.kind === "answer")
      if (over) return false
      const now = yield* Clock.currentTimeMillis
      const again: Inbox.Entry =
        "notice" in ready && ready.notice.kind === "done"
          ? { ...ready, priority: "needs-you", arrivedAt: now, notice: { ...ready.notice, kind: "notice" } }
          : ready
      // Not if yapd was turned off meanwhile, which dropped everything waiting.
      return yield* STM.commit(
        STM.gen(function* () {
          const current = yield* TRef.get(inbox)
          if ((yield* TRef.get(power)).turns !== turns || current.has(again.session)) return false
          yield* TRef.set(inbox, Inbox.add(current, again))
          return true
        }),
      )
    })

  /**
   * What's played for a notice: its own words, or those it says in their
   * place when it asks for them just before it's played, rendered then and
   * removed once it's said. Should rendering fail, its own words go after all.
   * What tells it that it gets those in their place comes with them, to run
   * once it's known it's still to be played.
   */
  const words = (said: Inbox.Said) =>
    Effect.gen(function* () {
      const { instead } = said.notice
      const own = { path: said.audio, spoken: said.notice.spoken, used: Effect.void }
      if (instead === undefined || !(yield* instead.when)) return own
      const path = join(dir, `${crypto.randomUUID()}${extension}`)
      // What could give a secret away, or came of a request held back as one, is logged nowhere, as for its own words.
      const what = said.notice.withheld === true || T3Actions.revealing(instead.spoken) ? "something that could give a secret away" : `"${instead.spoken}"`
      return yield* Effect.acquireRelease(voice.render(instead.spoken, path).pipe(Effect.onError(() => removeFile(path))), () => removeFile(path)).pipe(
        Effect.as({ path, spoken: instead.spoken, used: Effect.zipRight(Effect.logInfo(`Saying instead: ${what}`), instead.used ?? Effect.void) }),
        Effect.catchAll((error) => Effect.as(Effect.logWarning(`Could not say ${what} instead`, error), own)),
      )
    })

  /**
   * Says a notice. Only a question, or an answer that can be followed up, is
   * listened to: whatever else they'd say to it has nowhere to go, so over
   * anything else only "Mute." is heard. One said unasked, like a failure, is
   * followed up only while he's at hand. What can't be played was never
   * said, so it isn't what the user heard last; and a question that can't be
   * asked in full, even one that breaks off midway, counts as never said and
   * goes unanswered, to be asked again later or let go, rather than left open.
   * `ended` runs once it's been said to the end.
   */
  const say = (said: Inbox.Said, dealtWith: Effect.Effect<void>, listening = true, ended: Effect.Effect<void> = Effect.void) =>
    Effect.gen(function* () {
      const { question, followUp, handoff } = said.notice
      if (yield* said.notice.stale) return yield* dealtWith
      // What came of something handed over from an update, how long that took, part by part, as it starts to play.
      const timed =
        handoff === undefined
          ? Effect.void
          : Effect.flatMap(Clock.currentTimeMillis, (now) =>
              Conversation.answeredIn(handoff.since, { responder: handoff.responder, brain: handoff.brain, acting: said.notice.at - handoff.ran, rendering: now - said.notice.at }),
            )
      const saying = Effect.zipRight(timed, said.notice.saying ?? Effect.void)
      const confirmed = said.notice.confirmed ?? Effect.void
      const { path: played, spoken, used } = yield* words(said)
      // Settled while its words were rendered, like a question closed by what he said meanwhile, it's dropped all the same.
      if (yield* said.notice.stale) return yield* dealtWith
      yield* used
      // Off, what he asked is answered, but the microphone stays closed: yapd is quiet again once it's said. A question it asks is
      // answered with the shortcut, as it's left open.
      if (!listening) {
        const playback = yield* audio.play(played).pipe(Effect.onError(() => (question === undefined ? Effect.void : Effect.zipRight(dealtWith, question.unanswered))))
        yield* saying
        if (playback.confirmed) yield* confirmed
        yield* playback.finished.pipe(
          Effect.onError((cause) =>
            question === undefined || Cause.isInterruptedOnly(cause) ? Effect.void : dealtWith.pipe(Effect.zipRight(question.unsaid), Effect.zipRight(question.unanswered)),
          ),
        )
        if (!playback.confirmed) yield* confirmed
        if (question !== undefined) yield* question.through ?? Effect.void
        yield* said.notice.heard ?? Effect.void
        yield* dealtWith
        if (question !== undefined) yield* question.unanswered
        return
      }
      // Said unasked, like a failure, while he isn't at hand, who speaks after it may well not be him: only "Mute." is listened for.
      const hand = said.notice.unasked !== true || (yield* present)
      if (question === undefined && followUp !== undefined && hand) {
        let through = false
        /** Once, as soon as it's said to the end, even with the microphone still open for a follow-up. */
        const heard = Effect.suspend(() => {
          if (through) return Effect.void
          through = true
          return Effect.zipRight(Effect.zipRight(said.notice.heard ?? Effect.void, dealtWith), ended)
        }).pipe(Effect.uninterruptible)
        // Listened to like an update, so he can follow up what he asked about, which only one said to the end lingers for, or one
        // followed up only from its end, which plays through what's said over it as a notice does.
        const followed = yield* conversation.answer({
          audio: played,
          spoken,
          saying,
          confirmed,
          followUp,
          through: heard,
          ...(said.notice.window === undefined ? {} : { wait: said.notice.window }),
          ...(said.notice.after === true ? { after: true } : {}),
          ...(said.notice.withheld === true ? { withheld: true } : {}),
        })
        if (followed) yield* heardHim
        // Cut off by a follow-up, a thanks or a stop, it's dealt with, never said again, but not heard: what he missed that it
        // was telling him, he didn't hear all of, so it's still his to catch up on, as when a dictation cuts it off.
        if (!through) yield* Effect.uninterruptible(dealtWith)
        return
      }
      if (question === undefined) {
        // Nothing else he'd say over it has anywhere to go, so it plays through all he says, never turned down, but "Mute.", which it
        // listens for a moment after it too, only as long as the pause between lines once something waits to be said next, which hears
        // it itself: heard as soon as it's said to the end, so a dictation then neither puts it back nor finds it missed.
        const heard = Effect.zipRight(Effect.zipRight(said.notice.heard ?? Effect.void, dealtWith), ended).pipe(Effect.uninterruptible)
        return yield* conversation.tell({ audio: played, spoken, saying, confirmed, through: heard })
      }
      const answer = (heard: string, voiced: number, echo?: string, afterPause?: string, unsaid?: string) =>
        question.answer(heard, voiced, echo, afterPause, unsaid).pipe(Effect.map(Option.map((proceed) => Effect.zipRight(dealtWith, proceed))))
      const asked = {
        audio: played,
        spoken,
        saying,
        confirmed,
        answer,
        through: Effect.zipRight(question.through ?? Effect.void, ended),
        ...(question.terms === undefined ? {} : { terms: question.terms }),
      }
      const answered = yield* conversation.ask(asked).pipe(
        Effect.onError((cause) =>
          Cause.isInterruptedOnly(cause) ? Effect.void : dealtWith.pipe(Effect.zipRight(question.unsaid), Effect.zipRight(question.unanswered)),
        ),
      )
      if (answered) yield* heardHim
      // Answered, or asked in full.
      yield* said.notice.heard ?? Effect.void
      if (!answered) yield* Effect.uninterruptible(Effect.zipRight(dealtWith, question.unanswered))
    }).pipe(Effect.scoped)

  /** Once yapd is turned off, even if it's turned on again before this hears of it. */
  const turnedOff = (since: number) =>
    STM.commit(STM.flatMap(TRef.get(power), ({ turns }) => (turns === since ? STM.retry : STM.void)))

  /**
   * Updates heard again that are being rendered, waiting their turn or being
   * said, by id, each as it was asked for, so one asked for since yapd was
   * turned off and on isn't taken for one that was dropped.
   */
  const replays = new Map<string, Inbox.Replay>()

  const heardAlready = (heard: ReadonlyArray<HeardUpdate>, update: Conversation.Update) =>
    heard.some((heard) => heard.update.session === update.session && heard.update.at === update.at)

  /** Keeps an update the user is hearing, unless they're hearing it again, by its entry in the journal, so it's the same after a restart. */
  const hear = (update: Conversation.Update) =>
    SubscriptionRef.update(state, (current) =>
      heardAlready(current.heard, update)
        ? current
        : { ...current, heard: [{ id: String(rows.get(update) ?? crypto.randomUUID()), update }, ...current.heard].slice(0, replayable) },
    )

  /** An update heard again has been said, or won't be. */
  const replayed = (replay: Inbox.Replay) =>
    Effect.sync(() => {
      if (replays.get(replay.id) === replay) replays.delete(replay.id)
    })

  /**
   * Whether an update waiting to be read is one his muting its thread keeps
   * quiet: never what needs him, what couldn't be summed up, which may, one he
   * asked to hear again, nor one that answers what he asked of the thread
   * himself.
   */
  const quiet = (ready: Inbox.Ready) => ready.priority !== "needs-you" && ready.replay === undefined && !audible.has(ready.update)

  /**
   * Whether an update waiting to be read is one that quiet holds for the
   * morning, though no mute keeps it quiet: the first turn of work yapd
   * started, unless it needs him or he asked to hear it again.
   */
  const quietOnly = (ready: Inbox.Ready) => ready.priority !== "needs-you" && ready.replay === undefined && openings.has(ready.update)

  /**
   * Whether an update waiting to be read is muted now, or held by focus or
   * quiet: the first turn of work yapd started, only by quiet. A subagent's,
   * whatever it is, once its thread's are no longer read to him, unless he
   * asked to hear it again.
   */
  const quieted = (ready: Inbox.Ready): Effect.Effect<Option.Option<"muted" | Modes.Hold>> =>
    ready.replay === undefined && ready.update.subagent !== undefined
      ? Effect.flatMap(reads(Option.fromNullable(ready.update.subagent.head?.ref)), (read) => (read ? quietedAs(ready) : Effect.succeedSome("muted" as const)))
      : quietedAs(ready)

  /** Whether an update waiting to be read is muted now, or held by focus or quiet, as `quieted` says of any but a subagent's. */
  const quietedAs = (ready: Inbox.Ready): Effect.Effect<Option.Option<"muted" | Modes.Hold>> =>
    quiet(ready)
      ? Effect.flatMap(muting(Mutes.covering(ready.update, called)), (mute): Effect.Effect<Option.Option<"muted" | Modes.Hold>> =>
          Option.isSome(mute) ? Effect.succeedSome("muted") : holdingNow,
        )
      : quietOnly(ready)
        ? Effect.map(holdingNow, Option.filter((mode): mode is "quiet" => mode === "quiet"))
        : Effect.succeedNone

  /**
   * A thread was just muted under these keys: its updates waiting to be read
   * are dropped, and they and those held for later are kept as kept quiet,
   * but never what needs him, one he asked to hear again, the line being
   * said, or what yapd has to say for itself. A hook he heard waits on, as when he tells an update to stop, and
   * any other is let go of. One said in a hook's place is the turn's, so its
   * own Stop coming late isn't said either. What's still being prepared looks
   * for itself.
   */
  const silence = (keys: ReadonlyArray<string>): Effect.Effect<void> => {
    const muted = new Set(keys)
    return Effect.gen(function* () {
      yield* drop((entry) => Mutes.covering(entry.update, called).some((key) => muted.has(key)), { _tag: "Muted" })
      // What of it was held for later is kept quiet too, so the digest and the rundown never bring up a thread he muted since. Not what a
      // mute never keeps quiet, held as yapd was off: what needs him, or answers what he asked, still leads a catch-up.
      const held = (yield* journal.held(0)).filter((kept) => !Missed.audible(kept) && Mutes.coveringKept(kept, called).some((key) => muted.has(key)))
      yield* journal.mute(held.map(({ id }) => id))
    })
  }

  /**
   * He no longer has the subagents of the thread under this key read to
   * him: as when they're kept to yapd from the start, whatever they say,
   * what of them waits to be read is dropped, what needs him and what can't
   * be summed up too, and kept quiet, and so is what of them was held for
   * later, whatever it is. Never one he asked to hear again, nor the line
   * being said. What's still being prepared looks for itself.
   */
  const unread = (key: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* drop((entry) => entry.update.subagent?.head !== undefined && Mutes.key.thread(entry.update.subagent.head.ref) === key, { _tag: "Muted" }, true)
      const held = (yield* journal.held(0)).filter((kept) => Mutes.headKept(kept) === key)
      yield* journal.mute(held.map(({ id }) => id))
    })

  /**
   * Focus or quiet just began: the updates waiting to be read that a mute
   * could keep quiet are dropped and kept as held for later, as `silence`
   * keeps them, and, for quiet, the first turn of work yapd started too, as
   * one that comes in quiet is held. Never what needs him, one he asked to
   * hear again, the line being said, or what yapd has to say for itself.
   */
  const hold = (why: Modes.Hold): Effect.Effect<void> => drop(() => true, { _tag: "Held", why })

  /**
   * Drops the updates waiting to be read that a mute could keep quiet and
   * `which` picks, kept as muted or held, and, held by quiet, those quiet
   * alone holds; or, `whatever`, any `which` picks but one he asked to hear
   * again.
   */
  const drop = (
    which: (entry: Inbox.Ready) => boolean,
    as: { readonly _tag: "Muted" } | { readonly _tag: "Held"; readonly why: Modes.Hold },
    whatever = false,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const dropping = (entry: Inbox.Ready) =>
        whatever ? entry.replay === undefined : quiet(entry) || (as._tag === "Held" && as.why === "quiet" && quietOnly(entry))
      const dropped = yield* STM.commit(
        TRef.modify(inbox, (current) => {
          const quietened = [...current.values()].filter((entry): entry is Inbox.Ready => "update" in entry && dropping(entry) && which(entry))
          return [quietened, quietened.reduce((left, entry) => Inbox.remove(left, entry.session), current)] as const
        }),
      )
      if (dropped.length === 0) return
      const { heard } = yield* SubscriptionRef.get(state)
      const kept: Array<number> = []
      for (const entry of dropped) {
        yield* removeFile(Inbox.audio(entry))
        if (!heardAlready(heard, entry.update)) yield* release(entry.hook)
        const fallback = standing.get(entry.update)
        if (fallback !== undefined) {
          fallback.heard = true
          fallback.quiet = true
        }
        const row = rows.get(entry.update)
        if (row !== undefined) kept.push(row)
        yield* quieten(stopOf.get(entry.update))
      }
      yield* as._tag === "Muted" ? journal.mute(kept) : journal.hold(kept, as.why)
      yield* Effect.logInfo(`${as._tag === "Muted" ? "Muted" : "Held"} ${dropped.length === 1 ? "an update" : `${dropped.length} updates`} waiting to be said`)
    })

  if (options.mutes !== undefined) controls = Mutes.controls({ mutes: options.mutes, silence, unread, journal })

  /**
   * Drops an update the user told to stop, even one a dictation cut off and
   * put back to be read again: it isn't, and they've heard enough of it. Its
   * hook waits on, like any they heard, for a reply to it heard again.
   */
  const skip = (update: Conversation.Update) =>
    Effect.gen(function* () {
      const dropped = yield* STM.commit(
        TRef.modify(inbox, (current) => {
          const queued = [...current.values()].find((entry) => "update" in entry && entry.update === update)
          return queued === undefined ? [undefined, current] as const : [queued, Inbox.remove(current, queued.session)] as const
        }),
      )
      if (dropped !== undefined && "update" in dropped) {
        yield* removeFile(Inbox.audio(dropped))
        if (!heardAlready((yield* SubscriptionRef.get(state)).heard, update)) yield* release(dropped.hook)
        if (dropped.replay !== undefined) yield* replayed(dropped.replay)
      }
      const row = rows.get(update)
      alone.delete(update)
      yield* journal.markHeard([...(row === undefined ? [] : [row]), ...(leading.get(update) ?? [])], yield* Clock.currentTimeMillis)
      // Said in its hook's place, it's the turn's, so a Stop of its own coming later isn't said either.
      const fallback = standing.get(update)
      if (fallback !== undefined) fallback.heard = true
    })

  /**
   * Waits for something to say. When something is about to be ready, the
   * speaker gets ready meanwhile, and if it doesn't come after all, like an
   * update that turned out trivial, there's nothing to say for now.
   */
  const nextUp = Effect.gen(function* () {
    const first = yield* STM.commit(STM.orElse(STM.map(takeNext, Option.some), () => STM.as(expected, Option.none())))
    if (Option.isSome(first)) return first
    const { turns } = yield* switched
    yield* floor.device.withPermits(1)(audio.warm)
    // Turned off meanwhile, nothing will come, so the speaker rests at once rather than after a while.
    return yield* STM.commit(takeNext).pipe(
      Effect.timeoutOption(patience),
      Effect.raceFirst(Effect.as(turnedOff(turns), Option.none())),
    )
  })

  /** When the last line yapd said ended, or when it started, for how long it's been quiet. */
  let lastEnded = yield* Clock.currentTimeMillis

  /**
   * How long it's been quiet since the last line ended, in ms: none while
   * anything waits to be said, is about to be, is being said or listened
   * after, an answer is on its way, an update is being summed up, or he's
   * dictating.
   */
  const idle = Effect.gen(function* () {
    const busy = yield* STM.commit(
      STM.gen(function* () {
        return (
          (yield* TRef.get(inbox)).size > 0 ||
          (yield* TRef.get(floor.reading)) ||
          (yield* TRef.get(coming)) ||
          (yield* TRef.get(awaited)).length > 0 ||
          (yield* Floor.dictating(floor))
        )
      }),
    )
    if (busy || (yield* FiberMap.size(preparing)) > 0) return Option.none<number>()
    return Option.some((yield* Clock.currentTimeMillis) - lastEnded)
  })

  /** What's being said now, until it's heard, put back or done with. */
  let saying: Inbox.Entry | undefined

  const speakNext = Effect.gen(function* () {
    const queued = yield* STM.commit(
      takeNext.pipe(
        STM.map(Option.some),
        STM.orElse(() => STM.succeed(Option.none())),
      ),
    )
    const next = yield* Option.match(queued, {
      // Nothing left to say, so the microphone goes off until there is, once no dictation is using it.
      onNone: () => Floor.use(floor, audio)(Effect.void).pipe(Effect.zipRight(nextUp)),
      onSome: (ready) => Effect.succeed(Option.some(ready)),
    })
    // What was about to be ready never came, so the speaker rests again, the next time round.
    if (Option.isNone(next)) return
    const { ready, turns, on } = next.value
    // A turn said in its hook's place is the turn's as he hears it, unless it gave way to a Stop of its own, or its thread was on another run, by now.
    const fallback = "update" in ready ? standing.get(ready.update) : undefined
    if (fallback !== undefined && !(yield* begin(fallback))) {
      yield* removeFile(Inbox.audio(ready))
      yield* STM.commit(TRef.set(floor.reading, false))
      if ("update" in ready) yield* parted(ready.update)
      return yield* Effect.logInfo("Not saying a turn no hook told of, since its hook came or its thread started again")
    }
    saying = ready
    paused = false
    if ("update" in ready) {
      readSince.set(ready.update, turns)
      yield* hear(ready.update)
      const menu = ready.replay?.menu
      latest = { update: ready.update, said: ready.update.spoken, at: yield* Clock.currentTimeMillis, playing: true, turns, ...(menu === undefined ? {} : { menu }) }
    }
    let kept = false
    let dealtWith = false
    /** An update read to the end, or answered: the user heard it. */
    let through = false
    /** When it was said to the end, by the clock, and what waited to be said next then, for how long the microphone stayed open after it. */
    let ending: { readonly at: number; readonly waiting: string } | undefined
    const ended = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const next = Inbox.next(yield* STM.commit(TRef.get(inbox)))
      ending = { at, waiting: next === undefined ? "nothing" : "update" in next ? "update" : next.notice.kind }
    })
    /**
     * Noted at once, even while the microphone stays open for a reply, so a
     * dictation then neither puts it back nor finds it missed. Heard, it
     * makes what was held as progress of the same work out of date, so the
     * digest never brings that up after he heard how it went, and what was
     * kept quiet of its turn in its hook's place, whose place its entry
     * takes, is noted as heard with it.
     */
    const heard = (update: Conversation.Update) =>
      Effect.suspend(() => {
        if (through) return Effect.void
        through = true
        alone.delete(update)
        const row = rows.get(update)
        // What he asked to hear of its finishing, which led it, is heard with it.
        const led = leading.get(update) ?? []
        if (row === undefined) return Effect.zipRight(ended, led.length === 0 ? Effect.void : Effect.flatMap(Clock.currentTimeMillis, (at) => journal.markHeard(led, at)))
        return Effect.zipRight(
          ended,
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.zipRight(journal.markHeard([row, ...led], at), journal.outdated(row, update.session, update.about ?? update.owner ?? update.subagent?.child, at)),
          ),
        )
      }).pipe(Effect.uninterruptible)
    /** Where it's put back to be read again from, once what he handed over that needs it to be is acted on. */
    let putting: number | undefined
    /**
     * Puts it back to be read again from where he cut in, once the answer to
     * what he handed over is said: whichever of this and a dictation starting
     * then finds it put back already never takes that back.
     */
    const back = (from: number) =>
      Effect.gen(function* () {
        putting = from
        const again = yield* keep("update" in ready ? { ...ready, from } : ready, false, turns)
        kept = kept || again
        if (again) yield* Effect.logInfo("Put back to be read again from where he cut in")
      })
    const reading =
      "update" in ready
        ? conversation
            // Longer after one that asks him something while he's at hand, or one heard again, which he asked for. From where it was put
            // back to be read again, when it was.
            .converse(ready.update, heard(ready.update), {
              replay: ready.replay !== undefined,
              present: yield* present,
              ...(ready.from === undefined ? {} : { from: ready.from }),
              back,
            })
            .pipe(Effect.flatMap((heardIt) => (heardIt ? heard(ready.update) : Effect.void)))
        : say(
            ready,
            Effect.sync(() => {
              dealtWith = true
            }),
            on,
            ended,
          )
    /** Whether turning yapd off or on cut it off. */
    let cut = false
    yield* reading.pipe(
      // Failing, like when the audio helper quits midway, it isn't heard: trouble with the speaker rather than a fault of yapd's.
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : Cause.isDie(cause)
            ? Effect.logError("Could not speak update", cause)
            : Effect.logWarning("Could not speak update", cause),
      ),
      // Stopped at once, and let go of before the dictation starts.
      Effect.raceFirst(
        Effect.zipRight(
          dictationStarted,
          Effect.map(
            Effect.suspend(() => keep(putting === undefined || !("update" in ready) ? ready : { ...ready, from: putting }, dealtWith || through, turns)),
            (again) => {
              kept = kept || again
            },
          ),
        ),
      ),
      // Stopped at once, and not put back to be said again: an update he didn't hear through is kept unheard, as what came in while yapd was off.
      Effect.raceFirst(
        Effect.zipRight(
          turnedOff(turns),
          Effect.sync(() => {
            cut = true
          }),
        ),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          if (!cut || through || !("update" in ready) || ready.replay !== undefined) return Effect.void
          const row = rows.get(ready.update)
          // What led it is kept unheard with it.
          alone.delete(ready.update)
          // Never heard to the end now, so a failure left to its Stop is handed on, to be kept unheard apart.
          return Effect.zipRight(journal.hold([...(row === undefined ? [] : [row]), ...(leading.get(ready.update) ?? [])], "off"), quieten(stopOf.get(ready.update)))
        }),
      ),
      // Done with before he heard it, not put back nor cut off by turning yapd off, what led it is said on its own.
      Effect.ensuring(Effect.suspend(() => (kept || cut || through || !("update" in ready) ? Effect.void : parted(ready.update)))),
      // Not put back, it's done with, said or not.
      Effect.ensuring(
        Effect.suspend(() =>
          kept
            ? Effect.void
            : Effect.zipRight(
                removeFile(Inbox.audio(ready)),
                "update" in ready ? (ready.replay === undefined ? Effect.void : replayed(ready.replay)) : (ready.notice.gone ?? Effect.void),
              ),
        ),
      ),
      Effect.ensuring(STM.commit(TRef.set(floor.reading, false))),
      // Broken off before he heard it, or put back to be read again, it isn't the turn's until he does.
      Effect.ensuring(Effect.suspend(() => (fallback === undefined || through ? Effect.void : unheard(fallback)))),
      Effect.ensuring(
        Effect.gen(function* () {
          if (saying === ready) saying = undefined
          const at = yield* Clock.currentTimeMillis
          lastEnded = at
          if (!("update" in ready)) return
          if (latest?.update === ready.update) latest = { ...latest, at, playing: false }
        }),
      ),
    )
    // How long the microphone stayed open after it, against how long it would have before lines could be answered from their end and
    // waits grew, with what waited behind it, so what that costs can be counted from the log.
    if (ending !== undefined) {
      const notice = "notice" in ready ? ready.notice : undefined
      const kind = notice === undefined ? "update" : `${notice.kind}${notice.after === true && notice.followUp !== undefined ? ", from its end" : ""}`
      const before =
        notice === undefined ? 3 : notice.question !== undefined ? 8 : notice.followUp !== undefined && notice.after !== true ? 3 : ending.waiting === "nothing" ? 3 : 0.5
      const open = ((yield* Clock.currentTimeMillis) - ending.at) / 1000
      yield* Effect.logInfo(`Window: ${kind}, open ${open.toFixed(1)} s, ${before} s by today's rule, waiting: ${ending.waiting}`)
    }
    // The pause between lines, unless the moment after this one was it already.
    if (!paused) yield* Effect.sleep("400 millis")
  })

  /**
   * Off, what's being said stops at once, and what's waiting to be is
   * dropped, an update kept unheard as what came in while yapd was off. What's
   * still being summed up carries on, to be kept so too, but its hook is let
   * go of at once, so nothing waits on yapd. The hooks are let go of with
   * the events going on held, so none gets past it half taken in.
   */
  const turn = (next: boolean) =>
    Effect.gen(function* () {
      const dropped = yield* STM.commit(
        STM.gen(function* () {
          const { on, turns } = yield* TRef.get(power)
          if (on === next) return undefined
          yield* TRef.set(power, { on: next, turns: turns + 1 })
          yield* TRef.set(coming, false)
          // Off, no answer is on its way any more. On, what was still to be said in answer to what he asked while it was off is dropped too,
          // as what it was saying is stopped.
          if (!next) yield* TRef.set(awaited, [])
          return yield* TRef.modify(inbox, (queued) => [[...queued.values()], Inbox.empty] as const)
        }),
      )
      if (dropped === undefined) return
      yield* SubscriptionRef.update(state, (current) => ({ ...current, on: next }))
      yield* Effect.logInfo(next ? "Turned on" : "Turned off")
      // Their hooks are let go of as they stop.
      if (!next) yield* Effect.gen(function* () {
        for (const channel of followed.values()) {
          channel.queued.length = 0
          if (channel.current === undefined) yield* release(channel.hook)
        }
        for (const hook of summing.values()) yield* release(hook)
      }).pipe(events.withPermits(1))
      // The hook of one the user heard, cut off by a dictation, waits on for a reply to it heard again.
      const { heard } = yield* SubscriptionRef.get(state)
      const kept: Array<number> = []
      for (const entry of dropped) {
        yield* removeFile(Inbox.audio(entry))
        if (!("update" in entry)) {
          yield* entry.notice.gone ?? Effect.void
          continue
        }
        if (!heardAlready(heard, entry.update)) yield* release(entry.hook)
        if (entry.replay !== undefined) {
          yield* replayed(entry.replay)
          continue
        }
        // Kept quiet in its hook's place, it's the turn's, as one held for focus is.
        const fallback = standing.get(entry.update)
        if (fallback !== undefined) {
          fallback.heard = true
          fallback.quiet = true
        }
        const row = rows.get(entry.update)
        if (row !== undefined) kept.push(row)
        // What led it is kept unheard with it.
        kept.push(...(leading.get(entry.update) ?? []))
        alone.delete(entry.update)
        // Never said now, so a failure left to its Stop is handed on, to be kept unheard apart.
        yield* quieten(stopOf.get(entry.update))
      }
      yield* journal.hold(kept, "off")
    })

  /**
   * Says an update the user heard again, all of it, its headline and the
   * rest kept for "more" too, since he asked to hear it, and listens for a
   * reply like after any update. Asked for from the menu, it's said for that
   * row, by its key, so "mute it" over it mutes that row.
   */
  const replay = (id: string, menu?: string) =>
    Effect.gen(function* () {
      const found = (yield* SubscriptionRef.get(state)).heard.find((heard) => heard.id === id)
      if (found === undefined) return "unknown" as const
      const { on, turns } = yield* switched
      if (!on) return "off" as const
      // Once, however many times it's asked for before it's said.
      if (replays.get(id)?.turns === turns) return "queued" as const
      const asked: Inbox.Replay = { id, turns, ...(menu === undefined ? {} : { menu }) }
      replays.set(id, asked)
      return yield* again(found, asked).pipe(
        Effect.tap((result) => (result === "queued" ? Effect.void : replayed(asked))),
        Effect.onError(() => replayed(asked)),
      )
    })

  /**
   * Renders an update heard before, all of it, and queues it: heard to the
   * end, it was heard in full, so it's noted as heard and "say that again"
   * says all of it, with nothing left for "more".
   */
  const again = (found: HeardUpdate, asked: Inbox.Replay) =>
    Effect.gen(function* () {
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      const { more, ...was } = found.update
      const spoken = Missed.whole(was.spoken, more)
      yield* soon
      yield* voice.render(spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const update: Conversation.Update = { ...was, spoken, audio }
      // Replays keep both the hook generation and the original chain of voice replies.
      const generation = generations.get(found.update)
      if (generation !== undefined) generations.set(update, generation)
      if (hooked.has(found.update)) hooked.add(update)
      // And its entry in the journal, so heard to the end this time, it's noted as heard, with the one it took the place of.
      const row = rows.get(found.update)
      if (row !== undefined) rows.set(update, row)
      const arrivedAt = yield* Clock.currentTimeMillis
      const session = `replay:${found.id}`
      if (yield* enqueue({ session, priority: "needs-you", arrivedAt, update, replay: asked }, asked.turns)) return "queued" as const
      yield* removeFile(audio)
      return "off" as const
    })

  return {
    handle,
    speak: Effect.forever(speakNext),
    /** Whether yapd is on and what the user heard lately, then each time that changes. */
    state: state.changes,
    turn,
    replay,
    tell,
    /** What the user was told lately, newest first: never what was kept quiet or held for later, since he never heard it. */
    recent: Effect.flatMap(Clock.currentTimeMillis, (now) =>
      journal.since(now - Recent.lifetime, { most: Recent.most, kinds: ["update", "started"], muted: false, held: false }),
    ).pipe(Effect.map((entries) => entries.toReversed().map(Recent.fromJournal))),
    silence,
    unread,
    hold,
    idle,
    /** Muting from the menu or by voice, which drops what of a thread waits to be said: none without mutes. */
    controls: Option.fromNullable(controls),
    /**
     * The newest update he heard that's muted, or shown, under this key, by
     * its id among those heard, to hear again: only when it's the thread's
     * latest, kept at `at` or since, not one before what was kept quiet of it
     * or a notice that came after.
     */
    latestHeard: (key: string, at: number) =>
      Effect.map(SubscriptionRef.get(state), ({ heard }) =>
        Option.fromNullable(heard.find(({ update }) => update.at >= at && Mutes.keysOf(update, called).includes(key))?.id),
      ),
    /** Whether yapd is on, and how many times it was turned on or off, so what was heard before can tell. */
    power: switched,
    /** The update being read, or the last one the user heard, what of it was said last, and when, with how many times yapd had been turned on or off then. */
    lastHeard: Effect.sync(() => Option.fromNullable(latest)),
    /** Something is about to be said, like an answer being worked out, so the speaker gets ready meanwhile. */
    coming: soon,
    /**
     * An answer is on its way: nothing but answers is said until what this
     * gives back is run, once it's queued or won't come, or for twenty seconds
     * after the user last stopped dictating at most.
     */
    awaiting,
    /** As `awaiting`, but for as long as `after` once he last stopped dictating at most. */
    awaitingFor,
    /** Whether these words are waiting to be said, like an update or work that started, which a dictation cut off. */
    queued: (spoken: string) =>
      STM.commit(
        STM.map(TRef.get(inbox), (waiting) => [...waiting.values()].some((entry) => ("update" in entry ? entry.update.spoken : entry.notice.spoken) === spoken)),
      ),
    skip,
    /** The updates waiting to be read, like one a dictation cut off, by their entry in the journal: coming up, so not missed. */
    upcoming: Effect.map(STM.commit(TRef.get(inbox)), (queued) =>
      [...queued.values()].flatMap((entry): ReadonlyArray<number> => {
        const row = "update" in entry ? rows.get(entry.update) : undefined
        return row === undefined ? [] : [row]
      }),
    ),
    /**
     * What's told him by what's being said now, an update or a notice, or by
     * a notice waiting to be, like a failure or a catch-up, by their entries
     * in the journal: being told him, so not missed.
     */
    telling: Effect.gen(function* () {
      const entry = saying
      const queued = [...(yield* STM.commit(TRef.get(inbox))).values()]
      const told = yield* Effect.forEach(
        [...(entry === undefined || "update" in entry ? [] : [entry]), ...queued].flatMap((each) => ("notice" in each ? [each.notice] : [])),
        (notice) => notice.telling ?? Effect.succeed<ReadonlyArray<number>>([]),
      )
      const reading = entry !== undefined && "update" in entry ? Option.toArray(Option.fromNullable(rows.get(entry.update))) : []
      return [...reading, ...told.flat()]
    }),
    /** Each time something said over an update is taken in, which takes the place of whatever yapd asked before. */
    replies: Stream.fromPubSub(replied),
    /**
     * The Stop hooks of these sessions in the last hour, when they came and
     * what they said last, oldest first, by the agent's own ids for them,
     * whether their updates were said or not, once what came of each is
     * known, so one that told of nothing says so.
     */
    stopped: (sessions: ReadonlyArray<string>) =>
      Effect.suspend(() =>
        Effect.zipRight(
          Effect.forEach(stopsOf(sessions), (stop) => Option.match(Option.fromNullable(deciding.get(stop)), { onNone: () => Effect.void, onSome: Deferred.await }), {
            discard: true,
          }),
          Effect.sync((): ReadonlyArray<Notices.Stop> => stopsOf(sessions)),
        ),
      ),
    /** A failure left to these Stops, said after all should what they told of be kept quiet, as his muting the thread does. */
    unheard: unheardFailure,
    finished,
    overtaken,
  }
})
