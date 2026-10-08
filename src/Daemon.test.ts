import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Queue, Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { Audio } from "./Audio.ts"
import { Waiting, WaitingLive } from "./ClaudeCode.ts"
import { Condenser, type Turn } from "./Condenser.ts"
import * as Daemon from "./Daemon.ts"
import { defaults } from "./Endpointer.ts"
import * as Floor from "./Floor.ts"
import { RelayError, Relays, type Thread } from "./Relay.ts"
import { key } from "./Payload.ts"
import { Responder } from "./Responder.ts"
import type { Handle } from "./Server.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad, VadError } from "./Vad.ts"
import * as Persona from "./Persona.ts"
import { Voice } from "./Voice.ts"

/**
 * Runs the daemon with updates that each take ten seconds to read, and no
 * microphone unless the user `says` something, which is then meant for the agent
 * and takes three seconds to send.
 */
const make = (says?: string, options: {
  /** How long rendering takes, which is at once unless said. */
  readonly renderSeconds?: number
  readonly transcripts?: ReadonlyArray<string>
  readonly waitingHooks?: boolean
  readonly onHookOpen?: () => Effect.Effect<void>
  readonly trivialMessages?: ReadonlyArray<string>
  readonly send?: (thread: Thread, text: string, handle: Handle, nextEvent: (...prefixes: ReadonlyArray<string>) => Effect.Effect<string>) => Effect.Effect<void, RelayError>
} = {}) => Effect.gen(function* () {
  /** What each rendered file says, and what was played, in order. */
  const rendered = new Map<string, string>()
  const played: Array<string> = []
  const stopped: Array<string> = []
  /** What happened to follow-ups and the hooks that wait for them, in order. */
  const followUps: Array<string> = []
  const condensed: Array<Turn> = []
  const logs = yield* Queue.unbounded<string>()
  const playbacks = yield* Queue.unbounded<string>()
  const nextEvent = (...prefixes: ReadonlyArray<string>) => Effect.gen(function* () {
    while (true) {
      const message = yield* Queue.take(logs)
      if (prefixes.some((prefix) => message.startsWith(prefix))) return message
    }
  })
  const microphone = yield* Queue.unbounded<Float32Array>()
  const transcripts = [...options.transcripts ?? []]
  const waiting = options.waitingHooks ? yield* Waiting.pipe(Effect.provide(WaitingLive)) : undefined
  let handle: Handle
  let rests = 0
  const layer = Layer.mergeAll(
    Persona.Plain,
    Layer.succeed(Condenser, {
      condense: (_, turn) => Effect.sync(() => {
        condensed.push(turn)
        return { priority: options.trivialMessages?.includes(turn.message) ? "trivial" as const : "done" as const, spoken: turn.message }
      }),
    }),
    Layer.succeed(Voice, {
      render: (text, path) =>
        Effect.sleep(`${options.renderSeconds ?? 0} seconds`).pipe(Effect.zipRight(Effect.sync(() => void rendered.set(path, text)))),
    }),
    Layer.succeed(Audio, {
      play: (path) =>
        Effect.gen(function* () {
          const text = rendered.get(path) ?? path
          played.push(text)
          yield* Queue.offer(playbacks, text)
          let done = false
          // Closing the scope stops it, as with the helper.
          yield* Effect.addFinalizer(() => Effect.sync(() => void (done || stopped.push(text))))
          return {
            duration: 10,
            finished: Effect.sleep("10 seconds").pipe(
              Effect.tap(() => {
                done = true
              }),
            ),
            stop: Effect.succeed(2),
            volume: () => Effect.void,
          }
        }),
      microphone: Effect.succeed(says === undefined ? Option.none() : Option.some(microphone)),
      rest: Effect.sync(() => void rests++),
    }),
    Layer.succeed(Waiting, waiting === undefined ? {
      open: (session) => Effect.map(Deferred.make<string | undefined>(), (answer) => ({ session, answer })),
      close: ({ session }) => Effect.sync(() => void followUps.push(`${session} let go`)),
      drop: () => Effect.void,
      deliver: () => Effect.succeed(false),
      reply: () => Effect.succeed(undefined),
    } : { ...waiting, open: (session) => waiting.open(session).pipe(Effect.tap(() => options.onHookOpen?.() ?? Effect.void)) }),
    Layer.succeed(Vad, {
      // Each frame holds the probability that it's speech.
      make: says === undefined ? Effect.fail(new VadError({ cause: "no microphone" })) : Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)),
    }),
    Layer.succeed(Transcriber, { transcribe: () => Effect.sync(() => transcripts.shift() ?? says ?? "") }),
    Layer.succeed(Responder, {
      respond: ({ heard }) =>
        says === undefined ? Effect.die("nothing to respond to") : Effect.succeed({ intent: "send" as const, spoken: "Okay, passed on.", message: heard }),
    }),
    Layer.succeed(Relays, {
      send: (thread, text) =>
        Effect.suspend(() => options.send?.(thread, text, handle, nextEvent) ?? (waiting === undefined
          ? Effect.sleep("3 seconds")
          : waiting.deliver(key(thread.agent, thread.session), text).pipe(Effect.flatMap((taken) => taken ? Effect.void : Effect.fail(new RelayError({ reason: "No waiting hook." })))))).pipe(
          Effect.zipRight(Effect.sync(() => void followUps.push(`${thread.session} sent: ${text}`))),
        ),
    }),
    Floor.layer,
    Logger.add(Logger.make(({ message }) => {
      for (const line of Array.isArray(message) ? message : [message]) {
        if (typeof line === "string") Queue.unsafeOffer(logs, line)
      }
    })),
  )
  const context = yield* Layer.build(layer)
  const made = yield* Daemon.make.pipe(Effect.provide(context))
  handle = made.handle
  const { speak: read, tell } = made
  yield* Effect.forkScoped(read)
  const floor = Context.get(context, Floor.Floor)
  // Lets the fibers catch up on what the test did, since the clock only moves when told to.
  const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
  const finish = (session: string, message: string, waits = false) =>
    handle(
      "claude",
      { hook_event_name: "Stop", session_id: session, cwd: "/tmp", last_assistant_message: message },
      { project: "yapd" },
      waits,
    ).pipe(Effect.tap(() => flush))
  /** Says what the user `says`, over whatever is being read. */
  const speak = Queue.offerAll(microphone, [
    ...Array.from({ length: 10 }, () => new Float32Array([0.9])),
    ...Array.from({ length: defaults.silence }, () => new Float32Array([0])),
  ]).pipe(Effect.zipRight(flush))
  const wait = (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush))
  /** A turn that took `seconds`, as its hooks report it. */
  const turn = (session: string, message: string, seconds: number, extra: { readonly needsYou?: boolean; readonly launched?: boolean } = {}) =>
    Effect.gen(function* () {
      yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: session, cwd: "/tmp", prompt: "Go on." }, { project: "yapd" }, false)
      yield* wait(seconds)
      yield* handle(
        "claude",
        { hook_event_name: "Stop", session_id: session, cwd: "/tmp", last_assistant_message: message, ...(extra.needsYou ? { needs_you: true } : {}) },
        { project: "yapd", ...(extra.launched ? { launched: true } : {}) },
        false,
      )
      yield* flush
    })
  /** Something yapd has to say for itself, which as a question records how it went. */
  const notice = (id: string, spoken: string, options: { readonly question?: Array<string>; readonly stale?: boolean; readonly needsYou?: boolean } = {}) =>
    tell({
      id,
      priority: options.question !== undefined || options.needsYou === true ? "needs-you" : "done",
      spoken,
      at: 0,
      stale: Effect.succeed(options.stale === true),
      ...(options.question === undefined
        ? {}
        : {
            question: {
              answer: () => Effect.succeed(Option.none()),
              unanswered: Effect.sync(() => void options.question?.push(`${id} unanswered`)),
            },
          }),
    }).pipe(Effect.zipRight(flush))
  /** Takes the floor as a dictation would, until the returned scope closes. */
  const dictate = Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Floor.take.pipe(Effect.provideService(Floor.Floor, floor), Scope.extend(scope))
    yield* flush
    return scope
  })
  /** Holds the speaker and microphone as a dictation records, until the returned effect lets go. */
  const record = Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    yield* Effect.forkScoped(Floor.use(floor, Context.get(context, Audio))(Deferred.await(done)))
    yield* flush
    return Deferred.succeed(done, undefined).pipe(Effect.zipRight(flush))
  })
  const reading = STM.commit(TRef.get(floor.reading))
  /** What the user heard lately, newest first, by id. */
  const heard = Effect.map(Stream.runHead(made.state), (state) => Option.getOrThrow(state).heard.map(({ id }) => id))
  const toggle = (on: boolean) => made.turn(on).pipe(Effect.zipRight(flush))
  return { handle, finish, turn, notice, speak, followUps, wait, dictate, record, reading, played, stopped, condensed, nextEvent, nextPlayback: Queue.take(playbacks), rests: () => rests, renders: () => rendered.size, flush, toggle, power: made.turn, heard, replay: made.replay }
})

