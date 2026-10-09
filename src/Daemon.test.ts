import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Queue, Schema, Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import * as Assistant from "./Assistant.ts"
import { Audio, AudioError } from "./Audio.ts"
import * as Brain from "./Brain.ts"
import { Waiting, WaitingLive } from "./ClaudeCode.ts"
import { Condenser, type Turn } from "./Condenser.ts"
import * as Daemon from "./Daemon.ts"
import * as Drafts from "./Drafts.ts"
import { defaults } from "./Endpointer.ts"
import * as Floor from "./Floor.ts"
import { RelayError, Relays, type Thread } from "./Relay.ts"
import { key } from "./Payload.ts"
import { Responder } from "./Responder.ts"
import type { Handle } from "./Server.ts"
import * as Show from "./Show.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad, VadError } from "./Vad.ts"
import * as Hands from "./Hands.ts"
import * as Journal from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import * as Persona from "./Persona.ts"
import { ProcessError } from "./Process.ts"
import * as Store from "./Store.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
import { Voice } from "./Voice.ts"
import { Writer } from "./Writer.ts"

/**
 * Runs the daemon with updates that each take ten seconds to read, and no
 * microphone unless the user `says` something, which is then meant for the agent
 * and takes three seconds to send, unless yapd has an `answer` to it.
 */
