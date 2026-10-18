import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Exit, Layer, Logger, Option, Queue, Schema, Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { hostname } from "node:os"
import * as Assistant from "./Assistant.ts"
import { Audio } from "./Audio.ts"
import * as Brain from "./Brain.ts"
import { Waiting } from "./ClaudeCode.ts"
import { CondenseError, Condenser, type Turn } from "./Condenser.ts"
import type * as Conversation from "./Conversation.ts"
import * as Daemon from "./Daemon.ts"
import * as Drafts from "./Drafts.ts"
import { defaults } from "./Endpointer.ts"
import * as Floor from "./Floor.ts"
import { RelayError, Relays, type Thread } from "./Relay.ts"
import { Responder } from "./Responder.ts"
import type { Handle } from "./Server.ts"
import * as Show from "./Show.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad, VadError } from "./Vad.ts"
import * as Hands from "./Hands.ts"
import * as Journal from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import * as Mutes from "./Mutes.ts"
import * as Persona from "./Persona.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3CodeServer from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
import { Voice } from "./Voice.ts"
import type { Line } from "./Words.ts"
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
  /** A microphone, even when the user says nothing. */
  readonly microphone?: boolean
  /** How stopping playback goes, which the audio helper answers when it's ready, with how far it got. */
  readonly stopping?: Effect.Effect<number>
  /** How many frames from the microphone, from the first, may carry yapd's own voice, as before the echo cancellation has learnt it. */
  readonly echoing?: number
  readonly send?: (thread: Thread, text: string) => Effect.Effect<void, RelayError>
  /** Finds the T3 Code thread a hook on this machine came from. */
  readonly link?: (session: string, cwd: string) => Effect.Effect<Option.Option<Threads.Ref>>
  /** Sends what the user says over an update tied to its T3 Code thread. */
  readonly hands?: Hands.Hands["Type"]
  /** How long working out what to do with what the user says takes, in seconds, so they can carry on meanwhile. */
  readonly thinking?: number
  /** What's muted. Nothing is without it. */
  readonly mutes?: Mutes.Mutes
  /** Messages the summary reads as needing the user, like a failure. */
  readonly urgentMessages?: ReadonlyArray<string>
  /** Messages that can't be summed up, as when the model is down. */
  readonly unsummarizable?: ReadonlyArray<string>
  /** Messages the summary reads as only how work that carries on is going. */
  readonly progressMessages?: ReadonlyArray<string>
  /** Focus or quiet, while one is on. */
  readonly holding?: Effect.Effect<Option.Option<"focus" | "quiet">>
  /** Whether "Mute." said on its own turns yapd off, as yapd serves it. */
  readonly off?: boolean
  /** What the Responder hands to yapd's assistant, rather than pass on. */
  readonly handsOver?: (heard: string) => boolean
  /** Where what's handed over goes, and what's said right after a late line, once the assistant's made, as yapd serves it. */
  readonly handing?: { over?: Assistant.Assistant["Type"]["over"]; following?: Assistant.Assistant["Type"]["following"] }
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
  /** What was logged, in order. */
  const logged: Array<string> = []
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
  let echoed = 0
  const layer = Layer.mergeAll(
    Persona.Plain,
    Journal.memory,
    Layer.succeed(Condenser, {
      condense: (_, turn) =>
        options.unsummarizable?.includes(turn.message) ? Effect.fail(new CondenseError({ cause: "the model is down" })) : Effect.sync(() => {
          condensed.push(turn)
          return {
            priority: options.urgentMessages?.includes(turn.message)
              ? "needs-you" as const
              : options.progressMessages?.includes(turn.message)
                ? "progress" as const
                : "done" as const,
            spoken: turn.message,
          }
        }),
      ask: (request) => Effect.succeed({ spoken: `wants to ${request.what}`, risk: "low" as const }),
      question: () => Effect.succeed({ spoken: "Which one should it use?" }),
    }),
    Layer.succeed(Voice, {
      render: (text, path) => Effect.sleep(`${options.renderSeconds ?? 0} seconds`).pipe(Effect.zipRight(Effect.sync(() => void rendered.set(path, text)))),
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
            confirmed: true,
            finished: Effect.sleep("10 seconds").pipe(
              Effect.tap(() => {
                done = true
              }),
            ),
            stop: options.stopping ?? Effect.succeed(2),
            volume: () => Effect.void,
          }
        }),
      microphone: Effect.succeed(listening ? Option.some(microphone) : Option.none()),
      echo: () => Effect.sync(() => echoed++ < (options.echoing ?? 0)),
      rest: Effect.void,
      warm: Effect.void,
      tick: Effect.void,
    }),
    Layer.succeed(Waiting, {
      open: (session) => Effect.map(Deferred.make<string | undefined>(), (answer) => ({ session, answer })),
      close: ({ session }) => Effect.sync(() => void followUps.push(`${session} let go`)),
      drop: () => Effect.void,
      deliver: () => Effect.succeed(false),
      reply: () => Effect.succeed(undefined),
    }),
    Layer.succeed(Vad, {
      // Each frame holds the probability that it's speech.
      make: listening ? Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)) : Effect.fail(new VadError({ cause: "no microphone" })),
    }),
    Layer.succeed(Transcriber, {
      transcribe: () => Effect.sync(() => transcripts.shift() ?? says ?? ""),
      ready: Effect.succeed(true),
    }),
    Layer.succeed(Responder, {
      respond: ({ heard }) =>
        says === undefined
          ? Effect.die("nothing to respond to")
          : Effect.sync(() => void responded.push(heard)).pipe(
              Effect.zipRight(Effect.sleep(`${options.thinking ?? 0} seconds`)),
              Effect.as({
                reply:
                  options.handsOver?.(heard) === true
                    ? { intent: "assistant" as const, spoken: "", message: "" }
                    : options.answer === undefined
                      ? { intent: "send" as const, spoken: "Okay, passed on.", message: heard }
                      : { intent: "answer" as const, spoken: options.answer, message: "" },
                source: "model" as const,
              }),
            ),
    }),
    Layer.succeed(Relays, {
      send: (thread, text) =>
        Effect.suspend(() => options.send?.(thread, text) ?? Effect.sleep("3 seconds")).pipe(
          Effect.zipRight(Effect.sync(() => void followUps.push(`${thread.session} sent: ${text}`))),
        ),
    }),
    Floor.layer,
    Logger.add(Logger.make(({ message }) => {
      for (const line of Array.isArray(message) ? message : [message]) {
        if (typeof line !== "string") continue
        Queue.unsafeOffer(logs, line)
        logged.push(line)
      }
    })),
  )
  const context = yield* Layer.build(layer)
  /** Turning yapd off as the menu does, once it's made. */
  let switchOff: Effect.Effect<void> = Effect.void
  const made = yield* Daemon.make({
    ...(options.link === undefined
      ? {}
      : { link: (session: string, cwd: string) => Effect.map(options.link!(session, cwd), Option.map((ref): Threads.Linked => ({ _tag: "Thread", ref }))) }),
    ...(options.hands === undefined ? {} : { hands: options.hands }),
    ...(options.mutes === undefined ? {} : { mutes: options.mutes }),
    ...(options.holding === undefined ? {} : { holding: options.holding }),
    // As the menu turns it off, which yapd serves with more around it.
    ...(options.off === true ? { off: Effect.suspend(() => switchOff) } : {}),
    // This machine is Rosie, as yapd serves it.
    naming,
    ...(options.handing === undefined
      ? {}
      : {
          over: (update: Conversation.Update, lines: ReadonlyArray<Line>, line: string, given: Assistant.Over) => (heard: string, voiced: number, echo?: string, afterPause?: string, unsaid?: string) =>
            Effect.suspend(() => options.handing!.over!(update, lines, line, given)(heard, voiced, echo, afterPause, unsaid)),
          following: (update: Conversation.Update, line: string, done?: Brain.Done, own?: Brain.Own) =>
            (heard: string, voiced: number, echo?: string, afterPause?: string, unsaid?: string, carried?: boolean) =>
              Effect.suspend(() => options.handing!.following!(update, line, done, own)(heard, voiced, echo, afterPause, unsaid, carried)),
        }),
  }).pipe(Effect.provide(context))
  switchOff = made.turn(false)
  const { handle, speak: read, tell } = made
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
   * Something yapd has to say for itself, which as a question, the one open, records in `question` that it went
   * unanswered, and in `heard` when it was heard to the end. As an answer with `followUp`, it takes what's said over
   * it or right after for a follow-up, noted there, unless it's talk with Sam.
   */
  const notice = (
    id: string,
    spoken: string,
    options: {
      readonly question?: Array<string>
      readonly stale?: boolean
      readonly needsYou?: boolean
      readonly answer?: boolean
      readonly heard?: Array<string>
      readonly followUp?: Array<string>
      /** With `followUp`, whether it's followed up only from its end, and said unasked. */
      readonly after?: boolean
      readonly unasked?: boolean
    } = {},
  ) =>
    tell({
      id,
      kind: options.question !== undefined ? "question" : options.answer === true ? "answer" : "notice",
      ...(options.question === undefined ? {} : { open: `open-${id}` }),
      priority: options.question !== undefined || options.needsYou === true || options.answer === true ? "needs-you" : "done",
      spoken,
      at: 0,
      stale: Effect.succeed(options.stale === true),
      ...(options.heard === undefined ? {} : { heard: Effect.sync(() => void options.heard?.push(id)) }),
      ...(options.followUp === undefined
        ? {}
        : {
            followUp: (heard: string) =>
              Effect.succeed(heard.startsWith("Sam,") ? Option.none() : Option.some(Effect.sync(() => void options.followUp?.push(`${id}: ${heard}`)))),
            ...(options.after === true ? { after: true as const } : {}),
            ...(options.unasked === true ? { unasked: true as const } : {}),
          }),
      ...(options.question === undefined
        ? {}
        : {
            question: {
              answer: () => Effect.succeed(Option.none()),
              unanswered: Effect.sync(() => void options.question?.push(`${id} unanswered`)),
              unsaid: Effect.void,
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
  const reading = STM.commit(TRef.get(floor.reading))
  /** What the user heard lately, newest first, by id. */
  const heard = Effect.map(Stream.runHead(made.state), (state) => Option.getOrThrow(state).heard.map(({ id }) => id))
  const toggle = (on: boolean) => made.turn(on).pipe(Effect.zipRight(flush))
  return { responded, made, handle, finish, turn, notice, speak, talk, followUps, wait, dictate, reading, played, stopped, condensed, logged, nextEvent, nextPlayback: Queue.take(playbacks), renders: () => rendered.size, flush, toggle, power: made.turn, heard, replay: made.replay, awaiting: made.awaiting.pipe(Effect.map((arrived) => arrived.pipe(Effect.zipRight(flush)))), journal: Context.get(context, Journal.Journal) }
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
  run: { status: "completed", final: message, others: [], natives: ["native-loader"], previous: Option.none(), userMessageId: Option.none(), startedAt: -60_000 },
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
  const reach: Effect.Effect<T3CodeServer.Transport, T3CodeServer.Trouble> = Effect.succeed({
    api: (<A, I>(_: string, schema: Schema.Schema<A, I>) => Schema.decodeUnknown(schema)({ projection: bounded }).pipe(Effect.orDie)) as T3CodeServer.Transport["api"],
    call: (<A, I>(method: string, payload: Record<string, unknown>, schema: Schema.Schema<A, I>) =>
      method === "orchestration.dispatchCommand"
        ? Effect.gen(function* () {
            dispatched.push(payload)
            if (payload.type === "message.dispatch" && payload.threadId === current.id) {
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
  // The Mina tickets too, idle, which a message to goes to as a turn of its own.
  const others = new Map([["t-mina", thread("t-mina", "Open the Mina SSV2 bug tickets")]])
  const hands = Hands.make({
    threads: {
      find: (ref) => Effect.sync(() => (ref.id === current.id ? Option.some(current) : Option.fromNullable(others.get(ref.id)))),
      actions: (machine) => (machine === "Rosie" ? Option.some(actions) : Option.none()),
      unseen: () => Effect.succeedNone,
    },
    ledger,
  })
  return {
    hands,
    ledger,
    /** The messages T3 Code was sent, by thread. */
    sent: () => dispatched.filter(({ type }) => type === "message.dispatch").map(({ threadId, text }) => `${threadId}: ${text}`),
    /** Every command T3 Code was sent, by thread and what it was. */
    commands: () => dispatched.map(({ threadId, type }) => `${String(threadId)}: ${String(type)}`),
    /** The thread as T3 Code has it from now on, like once he's typed something into it. */
    becomes: (overrides: Record<string, unknown>) =>
      Effect.sync(() => {
        current = tezos({ ...current, ...overrides })
      }),
  }
})

/** A thread T3 Code runs, idle in the yapd project, unless `overrides` says otherwise. */
const thread = (id: string, title: string, overrides: Record<string, unknown> = {}) =>
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
    ...overrides,
  })

/**
 * The daemon with the assistant on top, wired as yapd serves them, without
 * T3 Code but for what it shows of the threads on the `desk`, and with a model
 * that decides what `model` says, which isn't asked about what needs no model.
 */
const assisted = (
  model: (situation: Brain.Situation) => Brain.Decision,
  /**
   * With what the user `says` over an update, which is meant for its agent, as `make` takes it, and, with `t3`, what the assistant
   * does to threads and keeps of it, as `handing` gives them.
   */
  options: Parameters<typeof make>[1] & { readonly says?: string; readonly t3?: { readonly hands: Hands.Hands["Type"]; readonly ledger: Ledger.Ledger["Type"] } } = {},
  desk: ReadonlyArray<T3Live.Thread> = [],
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
    const ledger = options.t3?.ledger ?? Ledger.fromStore(store)
    const drafts = yield* Drafts.make({ machines: [], rules: Effect.succeed(Option.none()), recent: Effect.succeed([]) }).pipe(
      Effect.provideService(Writer, { decide: () => Effect.never, prepare: Effect.void }),
      Effect.provide(Persona.Plain),
    )
    const show = yield* Show.make(threads.detail, () => Effect.void)
    const assistant = yield* Assistant.make({
      threads,
      journal,
      drafts,
      hands: options.t3?.hands ?? Hands.make({ threads, ledger }),
      ledger,
      show,
      tell: made.tell,
      power: made.power,
      lastHeard: made.lastHeard,
      coming: made.coming,
      awaiting: made.awaiting,
      awaitingFor: made.awaitingFor,
      queued: made.queued,
      skip: made.skip,
      upcoming: made.upcoming,
      telling: made.telling,
      compose: () => Effect.succeedNone,
      ...(options.mutes === undefined ? {} : { mutes: options.mutes, ...Option.match(made.controls, { onNone: () => ({}), onSome: (controls) => ({ controls }) }) }),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Brain.Brain, {
            decide: (situation) => Effect.sync(() => model(situation)),
            // As the model is asked to: what he missed, from what it's given.
            brief: (brief) => Effect.succeed({ spoken: `You missed this: ${brief.groups.flatMap(({ rows }) => rows.map(({ said }) => said)).join(" ")}`, read: [] }),
          }),
          Persona.Plain,
        ),
      ),
    )
    if (options.handing !== undefined) {
      options.handing.over = assistant.over
      options.handing.following = assistant.following
    }
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
    return { ...daemon, dictating }
  })

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

  test("rejects a follow-up after a newer hook received in the same millisecond", async () => {
    let deliveries = 0
    await run(
      Effect.gen(function* () {
        const { handle, finish, speak, nextEvent, nextPlayback } = yield* make("Merge it.", {
          send: () => Effect.sync(() => { deliveries++ }),
        })
        yield* finish("a", "The PR is ready.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Different work." }, { project: "yapd" }, false)
        yield* speak
        yield* nextPlayback
      }),
    )
    expect(deliveries).toBe(0)
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
    // The two quick ones were skipped as such.
    const [pr, loader, merged] = [
      { at: first, message: "The PR is ready." },
      { at: other, message: "The loader is fixed.", skipped: "quick" as const },
      { at: second, message: "Done, it's merged.", skipped: "quick" as const },
    ]
    expect(result.kept).toEqual({ a: [pr, merged], b: [loader], both: [pr, loader, merged] })
    expect(result.later).toEqual({ a: [], b: 1 })
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
        yield* nextPlayback
        const kept = yield* journal.since(0)
        return { sent: t3.sent(), kept: JSON.stringify(kept).includes("hunter2"), logged: logged.some((line) => line.includes("hunter2")) }
      }),
    )
    expect(result).toEqual({ sent: [], kept: false, logged: false })
  })

  test.each([
    ["an answer, said", "answer", true],
    ["a notice, not said while yapd is off", "notice", false],
  ] as const)("what could give a secret away, %s, is never logged", async (_, kind, on) => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, power, played, logged } = yield* make()
        if (!on) yield* power(false)
        const { turns } = yield* made.power
        const spoken = "I won't keep sk-live-4f9a8b7c6d5e, sir. Type it into T3 Code."
        yield* made.tell({ id: "n1", kind, priority: "needs-you", spoken, at: yield* Clock.currentTimeMillis, stale: Effect.succeed(false) }, turns)
        yield* wait(5)
        return { played: played.length, logged: logged.filter((line) => line.includes("4f9a8b7c6d5e")) }
      }),
    )
    expect(result).toEqual({ played: on ? 1 : 0, logged: [] })
  })

  test("a turn no hook told of, said in its hook's place, is the turn's: its own Stop, come after, isn't said too, and one still waiting gives way to it", async () => {
    const stop = (handle: Handle, message: string) =>
      handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: message }, { project: "yapd", host: hostname() }, false)
    // Said, and heard, before its Stop came, a while getting going.
    const heard = await run(
      Effect.gen(function* () {
        const { made, wait, played, handle, nextEvent } = yield* make(undefined, { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }) })
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready:")
        yield* wait(11)
        yield* stop(handle, "The loader is fixed.")
        yield* wait(11)
        yield* wait(11)
        return [...played]
      }),
    )
    expect(heard).toEqual(["yapd. The loader is fixed."])
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
        // Nobody said anything in the time a question leaves for it.
        yield* wait(11)
        yield* wait(11)
        return { played: [...played], asked }
      }),
    )
    expect(result.played).toEqual([
      "yapd. The PR is ready.",
      "Which project is the loader fix for?",
      // From when the dictation was sent, which was before the update came in.
      "Started in yapd, on Fable, in a worktree.",
      "yapd. The tests pass.",
    ])
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

  test("turned off, stops at once, keeps what was being read, what waits and what finishes meanwhile unheard, lets their hooks go, and never says them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, played, stopped, condensed, followUps, journal, renders } = yield* daemon
        yield* finish("a", "The PR is ready.", true)
        yield* finish("b", "The tests pass.", true)
        yield* wait(1)
        yield* toggle(false)
        const letGo = [...followUps]
        // Its hook is never kept waiting while yapd is off.
        yield* finish("c", "Deployed it.", true)
        yield* wait(30)
        const off = (yield* journal.since(0, { kinds: ["update"] })).map(({ said, heardAt, detail }) => [said, heardAt, (detail as { held?: string }).held])
        yield* toggle(true)
        yield* wait(30)
        return { played: [...played], stopped: [...stopped], condensed: condensed.map(({ message }) => message), letGo, after: [...followUps], off, renders: renders() }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready."])
    expect(result.stopped).toEqual(["yapd. The PR is ready."])
    // The one it was reading was heard, so its hook waits for a reply to it heard again.
    expect(result.letGo).toEqual(["claude:b let go"])
    expect(result.after).toEqual(["claude:b let go"])
    expect(result.condensed).toEqual(["The PR is ready.", "The tests pass.", "Deployed it."])
    // What came in while off is summed up but never rendered.
    expect(result.renders).toBe(2)
    expect(result.off).toEqual([
      ["yapd. The PR is ready.", undefined, "off"],
      ["yapd. The tests pass.", undefined, "off"],
      ["yapd. Deployed it.", undefined, "off"],
    ])
  })

  test("says an update again as it was said, only one it said and only while on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, played, heard, replay, journal } = yield* daemon
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
        return { unknown, queued, off, after, id, played: [...played], playing, through }
      }),
    )
    expect(result).toMatchObject({ unknown: "unknown", queued: "queued", off: "off", after: [result.id], playing: 1, through: 0 })
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready."])
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
      yield* nextPlayback
      yield* speak
      yield* nextPlayback
      yield* wait(3)
      const beforeCompletion = [...followUps]
      yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Merge it." }, { project: "yapd" }, false)
      yield* finish("a", "Merged it.")
      yield* wait(3)
      const afterFirstCompletion = [...followUps]
      if (fails) yield* nextEvent("Ready: yapd. Couldn't send the queued message")
      else {
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Run the checks." }, { project: "yapd" }, false)
        yield* finish("a", "The checks pass.")
      }
      yield* wait(3)
      yield* finish("a", "Deployed it.")
      // Another reply to the same original update, after its queued work completed.
      yield* speak
      yield* wait(3)
      return { beforeCompletion, afterFirstCompletion, sent: [...followUps], targets }
    }))
    expect(result.beforeCompletion).toEqual(["a sent: Merge it."])
    expect(result.afterFirstCompletion).toEqual(fails ? ["a sent: Merge it."] : ["a sent: Merge it.", "a sent: Run the checks."])
    expect(result.sent).toEqual(["a sent: Merge it.", ...fails ? [] : ["a sent: Run the checks."], "a sent: Deploy it.", "a sent: Clean up."])
    expect(result.targets).toEqual(["The PR is ready.", "Merged it.", fails ? "Merged it." : "The checks pass.", "Deployed it."])
  })

  test.each(["a dictation", "turning yapd off"] as const)("sends and notes nothing he said when %s cuts in while what he said over an update's first seconds is still being worked out", async (cut) => {
    const result = await run(
      Effect.gen(function* () {
        const stops: Array<string> = []
        // Its own voice can get in for as long as he talks, as before the echo cancellation has learnt it.
        const { finish, talk, wait, dictate, toggle, followUps, responded, played, journal } = yield* make("Tell it to deploy.", {
          echoing: 60,
          thinking: 5,
          stopping: Effect.sync(() => void stops.push("stopped")).pipe(Effect.as(2)),
        })
        yield* finish("a", "The PR is ready.")
        yield* talk
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
    expect(result.before).toEqual({ played: ["yapd. The PR is ready."], stops: ["stopped"], responded: ["Tell it to deploy."] })
    expect(result).toMatchObject({ followUps: [], replies: [] })
  })
})

describe("Daemon headline first", () => {
  test("progress is held for the digest, never rendered, while what needs him, finished work and a turn that couldn't be summed up never are", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, turn, wait, played, renders, followUps, journal } = yield* make(undefined, {
          progressMessages: ["Pass 7 is running.", "Pass 8 is running."],
          unsummarizable: ["Garbled."],
        })
        yield* finish("review", "Pass 7 is running.", true)
        yield* wait(11)
        yield* turn("review2", "Pass 8 is running.", 120, { needsYou: true })
        yield* wait(11)
        yield* finish("tezos", "The Tezos migration is merged.")
        yield* wait(11)
        yield* finish("garbled", "Garbled.")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], renders: renders(), followUps: [...followUps], kept: updates.map(({ said, detail }) => [said, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual(["yapd. Pass 8 is running.", "yapd. The Tezos migration is merged.", "yapd finished a turn, but I couldn't summarize it."])
    expect(result.renders).toBe(3)
    // Its hook isn't kept waiting for a reply to what wasn't said.
    expect(result.followUps).toEqual(["claude:review let go"])
    expect(result.kept).toEqual([
      ["yapd. Pass 7 is running.", "progress"],
      ["yapd. Pass 8 is running.", undefined],
      ["yapd. The Tezos migration is merged.", undefined],
      ["yapd finished a turn, but I couldn't summarize it.", undefined],
    ])
  })

  test("focus holds finished work, condensed but never rendered, and lets through what needs him and the answer to his own message", async () => {
    const result = await run(
      Effect.gen(function* () {
        let mode = Option.none<"focus" | "quiet">()
        const { finish, speak, wait, nextEvent, nextPlayback, played, renders, journal } = yield* make("Use the fee table.", {
          holding: Effect.sync(() => mode),
          urgentMessages: ["The tests failed."],
          send: () => Effect.void,
        })
        yield* finish("tezos", "The migration compiles.")
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(14)
        mode = Option.some("focus")
        yield* finish("tezos", "The fee table is in.")
        yield* wait(11)
        yield* finish("other", "The Mina tickets are open.")
        yield* wait(11)
        yield* finish("urgent", "The tests failed.")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], renders: renders(), kept: updates.map(({ said, detail }) => [said, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual(["yapd. The migration compiles.", "Okay, passed on.", "yapd. The fee table is in.", "yapd. The tests failed."])
    expect(result.renders).toBe(4)
    expect(result.kept).toEqual([
      ["yapd. The migration compiles.", undefined],
      ["yapd. The fee table is in.", undefined],
      ["yapd. The Mina tickets are open.", "focus"],
      ["yapd. The tests failed.", undefined],
    ])
  })

  test("how long it's been quiet counts from the end of the last line, and is nothing while anything is summed up, waits, is said or dictated", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, wait, dictate } = yield* make(undefined, { renderSeconds: 2 })
        yield* wait(30)
        const quiet = yield* made.idle
        yield* finish("tezos", "The fee table is in.")
        const preparing = yield* made.idle
        yield* wait(3)
        const saying = yield* made.idle
        yield* wait(10)
        const after = yield* made.idle
        yield* wait(60)
        const later = yield* made.idle
        const dictation = yield* dictate
        const dictating = yield* made.idle
        yield* Scope.close(dictation, Exit.void)
        return { quiet, preparing, saying, after, later, dictating }
      }),
    )
    expect(result.quiet).toEqual(Option.some(30_000))
    expect(result.preparing).toEqual(Option.none())
    expect(result.saying).toEqual(Option.none())
    expect(Option.getOrThrow(result.after)).toBeLessThan(2_000)
    expect(Option.getOrThrow(result.later)).toBeGreaterThanOrEqual(60_000)
    expect(result.dictating).toEqual(Option.none())
  })
})

