import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Queue, Schema, Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { hostname } from "node:os"
import * as Assistant from "./Assistant.ts"
import { Audio, AudioError } from "./Audio.ts"
import * as Brain from "./Brain.ts"
import { Waiting, WaitingLive } from "./ClaudeCode.ts"
import { CondenseError, Condenser, type Turn } from "./Condenser.ts"
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
import * as Mutes from "./Mutes.ts"
import * as Notices from "./Notices.ts"
import * as Persona from "./Persona.ts"
import { ProcessError } from "./Process.ts"
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
  /** Whether what the user says over an update ends it, instead of being passed on. */
  readonly dismiss?: boolean
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
  /** How many frames from the microphone, from the first, may carry yapd's own voice, as before the echo cancellation has learnt it. */
  readonly echoing?: number
  /** Where the lines the persona is told are being said go, in order. */
  readonly noted?: Array<string>
  readonly send?: (thread: Thread, text: string, handle: Handle, nextEvent: (...prefixes: ReadonlyArray<string>) => Effect.Effect<string>) => Effect.Effect<void, RelayError>
  /** Finds the T3 Code thread a hook on this machine came from. */
  readonly link?: (session: string, cwd: string) => Effect.Effect<Option.Option<Threads.Ref>>
  /** Sends what the user says over an update tied to its T3 Code thread. */
  readonly hands?: Hands.Hands["Type"]
  /** How long working out what to do with what the user says takes, in seconds, so they can carry on meanwhile. */
  readonly thinking?: number
  /** What's muted. Nothing is without it. */
  readonly mutes?: Mutes.Mutes
  /** Finds the T3 Code thread a hook on another machine came from. */
  readonly owner?: (host: string, session: string, cwd: string) => Effect.Effect<Option.Option<Threads.Ref>>
  /** Messages the summary reads as needing the user, like a failure. */
  readonly urgentMessages?: ReadonlyArray<string>
  /** Messages that can't be summed up, as when the model is down. */
  readonly unsummarizable?: ReadonlyArray<string>
  /** What yapd sent each thread for him, as the ledger has it. */
  readonly sent?: (to: Threads.Ref, since: number) => Effect.Effect<ReadonlyArray<{ readonly at: number; readonly digest: string | null }>>
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
  /** What was logged, and what of it as a warning, in order. */
  const logged: Array<string> = []
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
  /** What each thing heard was listened for, as the transcriber was told: a question's options, or nothing. */
  const listened: Array<ReadonlyArray<string> | undefined> = []
  const waiting = options.waitingHooks ? yield* Waiting.pipe(Effect.provide(WaitingLive)) : undefined
  let handle: Handle
  let rests = 0
  let warms = 0
  let echoed = 0
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
      condense: (_, turn) => options.unsummarizable?.includes(turn.message) ? Effect.fail(new CondenseError({ cause: "the model is down" })) : Effect.sync(() => {
        condensed.push(turn)
        return {
          priority: options.trivialMessages?.includes(turn.message) ? "trivial" as const : options.urgentMessages?.includes(turn.message) ? "needs-you" as const : "done" as const,
          spoken: turn.message,
        }
      }),
      ask: (request) => Effect.succeed({ spoken: `wants to ${request.what}`, risk: "low" as const }),
      question: () => Effect.succeed({ spoken: "Which one should it use?" }),
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
      echo: () => Effect.sync(() => echoed++ < (options.echoing ?? 0)),
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
    Layer.succeed(Transcriber, {
      transcribe: (_, terms) =>
        Effect.sync(() => {
          listened.push(terms)
          return transcripts.shift() ?? says ?? ""
        }),
    }),
    Layer.succeed(Responder, {
      respond: ({ heard }) =>
        says === undefined
          ? Effect.die("nothing to respond to")
          : Effect.sync(() => void responded.push(heard)).pipe(
              Effect.zipRight(Effect.sleep(`${options.thinking ?? 0} seconds`)),
              Effect.as(
                options.dismiss === true
                  ? { intent: "dismiss" as const, spoken: "", message: "" }
                  : options.answer === undefined
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
        logged.push(line)
        if (logLevel._tag === "Warning") warnings.push(line)
      }
    })),
  )
  const context = yield* Layer.build(layer)
  const made = yield* Daemon.make({
    ...(options.link === undefined ? {} : { link: options.link }),
    ...(options.hands === undefined ? {} : { hands: options.hands }),
    ...(options.mutes === undefined ? {} : { mutes: options.mutes }),
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(options.sent === undefined ? {} : { sent: options.sent }),
    // This machine is Rosie, as yapd serves it.
    naming,
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
      /** What the question's options are called, to listen for. */
      readonly terms?: ReadonlyArray<string>
      /** Where the question takes whatever's said over it or right after for its answer, noted, rather than leaving it unanswered. */
      readonly answers?: Array<string>
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
              answer: (heard: string) =>
                Effect.succeed(options.answers === undefined ? Option.none() : Option.some(Effect.sync(() => void options.answers?.push(`${id}: ${heard}`)))),
              ...(options.terms === undefined ? {} : { terms: options.terms }),
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
  return { responded, listened, microphone, made, handle, finish, turn, notice, lastHeard: made.lastHeard, speak, talk, followUps, wait, dictate, record, reading, played, stopped, condensed, logged, warnings, nextEvent, nextPlayback: Queue.take(playbacks), rests: () => rests, warms: () => warms, renders: () => rendered.size, flush, toggle, power: made.turn, heard, replay: made.replay, awaiting: made.awaiting.pipe(Effect.map((arrived) => arrived.pipe(Effect.zipRight(flush)))), journal: Context.get(context, Journal.Journal) }
})

const daemon = make()

/** What the user calls each machine, here as yapd serves on Rosie. */
const naming = (host: string) => (host.toLowerCase() === hostname().toLowerCase() ? "Rosie" : (host.split(".")[0] ?? host))

/** Nothing muted yet, kept in a database of its own. */
const muting = Effect.flatMap(Store.make(":memory:"), Mutes.make)

/** A session here, by its key. */
const sessionKey = (session: string) => Mutes.key.session("Rosie", `claude:${session}`)

/** Whether a journal entry was kept quiet. */
const quieted = (kept: Journal.Kept) => (kept.detail as { readonly muted?: boolean } | undefined)?.muted === true

/**
 * The loader's turn T3 Code said finished, with no hook to tell of it, as of
 * when yapd had been turned on or off `turns` times: it said `message` last,
 * in its session `native-loader`, and is its thread's run while `current` says.
 */
