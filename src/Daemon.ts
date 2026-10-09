import { Cause, Clock, Effect, FiberMap, Option, PubSub, STM, Stream, SubscriptionRef, TRef } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Audio } from "./Audio.ts"
import { type Ticket, Waiting, wake } from "./ClaudeCode.ts"
import { Condenser, introduce, speakable, type Summary, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Conversation from "./Conversation.ts"
import * as Floor from "./Floor.ts"
import * as Inbox from "./Inbox.ts"
import { Journal } from "./Journal.ts"
import type { Origin } from "./Origin.ts"
import { type Agent, key, type Payload } from "./Payload.ts"
import { Persona } from "./Persona.ts"
import * as Project from "./Project.ts"
import * as Recent from "./Recent.ts"
import { RelayError, Relays, type Thread } from "./Relay.ts"
import type { Handle } from "./Server.ts"
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

/**
 * Updates are condensed and rendered in parallel, then spoken one at a time,
 * along with what yapd has to say for itself.
 */
export const make = Effect.gen(function* () {
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
  /**
   * The update being read, or the last one that was, what of it was said
   * last, like an answer over it, and when, which is what "it" means to the
   * user, with how many times yapd had been turned on or off as it was read:
   * once it's turned off, it's no longer what "it" means.
   */
  let latest: { readonly update: Conversation.Update; readonly said: string; at: number; playing: boolean; readonly turns: number } | undefined
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
   * yapd was turned off since. Never queued, however that ends, it's done with.
   */
  const tell = (notice: Inbox.Notice, since?: number) => {
    /** Whether it was queued, after which it's done with only once it's taken out to be said, or dropped. */
    let queued = false
    return Effect.gen(function* () {
      const turns = since ?? (yield* switched).turns
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
        return yield* Effect.logInfo(`Not saying "${notice.spoken}", since yapd is off`)
      }
      yield* Effect.logInfo(`Ready: ${notice.spoken}`)
    }).pipe(
      Effect.catchAllCause((cause) => Effect.logError(`Could not say "${notice.spoken}"`, cause)),
      Effect.ensuring(Effect.suspend(() => (queued ? Effect.void : (notice.gone ?? Effect.void)))),
    )
  }

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
          // Only once it's known to play, so a line for going ahead dropped as yapd was turned off, or that afplay couldn't play, never counts as the last one he heard.
          confirmed: persona.said(spoken),
        },
        readSince.get(update),
      ),
    )

  const moved = (update: Conversation.Update) => activity.get(update.session)?.chain !== generations.get(update)?.chain

  /** Called with the event lock held, before dispatch, since its reply can arrive immediately. */
  const register = (followUp: FollowUp, channel: Replies) => Effect.gen(function* () {
    const session = followUp.update.session
    const previousPrompt = prompts.get(session)
    const prompt = { text: followUp.message, at: yield* Clock.currentTimeMillis }
    channel.current = followUp
    prompts.set(session, prompt)
    return { followUp, thread: channel.thread, previousPrompt, prompt, generation: activity.get(session) }
  })

  const deliver = (pending: Effect.Effect.Success<ReturnType<typeof register>>) =>
    Effect.gen(function* () {
      const { followUp } = pending
      const { update, message } = followUp
      const session = update.session
      yield* relays.send(pending.thread, message).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            // Hooks or another follow-up may already have consumed or replaced this context.
            if (activity.get(session) !== pending.generation) return
            const channel = followed.get(session)
            if (channel?.current === followUp) delete channel.current
            if (prompts.get(session) === pending.prompt) {
              if (pending.previousPrompt === undefined) prompts.delete(session)
              else prompts.set(session, pending.previousPrompt)
            }
          }).pipe(events.withPermits(1)),
        ),
      )
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
      // Put back by a dictation that started just as this was sent, and answered now.
      const answered = yield* STM.commit(
        TRef.modify(inbox, (current) => {
          const queued = current.get(session)
          return queued !== undefined && "update" in queued && queued.update === update
            ? [queued, Inbox.remove(current, session)] as const
            : [undefined, current] as const
        }),
      )
      if (answered === undefined) return
      yield* removeFile(Inbox.audio(answered))
      yield* release(answered.hook)
    }).pipe(Effect.tapError(() => Effect.forkIn(sendNext(pending.followUp.update.session), lifetime)))

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
    send: (update, message) => Effect.gen(function* () {
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
          if (latest?.update === update) latest = { ...latest, said: line, at, playing: true }
        }),
      ),
  })

  const fallback = (project: string): Summary => ({
    priority: "done",
    spoken: `${speakable(project) ? project : "One of your threads"} finished a turn, but I couldn't summarize it.`,
  })

  const prepare = (
    session: string,
    project: string,
    turn: Turn,
    thread: Thread,
    arrivedAt: number,
    generation: { readonly chain: object },
    hook: Ticket | undefined,
    needsYou: boolean,
    turns: number,
  ) =>
    Effect.gen(function* () {
      const summary = yield* condenser.condense(project, turn).pipe(
        Effect.retry({ times: 1 }),
        Effect.catchAll((error) => Effect.logWarning("Could not condense", error).pipe(Effect.as(fallback(project)))),
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
      const update = { session, project, turn, needsYou: priority === "needs-you", spoken, audio, thread, at: arrivedAt }
      generations.set(update, generation)
      if (!(yield* enqueue({ session, priority, arrivedAt, update, ...(hook === undefined ? {} : { hook }) }, turns))) {
        yield* removeFile(audio)
        yield* release(hook)
        return yield* Effect.logInfo("Skipped update, since yapd is off")
      }
      const row = yield* journal.write({
        at: arrivedAt,
        kind: "update",
        host: thread.origin.host,
        project,
        thread: session,
        directory: thread.cwd,
        said: spoken,
        text: turn.message,
        detail: { priority, ...Option.match(turn.prompt, { onNone: () => ({}), onSome: (prompt) => ({ prompt }) }) },
      })
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
          yield* FiberMap.run(preparing, session, prepare(session, project, turn, thread, arrivedAt, currentGeneration, summaryHook, needsYou, turns))
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
      return yield* Effect.acquireRelease(voice.render(instead.spoken, path).pipe(Effect.onError(() => removeFile(path))), () => removeFile(path)).pipe(
        Effect.as({ path, spoken: instead.spoken, used: Effect.zipRight(Effect.logInfo(`Saying instead: ${instead.spoken}`), instead.used ?? Effect.void) }),
        Effect.catchAll((error) => Effect.as(Effect.logWarning(`Could not say "${instead.spoken}" instead`, error), own)),
      )
    })

  /**
   * Says a notice. Only a question, or an answer that can be followed up, is
   * listened to: whatever else they'd say to it has nowhere to go. What can't
   * be played was never said, so it isn't what the user heard last; and a
   * question that can't be asked in full, even one that breaks off midway,
   * counts as never said and goes unanswered, to be asked again later or let
   * go, rather than left open.
   */
  const say = (said: Inbox.Said, dealtWith: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const { question, followUp } = said.notice
      if (yield* said.notice.stale) return yield* dealtWith
      const saying = said.notice.saying ?? Effect.void
      const confirmed = said.notice.confirmed ?? Effect.void
      const { path: played, spoken, used } = yield* words(said)
      // Settled while its words were rendered, like a question closed by what he said meanwhile, it's dropped all the same.
      if (yield* said.notice.stale) return yield* dealtWith
      yield* used
      if (question === undefined && followUp !== undefined) {
        let through = false
        /** Once, as soon as it's said to the end, even with the microphone still open for a follow-up. */
        const heard = Effect.suspend(() => {
          if (through) return Effect.void
          through = true
          return Effect.zipRight(said.notice.heard ?? Effect.void, dealtWith)
        }).pipe(Effect.uninterruptible)
        // Listened to like an update, so he can follow up what he asked about, which only one said to the end lingers for.
        yield* conversation.answer({ audio: played, spoken, saying, confirmed, followUp, through: heard })
        // Cut off by a follow-up, a thanks or a stop, it's dealt with, never said again, but not heard: what he missed that it
        // was telling him, he didn't hear all of, so it's still his to catch up on, as when a dictation cuts it off.
        if (!through) yield* Effect.uninterruptible(dealtWith)
        return
      }
      if (question === undefined) {
        const playback = yield* audio.play(played)
        yield* saying
        if (playback.confirmed) yield* confirmed
        yield* playback.finished
        // afplay can't say it's playing, so that's known only now.
        if (!playback.confirmed) yield* confirmed
        yield* said.notice.heard ?? Effect.void
        return yield* dealtWith
      }
      const answer = (heard: string, voiced: number) =>
        question.answer(heard, voiced).pipe(Effect.map(Option.map((proceed) => Effect.zipRight(dealtWith, proceed))))
      const answered = yield* conversation.ask({ audio: played, spoken, saying, confirmed, answer }).pipe(
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
    if ("update" in ready) {
      readSince.set(ready.update, turns)
      yield* hear(ready.update)
      latest = { update: ready.update, said: ready.update.spoken, at: yield* Clock.currentTimeMillis, playing: true, turns }
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
        if (!("update" in entry)) {
          yield* entry.notice.gone ?? Effect.void
          continue
        }
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
  }
})