describe("Daemon with threads muted", () => {
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
})

describe("Lines listened to from their end", () => {
  test("a failure said with no dictation or reply taken in the last ten minutes listens only for 'Mute.'; said a minute after a dictation, it can be answered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, speak, dictate } = yield* make(undefined, { microphone: true, transcripts: ["Tell it to rerun them."] })
        const followUp: Array<string> = []
        yield* notice("away", "Tezos failed: rate limited.", { followUp, after: true, unasked: true })
        yield* wait(11)
        yield* speak
        yield* wait(5)
        const away = [...followUp]
        yield* Scope.close(yield* dictate, Exit.void)
        yield* wait(60)
        yield* notice("near", "Mina failed: the fee tests broke.", { followUp, after: true, unasked: true })
        yield* wait(11)
        yield* speak
        yield* wait(1)
        return { away, near: [...followUp] }
      }),
    )
    expect(result).toEqual({ away: [], near: ["near: Tell it to rerun them."] })
  })
})

describe("Daemon turned off by 'Mute.'", () => {
  /** The updates kept, what each said, when it was heard, and why it was held, if it was. */
  const kept = (journal: Journal.Journal["Type"]) =>
    Effect.map(journal.since(0, { kinds: ["update"] }), (rows) => rows.map(({ said, heardAt, detail }) => [said, heardAt, (detail as { held?: string }).held]))

  test("a bare 'Mute.' over an update turns yapd off at once, with no model call, and keeps it and what waits unheard", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, talk, flush, wait, played, responded, followUps, journal } = yield* make("Mute.", { off: true })
        yield* finish("a", "The PR is ready.")
        yield* finish("b", "The tests pass.")
        yield* wait(1)
        yield* talk
        yield* flush
        // With no time gone by for anything to be worked out.
        const { on } = yield* made.power
        yield* wait(30)
        return { on, played: [...played], responded: [...responded], followUps: [...followUps], kept: yield* kept(journal) }
      }),
    )
    expect(result.on).toBe(false)
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
    expect(result.played).toEqual(["yapd. The PR is ready."])
    expect(result.kept).toEqual([
      ["yapd. The PR is ready.", undefined, "off"],
      ["yapd. The tests pass.", undefined, "off"],
    ])
  })
})