const unhooked = (message: string, runId: string, turns: number, current: Effect.Effect<boolean> = Effect.succeed(true)) => ({
  about: { machine: "Rosie", id: "t-loader" },
  project: "yapd",
  cwd: "/code/yapd",
  turn: { prompt: Option.some("Fix the loader."), message },
  at: 0,
  key: `done:Rosie:${runId}`,
  turns,
  run: { status: "completed", final: message, others: [], natives: ["native-loader"], previous: Option.none(), startedAt: -60_000 },
  current,
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
    asset: () => Effect.die("not expected"),
  })
  const actions = T3Actions.make(reach)
  const hands = Hands.make({
    threads: {
      find: (ref) => Effect.sync(() => (ref.id === current.id ? Option.some(current) : Option.none())),
      actions: (machine) => (machine === "Rosie" ? Option.some(actions) : Option.none()),
      unseen: () => Effect.succeedNone,
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

  test("a reply over a linked update that could give a secret away, to a thread waiting on one, is held back, and his words are kept nowhere, nor logged", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        yield* t3.becomes({ pendingRuntimeRequest: { id: "turn-item:secret-request:credential", kind: "user_input", createdAt: "1970-01-01T00:00:00.000Z" } })
        const { handle, speak, wait, nextEvent, nextPlayback, journal, logged } = yield* make("The password is hunter2.", {
          hands: t3.hands,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* wait(1)
        const told = yield* nextPlayback
        const kept = yield* journal.since(0)
        return { sent: t3.sent(), told, kept: JSON.stringify(kept).includes("hunter2"), logged: logged.some((line) => line.includes("hunter2")) }
      }),
    )
    expect(result).toEqual({
      sent: [],
      told: "That didn't go through: it's waiting on a secret, so nothing goes to it by voice until that's given in T3 Code.",
      kept: false,
      logged: false,
    })
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

  test("a turn no hook told of, dropped as it was handed on after yapd was turned off and on, is said when T3 Code tells of it again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, played } = yield* make()
        const before = (yield* made.power).turns
        yield* made.turn(false)
        yield* made.turn(true)
        yield* made.finished(unhooked("The loader is fixed.", "run-1", before))
        yield* wait(11)
        // As after a reconnect.
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The loader is fixed."])
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

  test("a turn no hook told of, once said, is its run's even when its Stop's words can't be told, but never a newer turn's by words that can't tell them apart", async () => {
    const origin = { project: "yapd", host: hostname() }
    const stop = (handle: Handle, message: string) =>
      handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: message }, origin, false)
    /** Says the loader's turn, `said` last, in its hook's place, while `current` holds, then hears `then` happen before a Stop saying `stopped`. */
    const told = (said: string, stopped: string, then: (made: Effect.Effect.Success<ReturnType<typeof make>>, moved: () => void) => Effect.Effect<void>) =>
      run(
        Effect.gen(function* () {
          const harness = yield* make(undefined, { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }) })
          const { made, wait, played, handle, journal, nextEvent } = harness
          let current = true
          yield* made.finished(unhooked(said, "run-1", (yield* made.power).turns, Effect.sync(() => current)))
          yield* nextEvent("Ready:")
          yield* wait(11)
          yield* then(harness, () => (current = false))
          yield* stop(handle, stopped)
          yield* wait(11)
          yield* wait(11)
          const kept = yield* journal.since(0, { kinds: ["action"] })
          return { played: [...played], through: kept.map(({ detail }) => (detail as { through?: string }).through) }
        }),
      )
    // The same run's Stop, come late with words T3 Code kept otherwise: the thread is still on that run, so the turn was said already.
    expect(await told("The loader is fixed.", "Fixed the loader; the tests pass.", () => Effect.void)).toEqual({
      played: ["yapd. The loader is fixed."],
      through: ["done:Rosie:run-1"],
    })
    // The thread started again in T3 Code, and its next run said the same short thing: that's a new turn, said in its own right.
    expect(
      await told("Done.", "Done.", ({ made, wait }, moved) =>
        Effect.gen(function* () {
          moved()
          yield* made.overtaken({ machine: "Rosie", id: "t-loader" })
          yield* wait(60)
        }),
      ),
    ).toEqual({ played: ["yapd. Done.", "yapd. Done."], through: [] })
    // A prompt came through the hooks since, as when the session is taken up outside T3 Code: what it then said is a new turn too.
    expect(
      await told("The loader is fixed.", "The tests pass now.", ({ handle, wait }) =>
        Effect.gen(function* () {
          yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "native-loader", cwd: "/tmp", prompt: "Now run the tests." }, origin, false)
          yield* wait(60)
        }),
      ),
    ).toEqual({ played: ["yapd. The loader is fixed.", "yapd. The tests pass now."], through: [] })
  })

  test("a turn no hook told of, once heard, takes its run's Stop come late by its own words even once the thread started again, and a newer run that ended on them is said from T3 Code's word", async () => {
    const words = "The loader is fixed and the tests pass."
    type Step = (harness: Effect.Effect.Success<ReturnType<typeof make>>, run2: Notices.Finished) => Effect.Effect<void>
    /** The loader's run-1 said in its hook's place and heard, then the thread on to run-2, with what happens `then` and `after` a Stop ending on the same words. */
    const later = (then: Step, after: Step = () => Effect.void) =>
      run(
        Effect.gen(function* () {
          const harness = yield* make(undefined, { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }) })
          const { made, wait, played, handle, journal, nextEvent } = harness
          let first = true
          const { turns } = yield* made.power
          yield* made.finished(unhooked(words, "run-1", turns, Effect.sync(() => first)))
          yield* nextEvent("Ready:")
          yield* wait(11)
          first = false
          yield* made.overtaken({ machine: "Rosie", id: "t-loader" })
          // T3 Code reads the run before with it, which ended on the same words.
          const run2: Notices.Finished = {
            ...unhooked(words, "run-2", turns),
            run: { status: "completed", final: words, others: [words], natives: ["native-loader"], previous: Option.none(), startedAt: 0 },
          }
          yield* then(harness, run2)
          yield* handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: words }, { project: "yapd", host: hostname() }, false)
          yield* wait(11)
          yield* after(harness, run2)
          yield* wait(11)
          yield* wait(11)
          const kept = yield* journal.since(0, { kinds: ["action"] })
          return { played: [...played], through: kept.map(({ detail }) => (detail as { through?: string }).through) }
        }),
      )
    // Run-1's own Stop, come once the thread had started again: he heard that turn, so it isn't said again.
    expect(await later(() => Effect.void)).toEqual({ played: [`yapd. ${words}`], through: ["done:Rosie:run-1"] })
    // Or run-2's, that ended on the same words: taken for run-1's, it isn't run-2's own, so T3 Code's word that run-2 finished is said.
    expect(await later(() => Effect.void, ({ made }, run2) => made.finished(run2))).toEqual({
      played: [`yapd. ${words}`, `yapd. ${words}`],
      through: ["done:Rosie:run-1"],
    })
    // Run-2's turn, from T3 Code's word, waits to be said when the Stop comes: which run it's of can't be told, so it gives way to the Stop, which is said.
    expect(
      await later(({ made, finish, nextEvent }, run2) =>
        Effect.gen(function* () {
          yield* finish("a", "Something else first.")
          yield* made.finished(run2)
          yield* nextEvent("Ready: yapd. The loader")
        }),
      ),
    ).toEqual({ played: [`yapd. ${words}`, "yapd. Something else first.", `yapd. ${words}`], through: [] })
  })

  test("a turn no hook told of that he didn't hear after all, broken off or put back to be read again, gives way to a Stop of its own, unless he told it to stop", async () => {
    const linked = { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }) }
    /** The loader's turn, said in its hook's place in more words than its Stop's update has, ending the same. */
    const loader = (turns: number) => ({ ...unhooked("The loader is fixed.", "run-1", turns), turn: { prompt: Option.some("Fix the loader."), message: "Looked into it. The loader is fixed." } })
    const fallback = "yapd. Looked into it. The loader is fixed."
    const stop = (handle: Handle) =>
      handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: "The loader is fixed." }, { project: "yapd", host: hostname() }, false)
    /** What was played, what was kept as said through T3 Code's word, and what he missed, once the Stop's had time to be said. */
    const after = (played: ReadonlyArray<string>, journal: Journal.Journal["Type"], wait: (seconds: number) => Effect.Effect<void>) =>
      Effect.gen(function* () {
        yield* wait(11)
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["action"] })
        return { played: [...played], through: kept.map(({ detail }) => (detail as { through?: string }).through), missed: (yield* journal.unheard(0, 60)).map(({ said }) => said) }
      })
    const said = { played: [fallback, "yapd. The loader is fixed."], through: [], missed: [] }
    // Its playback broke off, as when the audio helper quits.
    expect(
      await run(
        Effect.gen(function* () {
          const { made, wait, played, handle, journal, nextEvent } = yield* make(undefined, { ...linked, breaks: { [fallback]: 3 } })
          yield* made.finished(loader((yield* made.power).turns))
          yield* nextEvent("Ready:")
          yield* wait(11)
          yield* stop(handle)
          return yield* after(played, journal, wait)
        }),
      ),
    ).toEqual(said)
    // yapd was turned off and on as it was said.
    expect(
      await run(
        Effect.gen(function* () {
          const { made, wait, played, handle, journal, nextEvent, nextPlayback, toggle } = yield* make(undefined, linked)
          yield* made.finished(loader((yield* made.power).turns))
          yield* nextEvent("Ready:")
          yield* nextPlayback
          yield* toggle(false)
          yield* toggle(true)
          yield* stop(handle)
          return yield* after(played, journal, wait)
        }),
      ),
    ).toEqual(said)
    // A dictation cut it off and put it back, and its Stop came meanwhile: that's said, rather than it again.
    expect(
      await run(
        Effect.gen(function* () {
          const { made, wait, played, handle, journal, nextEvent, nextPlayback, dictate } = yield* make(undefined, linked)
          yield* made.finished(loader((yield* made.power).turns))
          yield* nextEvent("Ready:")
          yield* nextPlayback
          const dictation = yield* dictate
          yield* stop(handle)
          yield* Scope.close(dictation, Exit.void)
          yield* wait(0)
          return yield* after(played, journal, wait)
        }),
      ),
    ).toEqual(said)
    // He told it to stop: he's heard enough of that turn, so its Stop isn't said either.
    expect(
      await run(
        Effect.gen(function* () {
          const { made, wait, played, handle, journal, nextEvent, dictating } = yield* assisted(() => Brain.decision({ act: "answer", spoken: "Asked." }), linked)
          yield* made.finished(loader((yield* made.power).turns))
          yield* nextEvent("Ready:")
          yield* wait(2)
          yield* dictating("Stop.")
          yield* stop(handle)
          return yield* after(played, journal, wait)
        }),
      ),
    ).toEqual({ played: [fallback], through: ["done:Rosie:run-1"], missed: [] })
  })

  test("a turn no hook told of isn't said once its thread is no longer on that run, whether it's found as it's queued or as its turn to be said comes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, played, finish, nextEvent } = yield* make()
        const { turns } = yield* made.power
        let current = true
        yield* finish("a", "Something else first.")
        // Started again just before it was handed on.
        yield* made.finished(unhooked("The loader's old turn.", "run-1", turns, Effect.succeed(false)))
        // Started again while it waits its turn, before T3 Code has said so to what drops it.
        yield* made.finished({ ...unhooked("The loader is fixed.", "run-2", turns, Effect.sync(() => current)), about: { machine: "Rosie", id: "t-other" } })
        yield* nextEvent("Ready: yapd. The loader is fixed.")
        current = false
        yield* wait(11)
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. Something else first."])
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

  test("what he says over a question is heard listening for its options", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, speak, wait, listened } = yield* make("Ghostnet.")
        yield* notice("question", "Which network first? Mainnet or Ghostnet?", { question: [], terms: ["Mainnet", "Ghostnet"] })
        yield* wait(1)
        yield* speak
        yield* wait(11)
        return listened
      }),
    )
    expect(result).toEqual([["Mainnet", "Ghostnet"]])
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

  test.each([
    ["a dictation", "while he's still talking over an update's first seconds"],
    ["a dictation", "while what he said over them is still being worked out"],
    ["turning yapd off", "while he's still talking over an update's first seconds"],
    ["turning yapd off", "while what he said over them is still being worked out"],
  ] as const)("sends and notes nothing he said when %s cuts in %s, once it has stopped for him", async (cut, when) => {
    const result = await run(
      Effect.gen(function* () {
        const stops: Array<string> = []
        // Its own voice can get in for as long as he talks, as before the echo cancellation has learnt it.
        const { finish, microphone, flush, talk, wait, dictate, toggle, followUps, responded, played, journal } = yield* make("Tell it to deploy.", {
          echoing: 60,
          thinking: 5,
          stopping: Effect.sync(() => void stops.push("stopped")).pipe(Effect.as(2)),
        })
        yield* finish("a", "The PR is ready.")
        if (when.startsWith("while he's")) yield* Queue.offerAll(microphone, Array.from({ length: 30 }, () => new Float32Array(512).fill(0.9))).pipe(Effect.zipRight(flush))
        else yield* talk
        const before = { played: [...played], stops: [...stops], responded: [...responded] }
        if (cut === "a dictation") {
          const dictation = yield* dictate
          yield* wait(1)
          yield* Scope.close(dictation, Exit.void)
        } else yield* toggle(false)
        yield* wait(30)
        return { before, followUps: [...followUps], replies: yield* journal.since(0, { kinds: ["reply"] }) }
      }),
    )
    // Stopped at once for him, as anywhere in a line, and what he finished saying taken whole to work out.
    expect(result.before).toEqual({
      played: ["yapd. The PR is ready."],
      stops: ["stopped"],
      responded: when.startsWith("while he's") ? [] : ["Tell it to deploy."],
    })
    expect(result).toMatchObject({ followUps: [], replies: [] })
  })

  test.each([["an answer", "answer"], ["a question", "question"]] as const)("%s said in other words in its place gives the model those words for its own voice getting into the microphone, so it's never what he said", async (_, kind) => {
    const result = await run(
      Effect.gen(function* () {
        // Its own voice gets in, as before the echo cancellation has learnt it, which Whisper hears as the words said in its place.
        const { made, wait, flush, speak, played } = yield* make(undefined, { microphone: true, echoing: 40, transcripts: ["The Tezos one are both running."] })
        const told: Array<string> = []
        const noting = (what: string) => Effect.sync(() => void told.push(what))
        // As the model would, told what yapd was saying around then, which it takes what was heard for.
        const taken = (heard: string, _voiced: number, echo?: string) =>
          noting(`${heard} over ${echo?.includes("the Tezos one are both running") === true ? "its words in its place" : (echo ?? "nothing")}`).pipe(
            Effect.as(echo === undefined ? Option.some(noting(`took: ${heard}`)) : Option.none()),
          )
        yield* Effect.forkScoped(
          made.tell({
            id: "a",
            kind,
            ...(kind === "question" ? { open: "open-a" } : {}),
            priority: "needs-you",
            spoken: "It's on your screen: two threads are running. Which one?",
            at: 0,
            stale: Effect.succeed(false),
            instead: { spoken: "Codex on yapd and the Tezos one are both running their tests now. Which one?", when: Effect.succeed(true) },
            heard: noting("heard"),
            ...(kind === "answer"
              ? { followUp: taken }
              : { question: { answer: taken, unanswered: noting("unanswered"), unsaid: noting("unsaid") } }),
          }),
        )
        yield* flush
        yield* wait(5)
        yield* speak
        yield* wait(5)
        yield* wait(15)
        return { played: [...played], told }
      }),
    )
    // Stopped for its own voice, as the model took it, it picked up again, saying nothing.
    const line = "Codex on yapd and the Tezos one are both running their tests now. Which one?"
    const over = "The Tezos one are both running. over its words in its place"
    expect(result).toEqual({ played: [line, line], told: kind === "answer" ? [over, "heard"] : [over, "heard", "unanswered"] })
  })

  test.each([
    ["no longer than its own voice can go on after it stops, which it may all have been", false],
    ["going on past that, which is surely his", true],
  ] as const)("an update ended over its first seconds by what's said %s is heard and noted only then", async (_, long) => {
    const result = await run(
      Effect.gen(function* () {
        // Its own voice gets in for as long as he talks, as before the echo cancellation has learnt it, and is heard as "Okay.".
        const { finish, speak, talk, wait, journal } = yield* make("Okay.", { echoing: 60, dismiss: true, stopping: Effect.succeed(0) })
        yield* finish("a", "The PR is ready.")
        yield* long ? talk : speak
        yield* wait(5)
        const replies = yield* journal.since(0, { kinds: ["reply"] })
        return { unheard: (yield* journal.unheard(0, 12)).length, replies: replies.map(({ text }) => text) }
      }),
    )
    // Left unheard, it's what he missed; heard, his reply is noted.
    expect(result).toEqual(long ? { unheard: 0, replies: ["Okay."] } : { unheard: 1, replies: [] })
  })

  test.each([["an answer", "answer"], ["a question", "question"]] as const)("%s told over its first seconds tells what he said back that it may be its own voice", async (_, kind) => {
    const result = await run(
      Effect.gen(function* () {
        // Its own voice gets in, as before the echo cancellation has learnt it, and Whisper hears words of his in it.
        const { made, wait, flush, speak } = yield* make(undefined, { microphone: true, echoing: 40, transcripts: ["Stop it now."] })
        const echoes: Array<string> = []
        const taken = (heard: string, _voiced: number, echo?: string) =>
          Effect.sync(() => void echoes.push(`${heard} over ${echo ?? "nothing"}`)).pipe(Effect.as(Option.some(Effect.void)))
        yield* Effect.forkScoped(
          made.tell({
            id: "a",
            kind,
            ...(kind === "question" ? { open: "open-a" } : {}),
            priority: "needs-you",
            spoken: "Stop the yapd thread, sir?",
            at: 0,
            stale: Effect.succeed(false),
            ...(kind === "answer"
              ? { followUp: taken }
              : { question: { answer: taken, unanswered: Effect.void, unsaid: Effect.void } }),
          }),
        )
        yield* flush
        yield* wait(1)
        yield* speak
        yield* wait(20)
        return echoes
      }),
    )
    // What yapd was saying around then, so the handler can tell its own words from his.
    expect(result).toEqual(["Stop it now. over Stop the yapd"])
  })

  test.each([["an answer", "answer"], ["a question", "question"]] as const)("%s told over its first seconds gives its handler what he said after a pause apart, as surely his", async (_, kind) => {
    const result = await run(
      Effect.gen(function* () {
        // Its own voice gets in, as before the echo cancellation has learnt it, and Whisper hears its last word, then his reply.
        const { made, wait, flush, speak } = yield* make(undefined, { microphone: true, echoing: 40, transcripts: ["Site.", "Yapd."] })
        const told: Array<string> = []
        const noting = (what: string) => Effect.sync(() => void told.push(what))
        // As the model would, taking a while: its own word alone is that, but what he said after the pause is his.
        const taken = (heard: string, _voiced: number, echo?: string, afterPause?: string) =>
          noting(`${heard} over ${echo ?? "nothing"}${afterPause === undefined ? "" : `, then ${afterPause}`}`).pipe(
            Effect.zipRight(Effect.sleep("2 seconds")),
            Effect.as(afterPause === undefined ? Option.none() : Option.some(noting(`took: ${afterPause}`))),
          )
        yield* Effect.forkScoped(
          made.tell({
            id: "a",
            kind,
            ...(kind === "question" ? { open: "open-a" } : {}),
            priority: "needs-you",
            spoken: "Which one, sir: yapd or the docs site?",
            at: 0,
            stale: Effect.succeed(false),
            ...(kind === "answer"
              ? { followUp: taken }
              : { question: { answer: taken, unanswered: Effect.void, unsaid: Effect.void } }),
          }),
        )
        yield* flush
        yield* wait(1)
        yield* speak
        // His reply, a second on, while what to make of the first is still being worked out.
        yield* wait(1)
        yield* speak
        yield* wait(20)
        return told
      }),
    )
    expect(result).toEqual(["Site. over Which one, sir: yapd or", "Site. Yapd. over Which one, sir: yapd or, then Yapd.", "took: Yapd."])
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

  test("a question that comes while an answer is listened to after waits for that to be over, and what's said back to the answer is never taken as its answer", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, speak, played, listened } = yield* make(undefined, { microphone: true, transcripts: ["Red.", "Blue."] })
        const followUps: Array<string> = []
        const answers: Array<string> = []
        yield* notice("status", "The loader fix is running its tests, sir.", { answer: true, followUp: followUps })
        yield* wait(5)
        // An agent asks while the answer is being said.
        yield* notice("question", "Which colour should the test use? Red or Blue?", { question: [], answers, terms: ["Red", "Blue"] })
        yield* wait(5)
        // Said to the end, the answer is listened to after, with the question still waiting.
        const lingering = [...played]
        yield* speak
        yield* wait(1)
        const replied = { followUps: [...followUps], answers: [...answers], played: [...played] }
        yield* wait(10)
        yield* speak
        yield* wait(1)
        return { lingering, replied, followUps, answers, listened: [...listened] }
      }),
    )
    expect(result.lingering).toEqual(["The loader fix is running its tests, sir."])
    // Said back to the answer, it's a follow-up, and only then is the question asked.
    expect(result.replied).toEqual({
      followUps: ["status: Red."],
      answers: [],
      played: ["The loader fix is running its tests, sir.", "Which colour should the test use? Red or Blue?"],
    })
    // Only what's said back to the question once it's asked answers it.
    expect(result.followUps).toEqual(["status: Red."])
    expect(result.answers).toEqual(["question: Blue."])
    // Heard listening for the question's options only when it's the question's answer.
    expect(result.listened).toEqual([undefined, ["Red", "Blue"]])
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

  test("thanks after the last of three steps asked over a catch-up answer, each worked out late, still leaves what he missed to be told", async () => {
    const asked = "What's it waiting on, then the tests, then the docs?"
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, dictating, speak, played } = yield* assisted(
          (situation) => {
            const { heard, via } = situation.utterance
            if (via === "reply" && heard === asked) return Brain.decision({ act: "answer", spoken: "A review, sir.", rest: "the tests, then the docs" })
            if (via === "reply" && heard === "the tests, then the docs") return Brain.decision({ act: "answer", spoken: "They pass, sir.", rest: "the docs" })
            if (via === "reply") return Brain.decision({ act: "answer", spoken: "They're done, sir." })
            const told = situation.unheard.map(({ said }) => said).join(" ")
            return Brain.decision({ act: "answer", how: "missed", spoken: told === "" ? "Nothing else." : `You missed this: ${told}` })
          },
          { microphone: true, transcripts: [asked, "Thanks."] },
          [],
          // The later steps take longer than a request waits for them, so each is said on its own once it's worked out.
          (situation) => (situation.utterance.heard.startsWith("the ") ? Effect.sleep("3 seconds") : Effect.void),
        )
        yield* finish("a", "The loader fix is ready.")
        yield* wait(2)
        yield* toggle(false)
        yield* toggle(true)
        yield* dictating("What did I miss?")
        yield* wait(3)
        yield* speak
        yield* wait(7)
        // Thanks over the last step's line, which cuts it off.
        yield* speak
        for (let i = 0; i < 3; i++) yield* wait(11)
        const told = played.length
        yield* dictating("What did I miss?")
        for (let i = 0; i < 3; i++) yield* wait(11)
        return { played: played.slice(0, told), again: played.slice(told) }
      }),
    )
    expect(result.played).toEqual([
      "yapd. The loader fix is ready.",
      "You missed this: yapd. The loader fix is ready.",
      "A review, sir.",
      "They pass, sir.",
      "They're done, sir.",
    ])
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

