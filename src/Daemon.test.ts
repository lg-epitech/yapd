import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Queue, Schema, Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { hostname } from "node:os"
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
import { Transcriber } from "./Transcriber.ts"
import { Vad, VadError } from "./Vad.ts"
import * as Hands from "./Hands.ts"
import * as Journal from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import * as Persona from "./Persona.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3CodeServer from "./T3CodeServer.ts"
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
  readonly send?: (thread: Thread, text: string, handle: Handle, nextEvent: (...prefixes: ReadonlyArray<string>) => Effect.Effect<string>) => Effect.Effect<void, RelayError>
  /** Finds the T3 Code thread a hook on this machine came from. */
  readonly link?: (session: string, cwd: string) => Effect.Effect<Option.Option<Threads.Ref>>
  /** Sends what the user says over an update tied to its T3 Code thread. */
  readonly hands?: Hands.Hands["Type"]
  /** How long working out what to do with what the user says takes, in seconds, so they can carry on meanwhile. */
  readonly thinking?: number
} = {}) => Effect.gen(function* () {
  /** What each rendered file says, and what was played, in order. */
  const rendered = new Map<string, string>()
  const played: Array<string> = []
  const stopped: Array<string> = []
  /** What happened to follow-ups and the hooks that wait for them, in order. */
  const followUps: Array<string> = []
  const condensed: Array<Turn> = []
  /** What the user said over an update, each time yapd worked out what to do with it. */
  const responded: Array<string> = []
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
    Persona.Plain,
    Journal.memory,
    Layer.succeed(Condenser, {
      condense: (_, turn) => Effect.sync(() => {
        condensed.push(turn)
        return { priority: options.trivialMessages?.includes(turn.message) ? "trivial" as const : "done" as const, spoken: turn.message }
      }),
      ask: (request) => Effect.succeed({ spoken: request._tag === "Approval" ? `wants to ${request.what}` : "asks something", risk: "low" as const }),
    }),
    Layer.succeed(Voice, {
      render: (text, path) =>
        Effect.sleep(`${options.renderSeconds ?? 0} seconds`).pipe(Effect.zipRight(Effect.sync(() => void rendered.set(path, text)))),
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
          : Effect.sync(() => void responded.push(heard)).pipe(
              Effect.zipRight(Effect.sleep(`${options.thinking ?? 0} seconds`)),
              Effect.as(
                options.answer === undefined
                  ? { intent: "send" as const, spoken: "Okay, passed on.", message: heard }
                  : { intent: "answer" as const, spoken: options.answer, message: "" },
              ),
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
  const made = yield* Daemon.make({
    ...(options.link === undefined ? {} : { link: options.link }),
    ...(options.hands === undefined ? {} : { hands: options.hands }),
  }).pipe(Effect.provide(context))
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
  /**
   * Something yapd has to say for itself, which as a question, the one open, records how it went, in `saying` when it
   * started being said, until that's undone, and in `heard` when it was heard to the end.
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
  return { responded, microphone, made, handle, finish, turn, notice, lastHeard: made.lastHeard, speak, followUps, wait, dictate, record, reading, played, stopped, condensed, warnings, nextEvent, nextPlayback: Queue.take(playbacks), rests: () => rests, warms: () => warms, renders: () => rendered.size, flush, toggle, power: made.turn, heard, replay: made.replay, awaiting: made.awaiting.pipe(Effect.map((arrived) => arrived.pipe(Effect.zipRight(flush)))), journal: Context.get(context, Journal.Journal) }
})

const daemon = make()

/**
 * The loader's turn T3 Code said finished, with no hook to tell of it, as of
 * when yapd had been turned on or off `turns` times: it said `message` last,
 * in its session `native-loader`.
 */
const unhooked = (message: string, runId: string, turns: number) => ({
  about: { machine: "Rosie", id: "t-loader" },
  project: "yapd",
  cwd: "/code/yapd",
  turn: { prompt: Option.some("Fix the loader."), message },
  at: 0,
  key: `done:Rosie:${runId}`,
  turns,
  run: { final: message, others: [], natives: ["native-loader"], startedAt: -60_000 },
})

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** The Tezos migration, as T3 Code's live view has it once the turn its hook told of ended. */
const tezos = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id: "t-tezos",
    projectId: "yapd",
    title: "Migrate Tezos Integration",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...overrides,
  })

/**
 * Hands over a ledger of their own and a T3 Code with the Tezos thread in
 * it, which takes a message as a turn of its own on an idle thread, or into
 * the turn under way, keeping what it was sent. A turn it starts shows in
 * the thread at once.
 */
const handing = Effect.gen(function* () {
  const ledger = Ledger.fromStore(yield* Store.make(":memory:"))
  const bounded = {
    runs: [] as Array<{ id: string; status: string; ordinal: number; userMessageId?: string }>,
    messages: [] as Array<{ id: string; role: string; text: string; createdAt: string }>,
    turnItems: [] as Array<Record<string, unknown>>,
  }
  const dispatched: Array<Record<string, unknown>> = []
  let current = tezos()
  /** Whether what it's sent is lost on the way, after it may have got there, and never shows in the thread. */
  let losing = false
  /** Whether T3 Code is down, so nothing it's sent ever leaves yapd. */
  let down = false
  const reach: Effect.Effect<T3CodeServer.Transport, T3CodeServer.Trouble> = Effect.succeed({
    api: (<A, I>(_: string, schema: Schema.Schema<A, I>) => Schema.decodeUnknown(schema)({ projection: bounded }).pipe(Effect.orDie)) as T3CodeServer.Transport["api"],
    call: (<A, I>(method: string, payload: Record<string, unknown>, schema: Schema.Schema<A, I>) =>
      method === "orchestration.dispatchCommand"
        ? Effect.gen(function* () {
            dispatched.push(payload)
            if (down) return yield* new T3CodeServer.Trouble({ reason: "T3 Code isn't running.", sent: false })
            if (losing) return yield* new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })
            if (payload.type === "message.dispatch") {
              const at = new Date(yield* Clock.currentTimeMillis).toISOString()
              const messageId = String(payload.messageId)
              const busy = current.activeRunId !== null
              bounded.messages.push({ id: messageId, role: "user", text: String(payload.text), createdAt: at })
              bounded.turnItems.push({ type: "user_message", messageId, inputIntent: busy ? "steer" : "turn_start" })
              if (!busy) bounded.runs.push({ id: `run-${bounded.runs.length + 2}`, status: "running", ordinal: bounded.runs.length + 2, userMessageId: messageId })
              current = tezos({ ...current, activeRunId: current.activeRunId ?? "run-2", activityRunStatus: "running", latestUserMessageAt: at, latestRunStartedAt: current.latestRunStartedAt ?? at })
            }
            return yield* Schema.decodeUnknown(schema)({ sequence: 1 }).pipe(Effect.orDie)
          })
        : Effect.die(`not expected: ${method}`)) as T3CodeServer.Transport["call"],
  })
  const actions = T3Actions.make(reach)
  const hands = Hands.make({
    threads: {
      find: (ref) => Effect.sync(() => (ref.id === current.id ? Option.some(current) : Option.none())),
      actions: (machine) => (machine === "Rosie" ? Option.some(actions) : Option.none()),
    },
    ledger,
  })
  return {
    hands,
    /** The messages T3 Code was sent, by thread. */
    sent: () => dispatched.filter(({ type }) => type === "message.dispatch").map(({ threadId, text }) => `${threadId}: ${text}`),
    /** How many commands were sent to T3 Code, whether they got there or not. */
    dispatched: () => dispatched.length,
    /** How each went in, as the thread says. */
    intents: () => bounded.turnItems.map(({ inputIntent }) => inputIntent),
    /** The thread as T3 Code has it from now on, like once he's typed something into it. */
    becomes: (overrides: Record<string, unknown>) =>
      Effect.sync(() => {
        current = tezos({ ...current, ...overrides })
      }),
    /** What it's sent from now on is lost on the way, or isn't. */
    loses: (lost: boolean) =>
      Effect.sync(() => {
        losing = lost
      }),
    /** T3 Code is down from now on, or up again. */
    downs: (isDown: boolean) =>
      Effect.sync(() => {
        down = isDown
      }),
  }
})

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
  options: Parameters<typeof make>[1] = {},
  desk: ReadonlyArray<T3Live.Thread> = [],
  /** How long the model takes over what was said, on top of deciding. */
  deciding: (situation: Brain.Situation) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const daemon = yield* make(undefined, options)
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
    )
    const asked: Array<Brain.Situation> = []
    const assistant = yield* Assistant.make({
      threads,
      journal,
      drafts,
      hands: Hands.make({ threads, ledger }),
      ledger,
      tell: made.tell,
      power: made.power,
      lastHeard: made.lastHeard,
      coming: made.coming,
      awaiting: made.awaiting,
      queued: made.queued,
      skip: made.skip,
      upcoming: made.upcoming,
      compose: () => Effect.succeedNone,
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
    return { ...daemon, assistant, asked, dictating }
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
        const { turn, wait, played, made } = yield* daemon
        yield* turn("a", "Quick and watched.", 5)
        yield* turn("b", "Quick, with nobody watching.", 5, { launched: true })
        yield* wait(11)
        yield* turn("c", "It was refused when it tried to push.", 5, { needsYou: true })
        yield* wait(11)
        // The skipped one's Stop is still known, so T3 Code's word that it finished isn't said in its place.
        return { played: [...played], stopped: yield* made.stopped(["a"]), never: yield* made.stopped(["d"]) }
      }),
    )
    expect(result.played).toEqual(["yapd. Quick, with nobody watching.", "yapd. It was refused when it tried to push."])
    expect(result.stopped).toHaveLength(1)
    expect(result.never).toEqual([])
  })

  test("every Stop of a session is kept, oldest first, so a turn's own is never taken for the one before's, and each is forgotten an hour on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { turn, wait, made } = yield* daemon
        const at: Array<number> = []
        // Two turns of one session, a few seconds apart, as a short reply of yapd's right after a turn that went well, and one of another between.
        yield* turn("a", "The PR is ready.", 30)
        at.push(yield* TestClock.currentTimeMillis)
        yield* turn("b", "The loader is fixed.", 1)
        at.push(yield* TestClock.currentTimeMillis)
        yield* turn("a", "Done, it's merged.", 3)
        at.push(yield* TestClock.currentTimeMillis)
        const kept = { a: yield* made.stopped(["a"]), b: yield* made.stopped(["b"]), both: yield* made.stopped(["b", "a"]) }
        yield* wait(60 * 60)
        yield* turn("b", "The loader's tests pass.", 1)
        return { at, kept, later: { a: yield* made.stopped(["a"]), b: (yield* made.stopped(["b"])).length } }
      }),
    )
    const [first, other, second] = result.at as [number, number, number]
    const [pr, loader, merged] = [
      { at: first, message: "The PR is ready." },
      { at: other, message: "The loader is fixed." },
      { at: second, message: "Done, it's merged." },
    ]
    expect(result.kept).toEqual({ a: [pr, merged], b: [loader], both: [pr, loader, merged] })
    expect(result.later).toEqual({ a: [], b: 1 })
  })

  test("a hook that can't be linked is spoken and answered the old way", async () => {
    const result = await run(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const { handle, speak, wait, nextEvent, nextPlayback, followUps, journal } = yield* make("Use the fee table.", {
          send: () => Effect.void,
          // No thread has the first session, and T3 Code never says for the second. The last is the Tezos thread's.
          link: (session) =>
            Effect.zipRight(
              Effect.sync(() => void asked.push(session)),
              session === "terminal" ? Effect.succeedNone : session === "tezos" ? Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }) : Effect.never,
            ),
        })
        const stop = (session: string, message: string, host: string) =>
          handle("claude", { hook_event_name: "Stop", session_id: session, cwd: "/tmp", last_assistant_message: message }, { project: "yapd", host }, false)
        yield* stop("terminal", "The fee table is in.", hostname())
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        yield* stop("slow", "The loader is fixed.", hostname())
        // Three seconds on, T3 Code still hasn't said which thread it is, so it's said all the same.
        yield* wait(3)
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        // Rig's T3 Code isn't followed, so nothing is asked for its hooks.
        yield* stop("elsewhere", "Rig's tests pass.", "rig.local")
        yield* nextPlayback
        // One that is linked is kept with its thread, as T3 Code knows it.
        yield* stop("tezos", "The Tezos migration is in.", hostname())
        yield* nextEvent("Ready: yapd. The Tezos")
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { asked, followUps: [...followUps], threads: updates.map(({ machine, thread }) => (machine === "Rosie" ? `Rosie ${thread}` : thread)) }
      }),
    )
    expect(result.asked).toEqual(["terminal", "slow", "tezos"])
    expect(result.followUps).toEqual(["terminal sent: Use the fee table.", "slow sent: Use the fee table."])
    expect(result.threads).toEqual(["claude:terminal", "claude:slow", "claude:elsewhere", "Rosie t-tezos"])
  })

  test("tell it to … after a linked update reaches that thread once, even when settle asks three times", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, speak, wait, nextEvent, nextPlayback, followUps, responded, journal } = yield* make("Tell it", {
          hands: t3.hands,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          // He says it in three goes, each before yapd has worked out the last.
          transcripts: ["Tell it to use", "the fee table", "from the Mina work."],
          thinking: 2,
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* wait(1)
        yield* speak
        yield* wait(1)
        yield* speak
        yield* wait(2)
        const told = yield* nextPlayback
        const sent = yield* journal.since(0, { kinds: ["sent"] })
        return { responded: [...responded], sent: t3.sent(), told, relayed: [...followUps], kept: sent.map(({ machine, thread, text }) => [machine, thread, text]) }
      }),
    )
    expect(result.responded).toEqual(["Tell it to use", "Tell it to use the fee table", "Tell it to use the fee table from the Mina work."])
    expect(result.sent).toEqual(["t-tezos: Tell it to use the fee table from the Mina work."])
    expect(result.told).toBe("Okay, passed on.")
    // Never the old way as well.
    expect(result.relayed).toEqual([])
    expect(result.kept).toEqual([["Rosie", "t-tezos", "Tell it to use the fee table from the Mina work."]])
  })

  test("a reply to a linked update whose Stop hook waits for it goes back through the hook, never through T3 Code", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, speak, wait, nextEvent, nextPlayback, followUps } = yield* make("Use the fee table.", {
          hands: t3.hands,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
        })
        // A terminal resuming the Tezos thread's session, whose hook waits for his reply.
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, true)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* wait(3)
        return { relayed: [...followUps], sent: t3.sent() }
      }),
    )
    expect(result.relayed).toEqual(["s-tezos sent: Use the fee table."])
    expect(result.sent).toEqual([])
  })

  test("a second follow-up to the same update is steered, not refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, speak, wait, nextEvent, nextPlayback, played } = yield* make("Tell it", {
          hands: t3.hands,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          transcripts: ["Use the fee table.", "And add a test for it."],
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        // He hears some of it first, so what he sends comes well after the update.
        yield* wait(5)
        yield* speak
        yield* nextPlayback
        // The turn his message started, as its hook tells of it, while he says more over what yapd said back.
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt: "Use the fee table." }, { project: "yapd", host: hostname() }, false)
        yield* wait(1)
        yield* speak
        yield* nextPlayback
        return { sent: t3.sent(), intents: t3.intents(), played: [...played] }
      }),
    )
    expect(result.sent).toEqual(["t-tezos: Use the fee table.", "t-tezos: And add a test for it."])
    expect(result.intents).toEqual(["turn_start", "steer"])
    expect(result.played).toEqual(["yapd. The migration compiles.", "Okay, passed on.", "Okay, passed on."])
  })

  test("a reply after the thread was given something else since is held back with a spoken reason", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, speak, wait, nextEvent, nextPlayback, journal } = yield* make("Use the fee table.", {
          hands: t3.hands,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        // He typed something else into it in T3 Code meanwhile.
        yield* wait(5)
        yield* t3.becomes({ latestUserMessageAt: new Date(yield* Clock.currentTimeMillis).toISOString() })
        yield* speak
        const told = yield* nextPlayback
        const noted = yield* journal.since(0, { kinds: ["sent", "action"] })
        return { sent: t3.sent(), told, noted: noted.map(({ thread, detail }) => [thread, (detail as { reason?: string }).reason]) }
      }),
    )
    expect(result.sent).toEqual([])
    expect(result.told).toBe("You've given it something else since, so I held that back.")
    expect(result.noted).toEqual([["t-tezos", Hands.given]])
  })

  test("the same reply over a linked update, after one that may not have got there, is never said to have gone, nor sent under new ids", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, speak, wait, nextEvent, nextPlayback, journal } = yield* make("Use the fee table.", {
          hands: t3.hands,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          transcripts: ["Use the fee table.", "Use the fee table."],
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        // T3 Code takes too long to say it got it, and it isn't in the thread when looked for.
        yield* t3.loses(true)
        yield* speak
        const first = yield* nextPlayback
        yield* t3.loses(false)
        yield* wait(1)
        yield* speak
        const second = yield* nextPlayback
        const noted = yield* journal.since(0, { kinds: ["action"] })
        return { told: [first, second], sent: t3.sent(), states: noted.map(({ detail }) => (detail as { state?: string }).state ?? (detail as { outcome?: string }).outcome) }
      }),
    )
    expect(result.told).toEqual(["I couldn't confirm it got there.", "I couldn't confirm that got there before, so I haven't sent it again."])
    expect(result.sent).toEqual(["t-tezos: Use the fee table."])
    expect(result.states).toEqual(["Unknown", "unknown"])
  })

  test("the same reply over a linked update, after one that never left yapd, is told it never got there, and isn't sent under new ids", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, speak, wait, nextEvent, nextPlayback, journal } = yield* make("Use the fee table.", {
          hands: t3.hands,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          transcripts: ["Use the fee table.", "Use the fee table."],
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        // T3 Code isn't running, so it never leaves yapd.
        yield* t3.downs(true)
        yield* speak
        const first = yield* nextPlayback
        // It's back, and he says the same again.
        yield* t3.downs(false)
        yield* wait(1)
        yield* speak
        const second = yield* nextPlayback
        const noted = yield* journal.since(0, { kinds: ["action"] })
        return { told: [first, second], dispatched: t3.dispatched(), states: noted.map(({ detail }) => (detail as { state?: string }).state ?? (detail as { outcome?: string }).outcome) }
      }),
    )
    expect(result.told).toEqual(["That didn't get there: T3 Code isn't running.", "That didn't get there before, so I haven't sent it: say it to me with the shortcut to send it again."])
    expect(result.dispatched).toBe(1)
    expect(result.states).toEqual(["NotSent", "failed"])
  })

  test("a turn no hook told of is said like a hook's update, once under its key, and never once yapd was turned off since", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, played, journal, finish, notice } = yield* make()
        const loader = (turns: number, runId: string) => made.finished(unhooked(`The loader is fixed, ${runId}.`, runId, turns))
        const { turns } = yield* made.power
        // While something else is being said, it waits alongside a notice about the same thread, and neither takes the other's place.
        yield* finish("a", "Something else first.")
        yield* loader(turns, "run-1")
        yield* notice("t3:Rosie:t-loader", "The loader wants your go-ahead.")
        yield* wait(11)
        yield* wait(11)
        yield* wait(11)
        // Heard of twice, as after a reconnect, it's said the once.
        yield* loader(turns, "run-1")
        yield* wait(11)
        // One heard of before yapd was turned off and on isn't said.
        yield* made.turn(false)
        yield* made.turn(true)
        yield* loader(turns, "run-2")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: updates.map(({ machine, thread, key }) => [machine, thread, key]) }
      }),
    )
    expect(result.played.toSorted()).toEqual(["The loader wants your go-ahead.", "yapd. Something else first.", "yapd. The loader is fixed, run-1."])
    // Kept with its thread, and the one never said isn't kept as if it were.
    expect(result.kept.slice(1)).toEqual([["Rosie", "t-loader", "done:Rosie:run-1"]])
  })

  test("a turn no hook told of, waiting to be said, isn't once its thread started again or went", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, played, finish, nextEvent } = yield* make()
        const { turns } = yield* made.power
        // It waits behind something else being said, and he follows it up in T3 Code meanwhile.
        yield* finish("a", "Something else first.")
        yield* made.finished(unhooked("The loader is fixed.", "run-1", turns))
        yield* nextEvent("Ready: yapd. The loader")
        yield* made.overtaken({ machine: "Rosie", id: "t-loader" })
        yield* wait(11)
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. Something else first."])
  })

  test("a turn no hook told of, said in its hook's place, is the turn's: its own Stop, come after, isn't said too, and one still waiting gives way to it", async () => {
    const stop = (handle: Handle, message: string) =>
      handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: message }, { project: "yapd", host: hostname() }, false)
    // Said, and heard, before its Stop came, a while getting going: that's kept as said that way.
    const heard = await run(
      Effect.gen(function* () {
        const { made, wait, played, handle, journal, nextEvent } = yield* make(undefined, { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }) })
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready:")
        yield* wait(11)
        yield* stop(handle, "The loader is fixed.")
        yield* wait(11)
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["update", "action"] })
        return { played: [...played], kept: kept.map(({ kind, key, heardAt, detail }) => [kind, key ?? (detail as { through?: string }).through, heardAt !== undefined]) }
      }),
    )
    expect(heard.played).toEqual(["yapd. The loader is fixed."])
    expect(heard.kept).toEqual([
      ["update", "done:Rosie:run-1", true],
      ["action", "done:Rosie:run-1", false],
    ])
    // Still waiting behind something else when its Stop comes, it gives way to the Stop's update, and isn't left as something he missed.
    const waiting = await run(
      Effect.gen(function* () {
        const { made, wait, played, handle, finish, journal, nextEvent } = yield* make()
        yield* finish("a", "Something else first.")
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready: yapd. The loader")
        yield* stop(handle, "The loader is fixed.")
        yield* wait(11)
        yield* wait(11)
        yield* wait(11)
        return { played: [...played], missed: (yield* journal.unheard(0, 10)).map(({ said }) => said) }
      }),
    )
    expect(waiting).toEqual({ played: ["yapd. Something else first.", "yapd. The loader is fixed."], missed: [] })
    // Its Stop came, and was said, by the time T3 Code's word was looked into, however late that was: it's left to it.
    const late = await run(
      Effect.gen(function* () {
        const { made, wait, played, handle } = yield* make()
        yield* stop(handle, "The loader is fixed.")
        yield* wait(11)
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* wait(11)
        yield* wait(11)
        return [...played]
      }),
    )
    expect(late).toEqual(["yapd. The loader is fixed."])
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
})
