import { Cause, Clock, Effect, FiberMap, Option, PubSub, STM, Stream, SubscriptionRef, TRef } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { Audio } from "./Audio.ts"
import { type Ticket, Waiting, wake } from "./ClaudeCode.ts"
import { Condenser, introduce, speakable, type Summary, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Conversation from "./Conversation.ts"
import * as Floor from "./Floor.ts"
import * as Inbox from "./Inbox.ts"
import * as Hands from "./Hands.ts"
import { type Entry, Journal } from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import * as Notices from "./Notices.ts"
import type { Origin } from "./Origin.ts"
import { type Agent, key, type Payload } from "./Payload.ts"
import { Persona } from "./Persona.ts"
import * as Project from "./Project.ts"
import * as Recent from "./Recent.ts"
import { RelayError, Relays, type Thread } from "./Relay.ts"
import type { Handle } from "./Server.ts"
import * as T3Code from "./T3Code.ts"
import type * as Threads from "./Threads.ts"
import { extension, Voice } from "./Voice.ts"

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
  /** Off, yapd says nothing, and nothing that finishes meanwhile is said later. */
  readonly on: boolean
  /** Newest first. */
  readonly heard: ReadonlyArray<HeardUpdate>
}

/** How many updates can be heard again. */
const replayable = 5

/** How long the speaker stays ready for something that was about to be said, before it rests again. */
const patience = "15 seconds"

/** How long an answer on its way holds everything else back at most, in case it never comes. */
const holding = "20 seconds"

/** How long a Stop is kept in mind: T3 Code says its thread finished well within it. */
const forgotten = 60 * 60_000

/** How long finding the T3 Code thread a hook came from can take, after which its update goes the old way. */
const lookup = "3 seconds"

/**
 * Updates are condensed and rendered in parallel, then spoken one at a time,
 * along with what yapd has to say for itself. `link` finds the T3 Code thread
 * a hook on this machine came from, if any, so what's said of it is kept
 * with the thread, and `hands` send what the user says over it to that
 * thread, as T3 Code takes it: into the turn under way, or in its queue.
 */