describe("Daemon with threads muted", () => {
  test("a muted thread's progress is kept quiet: kept for what he missed, its hook let go at once, and never rendered or said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, nextEvent, wait, played, renders, followUps, journal } = yield* make(undefined, { mutes })
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* finish("noisy", "Still going.", true)
        yield* nextEvent("Muted update for yapd")
        yield* finish("quiet", "The fix is in.")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], renders: renders(), followUps: [...followUps], kept: updates.map((kept) => [kept.said, quieted(kept)]) }
      }),
    )
    expect(result.played).toEqual(["yapd. The fix is in."])
    expect(result.renders).toBe(1)
    expect(result.followUps).toEqual(["claude:noisy let go"])
    expect(result.kept).toEqual([
      ["yapd. Still going.", true],
      ["yapd. The fix is in.", false],
    ])
  })

  test("what needs him is said whatever he muted: what the summary finds does, and what its hook says does", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, turn, wait, played, journal } = yield* make(undefined, { mutes, urgentMessages: ["The tests failed."] })
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* finish("noisy", "The tests failed.")
        yield* wait(11)
        yield* turn("noisy", "Which network first?", 120, { needsYou: true })
        yield* wait(11)
        yield* finish("noisy", "Still going.")
        yield* wait(11)
        return { played: [...played], quiet: (yield* journal.since(0, { kinds: ["update"] })).filter(quieted).map(({ said }) => said) }
      }),
    )
    expect(result.played).toEqual(["yapd. The tests failed.", "yapd. Which network first?"])
    expect(result.quiet).toEqual(["yapd. Still going."])
  })

  test("the answer to a follow-up he sent the thread is said, though he muted it since", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, speak, wait, nextEvent, nextPlayback, played, followUps } = yield* make("Use the fee table.", { mutes, send: () => Effect.void })
        yield* finish("tezos", "The migration compiles.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        // Muted once he'd asked it, its answer is still his to hear, though what comes after it isn't.
        yield* mutes.mute({ key: sessionKey("tezos") })
        yield* finish("tezos", "The fee table is in.")
        yield* wait(11)
        yield* finish("tezos", "Still going.")
        yield* wait(11)
        return { played: [...played], followUps: [...followUps] }
      }),
    )
    expect(result.followUps).toEqual(["tezos sent: Use the fee table."])
    expect(result.played).toEqual(["yapd. The migration compiles.", "Okay, passed on.", "yapd. The fee table is in."])
  })

  test("the answer to what he sent a linked thread by the shortcut is said, though it's muted, but not the turns he didn't ask for", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const asked = "Also run the integration tests."
        // Sent through T3 Code a moment before its prompt came, and much earlier in the words a later turn began with, as when it waited in the queue.
        const ledger: Array<{ readonly at: number; readonly digest: string | null }> = []
        const { handle, wait, nextEvent, played, followUps } = yield* make(undefined, {
          mutes,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          sent: (to, since) => Effect.succeed(to.machine === "Rosie" && to.id === "t-tezos" ? ledger.filter(({ at }) => at >= since) : []),
        })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-tezos" }), called: "the Tezos migration" })
        const turn = (prompt: string, message: string) =>
          Effect.gen(function* () {
            yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt }, { project: "yapd", host: hostname() }, false)
            yield* wait(120)
            yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: message }, { project: "yapd", host: hostname() }, true)
          })
        yield* wait(600)
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest(asked) })
        yield* wait(2)
        yield* turn(asked, "Integration tests pass.")
        yield* nextEvent("Ready: yapd. Integration tests pass.")
        yield* wait(11)
        yield* turn("Go on.", "Still going.")
        yield* nextEvent("Muted update for yapd")
        // Queued behind other work for ten minutes, it began the turn in its own words.
        const queued = "Then bump the fee table."
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest(queued) })
        yield* wait(600)
        yield* turn(queued, "The fee table is bumped.")
        yield* nextEvent("Ready: yapd. The fee table is bumped.")
        yield* wait(11)
        return { played: [...played], followUps: [...followUps] }
      }),
    )
    expect(result.played).toEqual(["yapd. Integration tests pass.", "yapd. The fee table is bumped."])
    // Nothing went to the agent: the muted turn's hook was let go of without a reply.
    expect(result.followUps).toEqual(["claude:s-tezos let go"])
  })

  test("a muted thread's turn under way when yapd queued his message behind it isn't his, but one it was steered into is", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const ledger: Array<{ readonly at: number; readonly digest: string | null; readonly how: Ledger.How }> = []
        const { handle, wait, nextEvent, played } = yield* make(undefined, {
          mutes,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          sent: (_, since) => Effect.succeed(ledger.filter(({ at }) => at >= since)),
        })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-tezos" }), called: "the Tezos migration" })
        const prompt = (text: string) => handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt: text }, { project: "yapd", host: hostname() }, false)
        const stop = (message: string) => handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: message }, { project: "yapd", host: hostname() }, false)
        yield* wait(600)
        yield* prompt("Migrate the fee module.")
        yield* wait(180)
        // Three minutes in, he has yapd send it more, which T3 Code queues behind the turn.
        const queued = "Then bump the fee table."
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest(queued), how: "queued" })
        yield* wait(120)
        yield* stop("The fee module is migrated.")
        yield* nextEvent("Muted update for yapd")
        // Its own turn, begun in its words, is his.
        yield* prompt(queued)
        yield* wait(60)
        yield* stop("The fee table is bumped.")
        yield* nextEvent("Ready: yapd. The fee table is bumped.")
        yield* wait(11)
        // Steered into the turn under way, that turn answers it.
        yield* prompt("Run the integration tests.")
        yield* wait(60)
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest("Skip the slow ones."), how: "steered" })
        yield* wait(60)
        yield* stop("The fast tests pass.")
        yield* nextEvent("Ready: yapd. The fast tests pass.")
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The fee table is bumped.", "yapd. The fast tests pass."])
  })

  test("a muted thread's turn he steered a message into is said from T3 Code's word, so its Stop coming late isn't dropped, nor said twice", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const ledger: Array<{ readonly at: number; readonly digest: string | null; readonly how: Ledger.How }> = []
        const { made, handle, wait, nextEvent, played } = yield* make(undefined, {
          mutes,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          sent: (_, since) => Effect.succeed(ledger.filter(({ at }) => at >= since)),
        })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-tezos" }), called: "the Tezos migration" })
        yield* wait(600)
        const started = yield* Clock.currentTimeMillis
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt: "Run the integration tests." }, { project: "yapd", host: hostname() }, false)
        yield* wait(60)
        // A minute in, yapd steers what he said into the turn under way.
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest("Skip the slow ones."), how: "steered" })
        yield* wait(60)
        // T3 Code's word that it finished comes first, then its Stop half a minute late.
        const ended = yield* Clock.currentTimeMillis
        yield* made.finished({
          ...unhooked("The fast tests pass.", "run-1", (yield* made.power).turns),
          about: { machine: "Rosie", id: "t-tezos" },
          turn: { prompt: Option.some("Run the integration tests."), message: "The fast tests pass." },
          at: ended,
          run: { status: "completed", final: "The fast tests pass.", others: [], natives: ["s-tezos"], previous: Option.none(), startedAt: started },
        })
        yield* nextEvent("Ready: yapd. The fast tests pass.")
        yield* wait(30)
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The fast tests pass." }, { project: "yapd", host: hostname() }, false)
        for (let i = 0; i < 2; i++) yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The fast tests pass."])
  })

  test("a muted thread's Stop coming late answers a message he steered into its turn, though T3 Code's word, which couldn't tell, was kept quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const ledger: Array<{ readonly at: number; readonly digest: string | null; readonly how: Ledger.How }> = []
        const { made, handle, wait, nextEvent, played, journal } = yield* make(undefined, {
          mutes,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          sent: (_, since) => Effect.succeed(ledger.filter(({ at }) => at >= since)),
        })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-tezos" }), called: "the Tezos migration" })
        yield* wait(600)
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt: "Run the integration tests." }, { project: "yapd", host: hostname() }, false)
        yield* wait(30)
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest("Skip the slow ones."), how: "steered" })
        yield* wait(90)
        // T3 Code didn't say when the run started, so its word is taken as starting as it ended, after what he steered into it.
        const ended = yield* Clock.currentTimeMillis
        yield* made.finished({
          ...unhooked("The fast tests pass.", "run-1", (yield* made.power).turns),
          about: { machine: "Rosie", id: "t-tezos" },
          turn: { prompt: Option.some("Run the integration tests."), message: "The fast tests pass." },
          at: ended,
          run: { status: "completed", final: "The fast tests pass.", others: [], natives: ["s-tezos"], previous: Option.none(), startedAt: ended },
        })
        yield* nextEvent("Muted update for yapd")
        yield* wait(30)
        // Its Stop has the prompt it began with, which tells.
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The fast tests pass." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready: yapd. The fast tests pass.")
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { played: [...played], missed: (yield* journal.unheard(0, 10)).length }
      }),
    )
    expect(result.played).toEqual(["yapd. The fast tests pass."])
    // Told of now, the turn kept quiet isn't what he missed too.
    expect(result.missed).toBe(0)
  })

  test("a muted thread with no hooks says the turn he steered a message into, and the one his queued message began, but not the turn it waited behind", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const ledger: Array<{ readonly at: number; readonly digest: string | null; readonly how: Ledger.How }> = []
        const { made, wait, nextEvent, played } = yield* make(undefined, {
          mutes,
          sent: (_, since) => Effect.succeed(ledger.filter(({ at }) => at >= since)),
        })
        const about = { machine: "Rosie", id: "t-loader" }
        yield* mutes.mute({ key: Mutes.key.thread(about) })
        const { turns } = yield* made.power
        /** A run of an agent yapd has no hooks for, which T3 Code tells of as it ends. */
        const ran = (runId: string, prompt: string, message: string, startedAt: number) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            yield* made.finished({
              ...unhooked(message, runId, turns),
              turn: { prompt: Option.some(prompt), message },
              at,
              run: { status: "completed", final: message, others: [], natives: [], previous: Option.none(), startedAt },
            })
          })
        yield* wait(600)
        // Steered into the turn under way.
        const first = yield* Clock.currentTimeMillis
        yield* wait(60)
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest("Skip the slow ones."), how: "steered" })
        yield* wait(60)
        yield* ran("run-1", "Run the integration tests.", "The fast tests pass.", first)
        yield* nextEvent("Ready: yapd. The fast tests pass.")
        yield* wait(11)
        // Queued behind the next turn, which isn't his, and then the turn it began.
        const second = yield* Clock.currentTimeMillis
        yield* wait(60)
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest("Then bump the fee table."), how: "queued" })
        yield* wait(60)
        yield* ran("run-2", "Migrate the fee module.", "The fee module is migrated.", second)
        yield* nextEvent("Muted update for yapd")
        const third = yield* Clock.currentTimeMillis
        yield* wait(60)
        yield* ran("run-3", "Then bump the fee table.", "The fee table is bumped.", third)
        yield* nextEvent("Ready: yapd. The fee table is bumped.")
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The fast tests pass.", "yapd. The fee table is bumped."])
  })

  test("a muted thread's turn no hook told of that answers what he said by voice back through one of its sessions' hooks is said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, speak, wait, nextEvent, nextPlayback, played, followUps } = yield* make("Use the fee table.", { mutes, send: () => Effect.void })
        yield* finish("tezos", "The migration compiles.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        // T3 Code's word of the turn that answers it, as its Stop never came.
        const startedAt = yield* Clock.currentTimeMillis
        yield* wait(60)
        yield* made.finished({
          ...unhooked("The fee table is in.", "run-1", (yield* made.power).turns),
          at: yield* Clock.currentTimeMillis,
          run: { status: "completed", final: "The fee table is in.", others: [], natives: ["tezos"], previous: Option.none(), startedAt },
        })
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { played: [...played], followUps: [...followUps] }
      }),
    )
    expect(result.followUps).toEqual(["tezos sent: Use the fee table."])
    expect(result.played).toEqual(["yapd. The migration compiles.", "Okay, passed on.", "yapd. The fee table is in."])
  })

  test("what he said by voice back through a session's hook, answered by T3 Code's word with no Stop, doesn't make a later run of the muted thread his", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, speak, wait, nextEvent, nextPlayback, played, followUps } = yield* make("Use the fee table.", { mutes, send: () => Effect.void })
        yield* finish("tezos", "The migration compiles.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        const { turns } = yield* made.power
        // T3 Code's word of the turn that answers it, as its Stop never came.
        const first = yield* Clock.currentTimeMillis
        yield* wait(60)
        yield* made.finished({
          ...unhooked("The fee table is in.", "run-1", turns),
          at: yield* Clock.currentTimeMillis,
          run: { status: "completed", final: "The fee table is in.", others: [], natives: ["tezos"], previous: Option.none(), startedAt: first },
        })
        yield* nextEvent("Ready: yapd. The fee table is in.")
        for (let i = 0; i < 2; i++) yield* wait(11)
        // Ten minutes on, a run he typed in T3 Code himself, again with no Stop.
        yield* wait(600)
        const second = yield* Clock.currentTimeMillis
        yield* wait(60)
        yield* made.finished({
          ...unhooked("The loader is refactored.", "run-2", turns),
          at: yield* Clock.currentTimeMillis,
          run: { status: "completed", final: "The loader is refactored.", others: [], natives: ["tezos"], previous: Option.none(), startedAt: second },
        })
        yield* nextEvent("Muted update for yapd")
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { played: [...played], followUps: [...followUps] }
      }),
    )
    expect(result.followUps).toEqual(["tezos sent: Use the fee table."])
    expect(result.played).toEqual(["yapd. The migration compiles.", "Okay, passed on.", "yapd. The fee table is in."])
  })

  test("what he said by voice back through one session's hook doesn't make a muted thread's run of other sessions his", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, speak, wait, nextEvent, nextPlayback, played, followUps } = yield* make("Use the fee table.", { mutes, send: () => Effect.void })
        yield* finish("tezos", "The migration compiles.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        // While that waits on its answer, the loader's own run, in a session of its own, finishes.
        const startedAt = yield* Clock.currentTimeMillis
        yield* wait(60)
        yield* made.finished({
          ...unhooked("The loader is refactored.", "run-1", (yield* made.power).turns),
          at: yield* Clock.currentTimeMillis,
          run: { status: "completed", final: "The loader is refactored.", others: [], natives: ["native-loader"], previous: Option.none(), startedAt },
        })
        yield* nextEvent("Muted update for yapd")
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { played: [...played], followUps: [...followUps] }
      }),
    )
    expect(result.followUps).toEqual(["tezos sent: Use the fee table."])
    expect(result.played).toEqual(["yapd. The migration compiles.", "Okay, passed on."])
  })

  test("a turn that couldn't be summed up is said on a muted thread, since it may be a question or a failure", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, wait, played, journal } = yield* make(undefined, { mutes, unsummarizable: ["Should I drop the old table too?"] })
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* finish("noisy", "Should I drop the old table too?")
        yield* wait(11)
        yield* finish("noisy", "Still going.")
        yield* wait(11)
        return { played: [...played], quiet: (yield* journal.since(0, { kinds: ["update"] })).filter(quieted).map(({ said }) => said) }
      }),
    )
    expect(result.played).toEqual(["yapd finished a turn, but I couldn't summarize it."])
    expect(result.quiet).toEqual(["yapd. Still going."])
  })

  test("a turn that couldn't be summed up, waiting to be said as its thread is muted, is still said, and so is the one a dictation cut off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const unsure = ["Should I drop the old table?", "Should I drop the new table?"]
        const { made, finish, wait, dictate, played, followUps, journal } = yield* make(undefined, { mutes, unsummarizable: unsure })
        // Waiting behind the line being said as he mutes its thread.
        yield* finish("playing", "Something long.")
        yield* finish("waiting", unsure[0]!, true)
        yield* Option.getOrThrow(made.controls).mute({ key: sessionKey("waiting") })
        for (let i = 0; i < 3; i++) yield* wait(11)
        // Cut off by a dictation, muted meanwhile, then put back.
        yield* finish("cut", unsure[1]!)
        yield* wait(1)
        const dictation = yield* dictate
        yield* Option.getOrThrow(made.controls).mute({ key: sessionKey("cut") })
        yield* wait(2)
        yield* Scope.close(dictation, Exit.void)
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { played: [...played], followUps: [...followUps], quiet: (yield* journal.since(0, { kinds: ["update"] })).filter(quieted).length }
      }),
    )
    const unsure = "yapd finished a turn, but I couldn't summarize it."
    expect(result.played).toEqual(["yapd. Something long.", unsure, unsure, unsure])
    // Its hook waits on for what he says to it, as for any update.
    expect(result.followUps).toEqual([])
    expect(result.quiet).toBe(0)
  })

  test("a failure left to the Stop that told of it is said after all once what that Stop told of is kept quiet, but not once he heard it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, wait, nextEvent, played } = yield* make(undefined, { mutes })
        const told: Array<string> = []
        const failed = (session: string) =>
          Effect.flatMap(made.stopped([session]), (stops) => made.unheard(stops, Effect.sync(() => void told.push(session))))
        // Kept quiet already, as its thread was muted.
        yield* mutes.mute({ key: sessionKey("muted") })
        yield* finish("muted", "The provider had an error, so I stopped.")
        yield* nextEvent("Muted update for yapd")
        yield* failed("muted")
        // Waiting to be said behind another line, then dropped as he mutes its thread.
        yield* finish("playing", "Something long.")
        yield* finish("waiting", "The provider failed, so I stopped.")
        yield* failed("waiting")
        const before = [...told]
        yield* Option.getOrThrow(made.controls).mute({ key: sessionKey("waiting") })
        yield* wait(11)
        // Said, so he heard what it told of.
        yield* finish("heard", "The model is down, so I stopped.")
        yield* failed("heard")
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { before, told, played: [...played] }
      }),
    )
    expect(result.before).toEqual(["muted"])
    expect(result.told).toEqual(["muted", "waiting"])
    expect(result.played).toEqual(["yapd. Something long.", "yapd. The model is down, so I stopped."])
  })

  test("a muted thread's Stop coming late with the answer to what he said over its update is said, though its turn was kept quiet in its hook's place", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, handle, speak, wait, nextEvent, nextPlayback, played, followUps } = yield* make("Use the fee table.", { mutes, send: () => Effect.void })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        yield* finish("tezos", "The migration compiles.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* wait(2)
        // T3 Code's word of a turn of the same session, kept quiet before he says anything.
        const startedAt = yield* Clock.currentTimeMillis
        const message = "The fee table is in, with its tests."
        yield* made.finished({
          ...unhooked(message, "run-1", (yield* made.power).turns),
          at: startedAt,
          run: { status: "completed", final: message, others: [], natives: ["tezos"], previous: Option.none(), startedAt },
        })
        yield* nextEvent("Muted update for yapd")
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        // Its Stop, late, comes with the answer to what he said over the update.
        yield* handle("claude", { hook_event_name: "Stop", session_id: "tezos", cwd: "/tmp", last_assistant_message: message }, { project: "yapd" }, false)
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { played: [...played], followUps: [...followUps] }
      }),
    )
    expect(result.followUps).toEqual(["tezos sent: Use the fee table."])
    expect(result.played).toEqual(["yapd. The migration compiles.", "Okay, passed on.", "yapd. The fee table is in, with its tests."])
  })

  test("the answer to what he sent a muted thread, waiting behind another line, isn't dropped as he mutes it from the menu, nor once a dictation cuts it off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const ledger: Array<{ readonly at: number; readonly digest: string | null; readonly how: Ledger.How }> = []
        const { made, handle, finish, wait, dictate, nextEvent, played } = yield* make(undefined, {
          mutes,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          sent: (_, since) => Effect.succeed(ledger.filter(({ at }) => at >= since)),
        })
        yield* wait(600)
        // Sent by the shortcut a moment before its prompt came.
        ledger.push({ at: yield* Clock.currentTimeMillis, digest: Ledger.digest("Run the integration tests."), how: "now" })
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt: "Run the integration tests." }, { project: "yapd", host: hostname() }, false)
        yield* wait(120)
        yield* finish("playing", "Something long.")
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The fast tests pass." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready: yapd. The fast tests pass.")
        yield* Option.getOrThrow(made.controls).mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-tezos" }) })
        yield* wait(11)
        // Cut off as it's said, it's put back and read again.
        const dictation = yield* dictate
        yield* wait(2)
        yield* Scope.close(dictation, Exit.void)
        for (let i = 0; i < 2; i++) yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. Something long.", "yapd. The fast tests pass.", "yapd. The fast tests pass."])
  })

  test("a failure left to a muted thread's Stop is said once a dictation cuts off what that Stop told of, muted from the menu as it was said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, wait, dictate, nextEvent, played, journal } = yield* make(undefined, { mutes })
        const told: Array<string> = []
        yield* finish("x", "The provider failed, so I stopped.")
        yield* nextEvent("Ready:")
        yield* wait(1)
        yield* made.unheard(yield* made.stopped(["x"]), Effect.sync(() => void told.push("x")))
        // The line being said isn't dropped as he mutes its thread.
        yield* Option.getOrThrow(made.controls).mute({ key: sessionKey("x") })
        const before = [...told]
        const dictation = yield* dictate
        yield* wait(2)
        yield* Scope.close(dictation, Exit.void)
        for (let i = 0; i < 2; i++) yield* wait(11)
        return { before, told, played: [...played], quiet: (yield* journal.since(0, { kinds: ["update"] })).filter(quieted).length }
      }),
    )
    expect(result.before).toEqual([])
    expect(result.told).toEqual(["x"])
    expect(result.played).toEqual(["yapd. The provider failed, so I stopped."])
    expect(result.quiet).toBe(1)
  })

  test("a failure left to two Stops waits until what both told of is kept quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, wait, nextEvent } = yield* make(undefined, { mutes })
        const told: Array<string> = []
        // The first kept quiet as its thread was muted then.
        yield* mutes.mute({ key: sessionKey("x") })
        yield* finish("x", "Step one is done.")
        yield* nextEvent("Muted update for yapd")
        yield* mutes.unmute(sessionKey("x"))
        // The second waits behind the line being said.
        yield* finish("playing", "Something long.")
        yield* finish("x", "The provider failed, so I stopped.")
        yield* nextEvent("Ready: yapd. The provider")
        const stops = yield* made.stopped(["x"])
        yield* made.unheard(stops, Effect.sync(() => void told.push("x")))
        const before = [...told]
        yield* Option.getOrThrow(made.controls).mute({ key: sessionKey("x") })
        yield* wait(11)
        return { stops: stops.length, before, told }
      }),
    )
    expect(result.stops).toBe(2)
    expect(result.before).toEqual([])
    expect(result.told).toEqual(["x"])
  })

  test("while yapd is off, a muted update isn't kept at all, as one it would have said isn't", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, toggle, wait, journal, followUps } = yield* make(undefined, { mutes })
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* toggle(false)
        yield* finish("noisy", "Still going.", true)
        yield* wait(11)
        return { kept: yield* journal.since(0, { kinds: ["update"] }), followUps: [...followUps] }
      }),
    )
    expect(result.kept).toEqual([])
    expect(result.followUps).toEqual([])
  })

  test("a muted turn no hook told of is kept quiet once, under its key, as heard, so its own Stop coming late isn't said, nor the turn once he unmutes it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, handle, wait, played, journal, nextEvent } = yield* make(undefined, { mutes, link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }) })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Muted update for yapd")
        yield* handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: "The loader is fixed." }, { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        yield* mutes.unmute(Mutes.key.thread({ machine: "Rosie", id: "t-loader" }))
        // T3 Code tells of it again, as after a reconnect.
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["update", "action"] })
        return { played: [...played], kept: kept.map((entry) => [entry.kind, entry.key ?? (entry.detail as { through?: string }).through, quieted(entry)]) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.kept).toEqual([
      ["update", "done:Rosie:run-1", true],
      ["action", "done:Rosie:run-1", false],
    ])
  })

  test("a turn no hook told of, dropped as it waited once its thread was muted, is the turn's, so its own Stop coming late isn't said, even untied", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, handle, wait, played, nextEvent } = yield* make(undefined, { mutes })
        const { turns } = yield* made.power
        yield* finish("playing", "Something long.")
        yield* made.finished(unhooked("The loader is fixed.", "run-1", turns))
        yield* nextEvent("Ready: yapd. The loader")
        yield* Option.getOrThrow(made.controls).mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        // Its own Stop, which can't be tied to its thread.
        yield* handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: "The loader is fixed." }, { project: "yapd", host: hostname() }, false)
        for (let index = 0; index < 3; index++) yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. Something long."])
  })

  test.each([
    ["its hook says it needs him", "Which network first?", { needs_you: true }],
    ["the summary finds it needs him", "The tests failed.", {}],
    ["it couldn't be summed up", "Should I drop the old table?", {}],
  ])("a turn no hook told of, kept quiet as its thread is muted, still lets its own Stop through when %s", async (_, message, extra) => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, handle, wait, played, nextEvent, journal } = yield* make(undefined, {
          mutes,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }),
          urgentMessages: ["The tests failed."],
          unsummarizable: ["Should I drop the old table?"],
        })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        yield* made.finished(unhooked(message === "Which network first?" ? message : "The loader is halfway.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Muted update for yapd")
        // Its own Stop, late, with what T3 Code didn't know.
        yield* handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: message, ...extra }, { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["update", "action"] })
        return { played: [...played], kept: kept.map((entry) => [entry.kind, quieted(entry)]), missed: (yield* journal.unheard(0, 10)).length }
      }),
    )
    expect(result.played).toEqual([message === "Should I drop the old table?" ? "yapd finished a turn, but I couldn't summarize it." : `yapd. ${message}`])
    expect(result.kept).toEqual([
      ["update", true],
      ["update", false],
    ])
    // Told of now, the turn kept quiet isn't what he missed too.
    expect(result.missed).toBe(0)
  })

  test("a turn no hook told of, dropped as it waited once its thread was muted, still lets its own Stop through when its hook says it needs him", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, handle, wait, played, nextEvent } = yield* make(undefined, { mutes })
        yield* finish("playing", "Something long.")
        yield* made.finished(unhooked("Which network first?", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready: yapd. Which network")
        yield* Option.getOrThrow(made.controls).mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        yield* handle(
          "claude",
          { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: "Which network first?", needs_you: true },
          { project: "yapd", host: hostname() },
          false,
        )
        for (let index = 0; index < 3; index++) yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. Something long.", "yapd. Which network first?"])
  })

  test("a turn no hook told of, cut off by a dictation once its thread was muted, still lets its own Stop through when its hook says it needs him", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, handle, wait, dictate, played, nextEvent } = yield* make(undefined, { mutes })
        yield* made.finished(unhooked("The loader is halfway.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready: yapd. The loader")
        yield* wait(1)
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        const dictation = yield* dictate
        yield* wait(2)
        yield* Scope.close(dictation, Exit.void)
        yield* wait(11)
        yield* handle(
          "claude",
          { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: "Which network first?", needs_you: true },
          { project: "yapd", host: hostname() },
          false,
        )
        for (let index = 0; index < 2; index++) yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The loader is halfway.", "yapd. Which network first?"])
  })

  test("a turn no hook told of that a message of yapd's started is said, though he muted its thread", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, wait, played } = yield* make(undefined, { mutes })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        const turns = (yield* made.power).turns
        yield* made.finished({ ...unhooked("The loader is fixed.", "run-1", turns), answering: true })
        yield* wait(11)
        yield* made.finished({ ...unhooked("Still going.", "run-2", turns), about: { machine: "Rosie", id: "t-loader" } })
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The loader is fixed."])
  })

  test("a session's mute, once its update is tied to a thread, mutes it and becomes the thread's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { handle, nextEvent, played, journal } = yield* make(undefined, { mutes, link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }) })
        yield* mutes.mute({ key: sessionKey("s-tezos"), called: "the Claude session in yapd" })
        yield* stopHere(handle, "s-tezos", "The migration compiles.")
        yield* nextEvent("Muted update for yapd")
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], mutes: yield* mutes.list, kept: kept.map(({ machine, thread, detail }) => ({ machine, thread, detail })) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.mutes).toEqual([{ key: "t3:Rosie:t-tezos", called: "the Claude session in yapd", at: 0 }])
    expect(result.kept).toEqual([{ machine: "Rosie", thread: "t-tezos", detail: { priority: "done", session: "claude:s-tezos", muted: true, host: hostname() } }])
  })

  test("rig's hook, found in rig's T3 Code, is kept under its thread there and muted by it, while what he says over it still goes the hook's way", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const asked: Array<string> = []
        const { handle, speak, wait, nextEvent, nextPlayback, played, followUps, journal } = yield* make("Use the fee table.", {
          mutes,
          send: () => Effect.void,
          // Nothing here has it, and rig's T3 Code knows it as the Mina thread.
          link: () => Effect.die("not asked for rig's hooks"),
          owner: (host, session) => Effect.sync(() => void asked.push(`${host} ${session}`)).pipe(Effect.as(Option.some({ machine: "rig", id: "t-mina" }))),
        })
        const stop = (message: string) =>
          handle("claude", { hook_event_name: "Stop", session_id: "s-mina", cwd: "/home/laurent/code/integration", last_assistant_message: message }, { project: "integration", host: "rig.local" }, false)
        yield* stop("The SSV2 tickets are open.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        // Muted by the menu, by its thread on rig: the answer to what he said over it is still said, but not what comes after.
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "rig", id: "t-mina" }) })
        yield* stop("The fee table is in.")
        yield* nextEvent("Ready: integration. The fee table")
        yield* wait(11)
        yield* stop("Still going.")
        yield* nextEvent("Muted update for integration")
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return {
          asked,
          played: [...played],
          followUps: [...followUps],
          kept: kept.map((entry) => [entry.machine, entry.thread, (entry.detail as { session?: string }).session, quieted(entry)]),
        }
      }),
    )
    expect(result.asked).toEqual(["rig.local s-mina", "rig.local s-mina", "rig.local s-mina"])
    expect(result.played).toEqual(["integration. The SSV2 tickets are open.", "Okay, passed on.", "integration. The fee table is in."])
    // The hook's way, never through T3 Code.
    expect(result.followUps).toEqual(["s-mina sent: Use the fee table."])
    expect(result.kept).toEqual([
      ["rig", "t-mina", "claude:s-mina", false],
      ["rig", "t-mina", "claude:s-mina", false],
      ["rig", "t-mina", "claude:s-mina", true],
    ])
  })

  test("a mute that lands while an update is being rendered still keeps it quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, wait, played, followUps, journal } = yield* make(undefined, { mutes, renderSeconds: 2 })
        yield* finish("noisy", "Still going.", true)
        yield* wait(1)
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* wait(1)
        yield* wait(11)
        return { played: [...played], followUps: [...followUps], kept: (yield* journal.since(0, { kinds: ["update"] })).map(quieted) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.followUps).toEqual(["claude:noisy let go"])
    expect(result.kept).toEqual([true])
  })

  test("a mute that lands while what needs him is being rendered never keeps it quiet: what its hook or its summary says needs him, nor what couldn't be summed up", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { handle, finish, wait, played, followUps, journal } = yield* make(undefined, {
          mutes,
          renderSeconds: 2,
          urgentMessages: ["The tests failed."],
          unsummarizable: ["Should I drop the old table?"],
        })
        yield* finish("urgent", "The tests failed.", true)
        yield* finish("unsure", "Should I drop the old table?", true)
        yield* handle("claude", { hook_event_name: "Stop", session_id: "asks", cwd: "/tmp", last_assistant_message: "Which network first?", needs_you: true }, { project: "yapd" }, true)
        yield* wait(1)
        for (const session of ["urgent", "unsure", "asks"]) yield* mutes.mute({ key: sessionKey(session) })
        yield* wait(1)
        for (let i = 0; i < 4; i++) yield* wait(11)
        return { played: [...played].toSorted(), followUps: [...followUps], quiet: (yield* journal.since(0, { kinds: ["update"] })).filter(quieted).length }
      }),
    )
    expect(result.played).toEqual(["yapd finished a turn, but I couldn't summarize it.", "yapd. The tests failed.", "yapd. Which network first?"])
    expect(result.followUps).toEqual([])
    expect(result.quiet).toBe(0)
  })

  test("muting drops the thread's updates waiting to be said and lets their hooks go, but never what needs him, what he asked to hear again, a notice, or the line being said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, notice, wait, played, followUps, journal, heard, replay } = yield* make(undefined, { mutes, urgentMessages: ["The tests failed."] })
        // Heard once, to hear again later.
        yield* finish("noisy", "Earlier news.", true)
        yield* wait(11)
        const [earlier] = yield* heard
        // The line being said, then what waits behind it.
        yield* finish("playing", "Something long.")
        yield* finish("noisy", "Still going.", true)
        yield* finish("other", "The Mina tickets are open.")
        yield* finish("urgent", "The tests failed.")
        yield* notice("t3:Rosie:t-noisy", "The noisy thread wants your go-ahead.")
        yield* replay(earlier!)
        yield* wait(0)
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* mutes.mute({ key: sessionKey("urgent") })
        yield* made.silence([sessionKey("noisy"), sessionKey("urgent")])
        for (let i = 0; i < 6; i++) yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], followUps: [...followUps], kept: updates.map((kept) => [kept.said, quieted(kept)]) }
      }),
    )
    expect(result.played).toEqual([
      "yapd. Earlier news.",
      "yapd. Something long.",
      "yapd. The tests failed.",
      "yapd. Earlier news.",
      "The noisy thread wants your go-ahead.",
      "yapd. The Mina tickets are open.",
    ])
    // The hook of the one he heard waits on, for a reply to it heard again; the one dropped is let go.
    expect(result.followUps).toEqual(["claude:noisy let go"])
    expect(result.kept).toEqual([
      ["yapd. Earlier news.", false],
      ["yapd. Something long.", false],
      ["yapd. Still going.", true],
      ["yapd. The Mina tickets are open.", false],
      ["yapd. The tests failed.", false],
    ])
  })

  test("an update a dictation cut off isn't read again once its thread is muted, before or while he dictates", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, wait, dictate, played, journal } = yield* make(undefined, { mutes })
        // Muted as it's said, by the menu, before he starts to dictate.
        yield* finish("before", "First update.")
        yield* wait(1)
        yield* mutes.mute({ key: sessionKey("before") })
        const first = yield* dictate
        yield* wait(2)
        yield* Scope.close(first, Exit.void)
        yield* wait(11)
        // Muted while he dictates, once it was put back to be read again.
        yield* finish("during", "Second update.")
        yield* wait(1)
        const second = yield* dictate
        yield* mutes.mute({ key: sessionKey("during") })
        yield* made.silence([sessionKey("during")])
        yield* wait(2)
        yield* Scope.close(second, Exit.void)
        yield* wait(11)
        return { played: [...played], kept: (yield* journal.since(0, { kinds: ["update"] })).map((kept) => [kept.said, quieted(kept)]) }
      }),
    )
    expect(result.played).toEqual(["yapd. First update.", "yapd. Second update."])
    expect(result.kept).toEqual([
      ["yapd. First update.", true],
      ["yapd. Second update.", true],
    ])
  })

  test("what the writer is told he heard lately leaves out what was kept quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, wait, nextEvent } = yield* make(undefined, { mutes })
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* finish("noisy", "Still going.")
        yield* nextEvent("Muted update for yapd")
        yield* finish("quiet", "The fix is in.")
        yield* wait(11)
        return (yield* made.recent).map(({ spoken }) => spoken)
      }),
    )
    expect(result).toEqual(["yapd. The fix is in."])
  })

  test("a noisy muted thread never crowds what he heard out of what the writer is told", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, journal, wait } = yield* make(undefined)
        yield* wait(60)
        for (let index = 0; index < 6; index++) yield* journal.write({ at: 1000 + index, kind: "update", project: "yapd", said: `Heard ${index}.` })
        // Twenty-five turns of a muted thread since.
        for (let index = 0; index < 25; index++) yield* journal.write({ at: 2000 + index, kind: "update", project: "yapd", said: "Still going.", detail: { muted: true } })
        return (yield* made.recent).map(({ spoken }) => spoken)
      }),
    )
    expect(result).toEqual(["Heard 5.", "Heard 4.", "Heard 3.", "Heard 2.", "Heard 1.", "Heard 0."])
  })

  test("the newest update he heard of a thread is found by its key, to hear again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, finish, wait, heard } = yield* make(undefined, { link: (session) => (session === "s-tezos" ? Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }) : Effect.succeedNone) })
        yield* stopHere(handle, "s-tezos", "The migration compiles.")
        yield* wait(11)
        yield* finish("terminal", "The fee table is in.")
        yield* wait(11)
        const ids = yield* heard
        return {
          ids,
          tezos: yield* made.latestHeard("t3:Rosie:t-tezos", 0),
          terminal: yield* made.latestHeard(sessionKey("terminal"), 0),
          none: yield* made.latestHeard("t3:Rosie:t-gone", 0),
        }
      }),
    )
    expect(result.tezos).toEqual(Option.some(result.ids[1]!))
    expect(result.terminal).toEqual(Option.some(result.ids[0]!))
    expect(result.none).toEqual(Option.none())
  })

  test("a thread's update he heard isn't what's heard again once something newer of it was kept quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, wait, nextEvent, journal } = yield* make(undefined, { mutes })
        yield* finish("noisy", "First, heard.")
        yield* wait(11)
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* wait(60)
        yield* finish("noisy", "Second, kept quiet.")
        yield* nextEvent("Muted update for yapd")
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return {
          first: yield* made.latestHeard(sessionKey("noisy"), kept[0]!.at),
          second: yield* made.latestHeard(sessionKey("noisy"), kept[1]!.at),
        }
      }),
    )
    expect(Option.isSome(result.first)).toBe(true)
    expect(result.second).toEqual(Option.none())
  })
})