const make = (says?: string, options: {
  /** How long rendering takes, which is at once unless said. */
  readonly renderSeconds?: number
  /** What yapd answers to what the user says over an update, instead of passing it on. */
  readonly answer?: string
  readonly transcripts?: ReadonlyArray<string>
  readonly waitingHooks?: boolean
  readonly onHookOpen?: () => Effect.Effect<void>
  readonly trivialMessages?: ReadonlyArray<string>
  /** A microphone, even when the user says nothing. */
  readonly microphone?: boolean
  /** How stopping playback goes, which the audio helper answers when it's ready, with how far it got. */
  readonly stopping?: Effect.Effect<number>
  /** Lines whose playback breaks off after so many seconds, as when the audio helper quits. */
  readonly breaks?: Readonly<Record<string, number>>
  /** Lines that can't be played at all, as when the audio helper is down. */
  readonly unplayable?: ReadonlyArray<string>
  /** Lines that can't be rendered, as when Kokoro fails. */
  readonly unrenderable?: ReadonlyArray<string>
  /** Plays like afplay, which can't say it's playing, so that's known only once it has played to the end. */
  readonly afplay?: boolean
  /** Where the lines the persona is told are being said go, in order. */
  readonly noted?: Array<string>
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
  /** What was logged as a warning, in order. */
  const warnings: Array<string> = []
  const playbacks = yield* Queue.unbounded<string>()
  const nextEvent = (...prefixes: ReadonlyArray<string>) => Effect.gen(function* () {
    while (true) {
      const message = yield* Queue.take(logs)
      if (prefixes.some((prefix) => message.startsWith(prefix))) return message
    }
  })
  const microphone = yield* Queue.unbounded<Float32Array>()
  const listening = says !== undefined || options.microphone === true
  const transcripts = [...options.transcripts ?? []]
  const waiting = options.waitingHooks ? yield* Waiting.pipe(Effect.provide(WaitingLive)) : undefined
  let handle: Handle
  let rests = 0
  let warms = 0
  const layer = Layer.mergeAll(
    options.noted === undefined
      ? Persona.Plain
      : Layer.succeed(Persona.Persona, {
          lines: Effect.succeed(Persona.plain),
          onIt: () => Effect.succeed(Persona.plain.onIt),
          said: (line) => Effect.sync(() => void options.noted?.push(line)),
        }),
    Journal.memory,
    Layer.succeed(Condenser, {
      condense: (_, turn) => Effect.sync(() => {
        condensed.push(turn)
        return { priority: options.trivialMessages?.includes(turn.message) ? "trivial" as const : "done" as const, spoken: turn.message }
      }),
    }),
    Layer.succeed(Voice, {
      render: (text, path) =>
        options.unrenderable?.includes(text)
          ? Effect.fail(new ProcessError({ command: "kokoro", code: 1, stderr: "Kokoro failed" }))
          : Effect.sleep(`${options.renderSeconds ?? 0} seconds`).pipe(Effect.zipRight(Effect.sync(() => void rendered.set(path, text)))),
    }),
    Layer.succeed(Audio, {
      play: (path) =>
        Effect.gen(function* () {
          const text = rendered.get(path) ?? path
          if (options.unplayable?.includes(text)) return yield* new AudioError({ message: "The audio helper didn't start playing" })
          played.push(text)
          yield* Queue.offer(playbacks, text)
          let done = false
          // Closing the scope stops it, as with the helper.
          yield* Effect.addFinalizer(() => Effect.sync(() => void (done || stopped.push(text))))
          const breaks = options.breaks?.[text]
          return {
            duration: 10,
            confirmed: options.afplay !== true,
            finished:
              breaks === undefined
                ? Effect.sleep("10 seconds").pipe(
                    Effect.tap(() => {
                      done = true
                    }),
                  )
                : Effect.sleep(`${breaks} seconds`).pipe(Effect.zipRight(new AudioError({ message: "The audio helper quit" }))),
            stop: options.stopping ?? Effect.succeed(2),
            volume: () => Effect.void,
          }
        }),
      microphone: Effect.succeed(listening ? Option.some(microphone) : Option.none()),
      rest: Effect.sync(() => void rests++),
      warm: Effect.sync(() => void warms++),
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
      make: listening ? Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)) : Effect.fail(new VadError({ cause: "no microphone" })),
    }),
    Layer.succeed(Transcriber, { transcribe: () => Effect.sync(() => transcripts.shift() ?? says ?? "") }),
    Layer.succeed(Responder, {
      respond: ({ heard }) =>
        says === undefined
          ? Effect.die("nothing to respond to")
          : Effect.succeed(
              options.answer === undefined
                ? { intent: "send" as const, spoken: "Okay, passed on.", message: heard }
                : { intent: "answer" as const, spoken: options.answer, message: "" },
            ),
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
    Logger.add(Logger.make(({ logLevel, message }) => {
      for (const line of Array.isArray(message) ? message : [message]) {
        if (typeof line !== "string") continue
        Queue.unsafeOffer(logs, line)
        if (logLevel._tag === "Warning") warnings.push(line)
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
  /** Says what the user `says` for as long as it takes to be his rather than talk nearby, which changing a thread needs. */
  const talk = Queue.offerAll(microphone, [
    ...Array.from({ length: 30 }, () => new Float32Array(512).fill(0.9)),
    ...Array.from({ length: defaults.silence }, () => new Float32Array(512)),
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
  /**
   * Something yapd has to say for itself, which as a question, the one open, records how it went, in `saying` when it
   * started being said, until that's undone, and in `heard` when it was heard to the end. As an answer with `followUp`,
   * it takes what's said over it or right after for a follow-up, noted there, unless it's talk with Sam.
   */
  const notice = (
    id: string,
    spoken: string,
    options: {
      readonly question?: Array<string>
      readonly stale?: boolean
      readonly needsYou?: boolean
      readonly answer?: boolean
      readonly done?: boolean
      readonly saying?: Array<string>
      readonly heard?: Array<string>
      readonly gone?: Array<string>
      readonly followUp?: Array<string>
    } = {},
  ) =>
    tell({
      id,
      kind: options.question !== undefined ? "question" : options.answer === true ? "answer" : options.done === true ? "done" : "notice",
      ...(options.question === undefined ? {} : { open: `open-${id}` }),
      priority: options.question !== undefined || options.needsYou === true || options.answer === true || options.done === true ? "needs-you" : "done",
      spoken,
      at: 0,
      stale: Effect.succeed(options.stale === true),
      ...(options.saying === undefined ? {} : { saying: Effect.sync(() => void options.saying?.push(id)) }),
      ...(options.heard === undefined ? {} : { heard: Effect.sync(() => void options.heard?.push(id)) }),
      ...(options.gone === undefined ? {} : { gone: Effect.sync(() => void options.gone?.push(id)) }),
      ...(options.followUp === undefined
        ? {}
        : {
            followUp: (heard: string) =>
              Effect.succeed(heard.startsWith("Sam,") ? Option.none() : Option.some(Effect.sync(() => void options.followUp?.push(`${id}: ${heard}`)))),
          }),
      ...(options.question === undefined
        ? {}
        : {
            question: {
              answer: () => Effect.succeed(Option.none()),
              unanswered: Effect.sync(() => void options.question?.push(`${id} unanswered`)),
              unsaid: Effect.sync(() => {
                const at = options.saying?.indexOf(id) ?? -1
                if (at >= 0) options.saying?.splice(at, 1)
              }),
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
  return { microphone, made, handle, finish, turn, notice, lastHeard: made.lastHeard, speak, talk, followUps, wait, dictate, record, reading, played, stopped, condensed, warnings, nextEvent, nextPlayback: Queue.take(playbacks), rests: () => rests, warms: () => warms, renders: () => rendered.size, flush, toggle, power: made.turn, heard, replay: made.replay, awaiting: made.awaiting.pipe(Effect.map((arrived) => arrived.pipe(Effect.zipRight(flush)))), journal: Context.get(context, Journal.Journal) }
})

const daemon = make()

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** A thread T3 Code runs, idle in the yapd project. */
const thread = (id: string, title: string) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId: "yapd",
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T20:00:00.000Z",
  })

/**
 * The daemon with the assistant on top, wired as yapd serves them, without
 * T3 Code but for what it shows of the threads on the `desk`, and with a model
 * that decides what `model` says, which isn't asked about what needs no model.
 */
const assisted = (
  model: (situation: Brain.Situation) => Brain.Decision,
  /** With what the user `says` over an update, which is meant for its agent, as `make` takes it. */
  options: Parameters<typeof make>[1] & { readonly says?: string } = {},
  desk: ReadonlyArray<T3Live.Thread> = [],
  /** How long the model takes over what was said, on top of deciding. */
  deciding: (situation: Brain.Situation) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const daemon = yield* make(options.says, options)
    const { made, journal } = daemon
    const view: T3Live.View = {
      projects: new Map([["yapd", { id: "yapd", title: "yapd", workspaceRoot: "/code/yapd" }]]),
      threads: new Map(desk.map((thread) => [thread.id, thread])),
      sequence: 1,
      synced: true,
    }
    const store = yield* Store.make(":memory:")
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: { view: Effect.succeed(desk.length === 0 ? Option.none() : Option.some(view)), changes: Stream.never },
      actions: Option.none(),
      others: [],
      journal,
      store,
    })
    const ledger = Ledger.fromStore(store)
    const drafts = yield* Drafts.make({ machines: [], rules: Effect.succeed(Option.none()), recent: Effect.succeed([]) }).pipe(
      Effect.provideService(Writer, { decide: () => Effect.never, research: () => Effect.never, prepare: Effect.void }),
      Effect.provide(Persona.Plain),
    )
    const asked: Array<Brain.Situation> = []
    const show = yield* Show.make(threads.detail, () => Effect.void)
    const assistant = yield* Assistant.make({
      threads,
      journal,
      drafts,
      hands: Hands.make({ threads, ledger }),
      ledger,
      show,
      tell: made.tell,
      power: made.power,
      lastHeard: made.lastHeard,
      coming: made.coming,
      awaiting: made.awaiting,
      queued: made.queued,
      skip: made.skip,
      upcoming: made.upcoming,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Brain.Brain, {
            decide: (situation) =>
              Effect.sync(() => {
                asked.push(situation)
                return model(situation)
              }).pipe(Effect.zipLeft(deciding(situation))),
          }),
          Persona.Plain,
        ),
      ),
    )
    let presses = 0
    /** He presses the shortcut over whatever is being read, says `heard` for a couple of seconds, and lets go. */
    const dictating = (heard: string) =>
      Effect.gen(function* () {
        const press = ++presses
        const { turns } = yield* made.power
        yield* assistant.prepare(press, turns)
        const dictation = yield* daemon.dictate
        yield* daemon.wait(2)
        yield* Scope.close(dictation, Exit.void)
        yield* assistant.heard({ heard, via: "shortcut", at: yield* Clock.currentTimeMillis, voiced: 2, turns }, press)
        yield* daemon.flush
      })
    return { ...daemon, assistant, asked, dictating, show }
  })

describe("Daemon", () => {
  test("gets the speaker ready while an update renders, and lets it rest again when nothing comes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, warms, rests, played, toggle } = yield* make(undefined, { renderSeconds: 1 })
        const restedBefore = rests()
        yield* finish("s1", "The PR is ready.")
        const whileRendering = warms()
        yield* wait(1)
        yield* wait(10)
        // Past the pause between updates, so it's waiting again.
        yield* wait(1)
        const playedFirst = [...played]
        yield* finish("s2", "The tests pass.")
        const warmedAgain = warms()
        const restedBeforeOff = rests()
        // Turned off before it's ready, so nothing comes, and it rests at once rather than after a while.
        yield* toggle(false)
        return { whileRendering, playedFirst, restedBefore, warmedAgain, restedBeforeOff, restedAfterOff: rests() }
      }),
    )
    expect(result.whileRendering).toBe(1)
    expect(result.playedFirst).toEqual(["yapd. The PR is ready."])
    expect(result.warmedAgain).toBe(2)
    expect(result.restedAfterOff).toBeGreaterThan(result.restedBeforeOff)
  })

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

  test("says the answer to a dictation before the update it cut off, however long he talks and it takes to work out", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictate, notice, awaiting, played } = yield* daemon
        yield* finish("a", "The PR is ready.")
        // He presses the shortcut, which awaits what he'll ask, and asks it, taking as long as most dictations do.
        const arrived = yield* awaiting
        const dictation = yield* dictate
        yield* wait(27)
        yield* Scope.close(dictation, Exit.void)
        // The model takes a few seconds, while nothing else is said.
        yield* wait(4)
        const meanwhile = [...played]
        yield* notice("answer", "Four on the go, sir.", { answer: true })
        yield* arrived
        yield* wait(11)
        yield* wait(11)
        return { meanwhile, played: [...played] }
      }),
    )
    expect(result.meanwhile).toEqual(["yapd. The PR is ready."])
    expect(result.played).toEqual(["yapd. The PR is ready.", "Four on the go, sir.", "yapd. The PR is ready."])
  })

  test("an answer cut off by a follow-up isn't said again, and work that started is said after the new answer", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { wait, dictate, notice, awaiting, played } = yield* daemon
        /** He cuts in on what's being said by dictating for a while, and it takes a few seconds to answer. */
        const follow = (spoken: string) =>
          Effect.gen(function* () {
            const arrived = yield* awaiting
            const dictation = yield* dictate
            yield* wait(30)
            yield* Scope.close(dictation, Exit.void)
            yield* wait(4)
            yield* notice(spoken, spoken, { answer: true })
            yield* arrived
            yield* wait(11)
            yield* wait(11)
          })
        yield* notice("status", "Four threads are on the go, sir, and the Tezos migration is the busiest.", { answer: true })
        yield* wait(2)
        yield* follow("The Tezos migration is running its tests, sir.")
        yield* notice("started", "Started in yapd, on Fable, in a worktree.", { done: true })
        yield* wait(2)
        yield* follow("Nothing needs you right now, sir.")
        return [...played]
      }),
    )
    expect(result).toEqual([
      "Four threads are on the go, sir, and the Tezos migration is the busiest.",
      "The Tezos migration is running its tests, sir.",
      "Started in yapd, on Fable, in a worktree.",
      "Nothing needs you right now, sir.",
      "Started in yapd, on Fable, in a worktree.",
    ])
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

  test("what was heard last is the line said over an update, like an answer to what he asked over it, still tied to the update", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, speak, wait, lastHeard, played } = yield* make("What does the PR change?", { answer: "The PR changes the microphone buffer." })
        yield* finish("a", "The PR is ready.")
        const reading = yield* lastHeard
        yield* speak
        yield* wait(1)
        const answering = yield* lastHeard
        // Said to the end, and nothing more said over it.
        yield* wait(10)
        yield* wait(3)
        return { reading, answering, after: yield* lastHeard, played: [...played] }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready.", "The PR changes the microphone buffer."])
    const update = { session: "claude:a", spoken: "yapd. The PR is ready." }
    expect(result.reading).toEqual(Option.some(expect.objectContaining({ update: expect.objectContaining(update), said: "yapd. The PR is ready.", playing: true })))
    expect(result.answering).toEqual(
      Option.some(expect.objectContaining({ update: expect.objectContaining(update), said: "The PR changes the microphone buffer.", playing: true })),
    )
    expect(result.after).toEqual(
      Option.some(expect.objectContaining({ update: expect.objectContaining(update), said: "The PR changes the microphone buffer.", playing: false })),
    )
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

  test("tells the persona of a reply's line said later only once it plays, never when yapd was turned off meanwhile", async () => {
    const result = await run(
      Effect.gen(function* () {
        const noted: Array<string> = []
        const { finish, speak, wait, dictate } = yield* make("Merge it.", { noted })
        yield* finish("a", "The PR is ready.", true)
        yield* speak
        // On its way to the agent, which takes three seconds.
        yield* wait(1)
        const dictation = yield* dictate
        yield* wait(3)
        const during = [...noted]
        yield* Scope.close(dictation, Exit.void)
        yield* wait(0)
        yield* wait(11)
        return { during, noted }
      }),
    )
    expect(result).toEqual({ during: [], noted: ["Okay, passed on."] })
    const off = await run(
      Effect.gen(function* () {
        const noted: Array<string> = []
        const { finish, speak, wait, power, played } = yield* make("Merge it.", { noted })
        yield* finish("a", "The PR is ready.")
        yield* speak
        yield* wait(1)
        yield* power(false)
        yield* power(true)
        yield* wait(3)
        yield* wait(30)
        return { played: [...played], noted }
      }),
    )
    expect(off).toEqual({ played: ["yapd. The PR is ready."], noted: [] })
  })

  test("with afplay, tells the persona of a reply's line said later only once it has played to the end, never when afplay can't play it", async () => {
    const follow = (breaks: boolean) =>
      run(
        Effect.gen(function* () {
          const noted: Array<string> = []
          const { finish, speak, wait, dictate, played } = yield* make("Merge it.", {
            noted,
            afplay: true,
            ...(breaks ? { breaks: { "yapd. Okay, passed on.": 1 } } : {}),
          })
          yield* finish("a", "The PR is ready.", true)
          yield* speak
          yield* wait(1)
          const dictation = yield* dictate
          yield* wait(3)
          yield* Scope.close(dictation, Exit.void)
          yield* wait(0)
          // The line is playing.
          yield* wait(5)
          const during = [...noted]
          yield* wait(20)
          return { played, during, noted }
        }),
      )
    const played = ["yapd. The PR is ready.", "yapd. Okay, passed on."]
    expect(await follow(true)).toEqual({ played, during: [], noted: [] })
    expect(await follow(false)).toEqual({ played, during: [], noted: ["Okay, passed on."] })
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
    expect(result).toBe("You've moved on from that since, so I held it back.")
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

  test("what yapd says counts as heard once it's said to the end, never when a dictation cuts it off or yapd is turned off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { wait, dictate, notice, toggle, played } = yield* daemon
        const heard: Array<string> = []
        yield* notice("whole", "Nothing needs you right now, sir.", { answer: true, heard })
        yield* wait(11)
        yield* notice("cut", "The loader fix is ready, sir.", { answer: true, heard })
        yield* wait(2)
        const dictation = yield* dictate
        yield* Scope.close(dictation, Exit.void)
        yield* wait(11)
        yield* notice("off", "The Tezos migration is comparing request formats, sir.", { answer: true, heard })
        yield* wait(2)
        yield* toggle(false)
        yield* wait(11)
        return { played: [...played], heard }
      }),
    )
    expect(result.played).toEqual(["Nothing needs you right now, sir.", "The loader fix is ready, sir.", "The Tezos migration is comparing request formats, sir."])
    expect(result.heard).toEqual(["whole"])
  })

  test("what yapd says is done with once it's said, gone stale, cut off and not put back, dropped or never queued, but not while it's put back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, dictate, toggle } = yield* daemon
        const gone: Array<string> = []
        const cutOff = Effect.gen(function* () {
          yield* wait(2)
          const dictation = yield* dictate
          yield* Scope.close(dictation, Exit.void)
          yield* wait(0)
        })
        yield* notice("said", "Nothing needs you right now, sir.", { answer: true, gone })
        yield* wait(11)
        yield* notice("stale", "Looking through yapd first.", { stale: true, needsYou: true, gone })
        yield* wait(1)
        // What came of something he asked for is put back to be said after what he dictated, and an answer isn't.
        yield* notice("started", "Started in yapd, on Fable, in a worktree.", { done: true, gone })
        yield* cutOff
        const putBack = [...gone]
        yield* wait(11)
        yield* notice("cut", "The loader fix is ready, sir.", { answer: true, gone })
        yield* cutOff
        yield* wait(11)
        // Turned off as one is said and another waits, and told one while it's off.
        yield* notice("playing", "The Tezos migration is comparing request formats, sir.", { answer: true, gone })
        yield* notice("waiting", "Two running, sir.", { answer: true, gone })
        yield* wait(2)
        yield* toggle(false)
        yield* notice("off", "One running, sir.", { answer: true, gone })
        return { putBack, gone }
      }),
    )
    expect(result.putBack).toEqual(["said", "stale"])
    expect(result.gone.slice(0, 4)).toEqual(["said", "stale", "started", "cut"])
    expect(result.gone.slice(4).toSorted()).toEqual(["off", "playing", "waiting"])
  })

  test("a clarification cut off by a dictation is not put back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, dictate, played } = yield* daemon
        const asked: Array<string> = []
        yield* notice("question", "The Tezos migration or the Mina tickets, sir?", { question: asked })
        yield* notice("started", "Started in yapd, on Fable, in a worktree.")
        yield* wait(2)
        const dictation = yield* dictate
        yield* wait(30)
        yield* Scope.close(dictation, Exit.void)
        yield* wait(0)
        yield* wait(11)
        yield* wait(11)
        return { played: [...played], asked }
      }),
    )
    // What was dictated answers it or takes its place, so it's never asked again, nor counted unanswered.
    expect(result.played).toEqual(["The Tezos migration or the Mina tickets, sir?", "Started in yapd, on Fable, in a worktree."])
    expect(result.asked).toEqual([])
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
        const { finish, wait, toggle, played, condensed, heard, replay, journal } = yield* daemon
        yield* finish("a", "The PR is ready.")
        // What he missed is what he hasn't heard through yet.
        const playing = (yield* journal.unheard(0, 12)).length
        yield* wait(11)
        const through = (yield* journal.unheard(0, 12)).length
        const [id] = yield* heard
        const unknown = yield* replay("nope")
        const queued = yield* replay(id!)
        yield* wait(0)
        yield* wait(11)
        const after = yield* heard
        yield* toggle(false)
        const off = yield* replay(id!)
        return { unknown, queued, off, after, id, played: [...played], condensed: condensed.length, playing, through }
      }),
    )
    expect(result).toMatchObject({ unknown: "unknown", queued: "queued", off: "off", after: [result.id], condensed: 1, playing: 1, through: 0 })
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready."])
  })

  test("an update cut off by turning yapd off is heard once it's said again to the end", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, played, heard, replay, journal } = yield* daemon
        yield* finish("a", "The PR is ready.")
        const [id] = yield* heard
        // Off and on again before it's said to the end, then asked for again.
        yield* toggle(false)
        yield* toggle(true)
        const cutOff = (yield* journal.unheard(0, 12)).length
        const queued = yield* replay(id!)
        yield* wait(0)
        yield* wait(11)
        return { cutOff, queued, played: [...played], after: (yield* journal.unheard(0, 12)).length }
      }),
    )
    expect(result).toMatchObject({ cutOff: 1, queued: "queued", after: 0 })
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
    expect(result).toBe("You've moved on from that since, so I held it back.")
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
          yield* nextEvent("Ready: yapd. That work moved on")
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
    if (ending === "empty") expect(result.retry).toBe("You've moved on from that since, so I held it back.")
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

  test("an update read to the end is heard at once, so asked about in the time left for a reply, it isn't read again after the answer", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictate, notice, awaiting, lastHeard, played, journal } = yield* make(undefined, { microphone: true })
        yield* finish("a", "The PR is ready.")
        // Read to the end, and listening a moment for a reply, when he presses the shortcut to ask about it.
        yield* wait(10)
        yield* wait(1)
        const lingering = (yield* journal.unheard(0, 12)).length
        const subject = yield* lastHeard
        const arrived = yield* awaiting
        const dictation = yield* dictate
        const dictating = (yield* journal.unheard(0, 12)).length
        yield* wait(3)
        yield* Scope.close(dictation, Exit.void)
        yield* notice("answer", "It changes the parser.", { answer: true })
        yield* arrived
        for (let i = 0; i < 4; i++) yield* wait(11)
        return { lingering, dictating, subject: Option.map(subject, ({ said, playing }) => ({ said, playing })), played: [...played] }
      }),
    )
    expect(result).toEqual({
      lingering: 0,
      dictating: 0,
      subject: Option.some({ said: "yapd. The PR is ready.", playing: true }),
      played: ["yapd. The PR is ready.", "It changes the parser."],
    })
  })

  test("an update that plays to its end while a stop is still being answered is heard, so a dictation then doesn't read it again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, speak, dictate, played, journal } = yield* make("Thanks.", {
          // Stopped a moment before its natural end, which the helper only answers once it has ended anyway.
          stopping: Effect.sleep("200 millis").pipe(Effect.as(10)),
          answer: "You're welcome.",
        })
        yield* finish("a", "The PR is ready.")
        yield* wait(9.9)
        yield* speak
        yield* wait(0.15)
        const unheard = (yield* journal.unheard(0, 12)).length
        const floor = yield* dictate
        yield* wait(0.2)
        yield* Scope.close(floor, Exit.void)
        yield* wait(15)
        return { unheard, read: played.filter((line) => line === "yapd. The PR is ready.").length }
      }),
    )
    expect(result).toEqual({ unheard: 0, read: 1 })
  })

  test("an update stopped for him to speak, whose playback then breaks off as the helper quits, isn't heard, and that's noted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, microphone, warnings, journal } = yield* make(undefined, {
          microphone: true,
          breaks: { "yapd. The PR is ready.": 3 },
          // A helper that quits answers a stop under way with nothing.
          stopping: Effect.sleep("1 second").pipe(Effect.as(0)),
        })
        yield* finish("a", "The PR is ready.")
        yield* wait(2)
        yield* Queue.offerAll(microphone, Array.from({ length: 4 }, () => new Float32Array([0.9])))
        yield* wait(0)
        yield* wait(1)
        // And the microphone goes with it.
        yield* Queue.shutdown(microphone)
        yield* wait(1)
        return { unheard: (yield* journal.unheard(0, 12)).length, warnings: [...warnings] }
      }),
    )
    expect(result).toEqual({ unheard: 1, warnings: ["Could not speak update"] })
  })

  test("a question asked after a dictation was said is asked at once, though that dictation is still being worked out", async () => {
    const result = await run(
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>()
        const loader = thread("loader", "Fix loader")
        const parser = thread("parser", "Fix parser")
        const handle = (situation: Brain.Situation, id: string) => situation.desk.threads.find(({ ref }) => ref.id === id)!.handle
        const { assistant, made, dictate, wait, flush, played } = yield* assisted(
          (situation) =>
            situation.utterance.heard === "Which fix?"
              ? Brain.decision({ act: "clarify", target: handle(situation, "loader"), others: handle(situation, "parser"), sure: "low" })
              : Brain.decision({ act: "answer", spoken: "Here is a separate answer." }),
          {},
          [loader, parser],
          // The second takes a while to work out.
          (situation) => (situation.utterance.heard === "Which fix?" ? Effect.void : Deferred.await(answered)),
        )
        const { turns } = yield* made.power
        const floor = yield* dictate
        // Two dictations, sent at 0 and a second later, are handed on together once the first is heard.
        yield* wait(2)
        yield* assistant.heard({ heard: "Which fix?", via: "shortcut", at: 0, voiced: 2, turns })
        const second = yield* Effect.fork(assistant.heard({ heard: "Tell me something unrelated.", via: "shortcut", at: 1000, voiced: 2, turns }))
        yield* flush
        yield* Scope.close(floor, Exit.void)
        yield* flush
        yield* wait(1)
        const asked = [...played]
        yield* Deferred.succeed(answered, undefined)
        yield* Fiber.join(second)
        return asked
      }),
    )
    expect(result).toEqual(["Fix loader or Fix parser?"])
  })

  test("an update stopped for him to speak isn't heard when the microphone goes before he's finished, and that's noted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, microphone, warnings, journal } = yield* make(undefined, { microphone: true, breaks: { "yapd. The PR is ready.": 3 } })
        yield* finish("a", "The PR is ready.")
        yield* wait(2)
        yield* Queue.offerAll(microphone, Array.from({ length: 4 }, () => new Float32Array([0.9])))
        yield* wait(0)
        // The helper goes, the microphone first, before the playback it stopped says it broke.
        yield* Queue.shutdown(microphone)
        yield* wait(1)
        return { unheard: (yield* journal.unheard(0, 12)).length, warnings: [...warnings] }
      }),
    )
    expect(result).toEqual({ unheard: 1, warnings: ["Could not speak update"] })
  })

  test("a question stopped for him to speak isn't said or heard when the microphone goes before he's finished, and goes unanswered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, microphone } = yield* make(undefined, { microphone: true, breaks: { "Which project?": 3 } })
        const saying: Array<string> = []
        const heard: Array<string> = []
        const question: Array<string> = []
        yield* notice("q", "Which project?", { saying, heard, question })
        yield* wait(2)
        yield* Queue.offerAll(microphone, Array.from({ length: 4 }, () => new Float32Array([0.9])))
        yield* wait(0)
        yield* Queue.shutdown(microphone)
        yield* wait(1)
        return { saying, heard, question }
      }),
    )
    expect(result).toEqual({ saying: [], heard: [], question: ["q unanswered"] })
  })

  test("a press got ready for late holds no question asked after the shortcut was pressed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>()
        const handle = (situation: Brain.Situation, id: string) => situation.desk.threads.find(({ ref }) => ref.id === id)!.handle
        const { assistant, made, dictate, wait, flush, played } = yield* assisted(
          (situation) =>
            situation.utterance.heard === "Which fix?"
              ? Brain.decision({ act: "clarify", target: handle(situation, "loader"), others: handle(situation, "parser"), sure: "low" })
              : Brain.decision({ act: "answer", spoken: "Here is a separate answer." }),
          {},
          [thread("loader", "Fix loader"), thread("parser", "Fix parser")],
          (situation) => (situation.utterance.heard === "Which fix?" ? Effect.void : Deferred.await(answered)),
        )
        const { turns } = yield* made.power
        const floor = yield* dictate
        yield* wait(2)
        yield* assistant.heard({ heard: "Which fix?", via: "shortcut", at: 0, voiced: 2, turns })
        // The second press, half a second in, is only got ready for now, behind a slow first.
        yield* assistant.prepare(2, turns, 500)
        const second = yield* Effect.fork(assistant.heard({ heard: "Tell me something unrelated.", via: "shortcut", at: 1000, voiced: 2, turns }, 2))
        yield* flush
        yield* Scope.close(floor, Exit.void)
        yield* flush
        yield* wait(1)
        const asked = [...played]
        yield* Deferred.succeed(answered, undefined)
        yield* Fiber.join(second)
        return asked
      }),
    )
    expect(result).toEqual(["Fix loader or Fix parser?"])
  })

  test.each([false, true])("an update whose playback breaks off midway isn't heard, and that's noted once, with a microphone: %s", async (microphone) => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, played, warnings, journal } = yield* make(undefined, { microphone, breaks: { "yapd. The PR is ready.": 3 } })
        yield* finish("a", "The PR is ready.")
        for (let i = 0; i < 6; i++) yield* wait(3)
        return { played: [...played], unheard: (yield* journal.unheard(0, 12)).length, warnings: [...warnings] }
      }),
    )
    expect(result).toEqual({ played: ["yapd. The PR is ready."], unheard: 1, warnings: ["Could not speak update"] })
  })

  test.each([false, true])("what can't be played isn't said nor heard, and a question that can't goes unanswered, with a microphone: %s", async (microphone) => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, played } = yield* make(undefined, {
          microphone,
          unplayable: ["The Tezos migration or the Mina tickets, sir?", "Nothing needs you right now, sir."],
        })
        const asked: Array<string> = []
        const saying: Array<string> = []
        const heard: Array<string> = []
        yield* notice("question", "The Tezos migration or the Mina tickets, sir?", { question: asked, saying, heard })
        yield* notice("answer", "Nothing needs you right now, sir.", { answer: true, saying, heard })
        yield* wait(11)
        yield* wait(11)
        return { played: [...played], asked, saying, heard }
      }),
    )
    expect(result).toEqual({ played: [], asked: ["question unanswered"], saying: [], heard: [] })
  })

  test.each([false, true])("a question whose playback breaks off goes unanswered, and counts as neither said nor heard, with a microphone: %s", async (microphone) => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait } = yield* make(undefined, { microphone, breaks: { "The Tezos migration or the Mina tickets, sir?": 3 } })
        const asked: Array<string> = []
        const saying: Array<string> = []
        const heard: Array<string> = []
        yield* notice("question", "The Tezos migration or the Mina tickets, sir?", { question: asked, saying, heard })
        for (let i = 0; i < 6; i++) yield* wait(3)
        return { asked, saying, heard }
      }),
    )
    // Begun, then broken off, so it's as if it was never said: what he says next isn't about it, and it's asked again later.
    expect(result).toEqual({ asked: ["question unanswered"], saying: [], heard: [] })
  })

  test.each([false, true])("a question that breaks off as it's asked isn't what he answers next: it's left, and he's told, with a microphone: %s", async (microphone) => {
    const loader = thread("1f0e8a7b-6c5d-4b7e-9d3c-2d5cee5c6a1f", "Fix the loader")
    const parser = thread("6a5b4c3d-2e1f-4c1d-8e7f-850299f83b2a", "Fix the parser")
    const question = "Fix the loader or Fix the parser?"
    const result = await run(
      Effect.gen(function* () {
        const { dictating, wait, played, asked, journal } = yield* assisted(
          (situation) => {
            const named = (of: T3Live.Thread) => situation.desk.threads.find(({ ref }) => ref.id === of.id)?.handle ?? ""
            return situation.utterance.heard === "How's the fix going?"
              ? Brain.decision({ act: "clarify", target: named(loader), sure: "low", others: named(parser) })
              : Brain.decision({ act: "dismiss", pending: Option.isSome(situation.open) ? "answers" : "" })
          },
          { microphone, breaks: { [question]: 1 } },
          [loader, parser],
        )
        yield* dictating("How's the fix going?")
        // A second in, the audio helper quits, and he never hears which.
        yield* wait(1)
        yield* wait(2)
        yield* dictating("No.")
        for (let i = 0; i < 4; i++) yield* wait(11)
        const closed = yield* journal.since(0, { kinds: ["action"] })
        const { open, subject } = asked.at(-1)!
        return { played: [...played], open, subject, closed: closed.map(({ detail }) => (detail as { open: string }).open) }
      }),
    )
    expect(result.played).toEqual([question, "I didn't ask whether you meant Fix the loader or Fix the parser, since you'd moved on."])
    // Nor what "it" means.
    expect(result.open).toEqual(Option.none())
    expect(result.subject).toEqual({ _tag: "Nothing" })
    expect(result.closed).toEqual(["replaced"])
  })

  test.each(["Stop.", "Skip.", "Enough.", "Next.", "Shut up.", "Stop, stop."])("told \"%s\" by the shortcut over an update, doesn't read it again, and counts it heard", async (said) => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictating, played, stopped, asked, journal } = yield* assisted(() => Brain.decision({ act: "answer", spoken: "Asked." }))
        yield* finish("a", "The PR is ready.")
        yield* wait(2)
        yield* dictating(said)
        for (let i = 0; i < 4; i++) yield* wait(11)
        return { played: [...played], stopped: [...stopped], asked: asked.length, unheard: (yield* journal.unheard(0, 12)).length }
      }),
    )
    expect(result).toEqual({ played: ["yapd. The PR is ready."], stopped: ["yapd. The PR is ready."], asked: 0, unheard: 0 })
  })

  test("what he missed leaves out the updates waiting to be read, like the one his asking cut off, which he's told are coming up", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, dictating, played, asked, journal } = yield* assisted((situation) => {
          // As the model is asked to: what he missed, from what he hasn't heard.
          const told = situation.unheard.map(({ said }) => said).join(" ")
          return Brain.decision({ act: "answer", how: "missed", spoken: told === "" ? "Nothing else." : `You missed this: ${told}` })
        })
        yield* finish("a", "The loader fix is ready.")
        yield* wait(2)
        // Turned off and on before it's read to the end, so he missed it.
        yield* toggle(false)
        yield* toggle(true)
        yield* finish("b", "The tests pass.")
        yield* wait(2)
        yield* dictating("What did I miss?")
        for (let i = 0; i < 4; i++) yield* wait(11)
        return { told: asked.at(-1)?.unheard.map(({ said }) => said), played: [...played], unheard: (yield* journal.unheard(0, 12)).length }
      }),
    )
    expect(result.told).toEqual(["yapd. The loader fix is ready."])
    expect(result.played).toEqual([
      "yapd. The loader fix is ready.",
      "yapd. The tests pass.",
      "You missed this: yapd. The loader fix is ready. One more update is coming up.",
      "yapd. The tests pass.",
    ])
    expect(result.unheard).toBe(0)
  })

  test("an answer said to be on his screen, which waits its turn while the app that would show its card goes away, is said without that", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, made, assistant, show, played, warnings, journal } = yield* assisted(() => Brain.decision({ act: "answer", spoken: "Asked." }), {}, [
          thread("f0000000-0000-4000-8000-000000000001", "Fix the loader"),
        ])
        yield* finish("a", "The PR is ready.")
        yield* wait(2)
        // Typed while the update is read, so what comes of it waits for the update to end, by when the app has gone.
        const watching = yield* Scope.make()
        yield* Scope.extend(show.watch, watching)
        const { turns } = yield* made.power
        yield* assistant.heard({ heard: "Show me what's running.", via: "typed", at: yield* Clock.currentTimeMillis, voiced: Number.POSITIVE_INFINITY, turns })
        yield* Scope.close(watching, Exit.void)
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { told: (yield* journal.since(0, { kinds: ["answer"] })).map(({ said }) => said), played: [...played], seen: yield* show.seen, warnings }
      }),
    )
    // Noted as said in the words played.
    expect(result.told).toEqual(["Nothing's running."])
    expect(result.played).toEqual(["yapd. The PR is ready.", "Nothing's running."])
    expect(result.seen).toEqual(Option.none())
    expect(result.warnings).toEqual([])
  })

  test("an answer said to be on his screen whose words without that can't be rendered by its turn is said and noted as it is", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, made, assistant, show, played, journal } = yield* assisted(
          () => Brain.decision({ act: "answer", spoken: "Asked." }),
          { unrenderable: ["Nothing's running."] },
          [thread("f0000000-0000-4000-8000-000000000001", "Fix the loader")],
        )
        yield* finish("a", "The PR is ready.")
        yield* wait(2)
        // Typed while the update is read, so what comes of it waits for the update to end, by when the app has gone.
        const watching = yield* Scope.make()
        yield* Scope.extend(show.watch, watching)
        const { turns } = yield* made.power
        yield* assistant.heard({ heard: "Show me what's running.", via: "typed", at: yield* Clock.currentTimeMillis, voiced: Number.POSITIVE_INFINITY, turns })
        yield* Scope.close(watching, Exit.void)
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { told: (yield* journal.since(0, { kinds: ["answer"] })).map(({ said }) => said), played: [...played] }
      }),
    )
    // Its own words went after all, and so they're what it's noted as having said.
    expect(result.played).toEqual(["yapd. The PR is ready.", "It's on your screen. Nothing's running."])
    expect(result.told).toEqual(["It's on your screen. Nothing's running."])
  })

  test("a notice that goes stale while the words said in its place are rendered is never played, nor told it was said in them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, played } = yield* make(undefined, { renderSeconds: 5 })
        let closed = false
        const told: Array<string> = []
        const noting = (what: string) => Effect.sync(() => void told.push(what))
        yield* Effect.forkScoped(
          made.tell({
            id: "q",
            kind: "question",
            open: "open-q",
            priority: "needs-you",
            spoken: "It's on your screen. Which project?",
            at: 0,
            stale: Effect.sync(() => closed),
            instead: { spoken: "Which project?", when: Effect.succeed(true), used: noting("used") },
            saying: noting("saying"),
            gone: noting("gone"),
            question: { answer: () => Effect.succeed(Option.none()), unanswered: noting("unanswered"), unsaid: noting("unsaid") },
          }),
        )
        // Its own words are rendered and its turn comes, then it's closed while the words in their place are rendered.
        yield* wait(5)
        closed = true
        yield* wait(5)
        yield* wait(10)
        return { played: [...played], told }
      }),
    )
    expect(result).toEqual({ played: [], told: ["gone"] })
  })

  test("a question he asked to see closed by what he says while its words for no app are rendered is never asked, nor its card put up", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, assistant, show, wait, flush, played } = yield* assisted(
          (situation) =>
            situation.utterance.heard === "Thanks."
              ? Brain.decision({ act: "dismiss", pending: "replaces" })
              : Brain.decision({ act: "clarify", sure: "low", target: situation.desk.threads[0]?.handle ?? "", others: situation.desk.threads[1]?.handle ?? "" }),
          { renderSeconds: 2 },
          [thread("f0000000-0000-4000-8000-000000000001", "Fix the loader"), thread("f0000000-0000-4000-8000-000000000002", "Fix the parser")],
        )
        const type = (heard: string) =>
          Effect.gen(function* () {
            const { turns } = yield* made.power
            yield* assistant.heard({ heard, via: "typed", at: yield* Clock.currentTimeMillis, voiced: Number.POSITIVE_INFINITY, turns })
          })
        const asked = yield* Effect.forkScoped(type("Which fix was that?"))
        yield* flush
        yield* wait(2)
        yield* Fiber.join(asked)
        yield* wait(10)
        // Asked to see it while the app watches, which goes before it's said, so the question alone is rendered to be said in its place.
        const watching = yield* Scope.make()
        yield* Scope.extend(show.watch, watching)
        const shown = yield* Effect.forkScoped(type("Show me what you said."))
        yield* flush
        yield* Scope.close(watching, Exit.void)
        yield* wait(2)
        yield* Fiber.join(shown)
        yield* wait(1)
        yield* type("Thanks.")
        const open = yield* assistant.open
        yield* wait(3)
        yield* wait(10)
        return { open, played: [...played], up: Option.map(yield* Stream.runHead(show.showing).pipe(Effect.map(Option.flatten)), ({ kind }) => kind) }
      }),
    )
    expect(result.open).toEqual(Option.none())
    expect(result.played).toEqual(["Fix the loader or Fix the parser?"])
    expect(result.up).toEqual(Option.none())
  })

  test("an update heard before yapd was turned off and on is never said again for 'say that again' after, while one heard since is", async () => {
    const result = await run(
      Effect.gen(function* () {
        // Saying again needs no model.
        const { finish, wait, toggle, made, assistant, played } = yield* assisted(() => Brain.decision({ act: "answer", spoken: "Asked." }))
        const again = Effect.gen(function* () {
          const { turns } = yield* made.power
          yield* assistant.heard({ heard: "Say that again.", via: "typed", at: yield* Clock.currentTimeMillis, voiced: Number.POSITIVE_INFINITY, turns })
          yield* wait(11)
        })
        yield* finish("a", "The PR is ready.")
        yield* wait(11)
        yield* toggle(false)
        yield* toggle(true)
        yield* again
        yield* finish("b", "The tests pass.")
        yield* wait(11)
        yield* again
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The PR is ready.", "I haven't said anything just now.", "yapd. The tests pass.", "yapd. The tests pass."])
  })

  test("anything else dictated over an update, even thanks, has it read again from the start once it's dealt with", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, dictating, played, journal } = yield* assisted((situation) =>
          situation.utterance.heard === "Thanks."
            ? Brain.decision({ act: "dismiss" })
            : Brain.decision({ act: "answer", spoken: "It changes the parser." }),
        )
        yield* finish("a", "The PR is ready.")
        yield* wait(2)
        yield* dictating("Thanks.")
        yield* wait(2)
        yield* dictating("What does it change?")
        for (let i = 0; i < 4; i++) yield* wait(11)
        return { played: [...played], unheard: (yield* journal.unheard(0, 12)).length }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready.", "It changes the parser.", "yapd. The PR is ready."])
    // Heard to the end the last time.
    expect(result.unheard).toBe(0)
  })

  test.each(["a follow-up", "silence"])("an answer said to the end is listened to as an update is, and what's next waits for %s", async (after) => {
    const followed = after === "a follow-up"
    const result = await run(
      Effect.gen(function* () {
        const { notice, finish, wait, speak, played } = yield* make(undefined, { microphone: true, transcripts: ["Tell it to fix the tests."] })
        const followUps: Array<string> = []
        const heard: Array<string> = []
        yield* notice("status", "The loader fix is running its tests, sir.", { answer: true, followUp: followUps, heard })
        yield* finish("a", "The PR is ready.")
        yield* wait(10)
        // Heard as soon as it's said to the end, with the microphone still open.
        const through = [...heard]
        yield* wait(2)
        const lingering = [...played]
        if (followed) yield* speak
        else yield* wait(1)
        yield* wait(1)
        return { through, lingering, followUps, played: [...played] }
      }),
    )
    expect(result.through).toEqual(["status"])
    expect(result.lingering).toEqual(["The loader fix is running its tests, sir."])
    expect(result.followUps).toEqual(followed ? ["status: Tell it to fix the tests."] : [])
    expect(result.played).toEqual(["The loader fix is running its tests, sir.", "yapd. The PR is ready."])
  })

  test.each(["a dictation", "turning yapd off", "the audio helper quitting"])("an answer cut off by %s isn't listened to after, while the next, said to the end, is", async (by) => {
    const result = await run(
      Effect.gen(function* () {
        const first = "The loader fix is running its tests, sir."
        const { notice, wait, dictate, toggle, played } = yield* make(undefined, { microphone: true, ...(by === "the audio helper quitting" ? { breaks: { [first]: 5 } } : {}) })
        const followUps: Array<string> = []
        yield* notice("first", first, { answer: true, followUp: followUps })
        yield* wait(5)
        if (by === "a dictation") yield* Scope.close(yield* dictate, Exit.void)
        if (by === "turning yapd off") {
          yield* toggle(false)
          yield* toggle(true)
        }
        yield* notice("second", "Nothing needs you right now, sir.", { answer: true, followUp: followUps })
        yield* notice("started", "Started the parser fix, sir.", { done: true })
        yield* wait(1)
        // Said at once after the first was cut off, then listened to after.
        const cut = [...played]
        yield* wait(10)
        const lingering = [...played]
        yield* wait(3)
        return { cut, lingering, played: [...played] }
      }),
    )
    expect(result.cut).toEqual(["The loader fix is running its tests, sir.", "Nothing needs you right now, sir."])
    expect(result.lingering).toEqual(result.cut)
    expect(result.played).toEqual([...result.cut, "Started the parser fix, sir."])
  })

  test("a reply right after a status answer goes to the assistant, with \"it\" the answer's thread, while one over an update still goes to its agent", async () => {
    const loader = thread("f0000000-0000-4000-8000-000000000001", "Fix the loader")
    const result = await run(
      Effect.gen(function* () {
        const { dictating, finish, speak, talk, wait, played, asked, followUps, journal } = yield* assisted(
          (situation) =>
            situation.utterance.via === "shortcut"
              ? Brain.decision({ act: "answer", target: situation.desk.threads[0]?.handle ?? "", spoken: "It's running its tests, sir." })
              : // What "it" is, as the model is shown it.
                Brain.decision({ act: "send", target: Option.match(Brain.focused(situation), { onNone: () => "", onSome: ({ handle }) => handle }), text: "Fix the tests.", how: "now" }),
          { says: "Use the staging branch.", transcripts: ["Tell it to fix the tests."] },
          [loader],
        )
        yield* dictating("Get me the status of this thread.")
        yield* wait(10)
        yield* wait(1)
        yield* talk
        yield* wait(11)
        const followedUp = asked.at(-1)!
        // An update, which what's said over still goes to its agent.
        yield* finish("a", "The PR is ready.")
        yield* wait(2)
        yield* speak
        for (let i = 0; i < 3; i++) yield* wait(11)
        const actions = yield* journal.since(0, { kinds: ["action"] })
        return {
          asked: asked.length,
          via: followedUp.utterance.via,
          heard: followedUp.utterance.heard,
          it: followedUp.subject._tag === "Answer" ? Option.map(followedUp.subject.about, ({ id }) => id) : Option.none(),
          to: actions.map(({ thread, detail }) => [thread, (detail as { act: string }).act]),
          replies: (yield* journal.since(0, { kinds: ["reply"] })).map(({ text }) => text),
          relayed: [...followUps],
          played: [...played],
        }
      }),
    )
    expect(result.asked).toBe(2)
    expect(result.via).toBe("reply")
    expect(result.heard).toBe("Tell it to fix the tests.")
    expect(result.it).toEqual(Option.some(loader.id))
    // To the thread, which isn't there to be reached here.
    expect(result.to).toEqual([[loader.id, "Message"]])
    expect(result.replies).toEqual(["Tell it to fix the tests.", "Use the staging branch."])
    expect(result.relayed).toEqual(["a sent: Use the staging branch."])
    expect(result.played).toEqual([
      "It's running its tests, sir.",
      "That didn't go through: I can't reach the threads on Rosie right now.",
      "yapd. The PR is ready.",
      "Okay, passed on.",
    ])
  })

  test.each([
    ["Thanks.", "right after"],
    ["Stop.", "over"],
  ])("\"%s\" said %s an answer ends it without the model", async (said, when) => {
    const result = await run(
      Effect.gen(function* () {
        const { dictating, finish, speak, wait, played, stopped, asked, journal } = yield* assisted(
          () => Brain.decision({ act: "answer", spoken: "Two things are running, sir." }),
          { microphone: true, transcripts: [said] },
        )
        yield* dictating("What's going on?")
        yield* wait(when === "over" ? 3 : 11)
        yield* speak
        yield* finish("a", "The PR is ready.")
        yield* wait(1)
        const replies = yield* journal.since(0, { kinds: ["reply"] })
        return {
          asked: asked.length,
          replies: replies.map(({ text, detail }) => [text, (detail as { decision: Brain.Decision }).decision.act]),
          played: [...played],
          stopped: [...stopped],
        }
      }),
    )
    expect(result.asked).toBe(1)
    expect(result.replies).toEqual([[said, "dismiss"]])
    // Nothing said back, and what's next goes at once.
    expect(result.played).toEqual(["Two things are running, sir.", "yapd. The PR is ready."])
    expect(result.stopped).toEqual(when === "over" ? ["Two things are running, sir."] : [])
  })

  test.each([
    ["a follow-up", "What's it waiting on?", "over"],
    ["thanks", "Thanks.", "over"],
    ["stop", "Stop.", "over"],
    ["a follow-up", "What's it waiting on?", "right after"],
  ])("what he missed that a catch-up answer told him, followed by %s said %s it, is heard only once it was said to the end, and told again when he asks", async (_, said, when) => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, dictating, speak, played, journal } = yield* assisted(
          (situation) => {
            if (situation.utterance.via === "reply") return Brain.decision({ act: "answer", spoken: "A review, sir." })
            // As the model is asked to: what he missed, from what he hasn't heard.
            const told = situation.unheard.map(({ said }) => said).join(" ")
            return Brain.decision({ act: "answer", how: "missed", spoken: told === "" ? "Nothing else." : `You missed this: ${told}` })
          },
          { microphone: true, transcripts: [said] },
        )
        yield* finish("a", "The loader fix is ready.")
        yield* wait(2)
        // Turned off and on before it's read to the end, so he missed it.
        yield* toggle(false)
        yield* toggle(true)
        yield* dictating("What did I miss?")
        yield* wait(when === "over" ? 3 : 11)
        yield* speak
        for (let i = 0; i < 3; i++) yield* wait(11)
        const unheard = (yield* journal.unheard(0, 12)).map(({ said }) => said)
        const told = played.length
        // What he said back was part of catching up, so asking again still reaches what he didn't hear of it.
        yield* dictating("What did I miss?")
        for (let i = 0; i < 3; i++) yield* wait(11)
        return { unheard, played: played.slice(0, told), again: played.slice(told) }
      }),
    )
    // Cut off, it's dealt with all the same: never said again.
    expect(result.played).toEqual([
      "yapd. The loader fix is ready.",
      "You missed this: yapd. The loader fix is ready.",
      ...(said === "What's it waiting on?" ? ["A review, sir."] : []),
    ])
    expect(result.unheard).toEqual(when === "over" ? ["yapd. The loader fix is ready."] : [])
    // Heard to the end, it's never told twice.
    expect(result.again).toEqual([when === "over" ? "You missed this: yapd. The loader fix is ready." : "Nothing else."])
  })

  test("thanks after the answer to a follow-up said over a catch-up answer still leaves what he missed to be told", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, dictating, speak, played } = yield* assisted(
          (situation) => {
            if (situation.utterance.via === "reply") return Brain.decision({ act: "answer", spoken: "A review, sir." })
            const told = situation.unheard.map(({ said }) => said).join(" ")
            return Brain.decision({ act: "answer", how: "missed", spoken: told === "" ? "Nothing else." : `You missed this: ${told}` })
          },
          { microphone: true, transcripts: ["What's it waiting on?", "Thanks."] },
        )
        yield* finish("a", "The loader fix is ready.")
        yield* wait(2)
        yield* toggle(false)
        yield* toggle(true)
        yield* dictating("What did I miss?")
        yield* wait(3)
        // The follow-up cuts the catch-up answer off, and thanks comes after its own answer.
        yield* speak
        yield* wait(11)
        yield* speak
        for (let i = 0; i < 3; i++) yield* wait(11)
        const told = played.length
        yield* dictating("What did I miss?")
        for (let i = 0; i < 3; i++) yield* wait(11)
        return { played: played.slice(0, told), again: played.slice(told) }
      }),
    )
    expect(result.played).toEqual(["yapd. The loader fix is ready.", "You missed this: yapd. The loader fix is ready.", "A review, sir."])
    expect(result.again).toEqual(["You missed this: yapd. The loader fix is ready."])
  })

  test("thanks after a card shown for a follow-up said over a catch-up answer still leaves what he missed to be told", async () => {
    const loader = thread("f0000000-0000-4000-8000-000000000001", "Fix the loader")
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, dictating, speak, played, show } = yield* assisted(
          (situation) => {
            if (situation.utterance.via === "reply") return Brain.decision({ act: "show", how: "thread", target: situation.desk.threads[0]?.handle ?? "" })
            const told = situation.unheard.map(({ said }) => said).join(" ")
            return Brain.decision({ act: "answer", how: "missed", spoken: told === "" ? "Nothing else." : `You missed this: ${told}` })
          },
          { microphone: true, transcripts: ["Show me that.", "Thanks."] },
          [loader],
        )
        yield* finish("a", "The loader fix is ready.")
        yield* wait(2)
        yield* toggle(false)
        yield* toggle(true)
        yield* dictating("What did I miss?")
        yield* wait(3)
        // Asked to see it over the catch-up answer, which that cuts off, and thanks comes once what's said of the card is over.
        yield* speak
        yield* wait(11)
        const up = Option.map(yield* Stream.runHead(show.showing).pipe(Effect.map(Option.flatten)), ({ kind }) => kind)
        yield* speak
        for (let i = 0; i < 3; i++) yield* wait(11)
        const told = played.length
        yield* dictating("What did I miss?")
        for (let i = 0; i < 3; i++) yield* wait(11)
        return { up, played: played.slice(0, told), again: played.slice(told) }
      }),
    )
    expect(result.up).toEqual(Option.some("thread"))
    expect(result.played).toEqual(["yapd. The loader fix is ready.", "You missed this: yapd. The loader fix is ready.", "Fix the loader is idle."])
    expect(result.again).toEqual(["You missed this: yapd. The loader fix is ready."])
  })

  test.each([
    ["What did I miss?", "Nothing else.", "catch-up"],
    ["What's going on?", "Two things are running, sir.", undefined],
  ])("thanks said to the answer to %s is noted as catching up only when that was", async (asked, spoken, over) => {
    const result = await run(
      Effect.gen(function* () {
        const { dictating, wait, speak, journal } = yield* assisted(() => Brain.decision({ act: "answer", spoken }), {
          microphone: true,
          transcripts: ["Thanks."],
        })
        yield* dictating(asked)
        yield* wait(11)
        yield* speak
        yield* wait(1)
        return (yield* journal.since(0, { kinds: ["reply"] })).map(({ detail }) => (detail as { readonly over?: string }).over)
      }),
    )
    // Even with nothing missed, what he says back to catching up never hides what comes in meanwhile and he doesn't hear.
    expect(result).toEqual([over])
  })
})