const daemon = make()

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Daemon", () => {
  test("stops an update for a dictation, and reads it again after, before newer ones", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictate, reading, played, stopped } = yield* daemon
        yield* finish("a", "The PR is ready.")
        const dictation = yield* dictate
        const readingDuring = yield* reading
        yield* finish("b", "The tests pass.")
        yield* wait(30)
        const playedDuring = [...played]
        yield* Scope.close(dictation, Exit.void)
        yield* wait(0)
        yield* wait(11)
        // Copies, since closing the test stops whatever is still playing.
        return { played: [...played], playedDuring, stopped: [...stopped], readingDuring }
      }),
    )
    expect(result.stopped).toEqual(["yapd. The PR is ready."])
    expect(result.readingDuring).toBe(false)
    // Nothing was read while the user dictated.
    expect(result.playedDuring).toEqual(["yapd. The PR is ready."])
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready.", "yapd. The tests pass."])
  })

  test("turns the microphone off once a dictation lets go of it, never while it records", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictate, record, rests } = yield* daemon
        yield* finish("a", "The PR is ready.")
        const before = rests()
        yield* dictate
        const stop = yield* record
        // The update it cut off has let go, and there's nothing else to read.
        yield* wait(1)
        const during = rests()
        yield* stop
        return { before, during, after: rests() }
      }),
    )
    expect(result.during).toBe(result.before)
    // Once as the dictation lets go, and once more by the daemon, which had nothing to read.
    expect(result.after).toBe(result.before + 2)
  })

  test("drops an update whose session moved on during the dictation", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictate, played } = yield* daemon
        yield* finish("a", "The PR is ready.")
        const dictation = yield* dictate
        yield* finish("a", "Merged it.")
        yield* Scope.close(dictation, Exit.void)
        yield* wait(0)
        yield* wait(11)
        return { played }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. Merged it."])
  })

  test("passes on a reply even when a dictation starts as it's being sent, and says so after", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, speak, followUps, wait, dictate, played } = yield* make("Merge it.")
        yield* finish("a", "The PR is ready.", true)
        yield* speak
        // On its way to the agent, which takes three seconds.
        yield* wait(1)
        const dictation = yield* dictate
        const during = [...followUps]
        yield* wait(3)
        const sent = [...followUps]
        yield* Scope.close(dictation, Exit.void)
        yield* wait(0)
        yield* wait(11)
        return { during, sent, played: [...played] }
      }),
    )
    expect(result.during).toEqual([])
    // Its hook stays, so a reply to the update heard again can reach it too.
    expect(result.sent).toEqual(["a sent: Merge it."])
    // The update isn't read again: it was answered.
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. Okay, passed on."])
  })

  test.each([false, true])("keeps a fast follow-up answer that arrives before delivery returns, with a prompt hook: %s", async (promptHook) => {
    let replyState = ""
    const result = await run(
      Effect.gen(function* () {
        const { turn, speak, wait, nextEvent, nextPlayback, condensed, played } = yield* make("Explain it.", {
          send: (thread, text, handle, nextEvent) => Effect.gen(function* () {
            if (promptHook) {
              yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: thread.session, cwd: "/tmp", prompt: text }, { project: "yapd" }, false)
            }
            yield* handle(
              "claude",
              { hook_event_name: "Stop", session_id: thread.session, cwd: "/tmp", last_assistant_message: "Here's what changed." },
              { project: "yapd" },
              false,
            )
            // The reply is prepared before delivery finishes, including when it was skipped.
            replyState = yield* nextEvent("Ready:", "Skipped quick turn")
          }),
        })
        yield* turn("a", "The PR is ready.", 21)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        const confirmation = yield* nextPlayback
        yield* wait(14)
        const answer = yield* nextPlayback
        return { confirmation, answer, played: [...played], prompts: condensed.map(({ prompt }) => prompt) }
      }),
    )
    expect(replyState).toBe("Ready: yapd. Here's what changed.")
    expect(result.confirmation).toBe("Okay, passed on.")
    expect(result.answer).toBe("yapd. Here's what changed.")
    expect(result.played).toEqual(["yapd. The PR is ready.", "Okay, passed on.", "yapd. Here's what changed."])
    expect(result.prompts).toEqual([Option.some("Go on."), Option.some("Explain it.")])
  })

  test("restores the previous prompt and quick-turn behavior when delivery fails", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { turn, finish, speak, wait, nextEvent, nextPlayback, condensed } = yield* make("Merge it.", {
          send: () => Effect.fail(new RelayError({ reason: "The agent couldn't accept that." })),
        })
        yield* turn("a", "May I merge the PR?", 5, { needsYou: true })
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        const failure = yield* nextPlayback
        yield* wait(1)
        yield* finish("a", "Another quick turn.")
        const quick = yield* nextEvent("Ready:", "Skipped quick turn")
        yield* wait(20)
        yield* finish("a", "A later full update.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        return { failure, quick, prompts: condensed.map(({ prompt }) => prompt) }
      }),
    )
    expect(result.failure).toBe("The agent couldn't accept that.")
    expect(result.quick).toBe("Skipped quick turn")
    expect(result.prompts).toEqual([Option.some("Go on."), Option.some("Go on.")])
  })

  test("keeps and answers a fresh update while an older follow-up is still being delivered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sending = yield* Deferred.make<void>()
        const respond = yield* Deferred.make<void>()
        const answered = yield* Deferred.make<void>()
        const delivered = yield* Deferred.make<void>()
        let dispatches = 0
        const { finish, speak, wait, dictate, nextEvent, nextPlayback, played } = yield* make("Explain it.", {
          send: (thread, _, handle, nextEvent) => Effect.gen(function* () {
            dispatches++
            if (dispatches !== 1) return
            yield* Deferred.succeed(sending, undefined)
            yield* Deferred.await(respond)
            yield* handle(
              "claude",
              { hook_event_name: "Stop", session_id: thread.session, cwd: "/tmp", last_assistant_message: "Here's what changed." },
              { project: "yapd" },
              false,
            )
            yield* nextEvent("Ready:")
            yield* Deferred.succeed(answered, undefined)
            yield* Deferred.await(delivered)
          }),
        })
        yield* finish("a", "The PR is ready.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* Deferred.await(sending)
        const first = yield* dictate
        yield* Deferred.succeed(respond, undefined)
        yield* Deferred.await(answered)
        yield* Scope.close(first, Exit.void)
        yield* wait(1)
        yield* nextPlayback
        // The pending dispatch belongs to the old update, so this interruption puts the new one back.
        const second = yield* dictate
        yield* Scope.close(second, Exit.void)
        yield* wait(1)
        const repeated = yield* nextPlayback
        // A follow-up to the new update can also start while the old dispatch is still pending.
        yield* speak
        const confirmation = yield* nextPlayback
        const beforeOldDelivery = dispatches
        yield* Deferred.succeed(delivered, undefined)
        yield* nextEvent("Ready:")
        return { repeated, confirmation, beforeOldDelivery, played: [...played] }
      }),
    )
    expect(result.repeated).toBe("yapd. Here's what changed.")
    expect(result.confirmation).toBe("Okay, passed on.")
    expect(result.beforeOldDelivery).toBe(2)
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. Here's what changed.", "yapd. Here's what changed.", "Okay, passed on."])
  })

  test("rejects a follow-up after a newer hook received in the same millisecond", async () => {
    let deliveries = 0
    const result = await run(
      Effect.gen(function* () {
        const { handle, finish, speak, nextEvent, nextPlayback } = yield* make("Merge it.", {
          send: () => Effect.sync(() => { deliveries++ }),
        })
        yield* finish("a", "The PR is ready.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Different work." }, { project: "yapd" }, false)
        yield* speak
        return yield* nextPlayback
      }),
    )
    expect(deliveries).toBe(0)
    expect(result).toBe("That session has moved on since, so I didn't send it.")
  })

  test("skips a turn the user was likely watching, but never one that needs them or that yapd started", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { turn, wait, played } = yield* daemon
        yield* turn("a", "Quick and watched.", 5)
        yield* turn("b", "Quick, with nobody watching.", 5, { launched: true })
        yield* wait(11)
        yield* turn("c", "It was refused when it tried to push.", 5, { needsYou: true })
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. Quick, with nobody watching.", "yapd. It was refused when it tried to push."])
  })

  test("says what yapd has to say for itself in turn, questions first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, notice, wait, played } = yield* daemon
        const asked: Array<string> = []
        yield* wait(1)
        yield* finish("a", "The PR is ready.")
        yield* finish("b", "The tests pass.")
        yield* notice("started", "Started in yapd, on Fable, in a worktree.")
        yield* notice("gone", "Looking through yapd first.", { stale: true, needsYou: true })
        yield* notice("question", "Which project is the loader fix for?", { question: asked })
        yield* wait(11)
        yield* wait(11)
        const meanwhile = [...asked]
        // Nobody said anything in the time a question leaves for it.
        yield* wait(11)
        yield* wait(11)
        return { played: [...played], meanwhile, asked }
      }),
    )
    expect(result.played).toEqual([
      "yapd. The PR is ready.",
      "Which project is the loader fix for?",
      // From when the dictation was sent, which was before the update came in.
      "Started in yapd, on Fable, in a worktree.",
      "yapd. The tests pass.",
    ])
    expect(result.meanwhile).toEqual(["question unanswered"])
    expect(result.asked).toEqual(["question unanswered"])
  })

  test("asks a question again after the dictation that cut it off, without counting it unanswered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, dictate, played } = yield* daemon
        const asked: Array<string> = []
        yield* notice("question", "Which project is the loader fix for?", { question: asked })
        yield* wait(2)
        const dictation = yield* dictate
        yield* wait(30)
        const during = { played: [...played], asked: [...asked] }
        yield* Scope.close(dictation, Exit.void)
        yield* wait(0)
        yield* wait(11)
        return { during, played: [...played], asked }
      }),
    )
    expect(result.during).toEqual({ played: ["Which project is the loader fix for?"], asked: [] })
    expect(result.played).toEqual(["Which project is the loader fix for?", "Which project is the loader fix for?"])
    expect(result.asked).toEqual(["question unanswered"])
  })

  test("turned off, stops at once, drops what waits and lets its hooks go, and never says what finishes meanwhile", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, played, stopped, condensed, followUps } = yield* daemon
        yield* finish("a", "The PR is ready.", true)
        yield* finish("b", "The tests pass.", true)
        yield* wait(1)
        yield* toggle(false)
        const letGo = [...followUps]
        yield* finish("c", "Deployed it.", true)
        yield* wait(30)
        yield* toggle(true)
        yield* wait(30)
        return { played: [...played], stopped: [...stopped], condensed: condensed.map(({ message }) => message), letGo }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready."])
    expect(result.stopped).toEqual(["yapd. The PR is ready."])
    // The one it was reading was heard, so its hook waits for a reply to it heard again.
    expect(result.letGo).toEqual(["claude:b let go"])
    expect(result.condensed).toEqual(["The PR is ready.", "The tests pass."])
  })

  test("says an update again as it was said, only one it said and only while on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, played, condensed, heard, replay } = yield* daemon
        yield* finish("a", "The PR is ready.")
        yield* wait(11)
        const [id] = yield* heard
        const unknown = yield* replay("nope")
        const queued = yield* replay(id!)
        yield* wait(0)
        yield* wait(11)
        const after = yield* heard
        yield* toggle(false)
        const off = yield* replay(id!)
        return { unknown, queued, off, after, id, played: [...played], condensed: condensed.length }
      }),
    )
    expect(result).toMatchObject({ unknown: "unknown", queued: "queued", off: "off", after: [result.id], condensed: 1 })
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready."])
  })

  test("sends no reply to an update heard again once its session has moved on", async () => {
    let deliveries = 0
    const result = await run(
      Effect.gen(function* () {
        const { handle, finish, speak, wait, nextEvent, nextPlayback, heard, replay } = yield* make("Merge it.", {
          send: () => Effect.sync(() => { deliveries++ }),
        })
        yield* finish("a", "The PR is ready.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* wait(15)
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Different work." }, { project: "yapd" }, false)
        const [id] = yield* heard
        yield* replay(id!)
        yield* nextPlayback
        yield* speak
        return yield* nextPlayback
      }),
    )
    expect(deliveries).toBe(0)
    expect(result).toBe("That session has moved on since, so I didn't send it.")
  })

  test("stops what it's reading when turned off, even if it's on again before the reading hears of it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, power, played, stopped } = yield* daemon
        yield* finish("a", "The PR is ready.")
        yield* wait(1)
        yield* power(false)
        yield* power(true)
        yield* wait(30)
        return { played: [...played], stopped: [...stopped] }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready."])
    expect(result.stopped).toEqual(["yapd. The PR is ready."])
  })

  test("renders an update heard again once, however many times it's asked for meanwhile", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, played, heard, replay, renders } = yield* make(undefined, { renderSeconds: 1 })
        yield* finish("a", "The PR is ready.")
        yield* wait(1)
        yield* wait(11)
        const [id] = yield* heard
        const asked = yield* Effect.fork(Effect.all([replay(id!), replay(id!)], { concurrency: "unbounded" }))
        yield* wait(1)
        const answers = yield* Fiber.join(asked)
        yield* wait(30)
        return { answers, played: [...played], renders: renders() }
      }),
    )
    expect(result.answers).toEqual(["queued", "queued"])
    expect(result.renders).toBe(2)
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready."])
  })

  test("says nothing that was being prepared when it was turned off, even once it's on again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, notice, wait, toggle, played, followUps } = yield* make(undefined, { renderSeconds: 5 })
        yield* finish("a", "The PR is ready.", true)
        yield* Effect.fork(notice("started", "Started in yapd."))
        yield* wait(1)
        yield* toggle(false)
        yield* toggle(true)
        yield* wait(5)
        yield* wait(30)
        return { played: [...played], followUps: [...followUps] }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.followUps).toEqual(["claude:a let go"])
  })

  test("leaves the hooks of updates it read waiting, for a reply to one heard again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, followUps } = yield* daemon
        for (const session of ["a", "b", "c", "d", "e", "f"]) {
          yield* finish(session, `Done with ${session}.`, true)
          yield* wait(11)
        }
        return [...followUps]
      }),
    )
    expect(result).toEqual([])
  })

  test("says nothing about a reply still on its way when it was turned off, even once it's on again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, speak, wait, power, followUps, played } = yield* make("Merge it.")
        yield* finish("a", "The PR is ready.")
        yield* speak
        // On its way to the agent, which takes three seconds.
        yield* wait(1)
        yield* power(false)
        yield* power(true)
        yield* wait(3)
        yield* wait(30)
        return { followUps: [...followUps], played: [...played] }
      }),
    )
    expect(result.followUps).toEqual(["a sent: Merge it."])
    expect(result.played).toEqual(["yapd. The PR is ready."])
  })

  test("turned off, lets go of the hooks of what the user hasn't heard, but not of one a dictation cut off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictate, power, followUps } = yield* daemon
        yield* finish("a", "The PR is ready.", true)
        yield* finish("b", "The tests pass.", true)
        yield* wait(1)
        // Cut off, and waiting to be read again from the start.
        yield* dictate
        yield* power(false)
        yield* wait(1)
        return [...followUps]
      }),
    )
    expect(result).toEqual(["claude:b let go"])
  })

  test.each([false, true])("queues replies in order and keeps the original update usable, with a queued failure: %s", async (fails) => {
    const result = await run(Effect.gen(function* () {
      const targets: Array<string> = []
      const { handle, finish, speak, wait, dictate, nextPlayback, nextEvent, followUps, heard, replay } = yield* make("Merge it.", {
        transcripts: ["Merge it.", "Run the checks.", "Deploy it.", "Clean up."],
        send: (thread) => Effect.gen(function* () {
          const dispatch = targets.length
          targets.push(thread.message)
          yield* Effect.sleep("3 seconds")
          if (fails && dispatch === 1) return yield* new RelayError({ reason: "T3 Code isn't answering." })
        }),
      })
      yield* finish("a", "The PR is ready.")
      yield* nextPlayback
      yield* speak
      yield* wait(1)
      const dictation = yield* dictate
      yield* Scope.close(dictation, Exit.void)
      const [id] = yield* heard
      yield* replay(id!)
      yield* wait(1)
      yield* nextPlayback
      yield* speak
      const second = yield* nextPlayback
      yield* speak
      const third = yield* nextPlayback
      yield* wait(3)
      const beforeCompletion = [...followUps]
      yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Merge it." }, { project: "yapd" }, false)
      yield* finish("a", "Merged it.")
      yield* wait(3)
      const afterFirstCompletion = [...followUps]
      const failure = fails ? yield* nextEvent("Ready: yapd. Couldn't send the queued message") : undefined
      if (!fails) {
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Run the checks." }, { project: "yapd" }, false)
        yield* finish("a", "The checks pass.")
      }
      yield* wait(3)
      yield* finish("a", "Deployed it.")
      // Another reply to the same original update, after its queued work completed.
      yield* speak
      yield* wait(3)
      return { second, third, beforeCompletion, afterFirstCompletion, sent: [...followUps], targets, failure }
    }))
    expect(result.second).toBe("Noted. I'll get to it once the current task is done.")
    expect(result.third).toBe(result.second)
    expect(result.beforeCompletion).toEqual(["a sent: Merge it."])
    expect(result.afterFirstCompletion).toEqual(fails ? ["a sent: Merge it."] : ["a sent: Merge it.", "a sent: Run the checks."])
    expect(result.sent).toEqual(["a sent: Merge it.", ...fails ? [] : ["a sent: Run the checks."], "a sent: Deploy it.", "a sent: Clean up."])
    expect(result.targets).toEqual(["The PR is ready.", "Merged it.", fails ? "Merged it." : "The checks pass.", "Deployed it."])
    if (fails) expect(result.failure).toBe('Ready: yapd. Couldn\'t send the queued message "Run the checks.". T3 Code isn\'t answering.')
  })

  test.each(["failure", "takeover", "off", "empty"] as const)("settles queued replies when the preceding delivery ends with %s", async (ending) => {
    const result = await run(Effect.gen(function* () {
      const delivered = yield* Deferred.make<void, RelayError>()
      let dispatches = 0
      const { handle, finish, speak, wait, dictate, nextPlayback, nextEvent, followUps, heard, replay, power } = yield* make("Merge it.", {
        transcripts: ["Merge it.", "Deploy it."],
        send: () => Effect.suspend(() => ++dispatches === 1 ? Deferred.await(delivered) : Effect.void),
      })
      yield* finish("a", "The PR is ready.")
      yield* nextPlayback
      yield* speak
      const dictation = yield* dictate
      yield* Scope.close(dictation, Exit.void)
      const [id] = yield* heard
      yield* replay(id!)
      yield* wait(1)
      yield* nextPlayback
      yield* speak
      const queued = yield* nextPlayback
      let retry: string | undefined
      if (ending === "failure") {
        yield* Deferred.fail(delivered, new RelayError({ reason: "The agent couldn't accept that." }))
        yield* nextEvent("Delivered: Deploy it.")
      } else {
        if (ending === "takeover") {
          yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Instead of 'Merge it.', start unrelated work." }, { project: "yapd" }, false)
          yield* nextEvent("Ready: yapd. The session moved on")
        }
        if (ending === "off") {
          yield* power(false)
          yield* power(true)
        }
        yield* Deferred.succeed(delivered, undefined)
        yield* wait(0)
        yield* finish("a", ending === "empty" ? "" : "Merged it.")
        yield* wait(0)
        if (ending === "empty") {
          yield* speak
          retry = yield* nextPlayback
        }
      }
      return { queued, dispatches, sent: [...followUps], retry }
    }))
    expect(result.queued).toBe("Noted. I'll get to it once the current task is done.")
    expect(result.dispatches).toBe(ending === "failure" ? 2 : 1)
    expect(result.sent).toEqual(ending === "failure" ? ["a sent: Deploy it."] : ["a sent: Merge it."])
    if (ending === "empty") expect(result.retry).toBe("That session has moved on since, so I didn't send it.")
  })

  test.each([false, true])("settles the queued Claude hook after a trivial update, turned off before dispatch: %s", async (off) => {
    const result = await run(Effect.gen(function* () {
      const scope = yield* Effect.scope
      let opens = 0
      let turningOff = Effect.void
      const { finish, speak, wait, nextPlayback, nextEvent, followUps, power } = yield* make("Merge it.", {
        transcripts: ["Merge it.", "Deploy it."],
        waitingHooks: true,
        trivialMessages: ["Understood."],
        onHookOpen: () => off && ++opens === 2 ? turningOff : Effect.void,
      })
      turningOff = Effect.forkIn(power(false), scope).pipe(Effect.zipRight(nextEvent("Turned off")), Effect.asVoid)
      const firstHook = yield* Effect.forkScoped(finish("a", "The PR is ready.", true))
      yield* nextPlayback
      yield* speak
      yield* nextPlayback
      const first = yield* Fiber.join(firstHook)
      yield* speak
      const queued = yield* nextPlayback
      const secondHook = yield* Effect.forkScoped(finish("a", "Understood.", true))
      yield* wait(0)
      const second = yield* Fiber.join(secondHook)
      return { first, second, queued, sent: [...followUps] }
    }))
    expect(result.first).toBe("Merge it.")
    expect(result.second).toBe(off ? undefined : "Deploy it.")
    expect(result.queued).toBe("Noted. I'll get to it once the current task is done.")
    expect(result.sent).toEqual(off ? ["a sent: Merge it."] : ["a sent: Merge it.", "a sent: Deploy it."])
  })

  test("says an update asked for again once it's back on, even if it was being rendered for when turned off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, power, played, heard, replay } = yield* make(undefined, { renderSeconds: 5 })
        yield* finish("a", "The PR is ready.")
        yield* wait(5)
        yield* wait(11)
        const [id] = yield* heard
        const dropped = yield* Effect.fork(replay(id!))
        yield* wait(1)
        yield* power(false)
        yield* power(true)
        const asked = yield* Effect.fork(replay(id!))
        yield* wait(4)
        yield* wait(1)
        const answers = { dropped: yield* Fiber.join(dropped), asked: yield* Fiber.join(asked) }
        yield* wait(11)
        return { answers, played: [...played] }
      }),
    )
    expect(result.answers).toEqual({ dropped: "off", asked: "queued" })
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready."])
  })
})