describe("Daemon muting over an update", () => {
  test("'mute it' said over an update, plainly his, mutes its thread and says so, never asking the model or sending the agent anything", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, wait, responded, followUps } = yield* make("Mute it.", { mutes })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(11)
        return { responded: [...responded], followUps: [...followUps], mutes: (yield* mutes.list).map(({ key }) => key) }
      }),
    )
    expect(result).toEqual({ responded: [], followUps: [], mutes: [sessionKey("noisy")] })
  })

  test("'mute it' begun over yapd's own voice, or too faint to be his, is the model's, which never sends it on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, talk, wait, responded, followUps } = yield* make("Mute it.", { mutes, echoing: 30, answer: "Say that again?" })
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

describe("Daemon handing over what's yapd's to do", () => {
  const minaThread = (overrides: Record<string, unknown> = {}) => thread("t-mina", "Open the Mina SSV2 bug tickets", overrides)
  /** A thread's handle on the desk the model was shown. */
  const handleOf = (situation: Brain.Situation, id: string) => situation.desk.threads.find(({ ref }) => ref.id === id)?.handle ?? ""
  /** The Tezos migration's Stop, tied to its thread, waiting for his reply when it's `hooked`, needing him when it asks. */
  const tezosStop = (handle: Handle, hooked = false, message = "The migration compiles.") =>
    handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: message }, { project: "yapd", host: hostname() }, hooked)

  test("words over an update's first seconds with nothing after a pause, handed over, are never acted on", async () => {
    /** He says `said` over the Tezos update's first seconds, which may all be yapd's own voice, as the model takes it. */
    const over = (said: string, model: (situation: Brain.Situation) => Brain.Decision) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const mutes = yield* muting
          const { handle, talk, wait, nextEvent, played, dictating } = yield* assisted(
            (situation) => (situation.utterance.via === "shortcut" ? Brain.decision({ act: "answer", spoken: "Nothing else needs you." }) : model(situation)),
            {
              says: said,
              hands: t3.hands,
              t3,
              mutes,
              link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
              handsOver: () => true,
              handing: {},
              // Its own voice may be in all he says over its first seconds.
              echoing: 1_000,
            },
            [tezos(), minaThread({ status: "running", activeRunId: "run-3", activityRunStatus: "running" })],
          )
          yield* dictating("Does anything need me?")
          for (let second = 0; second < 20; second++) yield* wait(1)
          yield* tezosStop(handle)
          yield* nextEvent("Ready: yapd.")
          yield* talk
          for (let second = 0; second < 40; second++) yield* wait(1)
          const update = "yapd. The migration compiles."
          return { played: played.slice(played.indexOf(update)), sent: t3.commands() }
        }),
      )
    const result = await over("Tell the Mina one to wait.", (situation) => Brain.decision({ act: "send", target: handleOf(situation, "t-mina"), text: "Wait." }))
    // Let go: picked up again, nothing sent.
    expect(result.sent).toEqual([])
    expect(result.played.every((line) => line === "yapd. The migration compiles.")).toBe(true)
  }, 30_000)
})
