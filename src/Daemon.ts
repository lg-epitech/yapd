import { Cause, Clock, Effect, Exit, Fiber, FiberMap, Option, STM, TRef } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Audio } from "./Audio.ts"
import { type Ticket, Waiting } from "./ClaudeCode.ts"
import { Condenser, introduce, type Summary, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Conversation from "./Conversation.ts"
import * as Floor from "./Floor.ts"
import * as Inbox from "./Inbox.ts"
import type { Origin } from "./Origin.ts"
import { type Agent, key, type Payload } from "./Payload.ts"
import * as Project from "./Project.ts"
import * as Recent from "./Recent.ts"
import { RelayError, type Thread } from "./Relay.ts"
import type { Handle } from "./Server.ts"
import { extension, Voice } from "./Voice.ts"

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

/** How long an update waits, at most, on which thread it came from. */
const linking = "2 seconds"

/** A T3 Code thread, as what's heard names it. */
type Link = NonNullable<Recent.Heard["thread"]>

export interface Options {
  /**
   * The T3 Code thread an update came from, when it can be told, so that "tell
   * that one to" can follow it. Asked alongside the summary, never for long,
   * and an update goes out without a link sooner than wait on one.
   */
  readonly locate?: (thread: Thread) => Effect.Effect<Option.Option<Link>>
}

/**
 * Updates are condensed and rendered in parallel, then spoken one at a time,
 * along with what yapd has to say for itself.
 */
export const make = (options: Options = {}) => Effect.gen(function* () {
  const scope = yield* Effect.scope
  const condenser = yield* Condenser
  const voice = yield* Voice
  const audio = yield* Audio
  const waiting = yield* Waiting
  const floor = yield* Floor.Floor
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
  const activity = new Map<string, number>()
  const generations = new WeakMap<Conversation.Update, number>()
  let generation = 0
  /** Each update's thread being looked up, kept for what's said about the update later. */
  const links = new WeakMap<Conversation.Update, Fiber.RuntimeFiber<Option.Option<Link>>>()
  /** Follow-ups the user just sent by voice, whose answers they'll want to hear however short. */
  const followed = new Map<string, { readonly message: string }>()
  let recent = Recent.empty
  const events = yield* Effect.makeSemaphore(1)
  const workers = yield* Effect.makeSemaphore(3)

  /** Renders a notice and queues it. One that can't be rendered is only logged. */
  const tell = (notice: Inbox.Notice) =>
    Effect.gen(function* () {
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      yield* voice.render(notice.spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const said = { session: notice.id, priority: notice.priority, arrivedAt: notice.at, notice, audio }
      yield* STM.commit(TRef.update(inbox, (current) => Inbox.add(current, said)))
      yield* Effect.logInfo(`Ready: ${notice.spoken}`)
    }).pipe(Effect.catchAllCause((cause) => Effect.logError(`Could not say "${notice.spoken}"`, cause)))

  /** The T3 Code thread `thread` is, when it can be told. Never waited on for long: what's said goes out without a link sooner than wait on one. */
  const locate = (thread: Thread) =>
    (options.locate?.(thread) ?? Effect.succeed(Option.none<Link>())).pipe(
      Effect.timeout(linking),
      Effect.catchAllCause(() => Effect.succeed(Option.none<Link>())),
    )

  /**
   * The thread `update` was found to be from as it was prepared. It's found by
   * the message its turn ended on, and a follow-up since has taken the thread
   * past that: only one that was never found is looked for now.
   */
  const linked = (update: Conversation.Update) =>
    Effect.gen(function* () {
      const link = links.get(update)
      const found = link === undefined ? Option.none<Link>() : Exit.getOrElse(yield* Fiber.await(link), () => Option.none<Link>())
      return Option.isSome(found) ? found : yield* locate(update.thread)
    })

  const conversation = yield* Conversation.make({
    dir,
    moved: (update) => Effect.sync(() => activity.get(update.session) !== generations.get(update)),
    send: (update, message, deliver) =>
      Effect.gen(function* () {
        const session = update.session
        const pending = yield* Effect.gen(function* () {
          if (activity.get(session) !== generations.get(update)) {
            return yield* new RelayError({ reason: "That session has moved on since, so I didn't send it." })
          }
          const previousFollowed = followed.get(session)
          const previousPrompt = prompts.get(session)
          const followUp = { message }
          const prompt = { text: message, at: yield* Clock.currentTimeMillis }
          // A reply can arrive before delivery returns, so its context is ready before dispatch.
          followed.set(session, followUp)
          prompts.set(session, prompt)
          return { previousFollowed, previousPrompt, followUp, prompt, generation: activity.get(session) }
        }).pipe(events.withPermits(1))
        yield* deliver.pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              // Hooks or another follow-up may already have consumed or replaced this context.
              if (activity.get(session) !== pending.generation) return
              if (followed.get(session) === pending.followUp) {
                if (pending.previousFollowed === undefined) followed.delete(session)
                else followed.set(session, pending.previousFollowed)
              }
              if (prompts.get(session) === pending.prompt) {
                if (pending.previousPrompt === undefined) prompts.delete(session)
                else prompts.set(session, pending.previousPrompt)
              }
            }).pipe(events.withPermits(1)),
          ),
        )
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
      }),
    late: (update, spoken, failed) =>
      Effect.gen(function* () {
        const id = `late:${crypto.randomUUID()}`
        const said = introduce(update.project, spoken)
        // How the follow-up went is about the thread it went to, like the update it answered: "tell it to" can follow it.
        const located = yield* linked(update)
        const at = yield* Clock.currentTimeMillis
        recent = Recent.add(
          recent,
          {
            id,
            project: update.project,
            ...(update.thread.origin.host === undefined ? {} : { host: update.thread.origin.host }),
            directory: update.thread.cwd,
            spoken: said,
            message: update.turn.message,
            ...(Option.isNone(located) ? {} : { thread: located.value }),
            at,
          },
          at,
        )
        yield* tell({ id, priority: failed ? "needs-you" : "done", spoken: said, at, stale: Effect.succeed(false) })
      }),
  })


  const fallback = (project: string): Summary => ({
    priority: "done",
    spoken: `${project} finished a turn, but I couldn't summarize it.`,
  })

  const prepare = (
    session: string,
    project: string,
    turn: Turn,
    thread: Thread,
    arrivedAt: number,
    generation: number,
    hook: Ticket | undefined,
    needsYou: boolean,
  ) =>
    Effect.gen(function* () {
      // Looked up while the summary is written, which takes about as long. Whatever the lookup does, the
      // update goes out: past its time, or failing, it just carries no thread. Interrupted with the rest if the session moves on.
      const locating = yield* Effect.fork(locate(thread))
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
      const id = crypto.randomUUID()
      const audio = join(dir, `${id}${extension}`)
      yield* voice.render(spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const update = { session, project, turn, needsYou: priority === "needs-you", spoken, audio, thread, at: arrivedAt }
      generations.set(update, generation)
      links.set(update, locating)
      // Noted before it's queued, since it can be read out the moment it is.
      const now = yield* Clock.currentTimeMillis
      recent = Recent.add(
        recent,
        {
          id,
          project,
          ...(thread.origin.host === undefined ? {} : { host: thread.origin.host }),
          directory: thread.cwd,
          spoken,
          message: turn.message,
          at: arrivedAt,
        },
        now,
      )
      yield* STM.commit(
        TRef.update(inbox, (current) =>
          Inbox.add(current, { id, session, priority, arrivedAt, update, ...(hook === undefined ? {} : { hook }) }),
        ),
      )
      yield* Effect.logInfo(`Ready: ${spoken}`)
      // Only this machine's threads are ever found: another machine's T3 Code isn't asked, so its updates carry no thread.
      const located = yield* Fiber.join(locating)
      if (Option.isSome(located)) recent = Recent.about(recent, id, located.value)
    }).pipe(
      workers.withPermits(1),
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

  /** An entry that leaves the inbox without being read out leaves what the user was going to hear too. */
  const forget = (entry: Inbox.Entry) =>
    Effect.sync(() => {
      recent = Recent.drop(recent, "update" in entry ? entry.id : entry.notice.id)
    })

  /** Drops a session's pending update, whether it's still being prepared or already waiting. */
  const discard = (session: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(preparing, session)
      const dropped = yield* STM.commit(
        TRef.modify(inbox, (current) => [current.get(session), Inbox.remove(current, session)] as const),
      )
      if (dropped !== undefined) yield* Effect.zipRight(removeFile(Inbox.audio(dropped)), forget(dropped))
      // Its hook, if one waits, won't be getting a reply.
      yield* waiting.drop(session)
    })

  /** Returns the ticket of the session's Stop hook when it waits for a reply. */
  const receive = (agent: Agent, payload: Payload, origin: Origin, wait: boolean) =>
    Effect.gen(function* () {
      const session = key(agent, payload.session_id)
      const arrivedAt = yield* Clock.currentTimeMillis
      const currentGeneration = ++generation
      activity.set(session, currentGeneration)
      // Any new activity makes the session's pending update stale.
      yield* discard(session)

      switch (payload.hook_event_name) {
        case "UserPromptSubmit": {
          prompts.set(session, { text: payload.prompt, at: arrivedAt })
          // Anything but the follow-up itself means the user took over.
          const sent = followed.get(session)
          if (sent !== undefined && !squash(payload.prompt ?? "").includes(squash(sent.message))) followed.delete(session)
          return undefined
        }
        case "Stop": {
          const hook = wait ? yield* waiting.open(session) : undefined
          const message = payload.last_assistant_message?.trim()
          const followedUp = followed.delete(session)
          // Hooks older than project names leave it to the daemon, which only sees its own machine's directories.
          const project = origin.project ?? (yield* Project.name(payload.cwd))
          const prompt = prompts.get(session)
          if (!message) {
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
          yield* FiberMap.run(preparing, session, prepare(session, project, turn, thread, arrivedAt, currentGeneration, hook, needsYou))
          return hook
        }
      }
    }).pipe(events.withPermits(1))

  /** The reply waits outside the lock, so other sessions' events keep coming in. */
  const handle: Handle = (agent, payload, origin, wait) =>
    receive(agent, payload, origin, wait).pipe(
      Effect.flatMap((hook) => (hook === undefined ? Effect.succeed(undefined) : waiting.reply(hook))),
    )

  /** Nothing is read while the user dictates. */
  const takeNext = STM.gen(function* () {
    if (yield* Floor.dictating(floor)) return yield* STM.retry
    const current = yield* TRef.get(inbox)
    const ready = Inbox.next(current)
    if (ready === undefined) return yield* STM.retry
    yield* TRef.set(inbox, Inbox.remove(current, ready.session))
    yield* TRef.set(floor.reading, true)
    return ready
  })

  /**
   * Puts back what a dictation cut off, to be said again from the start: an
   * update unless the session has moved on or been answered since, even by a
   * follow-up that's still on its way, and a notice unless it has been dealt
   * with. What's put back stays among what was heard until it's read again,
   * however much plays before its turn comes round.
   */
  const keep = (ready: Inbox.Entry, dealtWith: boolean) =>
    Effect.gen(function* () {
      const over =
        "update" in ready
          ? activity.get(ready.session) !== generations.get(ready.update) ||
            followed.has(ready.session) ||
            (yield* conversation.sending(ready.session, ready.update))
          : dealtWith
      if (over) return false
      const again = yield* STM.commit(
        TRef.modify(inbox, (current) => (current.has(ready.session) ? [false, current] : [true, Inbox.add(current, ready)])),
      )
      if (again) recent = Recent.keep(recent, "update" in ready ? ready.id : ready.notice.id)
      return again
    })

  /** A hook is let go of once the follow-up on its way has reached it, or it would get none. */
  const letGo = (ready: Inbox.Entry) =>
    "update" in ready && ready.hook !== undefined
      ? conversation.settled(ready.session).pipe(Effect.zipRight(release(ready.hook)), Effect.forkIn(scope), Effect.asVoid)
      : Effect.void

  /**
   * Counts what has started playing as heard, from its first word: a dictation
   * over it can already point at it. Only once it has: what never starts, the
   * user knows nothing of, and it's forgotten with its entry.
   */
  const heard = (id: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      recent = Recent.heard(recent, id, now)
    })

  /** Says a notice. Only a question is listened to: whatever else they'd say to it has nowhere to go. */
  const say = (said: Inbox.Said, dealtWith: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const { question } = said.notice
      if (yield* said.notice.stale) return yield* dealtWith
      if (question === undefined) {
        const playback = yield* audio.play(said.audio)
        yield* heard(said.notice.id)
        yield* playback.finished
        return yield* dealtWith
      }
      const answer = (heard: string) =>
        question.answer(heard).pipe(Effect.map(Option.map((proceed) => Effect.zipRight(dealtWith, proceed))))
      const answered = yield* conversation.ask({ audio: said.audio, started: heard(said.notice.id), answer })
      if (!answered) yield* Effect.uninterruptible(Effect.zipRight(dealtWith, question.unanswered))
    }).pipe(Effect.scoped)

  const dictationStarted = STM.commit(
    STM.flatMap(Floor.dictating(floor), (dictating) => (dictating ? STM.void : STM.retry)),
  )

  const speakNext = Effect.gen(function* () {
    const queued = yield* STM.commit(
      takeNext.pipe(
        STM.map(Option.some),
        STM.orElse(() => STM.succeed(Option.none())),
      ),
    )
    const ready = yield* Option.match(queued, {
      // Nothing left to say, so the microphone goes off until there is, once no dictation is using it.
      onNone: () => Floor.use(floor, audio)(Effect.void).pipe(Effect.zipRight(STM.commit(takeNext))),
      onSome: Effect.succeed,
    })
    let kept = false
    let dealtWith = false
    const reading =
      "update" in ready
        ? conversation.converse(ready.update, heard(ready.id))
        : say(
            ready,
            Effect.sync(() => {
              dealtWith = true
            }),
          )
    yield* reading.pipe(
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not speak update", cause),
      ),
      // Stopped at once, and let go of before the dictation starts.
      Effect.raceFirst(
        Effect.zipRight(
          dictationStarted,
          Effect.map(
            Effect.suspend(() => keep(ready, dealtWith)),
            (again) => {
              kept = again
            },
          ),
        ),
      ),
      // Forgotten only if it never started playing: a stale notice, or an update whose session moved on.
      Effect.ensuring(Effect.suspend(() => (kept ? Effect.void : Effect.all([removeFile(Inbox.audio(ready)), letGo(ready), forget(ready)], { discard: true })))),
      Effect.ensuring(STM.commit(TRef.set(floor.reading, false))),
    )
    yield* Effect.sleep("400 millis")
  })

  return {
    handle,
    speak: Effect.forever(speakNext),
    tell,
    /** What the user had heard by `at`, the latest first, as it stood then. What's still waiting to be read out isn't theirs to point at yet. */
    recent: (at: number) => Effect.sync(() => Recent.heardBy(recent, at)),
    /** Notes something yapd is about to say for itself, for the user to build on like they do on updates. Noted before it's told, since it counts once it plays. */
    note: (heard: Recent.Heard) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        recent = Recent.add(recent, heard, now)
      }),
  }
})
