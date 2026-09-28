import { Cause, Clock, Effect, FiberMap, Option, STM, TRef } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Condenser, type Summary, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Inbox from "./Inbox.ts"
import type { Agent, Payload } from "./Payload.ts"
import { chime, extension, play, Voice } from "./Voice.ts"

/** Updates are condensed and rendered in parallel, then spoken one at a time. */
export const make = Effect.gen(function* () {
  const condenser = yield* Condenser
  const voice = yield* Voice
  const minMillis = (yield* Config.minSeconds) * 1000

  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "yapd-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  )
  const removeFile = (path: string) => Effect.promise(() => rm(path, { force: true }))

  const inbox = yield* STM.commit(TRef.make(Inbox.empty))
  const preparing = yield* FiberMap.make<string>()
  const prompts = new Map<string, { readonly text: string | undefined; readonly at: number }>()
  const events = yield* Effect.makeSemaphore(1)
  const workers = yield* Effect.makeSemaphore(3)

  const fallback: Summary = { priority: "done", spoken: "Finished a turn, but I couldn't summarize it." }

  const prepare = (session: string, project: string, turn: Turn, arrivedAt: number) =>
    Effect.gen(function* () {
      const summary = yield* condenser.condense(turn).pipe(
        Effect.retry({ times: 1 }),
        Effect.catchAll((error) => Effect.logWarning("Could not condense", error).pipe(Effect.as(fallback))),
      )
      const { priority, spoken } = summary
      if (priority === "trivial") return yield* Effect.logInfo("Skipped trivial update")

      const audio = join(dir, `${crypto.randomUUID()}${extension}`)
      yield* voice.render(`${project}. ${spoken}`, audio).pipe(Effect.onError(() => removeFile(audio)))
      yield* STM.commit(
        TRef.update(inbox, (current) => Inbox.add(current, { session, priority, arrivedAt, audio })),
      )
      yield* Effect.logInfo(`Ready: ${spoken}`)
    }).pipe(
      workers.withPermits(1),
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not prepare update", cause),
      ),
      Effect.annotateLogs({ project }),
    )

  /** Drops a session's pending update, whether it's still being prepared or already waiting. */
  const discard = (session: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(preparing, session)
      const dropped = yield* STM.commit(
        TRef.modify(inbox, (current) => [current.get(session), Inbox.remove(current, session)] as const),
      )
      if (dropped !== undefined) yield* removeFile(dropped.audio)
    })

  const handle = (agent: Agent, payload: Payload) =>
    Effect.gen(function* () {
      const session = `${agent}:${payload.session_id}`
      // Any new activity makes the session's pending update stale.
      yield* discard(session)

      switch (payload.hook_event_name) {
        case "UserPromptSubmit":
          prompts.set(session, { text: payload.prompt, at: yield* Clock.currentTimeMillis })
          return
        case "Stop": {
          const message = payload.last_assistant_message?.trim()
          if (!message) return
          const project = basename(payload.cwd)
          const prompt = prompts.get(session)
          const arrivedAt = yield* Clock.currentTimeMillis
          // The user is probably still looking at a turn this short. Without a prompt there's no telling, so it's spoken.
          if (prompt !== undefined && arrivedAt - prompt.at < minMillis) {
            return yield* Effect.logInfo("Skipped quick turn").pipe(Effect.annotateLogs({ project }))
          }
          const turn = { prompt: Option.fromNullable(prompt?.text), message }
          yield* FiberMap.run(preparing, session, prepare(session, project, turn, arrivedAt))
        }
      }
    }).pipe(events.withPermits(1))

  const takeNext = STM.gen(function* () {
    const current = yield* TRef.get(inbox)
    const ready = Inbox.next(current)
    if (ready === undefined) return yield* STM.retry
    yield* TRef.set(inbox, Inbox.remove(current, ready.session))
    return ready
  })

  const speakNext = Effect.gen(function* () {
    const ready = yield* STM.commit(takeNext)
    yield* chime.pipe(Effect.ignore)
    yield* play(ready.audio).pipe(
      Effect.catchAll((error) => Effect.logError("Could not play update", error)),
      Effect.ensuring(removeFile(ready.audio)),
    )
    yield* Effect.sleep("400 millis")
  })

  return { handle, speak: Effect.forever(speakNext) }
})