export const make = (
  options: {
    readonly link?: (session: string, cwd: string) => Effect.Effect<Option.Option<Threads.Ref>>
    readonly hands?: Hands.Hands["Type"]
  } = {},
) => Effect.gen(function* () {
  const lifetime = yield* Effect.scope
  const condenser = yield* Condenser
  const voice = yield* Voice
  const audio = yield* Audio
  const waiting = yield* Waiting
  const relays = yield* Relays
  const floor = yield* Floor.Floor
  const journal = yield* Journal
  const persona = yield* Persona
  const minMillis = (yield* Config.minSeconds) * 1000

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
  /**
   * The update being read, or the last one that was, what of it was said
   * last, like an answer over it, and when, which is what "it" means to the user.
   */
  let latest: { readonly update: Conversation.Update; readonly said: string; at: number; playing: boolean } | undefined
  /** Follow-ups the user just sent by voice, whose answers they'll want to hear however short. */
  interface FollowUp {
    readonly update: Conversation.Update
    readonly message: string
  }
  interface Replies {
    current?: FollowUp
    thread: Thread
    readonly queued: Array<FollowUp>
    hook?: Ticket
  }
  const followed = new Map<string, Replies>()
  /** Each session's Stops, when they came and what they said last, oldest first, by the agent's own id for it, whether or not they were said, for an hour. */
  const stops = new Map<string, ReadonlyArray<Notices.Stop>>()
  /**
   * A turn T3 Code said finished that no hook had told of, said in its hook's
   * place, under the session `finished:<machine>:<thread>`: what tells a Stop
   * of its own from another's, which is what decides the turn is its, and
   * whether it's begun being said, after which a Stop of its own coming late
   * isn't said too; until then, one gives way to it.
   */
  interface Fallback {
    readonly about: Threads.Ref
    readonly session: string
    readonly key: string
    readonly run: Notices.Finished["run"]
    /** Whether it's still the thread's run, which ends once the thread starts again or goes. */
    readonly current: Effect.Effect<boolean>
    readonly at: number
    begun: boolean
    /** Its entry in the journal, once it's kept, to note as dealt with if a Stop of its own takes its place. */
    row?: number
  }
  /** Each turn said in its hook's place, by the key it's said once under, which is its run's, for an hour: only it or its Stop's update is said. */
  const fallbacks = new Map<string, Fallback>()
  /** The turn said in its hook's place that each update is. */
  const standing = new WeakMap<Conversation.Update, Fallback>()
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
  const state = yield* SubscriptionRef.make<State>({ on: true, heard: [] })
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
  const lapse = Effect.gen(function* () {
    while (true) {
      yield* dictationOver
      if (yield* Effect.raceFirst(Effect.as(Effect.sleep(holding), true), Effect.as(dictationStarted, false))) return
    }
  })
  const awaiting = Effect.gen(function* () {
    const answer = {}
    yield* STM.commit(TRef.update(awaited, (all) => [...all, answer]))
    const arrived = STM.commit(TRef.update(awaited, (all) => all.filter((other) => other !== answer)))
    // Stoppable even when awaited from what can't be stopped, like an answer being taken in, so closing yapd never waits for it.
    yield* lapse.pipe(Effect.zipRight(arrived), Effect.interruptible, Effect.forkIn(lifetime))
    return arrived
  })

  /** Queues something to say, unless yapd is off or was turned off and on since `turns`, and returns whether it did. */
  const enqueue = (entry: Inbox.Entry, turns: number) =>
    STM.commit(
      STM.flatMap(TRef.get(power), (current) =>
        current.on && current.turns === turns
          ? STM.as(TRef.update(inbox, (queued) => Inbox.add(queued, entry)), true)
          : STM.succeed(false),
      ),
    )

  /**
   * Renders a notice and queues it. One that can't be rendered is only logged.
   * `since` is when what it's about began, if before now, so it isn't said if
   * yapd was turned off since.
   */
  const tell = (notice: Inbox.Notice, since?: number) =>
    Effect.gen(function* () {
      const turns = since ?? (yield* switched).turns
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      yield* soon
      yield* voice.render(notice.spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const said = { session: notice.id, priority: notice.priority, arrivedAt: notice.at, notice, audio }
      if (!(yield* enqueue(said, turns))) {
        yield* removeFile(audio)
        return yield* Effect.logInfo(`Not saying "${notice.spoken}", since yapd is off`)
      }
      yield* Effect.logInfo(`Ready: ${notice.spoken}`)
    }).pipe(Effect.catchAllCause((cause) => Effect.logError(`Could not say "${notice.spoken}"`, cause)))

  const late = (update: Conversation.Update, spoken: string, failed: boolean) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      tell(
        {
          id: `late:${crypto.randomUUID()}`,
          kind: "notice",
          priority: failed ? "needs-you" : "done",
          spoken: introduce(update.project, spoken),
          at,
          stale: Effect.succeed(false),
        },
        readSince.get(update),
      ),
    )

  /**
   * Whether what the user says over an update goes to its T3 Code thread by
   * yapd's own hand, rather than the way hooks have always been answered:
   * only when the update is tied to the thread, and its hook isn't waiting.
   */
  const steered = (update: Conversation.Update) => update.about !== undefined && options.hands !== undefined && !hooked.has(update)

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
      yield* Effect.logInfo(`Delivered: ${message}`)
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
        yield* noted({ how: outcome.how, ...(outcome.waiting === undefined ? {} : { waiting: outcome.waiting }) })
        yield* Effect.logInfo(`Delivered through T3 Code (${outcome.how}): ${message}`)
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
      Effect.zipRight(late(pending.followUp.update, `Sent the queued message: ${pending.followUp.message}`, false)),
      Effect.catchAll(({ reason }) => late(pending.followUp.update, `Couldn't send the queued message "${pending.followUp.message}". ${reason}`, true)),
    )
  })

  /** Called with the event lock held. Unrelated input cancels queued replies to the old work. */
  const invalidate = (session: string) => Effect.gen(function* () {
    activity.set(session, { chain: {} })
    const channel = followed.get(session)
    followed.delete(session)
    for (const queued of channel?.queued ?? []) {
      yield* Effect.forkIn(late(queued.update, `That work moved on, so I didn't send the queued message "${queued.message}".`, true), lifetime)
    }
  })

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
    replied: PubSub.publish(replied, undefined),
    saying: (update, line) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.sync(() => {
          if (latest?.update === update) latest = { update, said: line, at, playing: true }
        }),
      ),
    // Only what goes to its thread by yapd's own hand, which is held back when it could give a secret away.
    withholds: (update, message) =>
      update.about !== undefined && options.hands !== undefined && steered(update) ? options.hands.keeps(update.about, message) : Effect.succeed(false),
  })

  const unsummarized = (project: string): Summary => ({
    priority: "done",
    spoken: `${speakable(project) ? project : "One of your threads"} finished a turn, but I couldn't summarize it.`,
  })

  /** A turn that finished, to sum up and queue, and what it's for. */
  interface Finished {
    readonly session: string
    readonly project: string
    readonly turn: Turn
    readonly thread: Thread
    readonly arrivedAt: number
    readonly generation: { readonly chain: object }
    readonly hook: Ticket | undefined
    /** Whether its Stop hook waits for a reply, which then goes back through it, even once a queued follow-up holds it. */
    readonly hooked: boolean
    readonly needsYou: boolean
    readonly turns: number
    /** The T3 Code thread it's from, worked out alongside the summary, when there's one. */
    readonly about: Effect.Effect<Option.Option<Threads.Ref>>
    /** For a turn no hook told of, said in its hook's place, which is said once, ever, under its key. */
    readonly fallback?: Fallback
  }

  const prepare = (finished: Finished) => {
    const { session, project, turn, thread, arrivedAt, generation, hook, needsYou, turns } = finished
    return Effect.gen(function* () {
      const [summary, about] = yield* Effect.all(
        [
          condenser.condense(project, turn).pipe(
            Effect.retry({ times: 1 }),
            Effect.catchAll((error) => Effect.logWarning("Could not condense", error).pipe(Effect.as(unsummarized(project)))),
          ),
          finished.about,
        ],
        { concurrency: 2 },
      )
      // Whoever sent it knows it needs the user, whatever the summary makes of it.
      const priority = needsYou ? "needs-you" : summary.priority
      // Even a reply to a follow-up, since yapd already said it passed that on.
      if (priority === "trivial") {
        yield* release(hook)
        return yield* Effect.logInfo("Skipped trivial update")
      }

      const spoken = introduce(project, summary.spoken)
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      // Rendering takes about as long as the speaker takes to get ready.
      yield* soon
      yield* voice.render(spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const update: Conversation.Update = {
        session,
        project,
        turn,
        needsYou: priority === "needs-you",
        spoken,
        audio,
        thread,
        at: arrivedAt,
        ...Option.match(about, { onNone: () => ({}), onSome: (about) => ({ about }) }),
      }
      generations.set(update, generation)
      if (finished.hooked) hooked.add(update)
      // Kept under the thread T3 Code knows it by, when it's linked, so what was said of it is found with the thread.
      const entry: Entry = {
        at: arrivedAt,
        kind: "update",
        host: thread.origin.host,
        project,
        ...Option.match(about, { onNone: () => ({ thread: session }), onSome: ({ machine, id }) => ({ machine, thread: id }) }),
        directory: thread.cwd,
        said: spoken,
        text: turn.message,
        detail: {
          priority,
          ...Option.match(turn.prompt, { onNone: () => ({}), onSome: (prompt) => ({ prompt }) }),
          ...(Option.isSome(about) ? { session } : {}),
        },
      }
      // Said once ever: one already kept under its key was said, or held, before. Never kept for one yapd won't say, as it's off.
      const { fallback } = finished
      const power = yield* switched
      if (fallback !== undefined && (!power.on || power.turns !== turns)) {
        yield* removeFile(audio)
        return yield* Effect.logInfo("Skipped update, since yapd is off")
      }
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
      if (fallback !== undefined) standing.set(update, fallback)
      if (!(yield* enqueue({ session, priority, arrivedAt, update, ...(hook === undefined ? {} : { hook }) }, turns))) {
        yield* removeFile(audio)
        yield* release(hook)
        return yield* Effect.logInfo("Skipped update, since yapd is off")
      }
      const row = claimed === undefined ? yield* journal.write(entry) : Option.flatten(claimed)
      if (Option.isSome(row)) rows.set(update, row.value)
      yield* Effect.logInfo(`Ready: ${spoken}`)
    }).pipe(
      workers.withPermits(1),
      // Stopped from outside, like when yapd is turned off, which skips what's caught below.
      Effect.onInterrupt(() => release(hook)),
      Effect.catchAllCause((cause) =>
        Effect.zipRight(
          release(hook),
          Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not prepare update", cause),
        ),
      ),
      Effect.annotateLogs({ project }),
    )
  }

  /** Lets a waiting Stop hook go without a reply. */
  const release = (hook: Ticket | undefined) => (hook === undefined ? Effect.void : waiting.close(hook))

  /** Drops a session's pending update, whether it's still being prepared or already waiting. */
  const discard = (session: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(preparing, session)
      const dropped = yield* STM.commit(
        TRef.modify(inbox, (current) => [current.get(session), Inbox.remove(current, session)] as const),
      )
      if (dropped !== undefined) yield* removeFile(Inbox.audio(dropped))
      // Its hook, if one waits, won't be getting a reply.
      yield* waiting.drop(session)
    })

  /**
   * The T3 Code thread a hook came from, when it ran on this machine and the
   * thread is found in time. Anything else keeps its update on the old path.
   */
  const linking = (session: string, cwd: string, origin: Origin): Effect.Effect<Option.Option<Threads.Ref>> => {
    const { link } = options
    if (link === undefined) return Effect.succeedNone
    // Read each time, since a Mac's hostname changes with the network.
    if (origin.host === undefined || origin.host.toLowerCase() !== hostname().toLowerCase()) {
      return Effect.as(Effect.logInfo(`Not linked: it came from ${origin.host ?? "a machine that didn't say"}`), Option.none())
    }
    return link(session, cwd).pipe(
      Effect.timeout(lookup),
      Effect.catchTag("TimeoutException", () =>
        Effect.as(Effect.logInfo("Not linked: T3 Code took too long to say which thread it is"), Option.none<Threads.Ref>()),
      ),
    )
  }

  /** The Stops of these sessions in the last hour, oldest first, by the agent's own ids for them. */
  const stopsOf = (sessions: ReadonlyArray<string>) => sessions.flatMap((session) => stops.get(session) ?? []).toSorted((a, b) => a.at - b.at)

  /** Turns said in a hook's place under this session that haven't begun being said, which are dropped with what's waiting under it. */
  const forsake = (session: string) => {
    for (const [key, fallback] of fallbacks) if (fallback.session === session && !fallback.begun) fallbacks.delete(key)
  }

  /**
   * A Stop came for a turn T3 Code's word may have been said of in its hook's
   * place, by the session its run had: one whose run's last words it has, or
   * whose it can't be told, takes the place of one still to be said, which is
   * then dealt with, as the Stop's own update is said in its stead. One begun
   * being said, whose run's words it has, was said already, so it's given back
   * for the Stop's update not to be. Called with the event lock held.
   */
  const giveWay = (session: string, stop: Notices.Stop) =>
    Effect.gen(function* () {
      const theirs = [...fallbacks.values()].filter((fallback) => fallback.run.natives.includes(session))
      const own = theirs.find((fallback) => Notices.whose(stop, fallback.run) === "own")
      for (const fallback of theirs) {
        if (fallback.begun || (fallback !== own && Notices.whose(stop, fallback.run) !== "unknown")) continue
        fallbacks.delete(fallback.key)
        yield* discard(fallback.session)
        yield* Effect.logInfo("Not saying a turn no hook told of, since its hook came after all")
        if (fallback.row !== undefined) yield* journal.markHeard([fallback.row], stop.at)
      }
      return own?.begun === true ? own : undefined
    })

  /**
   * A turn said in its hook's place, as its turn to be said comes: begun, it's
   * the turn's, so a Stop of its own coming later isn't said too; unless it
   * gave way to one already, or its thread is on another run by now. Taken
   * with the event lock held, so it's one or the other.
   */
  const begin = (fallback: Fallback) =>
    Effect.gen(function* () {
      if (fallbacks.get(fallback.key) !== fallback) return false
      if (!(yield* fallback.current)) {
        fallbacks.delete(fallback.key)
        return false
      }
      fallback.begun = true
      return true
    }).pipe(events.withPermits(1))

  /**
   * A turn T3 Code says one of its threads finished, which no hook told of,
   * like one run by an agent yapd has no hooks for: summed up and said like a
   * hook's update, once ever under its `key`, unless a Stop of its own came,
   * said or skipped, or its thread started again or went. It's the thread's
   * own session to yapd, and a reply to it can only go through T3 Code. The
   * turn is its, or its Stop's, as decided with the event lock held, so
   * neither is said once the other is.
   */
  const finished = (input: Notices.Finished) =>
    Effect.gen(function* () {
      // Not what notices about the thread go under, so neither takes the other's place.
      const session = `finished:${input.about.machine}:${input.about.id}`
      if (!(yield* input.current)) return yield* Effect.logInfo("Not saying a turn no hook told of, since its thread started again")
      // A Stop of its own came, said or skipped, even since T3 Code's word was looked into: what it said, or why it wasn't, stands.
      if (Notices.hooked(stopsOf(input.run.natives), input.run, input.run.startedAt)) return yield* Effect.logInfo("Left to its hook")
      // Heard of twice, as after a reconnect, it's said the once.
      if (fallbacks.has(input.key)) return
      const fallback: Fallback = {
        about: input.about,
        session,
        key: input.key,
        run: input.run,
        current: input.current,
        at: yield* Clock.currentTimeMillis,
        begun: false,
      }
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
          about: Effect.succeedSome(input.about),
          fallback,
        }),
      )
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
  const receive = (agent: Agent, payload: Payload, origin: Origin, wait: boolean) =>
    Effect.gen(function* () {
      const session = key(agent, payload.session_id)
      const arrivedAt = yield* Clock.currentTimeMillis
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
          // Every one, even one that's never said, so T3 Code's word that its thread finished leaves it to the hook.
          for (const [other, kept] of stops) {
            const recent = kept.filter(({ at }) => arrivedAt - at <= forgotten)
            if (recent.length === 0) stops.delete(other)
            else stops.set(other, recent)
          }
          for (const [key, fallback] of fallbacks) if (arrivedAt - fallback.at > forgotten) fallbacks.delete(key)
          stops.set(payload.session_id, [...(stops.get(payload.session_id) ?? []), stop])
          // Not kept for later, so a waiting hook is let go of at once.
          const { on, turns } = yield* switched
          if (!on) {
            yield* invalidate(session)
            return undefined
          }
          const hook = wait ? yield* waiting.open(session) : undefined
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
          const through = yield* giveWay(payload.session_id, stop)
          const needsYou = payload.needs_you === true
          // Nobody watches a session yapd started, so it's heard from however quick its turn, as is one that needs the user.
          const watched = !needsYou && origin.launched !== true
          // The user is probably still looking at a turn this short. Without a prompt there's no telling, so it's spoken.
          if (watched && !followedUp && prompt !== undefined && arrivedAt - prompt.at < minMillis) {
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
          if (through !== undefined) {
            yield* release(summaryHook)
            yield* Effect.logInfo("Skipped update, said already from T3 Code's word that it finished").pipe(Effect.annotateLogs({ project }))
            // Kept as said that way, which is what "it" was.
            yield* journal.write({
              at: arrivedAt,
              kind: "action",
              host: origin.host,
              project,
              machine: through.about.machine,
              thread: through.about.id,
              directory: payload.cwd,
              text: message,
              detail: { through: through.key, session },
            })
            return hook
          }
          yield* FiberMap.run(
            preparing,
            session,
            prepare({
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
              about: linking(payload.session_id, payload.cwd, origin),
            }),
          )
          return hook
        }
      }
    }).pipe(events.withPermits(1))

  /** The reply waits outside the lock, so other sessions' events keep coming in. */
  const handle: Handle = (agent, payload, origin, wait) =>
    receive(agent, payload, origin, wait).pipe(
      Effect.flatMap((hook) => (hook === undefined ? Effect.succeed(undefined) : waiting.reply(hook))),
    )

  /**
   * Nothing is read while the user dictates, or while yapd is off, and only
   * answers while one is on its way. Taken with when yapd was last turned on.
   */
  const takeNext = STM.gen(function* () {
    const { on, turns } = yield* TRef.get(power)
    if (!on || (yield* Floor.dictating(floor))) return yield* STM.retry
    const current = yield* TRef.get(inbox)
    const ready = Inbox.next(current, (yield* TRef.get(awaited)).length > 0)
    if (ready === undefined) return yield* STM.retry
    yield* TRef.set(inbox, Inbox.remove(current, ready.session))
    yield* TRef.set(floor.reading, true)
    yield* TRef.set(coming, false)
    return { ready, turns }
  })

  /** Something about to be ready, while yapd is on and nobody is dictating. Taken once. */
  const expected = STM.gen(function* () {
    const { on } = yield* TRef.get(power)
    if (!on || (yield* Floor.dictating(floor)) || !(yield* TRef.get(coming))) return yield* STM.retry
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
   * Says a notice. Only a question is listened to: whatever else they'd say to
   * it has nowhere to go. What can't be played was never said, so it isn't
   * what the user heard last; and a question that can't be asked in full, even
   * one that breaks off midway, counts as never said and goes unanswered, to be
   * asked again later or let go, rather than left open.
   */
  const say = (said: Inbox.Said, dealtWith: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const { question } = said.notice
      if (yield* said.notice.stale) return yield* dealtWith
      const saying = said.notice.saying ?? Effect.void
      if (question === undefined) {
        const playback = yield* audio.play(said.audio)
        yield* saying
        yield* playback.finished
        yield* said.notice.heard ?? Effect.void
        return yield* dealtWith
      }
      const answer = (heard: string, voiced: number) =>
        question.answer(heard, voiced).pipe(Effect.map(Option.map((proceed) => Effect.zipRight(dealtWith, proceed))))
      const answered = yield* conversation.ask({ audio: said.audio, saying, answer, ...(question.through === undefined ? {} : { through: question.through }) }).pipe(
        Effect.onError((cause) =>
          Cause.isInterruptedOnly(cause) ? Effect.void : dealtWith.pipe(Effect.zipRight(question.unsaid), Effect.zipRight(question.unanswered)),
        ),
      )
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

  /** Keeps an update the user is hearing, unless they're hearing it again. */
  const hear = (update: Conversation.Update) =>
    SubscriptionRef.update(state, (current) =>
      heardAlready(current.heard, update)
        ? current
        : { ...current, heard: [{ id: crypto.randomUUID(), update }, ...current.heard].slice(0, replayable) },
    )

  /** An update heard again has been said, or won't be. */
  const replayed = (replay: Inbox.Replay) =>
    Effect.sync(() => {
      if (replays.get(replay.id) === replay) replays.delete(replay.id)
    })

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
      if (row !== undefined) yield* journal.markHeard([row], yield* Clock.currentTimeMillis)
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
    const { ready, turns } = next.value
    // A turn said in its hook's place is the turn's once it's begun, unless it gave way to a Stop of its own, or its thread was on another run, by now.
    const fallback = "update" in ready ? standing.get(ready.update) : undefined
    if (fallback !== undefined && !(yield* begin(fallback))) {
      yield* removeFile(Inbox.audio(ready))
      yield* STM.commit(TRef.set(floor.reading, false))
      return yield* Effect.logInfo("Not saying a turn no hook told of, since its hook came or its thread started again")
    }
    if ("update" in ready) {
      readSince.set(ready.update, turns)
      yield* hear(ready.update)
      latest = { update: ready.update, said: ready.update.spoken, at: yield* Clock.currentTimeMillis, playing: true }
    }
    let kept = false
    let dealtWith = false
    /** An update read to the end, or answered: the user heard it. */
    let through = false
    /** Noted at once, even while the microphone stays open for a reply, so a dictation then neither puts it back nor finds it missed. */
    const heard = (update: Conversation.Update) =>
      Effect.suspend(() => {
        if (through) return Effect.void
        through = true
        const row = rows.get(update)
        return row === undefined ? Effect.void : Effect.flatMap(Clock.currentTimeMillis, (at) => journal.markHeard([row], at))
      }).pipe(Effect.uninterruptible)
    const reading =
      "update" in ready
        ? conversation.converse(ready.update, heard(ready.update)).pipe(Effect.zipRight(heard(ready.update)))
        : say(
            ready,
            Effect.sync(() => {
              dealtWith = true
            }),
          )
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
            Effect.suspend(() => keep(ready, dealtWith || through, turns)),
            (again) => {
              kept = again
            },
          ),
        ),
      ),
      // Stopped at once, and not kept for later.
      Effect.raceFirst(turnedOff(turns)),
      Effect.ensuring(
        Effect.suspend(() =>
          kept
            ? Effect.void
            : Effect.zipRight(
                removeFile(Inbox.audio(ready)),
                "update" in ready && ready.replay !== undefined ? replayed(ready.replay) : Effect.void,
              ),
        ),
      ),
      Effect.ensuring(STM.commit(TRef.set(floor.reading, false))),
      Effect.ensuring(
        Effect.gen(function* () {
          if (!("update" in ready)) return
          const at = yield* Clock.currentTimeMillis
          if (latest?.update === ready.update) latest = { ...latest, at, playing: false }
        }),
      ),
    )
    yield* Effect.sleep("400 millis")
  })

  /**
   * Off, what's being said stops at once, and what's waiting to be, or still
   * being prepared, is dropped. The preparing waits for the events going on, so
   * none gets past it half taken in.
   */
  const turn = (next: boolean) =>
    Effect.gen(function* () {
      const dropped = yield* STM.commit(
        STM.gen(function* () {
          const { on, turns } = yield* TRef.get(power)
          if (on === next) return undefined
          yield* TRef.set(power, { on: next, turns: turns + 1 })
          yield* TRef.set(coming, false)
          // Off, no answer is on its way any more.
          if (!next) yield* TRef.set(awaited, [])
          return next ? [] : yield* TRef.modify(inbox, (queued) => [[...queued.values()], Inbox.empty] as const)
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
        yield* FiberMap.clear(preparing)
      }).pipe(events.withPermits(1))
      // The hook of one the user heard, cut off by a dictation, waits on for a reply to it heard again.
      const { heard } = yield* SubscriptionRef.get(state)
      for (const entry of dropped) {
        yield* removeFile(Inbox.audio(entry))
        if (!("update" in entry)) continue
        if (!heardAlready(heard, entry.update)) yield* release(entry.hook)
        if (entry.replay !== undefined) yield* replayed(entry.replay)
      }
    })

  /** Says an update the user heard again, as it was said, and listens for a reply like after any update. */
  const replay = (id: string) =>
    Effect.gen(function* () {
      const found = (yield* SubscriptionRef.get(state)).heard.find((heard) => heard.id === id)
      if (found === undefined) return "unknown" as const
      const { on, turns } = yield* switched
      if (!on) return "off" as const
      // Once, however many times it's asked for before it's said.
      if (replays.get(id)?.turns === turns) return "queued" as const
      const asked: Inbox.Replay = { id, turns }
      replays.set(id, asked)
      return yield* again(found, asked).pipe(
        Effect.tap((result) => (result === "queued" ? Effect.void : replayed(asked))),
        Effect.onError(() => replayed(asked)),
      )
    })

  /** Renders an update heard before, and queues it. */
  const again = (found: HeardUpdate, asked: Inbox.Replay) =>
    Effect.gen(function* () {
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      yield* soon
      yield* voice.render(found.update.spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const update = { ...found.update, audio }
      // Replays keep both the hook generation and the original chain of voice replies.
      const generation = generations.get(found.update)
      if (generation !== undefined) generations.set(update, generation)
      if (hooked.has(found.update)) hooked.add(update)
      // And its entry in the journal, so heard to the end this time, it's noted as heard.
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
    /** What the user was told lately, newest first. */
    recent: Effect.flatMap(Clock.currentTimeMillis, (now) =>
      journal.since(now - Recent.lifetime, { most: Recent.most, kinds: ["update", "started"] }),
    ).pipe(Effect.map((entries) => entries.toReversed().map(Recent.fromJournal))),
    /** Whether yapd is on, and how many times it was turned on or off, so what was heard before can tell. */
    power: switched,
    /** The update being read, or the last one the user heard, what of it was said last, and when. */
    lastHeard: Effect.sync(() => Option.fromNullable(latest)),
    /** Something is about to be said, like an answer being worked out, so the speaker gets ready meanwhile. */
    coming: soon,
    /**
     * An answer is on its way: nothing but answers is said until what this
     * gives back is run, once it's queued or won't come, or for twenty seconds
     * after the user last stopped dictating at most.
     */
    awaiting,
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
    /** Each time something said over an update is taken in, which takes the place of whatever yapd asked before. */
    replies: Stream.fromPubSub(replied),
    /** The Stop hooks of these sessions in the last hour, when they came and what they said last, oldest first, by the agent's own ids for them, whether their updates were said or not. */
    stopped: (sessions: ReadonlyArray<string>) => Effect.sync((): ReadonlyArray<Notices.Stop> => stopsOf(sessions)),
    finished,
    overtaken,
  }
})
