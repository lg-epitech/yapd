import { Cause, Clock, Effect, FiberMap, Option, STM, TRef } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Audio } from "./Audio.ts"
import { type Ticket, Waiting } from "./ClaudeCode.ts"
import { Condenser, introduce, type Summary, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Conversation from "./Conversation.ts"
import * as Inbox from "./Inbox.ts"
import type { Origin } from "./Origin.ts"
import { type Agent, key, type Payload } from "./Payload.ts"
import * as Project from "./Project.ts"
import type { Thread } from "./Relay.ts"
import type { Handle } from "./Server.ts"
import { extension, Voice } from "./Voice.ts"

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

/** Updates are condensed and rendered in parallel, then spoken one at a time. */
export const make = Effect.gen(function* () {
  const condenser = yield* Condenser
  const voice = yield* Voice
  const audio = yield* Audio
  const waiting = yield* Waiting
  const minMillis = (yield* Config.minSeconds) * 1000

  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "yapd-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  )
  const removeFile = (path: string) => Effect.promise(() => rm(path, { force: true }))

  const inbox = yield* STM.commit(TRef.make(Inbox.empty))
  const preparing = yield* FiberMap.make<string>()
  const prompts = new Map<string, { readonly text: string | undefined; readonly at: number }>()
  /** When each session last did anything. */
  const activity = new Map<string, number>()
  /** Follow-ups the user just sent by voice, whose answers they'll want to hear however short. */
  const followed = new Map<string, string>()
  const events = yield* Effect.makeSemaphore(1)
  const workers = yield* Effect.makeSemaphore(3)

  const conversation = yield* Conversation.make({
    dir,
    moved: (update) => Effect.sync(() => (activity.get(update.session) ?? 0) > update.at),
    sent: (session, message) =>
      Effect.gen(function* () {
        followed.set(session, message)
        // A session woken by its hook never reports this as a prompt, and the next summary should answer it.
        prompts.set(session, { text: message, at: yield* Clock.currentTimeMillis })
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
    hook: Ticket | undefined,
  ) =>
    Effect.gen(function* () {
      const summary = yield* condenser.condense(project, turn).pipe(
        Effect.retry({ times: 1 }),
        Effect.catchAll((error) => Effect.logWarning("Could not condense", error).pipe(Effect.as(fallback(project)))),
      )
      const priority = summary.priority
      // Even a reply to a follow-up, since yapd already said it passed that on.
      if (priority === "trivial") {
        yield* release(hook)
        return yield* Effect.logInfo("Skipped trivial update")
      }

      const spoken = introduce(project, summary.spoken)
      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      yield* voice.render(spoken, audio).pipe(Effect.onError(() => removeFile(audio)))
      const update = { session, project, turn, needsYou: priority === "needs-you", spoken, audio, thread, at: arrivedAt }
      yield* STM.commit(
        TRef.update(inbox, (current) =>
          Inbox.add(current, { session, priority, arrivedAt, update, ...(hook === undefined ? {} : { hook }) }),
        ),
      )
      yield* Effect.logInfo(`Ready: ${spoken}`)
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

  /** Drops a session's pending update, whether it's still being prepared or already waiting. */
  const discard = (session: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(preparing, session)
      const dropped = yield* STM.commit(
        TRef.modify(inbox, (current) => [current.get(session), Inbox.remove(current, session)] as const),
      )
      if (dropped !== undefined) yield* removeFile(dropped.update.audio)
      // Its hook, if one waits, won't be getting a reply.
      yield* waiting.drop(session)
    })

  /** Returns the ticket of the session's Stop hook when it waits for a reply. */
  const receive = (agent: Agent, payload: Payload, origin: Origin, wait: boolean) =>
    Effect.gen(function* () {
      const session = key(agent, payload.session_id)
      const arrivedAt = yield* Clock.currentTimeMillis
      activity.set(session, arrivedAt)
      // Any new activity makes the session's pending update stale.
      yield* discard(session)

      switch (payload.hook_event_name) {
        case "UserPromptSubmit": {
          prompts.set(session, { text: payload.prompt, at: arrivedAt })
          // Anything but the follow-up itself means the user took over.
          const sent = followed.get(session)
          if (sent !== undefined && !squash(payload.prompt ?? "").includes(squash(sent))) followed.delete(session)
          return undefined
        }
        case "Stop": {
          const hook = wait ? yield* waiting.open(session) : undefined
          const message = payload.last_assistant_message?.trim()
          const followedUp = followed.delete(session)
          const project = yield* Project.name(payload.cwd)
          const prompt = prompts.get(session)
          if (!message) {
            yield* release(hook)
            return hook
          }
          // The user is probably still looking at a turn this short. Without a prompt there's no telling, so it's spoken.
          if (!followedUp && prompt !== undefined && arrivedAt - prompt.at < minMillis) {
            yield* release(hook)
            yield* Effect.logInfo("Skipped quick turn").pipe(Effect.annotateLogs({ project }))
            return hook
          }
          const turn = { prompt: Option.fromNullable(prompt?.text), message }
          const thread = { agent, session: payload.session_id, cwd: payload.cwd, message, origin }
          yield* FiberMap.run(preparing, session, prepare(session, project, turn, thread, arrivedAt, hook))
          return hook
        }
      }
    }).pipe(events.withPermits(1))

  /** The reply waits outside the lock, so other sessions' events keep coming in. */
  const handle: Handle = (agent, payload, origin, wait) =>
    receive(agent, payload, origin, wait).pipe(
      Effect.flatMap((hook) => (hook === undefined ? Effect.succeed(undefined) : waiting.reply(hook))),
    )

  const takeNext = STM.gen(function* () {
    const current = yield* TRef.get(inbox)
    const ready = Inbox.next(current)
    if (ready === undefined) return yield* STM.retry
    yield* TRef.set(inbox, Inbox.remove(current, ready.session))
    return ready
  })

  const speakNext = Effect.gen(function* () {
    const queued = yield* STM.commit(
      takeNext.pipe(
        STM.map(Option.some),
        STM.orElse(() => STM.succeed(Option.none())),
      ),
    )
    const ready = yield* Option.match(queued, {
      // Nothing left to say, so the microphone goes off until there is.
      onNone: () => audio.rest.pipe(Effect.zipRight(STM.commit(takeNext))),
      onSome: Effect.succeed,
    })
    yield* conversation.converse(ready.update).pipe(
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not speak update", cause),
      ),
      Effect.ensuring(Effect.zipRight(removeFile(ready.update.audio), release(ready.hook))),
    )
    yield* Effect.sleep("400 millis")
  })

  return { handle, speak: Effect.forever(speakNext) }
})
