import { Cause, Effect, Exit, Option, Queue, Scope, Stream } from "effect"
import type { Audio } from "../Audio.ts"
import type { Vad } from "../Vad.ts"
import { record } from "./Capture.ts"
import { Listening } from "./Listening.ts"
import type { Runtime } from "./Runtime.ts"
import type { SessionEvent, ThreadRef } from "./Types.ts"

export interface VoiceTurns {
  readonly event: (event: SessionEvent) => void
  /** The caller establishes any new Runtime onset/Stop before waiting for cleanup. */
  readonly suspend: Effect.Effect<void>
}

interface Interest {
  readonly responseId: string
  readonly deviceId?: string
  readonly focus?: ThreadRef
  active: boolean
}

interface Entry {
  readonly deviceId: string
  readonly scope: Scope.CloseableScope
  readonly opening: AbortController
  controller?: Listening
  closing?: Promise<void>
}

type VoiceRuntime = Pick<Runtime, "start" | "push" | "send" | "cancel" | "originFor">
const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))

/** A listener belongs to the current response, never to an idle device or a reply timer. */
export const make = (options: {
  readonly audio: Pick<Audio["Type"], "listenFor" | "listeningDevice">
  readonly vad: Vad["Type"]
  readonly runtime: VoiceRuntime
  readonly onError: (error: Error) => void
}): Effect.Effect<VoiceTurns, never, Scope.Scope> => Effect.gen(function* () {
  let policy: { readonly deviceId: string; readonly handsFree: boolean } | undefined
  let interest: Interest | undefined
  let current: Entry | undefined
  let suspended = false, closed = false, scheduled = false
  let revision = 0
  let work: Promise<void> = Promise.resolve()
  const entries = new Set<Entry>()
  const releases = new Set<Promise<void>>()
  const report = (error: unknown) => { try { options.onError(errorOf(error)) } catch { /* Diagnostics cannot prevent input cleanup. */ } }
  const eligible = () => !closed && !suspended && interest?.deviceId !== undefined && policy?.deviceId === interest.deviceId && policy.handsFree ? interest.deviceId : undefined

  const close = (entry: Entry, uncertain = false): Promise<void> => {
    if (entry.closing !== undefined) return entry.closing
    entry.opening.abort()
    if (current === entry) current = undefined
    const closing = (async () => {
      // Listening closes recording views before the listener's native scope.
      // This keeps a false onset gated until its cancellation is acknowledged.
      try { await entry.controller?.close(uncertain) } catch (error) { report(error) }
      try { await Effect.runPromise(Scope.close(entry.scope, Exit.void)) } catch (error) { report(error) }
      entries.delete(entry)
    })()
    entry.closing = closing
    releases.add(closing)
    void closing.finally(() => { releases.delete(closing) })
    return closing
  }
  const released = async () => { while (releases.size > 0) await Promise.all([...releases]) }
  const fail = (entry: Entry, error: unknown) => {
    if (entry.closing !== undefined || closed) return
    report(error)
    if (current === entry && interest?.deviceId === entry.deviceId) { interest.active = false; suspended = true }
    void close(entry, true)
  }

  const reconcile = async () => {
    for (;;) {
      if (closed) return
      const target = eligible()
      if (current !== undefined) {
        if (current.deviceId !== target || (!interest?.active && !current.controller?.busy)) { await close(current); continue }
        return
      }
      if (target === undefined || !interest?.active || options.audio.listenFor === undefined) return
      await released()
      if (target !== eligible() || !interest?.active || closed) continue
      const version = revision
      const entry: Entry = { deviceId: target, scope: Effect.runSync(Scope.make()), opening: new AbortController() }
      entries.add(entry); current = entry
      try {
        // Failure to create VAD must never activate input or become probability 0.
        const detect = await Effect.runPromise(options.vad.make, { signal: entry.opening.signal })
        if (entry.opening.signal.aborted || current !== entry || version !== revision) { await close(entry); continue }
        const listener = await Effect.runPromise(options.audio.listenFor(target).pipe(Scope.extend(entry.scope)), { signal: entry.opening.signal })
        if (entry.opening.signal.aborted || current !== entry || version !== revision || target !== eligible() || !interest?.active) { await close(entry); continue }
        const controller = new Listening({
          deviceId: target, runtime: options.runtime,
          focus: () => interest?.focus,
          record: async (input) => {
            const recording = await Effect.runPromise(record({
              id: input.id, deviceId: target,
              audio: { captureFor: () => listener.promote(input.id, input.fromSequence) },
              // Listening already pinned this onset and created its recognizer.
              runtime: { start: () => {}, push: (frame) => options.runtime.push(frame), send: (capture) => options.runtime.send(capture), cancel: (capture) => options.runtime.cancel(capture) },
              onError: (error) => fail(entry, error),
            }).pipe(Scope.extend(entry.scope)))
            return { seal: () => Effect.runPromise(recording.seal), send: () => Effect.runPromise(recording.send), cancel: () => Effect.runPromise(recording.cancel) }
          },
          onError: (error) => fail(entry, error),
          onEvent: (event) => { if (event.type === "settled") schedule() },
        })
        entry.controller = controller
        await Effect.runPromise(Queue.take(listener.frames).pipe(
          Effect.flatMap((input) => detect(input.frame).pipe(Effect.tap((probability) => Effect.sync(() => {
            if (entry.closing === undefined && current === entry) controller.push({ ...input, probability, echo: input.echoRisk })
          })))),
          Effect.forever,
          Effect.catchAllCause((cause) => Effect.sync(() => {
            if (entry.closing === undefined) fail(entry, new Error("Hands-free voice detection or input failed.", { cause: Cause.squash(cause) }))
          })),
          Effect.forkIn(entry.scope),
        ))
        return
      } catch (error) {
        if (!entry.opening.signal.aborted && !closed) fail(entry, error)
        await close(entry)
      }
    }
  }
  function schedule(): void {
    if (closed || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      work = work.then(reconcile).catch(report)
    })
  }
  const refresh = (newResponse = false) => {
    revision++
    if (current !== undefined && (current.deviceId !== eligible() || newResponse && current.controller === undefined || !interest?.active && current.controller === undefined)) void close(current)
    schedule()
  }
  const suspend = Effect.promise(async () => {
    suspended = true; interest = undefined; revision++
    await Promise.all([...entries].map((entry) => close(entry)))
    await released()
    await work
  })
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    closed = true; suspended = true; interest = undefined; revision++
    await Promise.all([...entries].map((entry) => close(entry, true))); await released(); await work
  }))
  if (options.audio.listeningDevice !== undefined) yield* Stream.runForEach(options.audio.listeningDevice, (selected) => Effect.sync(() => {
    policy = Option.getOrUndefined(selected)
    refresh()
  })).pipe(Effect.catchAllCause((cause) => Effect.sync(() => {
    if (closed) return
    policy = undefined; report(Cause.squash(cause)); refresh()
  })), Effect.forkScoped)

  return {
    suspend,
    event: (event) => {
      if (closed) return
      if (event.type === "response_started") {
        const origin = options.runtime.originFor(event.responseId)
        suspended = false
        interest = { responseId: event.responseId, ...(origin?.deviceId === undefined ? {} : { deviceId: origin.deviceId }), ...(origin?.focus === undefined ? {} : { focus: { ...origin.focus } }), active: true }
        refresh(true)
        return
      }
      if (suspended || interest === undefined) return
      const responseId = "responseId" in event ? event.responseId : undefined
      if (responseId !== undefined && responseId !== interest.responseId) return
      if (event.type === "output_resumed" || event.type === "playback" && event.state === "playing") interest.active = true
      else if (event.type === "error" || event.type === "response_done" && event.text.trim() === "" || event.type === "playback" && event.state !== "playing" || event.type === "output_cancelled" && event.reason !== "onset") interest.active = false
      else return
      refresh()
    },
  }
})