describe("Daemon muting over an update", () => {
  test("'mute it' said over an update, plainly his, mutes its thread and says so, never asking the model or sending the agent anything", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, wait, played, responded, followUps, journal } = yield* make("Mute it.", { mutes })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(11)
        yield* finish("noisy", "Still going, again.")
        yield* wait(11)
        const replies = yield* journal.since(0, { kinds: ["reply"] })
        return { played: [...played], responded: [...responded], followUps: [...followUps], mutes: yield* mutes.list, replies: replies.map(({ said, detail }) => [said, (detail as { intent: string }).intent]) }
      }),
    )
    // The update said after it is kept quiet.
    expect(result.played).toEqual(["yapd. Still going.", "Muted it. I'll still tell you if it needs you."])
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
    expect(result.mutes.map(({ key, called }) => [key, called])).toEqual([[sessionKey("noisy"), "the Claude session in yapd"]])
    expect(result.replies).toEqual([["Muted it. I'll still tell you if it needs you.", "mute"]])
  })

  test("'undo that' right after 'mute it' over an update takes the mute back, never asking the model or sending the agent anything", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, wait, played, responded, followUps } = yield* make("Mute it.", { mutes, transcripts: ["Mute it.", "Undo that."], answer: "Say that again?" })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(2)
        // Over what yapd says of the mute.
        yield* talk
        yield* wait(11)
        yield* finish("noisy", "Still going, again.")
        yield* wait(11)
        return { played: [...played], responded: [...responded], followUps: [...followUps], mutes: yield* mutes.list }
      }),
    )
    expect(result.played).toEqual(["yapd. Still going.", "Muted it. I'll still tell you if it needs you.", "Unmuted it again.", "yapd. Still going, again."])
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
    expect(result.mutes).toEqual([])
  })

  test("'undo that' after a cough heard as words, or begun with a pause, still takes back the mute he made over the update", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, speak, wait, played, responded, followUps } = yield* make("Mute it.", {
          mutes,
          transcripts: ["Mute it.", "Thank you.", "Undo that."],
          answer: "Say that again?",
        })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(2)
        // A cough, too faint to be his, over what yapd says of the mute.
        yield* speak
        yield* wait(2)
        yield* talk
        yield* wait(11)
        return { played: [...played], responded: [...responded], followUps: [...followUps], mutes: yield* mutes.list }
      }),
    )
    expect(result.played).toEqual(["yapd. Still going.", "Muted it. I'll still tell you if it needs you.", "Say that again?", "Unmuted it again."])
    expect(result.responded).toEqual(["Thank you."])
    expect(result.followUps).toEqual([])
    expect(result.mutes).toEqual([])
  })

  test("'undo that' after something for its agent said since a mute over an update is the model's, as that's what it's about", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, wait, responded } = yield* make("Mute it.", { mutes, transcripts: ["Mute it.", "Fix the tests too.", "Undo that."] })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(2)
        yield* talk
        yield* wait(5)
        yield* talk
        yield* wait(11)
        return { responded: [...responded], mutes: (yield* mutes.list).map(({ key }) => key) }
      }),
    )
    expect(result.responded).toEqual(["Fix the tests too.", "Undo that."])
    expect(result.mutes).toEqual([sessionKey("noisy")])
  })

  test("'undo that' over an update once a mute was made from the menu since takes nothing back, as the last change isn't the one made over it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, talk, wait, played, responded } = yield* make("Mute it.", { mutes, transcripts: ["Mute it.", "Undo that."], answer: "Say that again?" })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(1)
        yield* Option.getOrThrow(made.controls).mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-mina" }), called: "the Mina tickets" })
        yield* wait(1)
        yield* talk
        yield* wait(11)
        return { played: [...played], responded: [...responded], mutes: (yield* mutes.list).map(({ key }) => key) }
      }),
    )
    expect(result.played).toEqual(["yapd. Still going.", "Muted it. I'll still tell you if it needs you.", "There's no mute to take back."])
    expect(result.responded).toEqual([])
    expect(result.mutes).toEqual([sessionKey("noisy"), "t3:Rosie:t-mina"])
  })

  test("anything else about mutes over an update, like a thread by name or 'what's muted?', is the shortcut's, never the model's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, wait, played, responded, followUps } = yield* make("Mute the Tezos one.", {
          mutes,
          transcripts: ["Mute the Tezos one.", "Mute it for a bit.", "What's muted?"],
        })
        yield* finish("noisy", "Still going.")
        for (let index = 0; index < 3; index++) {
          yield* wait(1)
          yield* talk
        }
        yield* wait(11)
        return { played: [...played], responded: [...responded], followUps: [...followUps], mutes: yield* mutes.list }
      }),
    )
    const elsewhere = "Ask me that with the shortcut. Over an update, I can only mute or unmute the one I'm reading."
    expect(result.played).toEqual(["yapd. Still going.", elsewhere, elsewhere, elsewhere])
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
    expect(result.mutes).toEqual([])
  })

  test("'unmute it' over a thread's update takes off the mute of its session, made before the session was found to be the thread's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { handle, talk, wait, played, responded } = yield* make("Unmute it.", {
          mutes,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          urgentMessages: ["The tests failed."],
        })
        yield* mutes.mute({ key: sessionKey("s-tezos") })
        // Said, as it needs him, so the mute stays the session's.
        yield* stopHere(handle, "s-tezos", "The tests failed.")
        yield* wait(1)
        yield* talk
        yield* wait(11)
        return { played: [...played], responded: [...responded], mutes: yield* mutes.list }
      }),
    )
    expect(result.played).toEqual(["yapd. The tests failed.", "Unmuted it."])
    expect(result.responded).toEqual([])
    expect(result.mutes).toEqual([])
  })

  test("'undo that' over an update with no mute made over it just before is the model's, as ever", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, wait, responded } = yield* make("Undo that.", { mutes, answer: "Say that again?" })
        yield* mutes.mute({ key: sessionKey("other") })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(11)
        return { responded: [...responded], mutes: (yield* mutes.list).map(({ key }) => key) }
      }),
    )
    expect(result.responded).toEqual(["Undo that."])
    expect(result.mutes).toEqual([sessionKey("other")])
  })

  test("'mute it' begun over yapd's own voice, or too faint to be his, is the model's, which never sends it on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, speak, wait, responded, followUps } = yield* make("Mute it.", { mutes, echoing: 30, answer: "Say that again?" })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(11)
        const echoed = [...responded]
        // Faint, like talk across the room.
        const faint = yield* make("Mute it.", { mutes, answer: "Say that again?" })
        yield* faint.finish("other", "Done.")
        yield* faint.wait(1)
        yield* faint.speak
        yield* faint.wait(11)
        return { echoed, faint: [...faint.responded], muted: yield* mutes.list, followUps: [...followUps, ...faint.followUps] }
      }),
    )
    expect(result.echoed).toEqual(["Mute it."])
    expect(result.faint).toEqual(["Mute it."])
    expect(result.muted).toEqual([])
    expect(result.followUps).toEqual([])
  })
})

/** A Stop from this machine's hook of `session`, which says where it came from, as a hook that can be tied to its thread does. */
const stopHere = (handle: Handle, session: string, message: string) =>
  handle("claude", { hook_event_name: "Stop", session_id: session, cwd: "/code/yapd", last_assistant_message: message }, { project: "yapd", host: hostname() }, false).pipe(
    Effect.zipRight(Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))),
  )
