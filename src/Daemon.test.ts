import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, type Duration, Effect, Exit, Fiber, Layer, Logger, Option, Queue, Schema, Scope, STM, Stream, TestClock, TestContext, TRef } from "effect"
import { hostname } from "node:os"
import * as Assistant from "./Assistant.ts"
import { Audio, AudioError } from "./Audio.ts"
import * as Brain from "./Brain.ts"
import { Waiting, WaitingLive } from "./ClaudeCode.ts"
import { CondenseError, Condenser, type Turn } from "./Condenser.ts"
import type * as Conversation from "./Conversation.ts"
import * as Daemon from "./Daemon.ts"
import * as Drafts from "./Drafts.ts"
import { defaults } from "./Endpointer.ts"
import * as Floor from "./Floor.ts"
import { RelayError, Relays, type Thread } from "./Relay.ts"
import { key } from "./Payload.ts"
import { quick, Responder } from "./Responder.ts"
import type { Handle } from "./Server.ts"
import * as Show from "./Show.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad, VadError } from "./Vad.ts"
import * as Hands from "./Hands.ts"
import * as Journal from "./Journal.ts"
import * as Ledger from "./Ledger.ts"
import * as Missed from "./Missed.ts"
import * as Mutes from "./Mutes.ts"
import * as Notices from "./Notices.ts"
import * as Persona from "./Persona.ts"
import { ProcessError } from "./Process.ts"
import * as Reminders from "./Reminders.ts"
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
  /** Finds the T3 Code thread a hook on this machine came from, or the subagent of T3 Code's own it did, told when that may take longer. */
  readonly linked?: (session: string, cwd: string, promising: Deferred.Deferred<void>) => Effect.Effect<Option.Option<Threads.Linked>>
  /** Sends what the user says over an update tied to its T3 Code thread. */
  readonly hands?: Hands.Hands["Type"]
  /** How long working out what to do with what the user says takes, in seconds, so they can carry on meanwhile. */
  readonly thinking?: number
  /** What's muted. Nothing is without it. */
  readonly mutes?: Mutes.Mutes
  /** Finds the T3 Code thread a hook on another machine came from. */
  readonly owner?: (host: string, session: string, cwd: string) => Effect.Effect<Option.Option<Threads.Ref>>
  /** Whether a directory on a machine is in the folder behind T3 Code's scratch project there. */
  readonly outside?: (machine: string, directory: string) => Effect.Effect<boolean>
  /** Messages the summary reads as needing the user, like a failure. */
  readonly urgentMessages?: ReadonlyArray<string>
  /** Messages that can't be summed up, as when the model is down. */
  readonly unsummarizable?: ReadonlyArray<string>
  /** What yapd sent each thread for him, as the ledger has it. */
  readonly sent?: (to: Threads.Ref, since: number) => Effect.Effect<ReadonlyArray<{ readonly at: number; readonly digest: string | null }>>
  /** The message each thread's latest run began with, as T3 Code has it. */
  readonly began?: (to: Threads.Ref) => Effect.Effect<Option.Option<Option.Option<string>>>
  /** Messages the summary reads as only how work that carries on is going. */
  readonly progressMessages?: ReadonlyArray<string>
  /** What the summary keeps for "more" of each message, beside its headline, which is the message. */
  readonly mores?: Readonly<Record<string, string>>
  /** Focus or quiet, while one is on. */
  readonly holding?: Effect.Effect<Option.Option<"focus" | "quiet">>
  /** How much of an update is said. */
  readonly detail?: Effect.Effect<"brief" | "full">
  /** What changes how yapd talks, said over an update. */
  readonly command?: (heard: string, asks: boolean) => Option.Option<Effect.Effect<string>>
  /** Whether what he says over an update is first worked out as the Responder does without the model. */
  readonly quickly?: boolean
  /** The journal, when it's kept from before a restart, rather than one of its own. */
  readonly journal?: Journal.Journal["Type"]
  /** Whether "Mute." said on its own turns yapd off, as yapd serves it. */
  readonly off?: boolean
  /** What he asked to hear once a thread finishes. */
  readonly finishing?: (about: Threads.Ref, before: number, ended: Effect.Effect<Reminders.Ending>) => Effect.Effect<ReadonlyArray<Reminders.Leading>>
  /** How the turn a Stop told of ended, as its thread's run has it. */
  readonly ending?: (about: Threads.Ref, stop: Notices.Stop) => Effect.Effect<Reminders.Ending>
  /** Where what's said right after a line said of an update, that can be followed up, goes, with that line, and whether it's said back to what it did, under which request. */
  readonly following?: Array<string>
  /** What the Responder hands to yapd's assistant, rather than pass on. */
  readonly handsOver?: (heard: string) => boolean
  /** Where what's handed over goes, and what's said right after a late line, once the assistant's made, as yapd serves it. */
  readonly handing?: { over?: Assistant.Assistant["Type"]["over"]; following?: Assistant.Assistant["Type"]["following"] }
} = {}) => Effect.gen(function* () {
  /** What each rendered file says, and what was played, in order. */
  const rendered = new Map<string, string>()
  const played: Array<string> = []
  /** How far into each line it was played from, in seconds, in order. */
  const playedFrom: Array<number> = []
  const stopped: Array<string> = []
  /** What happened to follow-ups and the hooks that wait for them, in order. */
  const followUps: Array<string> = []
  const condensed: Array<Turn> = []
  /** The project each turn was summed up in, in order. */
  const projects: Array<string> = []
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
    options.journal === undefined ? Journal.memory : Layer.succeed(Journal.Journal, options.journal),
    Layer.succeed(Condenser, {
      condense: (project, turn) => options.unsummarizable?.includes(turn.message) ? Effect.fail(new CondenseError({ cause: "the model is down" })) : Effect.sync(() => {
        condensed.push(turn)
        projects.push(project)
        return {
          priority: options.trivialMessages?.includes(turn.message)
            ? "trivial" as const
            : options.urgentMessages?.includes(turn.message)
              ? "needs-you" as const
              : options.progressMessages?.includes(turn.message)
                ? "progress" as const
                : "done" as const,
          spoken: turn.message,
          ...(options.mores?.[turn.message] === undefined ? {} : { more: options.mores[turn.message] }),
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
      play: (path, from = 0) =>
        Effect.gen(function* () {
          const text = rendered.get(path) ?? path
          if (options.unplayable?.includes(text)) return yield* new AudioError({ message: "The audio helper didn't start playing" })
          played.push(text)
          playedFrom.push(from)
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
      tick: Effect.void,
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
      ready: Effect.succeed(true),
    }),
    Layer.succeed(Responder, {
      respond: (interruption) => {
        const { heard } = interruption
        const fast = options.quickly === true ? Effect.runSync(quick(interruption, Effect.succeed("On it."))) : undefined
        return fast !== undefined
          ? Effect.succeed({ reply: fast, source: "quick" as const })
          : says === undefined
          ? Effect.die("nothing to respond to")
          : Effect.sync(() => void responded.push(heard)).pipe(
              Effect.zipRight(Effect.sleep(`${options.thinking ?? 0} seconds`)),
              Effect.as({
                reply:
                  options.handsOver?.(heard) === true
                    ? { intent: "assistant" as const, spoken: "", message: "" }
                    : options.dismiss === true
                    ? { intent: "dismiss" as const, spoken: "", message: "" }
                    : options.answer === undefined
                      ? { intent: "send" as const, spoken: "Okay, passed on.", message: heard }
                      : { intent: "answer" as const, spoken: options.answer, message: "" },
                source: "model" as const,
              }),
            )
      },
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
  /** Turning yapd off as the menu does, once it's made. */
  let switchOff: Effect.Effect<void> = Effect.void
  const made = yield* Daemon.make({
    ...(options.linked !== undefined
      ? { link: options.linked }
      : options.link === undefined
        ? {}
        : { link: (session: string, cwd: string) => Effect.map(options.link!(session, cwd), Option.map((ref): Threads.Linked => ({ _tag: "Thread", ref }))) }),
    ...(options.hands === undefined ? {} : { hands: options.hands }),
    ...(options.mutes === undefined ? {} : { mutes: options.mutes }),
    ...(options.owner === undefined
      ? {}
      : { owner: (host: string, session: string, cwd: string) => Effect.map(options.owner!(host, session, cwd), Option.map((ref): Threads.Linked => ({ _tag: "Thread", ref }))) }),
    ...(options.outside === undefined ? {} : { outside: options.outside }),
    ...(options.sent === undefined ? {} : { sent: options.sent }),
    ...(options.began === undefined ? {} : { began: options.began }),
    ...(options.holding === undefined ? {} : { holding: options.holding }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.command === undefined ? {} : { command: options.command }),
    // As the menu turns it off, which yapd serves with more around it.
    ...(options.off === true ? { off: Effect.suspend(() => switchOff) } : {}),
    ...(options.finishing === undefined ? {} : { finishing: options.finishing }),
    ...(options.ending === undefined ? {} : { ending: options.ending }),
    ...(options.following === undefined
      ? {}
      : {
          following: (_: unknown, line: string, done?: Brain.Done) => (heard: string) =>
            Effect.succeed(
              Option.some(
                Effect.sync(() => {
                  const change = done?.change
                  options.following?.push(`${line} ${heard}${change === undefined ? "" : `, after what it did${change.what === "acted" ? ` under ${change.utterance}` : ""}`}`)
                }),
              ),
            ),
        }),
    // This machine is Rosie, as yapd serves it.
    naming,
    ...(options.handing === undefined
      ? {}
      : {
          over: (update: Conversation.Update, lines: ReadonlyArray<Line>, line: string, given: Assistant.Over) => (heard: string, voiced: number, echo?: string, afterPause?: string, unsaid?: string) =>
            Effect.suspend(() => options.handing!.over!(update, lines, line, given)(heard, voiced, echo, afterPause, unsaid)),
          ...(options.following !== undefined
            ? {}
            : {
                following: (update: Conversation.Update, line: string, done?: Brain.Done, own?: Brain.Own) =>
                  (heard: string, voiced: number, echo?: string, afterPause?: string, unsaid?: string, carried?: boolean) =>
                    Effect.suspend(() => options.handing!.following!(update, line, done, own)(heard, voiced, echo, afterPause, unsaid, carried)),
              }),
        }),
  }).pipe(Effect.provide(context))
  switchOff = made.turn(false)
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
      /** What of the question it hadn't said yet, each time it's given what was said to it, as it's told that. */
      readonly unheard?: Array<string | undefined>
      readonly gone?: Array<string>
      readonly followUp?: Array<string>
      /** With `followUp`, whether it's followed up only from its end, said unasked, and how long it's listened to after. */
      readonly after?: boolean
      readonly unasked?: boolean
      readonly window?: Duration.DurationInput
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
            ...(options.after === true ? { after: true as const } : {}),
            ...(options.unasked === true ? { unasked: true as const } : {}),
            ...(options.window === undefined ? {} : { window: options.window }),
          }),
      ...(options.question === undefined
        ? {}
        : {
            question: {
              answer: (heard: string, _voiced: number, _echo?: string, _afterPause?: string, unsaid?: string) =>
                Effect.sync(() => {
                  options.unheard?.push(unsaid)
                  return options.answers === undefined ? Option.none() : Option.some(Effect.sync(() => void options.answers?.push(`${id}: ${heard}`)))
                }),
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
  return { responded, listened, microphone, made, handle, finish, turn, notice, lastHeard: made.lastHeard, speak, talk, followUps, wait, dictate, record, reading, played, playedFrom, stopped, condensed, projects, logged, warnings, nextEvent, nextPlayback: Queue.take(playbacks), rests: () => rests, warms: () => warms, renders: () => rendered.size, flush, toggle, power: made.turn, heard, replay: made.replay, awaiting: made.awaiting.pipe(Effect.map((arrived) => arrived.pipe(Effect.zipRight(flush)))), journal: Context.get(context, Journal.Journal) }
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
    /** How many commands were sent to T3 Code, whether they got there or not. */
    dispatched: () => dispatched.length,
    /** Every command T3 Code was sent, by thread and what it was. */
    commands: () => dispatched.map(({ threadId, type }) => `${String(threadId)}: ${String(type)}`),
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
    const ledger = options.t3?.ledger ?? Ledger.fromStore(store)
    const drafts = yield* Drafts.make({ machines: [], rules: Effect.succeed(Option.none()), recent: Effect.succeed([]) }).pipe(
      Effect.provideService(Writer, { decide: () => Effect.never, prepare: Effect.void }),
      Effect.provide(Persona.Plain),
    )
    const asked: Array<Brain.Situation> = []
    const show = yield* Show.make(threads.detail, () => Effect.void)
    const making = (given: Partial<Parameters<typeof Assistant.make>[0]> = {}) => Assistant.make({
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
      ...given,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Brain.Brain, {
            decide: (situation) =>
              Effect.sync(() => {
                asked.push(situation)
                return model(situation)
              }).pipe(Effect.zipLeft(deciding(situation))),
            // As the model is asked to: what he missed, from what it's given.
            brief: (brief) => Effect.succeed(`You missed this: ${brief.groups.flatMap(({ rows }) => rows.map(({ said }) => said)).join(" ")}`),
          }),
          Persona.Plain,
        ),
      ),
    )
    const assistant = yield* making()
    if (options.handing !== undefined) {
      options.handing.over = assistant.over
      options.handing.following = assistant.following
    }
    /** The assistant as yapd restarted would have it, on the same journal, with nothing waiting to be read or being told. */
    const restarted = making({ upcoming: Effect.succeed([]), telling: Effect.succeed([]) })
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
    return { ...daemon, assistant, asked, dictating, show, restarted }
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
        // Said to the end, and nothing more said over it, for as long as it's listened to after.
        yield* wait(10)
        yield* wait(6)
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
    // The two quick ones were skipped as such.
    const [pr, loader, merged] = [
      { at: first, message: "The PR is ready." },
      { at: other, message: "The loader is fixed.", skipped: "quick" as const },
      { at: second, message: "Done, it's merged.", skipped: "quick" as const },
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
        return { played: [...played], logged: logged.filter((line) => line.includes("4f9a8b7c6d5e") || line.includes("a secret away")) }
      }),
    )
    expect(result).toEqual(
      on
        ? { played: ["I won't keep sk-live-4f9a8b7c6d5e, sir. Type it into T3 Code."], logged: ["Ready: something that could give a secret away"] }
        : { played: [], logged: ["Not saying something that could give a secret away, since yapd is off"] },
    )
  })

  test("what came of a request held back as a secret is said, but never logged, whatever its words", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, played, logged } = yield* make()
        const { turns } = yield* made.power
        // Nothing in it looks like a secret, but it may give his away all the same.
        const spoken = "I won't keep the one that starts four f nine a, sir."
        yield* made.tell({ id: "n1", kind: "answer", priority: "needs-you", spoken, at: yield* Clock.currentTimeMillis, stale: Effect.succeed(false), withheld: true }, turns)
        yield* wait(5)
        return { played: [...played], logged: logged.filter((line) => line.includes("four f nine a") || line.includes("a secret away")) }
      }),
    )
    expect(result).toEqual({ played: ["I won't keep the one that starts four f nine a, sir."], logged: ["Ready: something that could give a secret away"] })
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

  test("a turn no hook told of is said like a hook's update, once under its key, and kept unheard, never said, once yapd was turned off since", async () => {
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
        // One heard of before yapd was turned off and on isn't said, but kept for him to catch up on.
        yield* made.turn(false)
        yield* made.turn(true)
        yield* loader(turns, "run-2")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: updates.map(({ machine, thread, key, detail }) => [machine, thread, key, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played.toSorted()).toEqual(["The loader wants your go-ahead.", "yapd. Something else first.", "yapd. The loader is fixed, run-1."])
    // Kept with its thread, and the one never said kept as unheard, from while yapd was off.
    expect(result.kept.slice(1)).toEqual([
      ["Rosie", "t-loader", "done:Rosie:run-1", undefined],
      ["Rosie", "t-loader", "done:Rosie:run-2", "off"],
    ])
  })

  test("a turn no hook told of, handed on after yapd was turned off and on, is kept unheard once, and not said when T3 Code tells of it again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, wait, played, journal } = yield* make()
        const before = (yield* made.power).turns
        yield* made.turn(false)
        yield* made.turn(true)
        yield* made.finished(unhooked("The loader is fixed.", "run-1", before))
        yield* wait(11)
        // As after a reconnect.
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: updates.map(({ key, heardAt, detail }) => [key, heardAt, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.kept).toEqual([["done:Rosie:run-1", undefined, "off"]])
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
            run: { status: "completed", final: words, others: [words], natives: ["native-loader"], previous: Option.none(), userMessageId: Option.none(), startedAt: 0 },
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
    // Its Stop tells less than it did, so it isn't taken for all of it: what he didn't hear of it is still his to catch up on, told twice at worst.
    const said = { played: [fallback, "yapd. The loader is fixed."], through: [], missed: [fallback] }
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

  test("what he says over a question goes to it with what it hadn't said yet a moment before he began, and nothing of that once all of it was said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, speak, wait } = yield* make("Ghostnet.")
        const answers: Array<string> = []
        const unheard: Array<string | undefined> = []
        // Over it three seconds in, which stops it at two of its ten; then after another, once it's been said to the end.
        yield* notice("over", "Which network first? Mainnet or Ghostnet?", { question: [], answers, unheard })
        yield* wait(3)
        yield* speak
        yield* wait(11)
        yield* notice("after", "Which network first? Mainnet or Ghostnet?", { question: [], answers, unheard })
        yield* wait(11)
        yield* speak
        yield* wait(11)
        return { answers, unheard }
      }),
    )
    expect(result).toEqual({ answers: ["over: Ghostnet.", "after: Ghostnet."], unheard: ["network first? Mainnet or Ghostnet?", undefined] })
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
        // Turned off as one is said and another waits, and told one of its own accord while it's off.
        yield* notice("playing", "The Tezos migration is comparing request formats, sir.", { answer: true, gone })
        yield* notice("waiting", "Two running, sir.", { answer: true, gone })
        yield* wait(2)
        yield* toggle(false)
        yield* notice("off", "The Tezos migration failed.", { gone })
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

  test("an update said again for the menu's row carries that row's key as what he hears, which one said again otherwise doesn't", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, heard, replay, lastHeard, played } = yield* daemon
        yield* finish("a", "The PR is ready.")
        yield* wait(11)
        const [id] = yield* heard
        const rows: Array<string> = []
        const hearing = Effect.flatMap(lastHeard, (last) => Effect.sync(() => void rows.push(Option.match(last, { onNone: () => "nothing", onSome: ({ menu }) => menu ?? "as heard" }))))
        yield* hearing
        yield* replay(id!, "t3:Rosie:t-tezos")
        yield* wait(0)
        yield* hearing
        yield* wait(11)
        yield* replay(id!)
        yield* wait(0)
        yield* hearing
        return { rows, played: [...played] }
      }),
    )
    expect(result.rows).toEqual(["as heard", "t3:Rosie:t-tezos", "as heard"])
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready.", "yapd. The PR is ready."])
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

  test("an update he heard only the headline of, cut off by turning yapd off, is said again in full, its rest too, before it counts as heard", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, played, heard, replay, journal, lastHeard } = yield* make(undefined, { mores: { "The PR is ready.": "Two review comments are left." } })
        yield* finish("a", "The PR is ready.")
        const [id] = yield* heard
        yield* toggle(false)
        yield* toggle(true)
        const queued = yield* replay(id!, "t3:Rosie:t-tezos")
        yield* wait(0)
        // Being said, it isn't heard yet.
        const saying = (yield* journal.unheard(0, 12)).length
        yield* wait(11)
        const last = yield* lastHeard
        return {
          queued,
          saying,
          played: [...played],
          after: (yield* journal.unheard(0, 12)).length,
          said: Option.map(last, ({ said }) => said),
          more: Option.map(last, ({ update }) => update.more),
        }
      }),
    )
    expect(result).toMatchObject({ queued: "queued", saying: 1, after: 0 })
    expect(result.played).toEqual(["yapd. The PR is ready.", "yapd. The PR is ready. Two review comments are left."])
    // What "say that again" repeats is all of it, with nothing left for "more".
    expect(result.said).toEqual(Option.some("yapd. The PR is ready. Two review comments are left."))
    expect(result.more).toEqual(Option.some(undefined))
  })

  test("a question kept unheard in its hook's place as yapd was off, then asked by its Stop come late and cut off by turning yapd off, is heard once that's said again from the menu, so catching up never asks it again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, played, heard, replay, journal, nextPlayback } = yield* make(undefined, {
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }),
        })
        // T3 Code tells of the loader's turn, which asks him something, while yapd is off: it's kept for him to catch up on.
        yield* toggle(false)
        yield* made.finished(unhooked("Which network first?", "run-1", (yield* made.power).turns))
        yield* wait(11)
        const kept = (yield* journal.unheard(0, 60)).map(({ said }) => said)
        // On again, its own Stop comes late with the same question, which is asked, and turning yapd off cuts it off.
        yield* toggle(true)
        yield* handle(
          "claude",
          { hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: "Which network first?", needs_you: true },
          { project: "yapd", host: hostname() },
          false,
        )
        yield* nextPlayback
        yield* toggle(false)
        yield* toggle(true)
        // Asked for again from the menu, it's said to the end.
        const [id] = yield* heard
        const queued = yield* replay(id!, "t3:Rosie:t-loader")
        yield* wait(0)
        yield* wait(11)
        return { kept, queued, played: [...played], missed: (yield* journal.unheard(0, 60)).map(({ said }) => said) }
      }),
    )
    expect(result.kept).toEqual(["yapd. Which network first?"])
    expect(result.queued).toBe("queued")
    expect(result.played).toEqual(["yapd. Which network first?", "yapd. Which network first?"])
    // So catching up doesn't ask it again, as what T3 Code told of it.
    expect(result.missed).toEqual([])
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
        const { finish, wait, toggle, dictating, played, asked, journal } = yield* assisted(() => Brain.decision({ act: "catchup" }))
        yield* finish("a", "The loader fix is ready.")
        yield* wait(2)
        // Turned off and on before it's read to the end, so he missed it.
        yield* toggle(false)
        yield* toggle(true)
        yield* finish("b", "The tests pass.")
        yield* wait(2)
        yield* dictating("What did I miss?")
        for (let i = 0; i < 4; i++) yield* wait(11)
        return { told: asked.at(-1)?.missed.groups.flatMap(({ rows }) => rows.map(({ said }) => said)), played: [...played], unheard: (yield* journal.unheard(0, 12)).length }
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

  test("what's being read isn't missed while it's read: a catch-up typed meanwhile doesn't tell it again, nor is it counted, an update or a notice", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, made, assistant, played, journal, asked } = yield* assisted(() => Brain.decision({ act: "catchup" }))
        yield* finish("a", "The Tezos importer tests pass.")
        yield* wait(2)
        const counted = yield* assistant.missed
        const { turns } = yield* made.power
        yield* assistant.heard({ heard: "Catch me up.", via: "typed", at: yield* Clock.currentTimeMillis, voiced: Number.POSITIVE_INFINITY, turns })
        for (let i = 0; i < 2; i++) yield* wait(11)
        // A failure being said, kept under its entry as it's said.
        const failure = Option.getOrThrow(yield* journal.write({ at: yield* Clock.currentTimeMillis, kind: "notice", thread: "t-loader", key: "fail:r1", said: "The loader failed.", detail: { failure: "provider_error" } }))
        yield* made.tell({ id: "n1", kind: "notice", priority: "needs-you", spoken: "The loader failed.", at: yield* Clock.currentTimeMillis, stale: Effect.succeed(false), telling: Effect.succeed([failure]) }, turns)
        yield* wait(1)
        const notice = yield* assistant.missed
        return { counted: counted.groups.length, told: asked.at(-1)?.missed.groups.length, played: [...played], notice: notice.groups.length }
      }),
    )
    expect(result).toEqual({ counted: 0, told: 0, played: ["yapd. The Tezos importer tests pass.", "You're all caught up.", "The loader failed."], notice: 0 })
  })

  test("a catch-up waiting to be said, or being said, keeps what it tells of from a second one asked meanwhile, as from the menu's count", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, made, assistant, played, journal } = yield* assisted(() => Brain.decision({ act: "catchup" }))
        yield* journal.write({ at: yield* Clock.currentTimeMillis, kind: "update", thread: "claude:dist", project: "yapd", said: "Distribox copied the EU bucket.", detail: { priority: "done", held: "off" } })
        yield* finish("a", "The Tezos importer tests pass.")
        yield* wait(2)
        const { turns } = yield* made.power
        const typed = Effect.flatMap(Clock.currentTimeMillis, (at) => assistant.heard({ heard: "Catch me up.", via: "typed", at, voiced: Number.POSITIVE_INFINITY, turns }))
        // Asked twice from the menu while the update is read, the first catch-up waiting behind it.
        yield* typed
        const waiting = (yield* assistant.missed).groups.length
        yield* typed
        for (let i = 0; i < 3; i++) yield* wait(11)
        return { waiting, played: [...played], unheard: (yield* journal.unheard(0, 12)).length }
      }),
    )
    expect(result).toEqual({
      waiting: 0,
      played: ["yapd. The Tezos importer tests pass.", "You missed this: Distribox copied the EU bucket.", "You're all caught up."],
      unheard: 0,
    })
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

  test.each(["a follow-up", "silence"])("an answer said to the end is listened to after, longer than an update is, and what's next waits for %s", async (after) => {
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
        yield* wait(5)
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
        yield* wait(6)
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
            return Brain.decision({ act: "catchup" })
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
    expect(result.again).toEqual([when === "over" ? "You missed this: yapd. The loader fix is ready." : "You're all caught up."])
  })

  test("thanks after the answer to a follow-up said over a catch-up answer still leaves what he missed to be told", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, toggle, dictating, speak, played } = yield* assisted(
          (situation) => {
            if (situation.utterance.via === "reply") return Brain.decision({ act: "answer", spoken: "A review, sir." })
            return Brain.decision({ act: "catchup" })
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
            return Brain.decision({ act: "catchup" })
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
            return Brain.decision({ act: "catchup" })
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
    ["What did I miss?", Brain.decision({ act: "catchup" }), "catch-up"],
    ["What's going on?", Brain.decision({ act: "answer", spoken: "Two things are running, sir." }), undefined],
  ])("thanks said to the answer to %s is noted as catching up only when the model took it for that", async (asked, decided, over) => {
    const result = await run(
      Effect.gen(function* () {
        const { dictating, wait, speak, journal } = yield* assisted(() => decided, {
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

describe("Daemon headline first", () => {
  test("what was said last of the same work goes to the summary, by its session, so progress can be told from news", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, condensed } = yield* daemon
        yield* finish("review", "Pass 6 found nothing new.")
        yield* wait(11)
        yield* wait(60)
        yield* finish("review", "Pass 7 is running.")
        yield* wait(11)
        yield* finish("other", "The Mina tickets are open.")
        yield* wait(11)
        return condensed.map(({ message, previous }) => [message, previous === undefined ? undefined : [previous.said, Math.round(previous.ago)]])
      }),
    )
    expect(result).toEqual([
      ["Pass 6 found nothing new.", undefined],
      ["Pass 7 is running.", ["yapd. Pass 6 found nothing new.", 1]],
      ["The Mina tickets are open.", undefined],
    ])
  })

  test("only the headline is said, its rest kept for more, while what needs him is said in full, question and all", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, played, journal, lastHeard } = yield* make(undefined, {
          urgentMessages: ["Which network first?"],
          mores: { "The loader is fixed.": "Retries back off now, and the flaky test is gone.", "Which network first?": "Tezos has its fee table ready, Mina doesn't." },
        })
        yield* finish("loader", "The loader is fixed.")
        yield* wait(5)
        const playing = Option.map(yield* lastHeard, ({ update }) => update.more)
        yield* wait(6)
        yield* finish("ask", "Which network first?")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], playing, kept: updates.map(({ said, detail }) => [said, (detail as { more?: string }).more]) }
      }),
    )
    expect(result.played).toEqual(["yapd. The loader is fixed.", "yapd. Which network first? Tezos has its fee table ready, Mina doesn't."])
    expect(result.playing).toEqual(Option.some("Retries back off now, and the flaky test is gone."))
    expect(result.kept).toEqual([
      ["yapd. The loader is fixed.", "Retries back off now, and the flaky test is gone."],
      ["yapd. Which network first? Tezos has its fee table ready, Mina doesn't.", undefined],
    ])
  })

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

  test("'give me everything' says updates in full and holds no progress, and 'talk shorter' goes back to headlines", async () => {
    const result = await run(
      Effect.gen(function* () {
        let detail: "brief" | "full" = "full"
        const { finish, wait, played, journal } = yield* make(undefined, {
          detail: Effect.sync(() => detail),
          progressMessages: ["Pass 7 is running."],
          mores: { "Pass 7 is running.": "Two comments are left.", "The loader is fixed.": "Retries back off now." },
        })
        yield* finish("review", "Pass 7 is running.")
        yield* wait(11)
        yield* finish("loader", "The loader is fixed.")
        yield* wait(11)
        detail = "brief"
        yield* finish("review", "Pass 7 is running.")
        yield* wait(11)
        yield* finish("loader", "The loader is fixed.")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: updates.map(({ detail }) => [(detail as { priority: string }).priority, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual(["yapd. Pass 7 is running. Two comments are left.", "yapd. The loader is fixed. Retries back off now.", "yapd. The loader is fixed."])
    // In full, progress is said as finished work is.
    expect(result.kept).toEqual([
      ["done", undefined],
      ["done", undefined],
      ["progress", "progress"],
      ["done", undefined],
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

  test("a muted thread stays muted in focus rather than held, so it never comes up as held for later", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, wait, played, journal } = yield* make(undefined, { mutes, holding: Effect.succeed(Option.some("quiet" as const)) })
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* finish("noisy", "Still going.")
        yield* wait(11)
        yield* finish("other", "The Mina tickets are open.")
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: updates.map((kept) => [kept.said, quieted(kept), (kept.detail as { held?: string }).held]), held: (yield* journal.held(0)).map(({ said }) => said) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.kept).toEqual([
      ["yapd. Still going.", true, undefined],
      ["yapd. The Mina tickets are open.", false, "quiet"],
    ])
    expect(result.held).toEqual(["yapd. The Mina tickets are open."])
  })

  test("entering focus drops what waits to be said as held, but never what needs him, what he asked to hear again, a notice, or the line being said", async () => {
    const result = await run(
      Effect.gen(function* () {
        let mode = Option.none<"focus" | "quiet">()
        const { made, finish, notice, wait, played, followUps, journal, heard, replay } = yield* make(undefined, {
          holding: Effect.sync(() => mode),
          urgentMessages: ["The tests failed."],
        })
        yield* finish("noisy", "Earlier news.", true)
        yield* wait(11)
        const [earlier] = yield* heard
        yield* finish("playing", "Something long.")
        yield* finish("noisy", "Still going.", true)
        yield* finish("other", "The Mina tickets are open.")
        yield* finish("urgent", "The tests failed.")
        yield* notice("t3:Rosie:t-noisy", "The noisy thread wants your go-ahead.")
        yield* replay(earlier!)
        yield* wait(0)
        mode = Option.some("focus")
        yield* made.hold("focus")
        for (let i = 0; i < 6; i++) yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], followUps: [...followUps], kept: updates.map(({ said, detail }) => [said, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual([
      "yapd. Earlier news.",
      "yapd. Something long.",
      "yapd. The tests failed.",
      "yapd. Earlier news.",
      "The noisy thread wants your go-ahead.",
    ])
    expect(result.followUps).toEqual(["claude:noisy let go"])
    expect(result.kept).toEqual([
      ["yapd. Earlier news.", undefined],
      ["yapd. Something long.", undefined],
      ["yapd. Still going.", "focus"],
      ["yapd. The Mina tickets are open.", "focus"],
      ["yapd. The tests failed.", undefined],
    ])
  })

  test("a dictation in focus cutting off an update reads what needs him again after, while finished work is held for later", async () => {
    const result = await run(
      Effect.gen(function* () {
        let mode = Option.none<"focus" | "quiet">()
        const { made, finish, wait, dictate, played, journal } = yield* make(undefined, { holding: Effect.sync(() => mode), urgentMessages: ["Which network first?"] })
        yield* finish("tezos", "The migration compiles.")
        yield* wait(1)
        // Focus begins as it's said, which never stops the line being said.
        mode = Option.some("focus")
        yield* made.hold("focus")
        const first = yield* dictate
        yield* wait(2)
        yield* Scope.close(first, Exit.void)
        yield* wait(11)
        yield* finish("ask", "Which network first?")
        yield* wait(1)
        const second = yield* dictate
        yield* wait(2)
        yield* Scope.close(second, Exit.void)
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: updates.map(({ said, detail }) => [said, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual(["yapd. The migration compiles.", "yapd. Which network first?", "yapd. Which network first?"])
    expect(result.kept).toEqual([
      ["yapd. The migration compiles.", "focus"],
      ["yapd. Which network first?", undefined],
    ])
  })

  test("what its hook says needs him is said in full, though the summary takes it for finished work", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { turn, wait, played, journal } = yield* make(undefined, { mores: { "Pick a network.": "Tezos has its fee table ready, Mina doesn't." } })
        yield* turn("ask", "Pick a network.", 120, { needsYou: true })
        yield* wait(11)
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: updates.map(({ detail }) => (detail as { more?: string }).more) }
      }),
    )
    expect(result.played).toEqual(["yapd. Pick a network. Tezos has its fee table ready, Mina doesn't."])
    expect(result.kept).toEqual([undefined])
  })

  test("focus begun while an update is rendered holds it, never said", async () => {
    const result = await run(
      Effect.gen(function* () {
        let mode = Option.none<"focus" | "quiet">()
        const { finish, wait, played, journal } = yield* make(undefined, { holding: Effect.sync(() => mode), renderSeconds: 5 })
        yield* finish("tezos", "The fee table is in.")
        yield* wait(1)
        mode = Option.some("focus")
        yield* wait(15)
        return { played: [...played], held: (yield* journal.held(0)).map(({ said, detail }) => [said, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.held).toEqual([["yapd. The fee table is in.", "focus"]])
  })

  test("focus begun while an update is rendered, then yapd turned off, holds it as what came in while off, for him to catch up on, never for the digest", async () => {
    const result = await run(
      Effect.gen(function* () {
        let mode = Option.none<"focus" | "quiet">()
        const { finish, wait, toggle, played, journal } = yield* make(undefined, { holding: Effect.sync(() => mode), renderSeconds: 5 })
        yield* finish("tezos", "The fee table is in.")
        yield* wait(1)
        mode = Option.some("focus")
        yield* toggle(false)
        yield* wait(15)
        yield* toggle(true)
        yield* wait(11)
        return { played: [...played], held: (yield* journal.held(0)).map(({ said, detail }) => [said, (detail as { held?: string }).held]) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.held).toEqual([["yapd. The fee table is in.", "off"]])
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

  test("'more' over a headline, or just after it, plays the rest at once without the model, rendered once as the headline began", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, speak, wait, nextPlayback, played, renders, responded, journal } = yield* make("More.", {
          quickly: true,
          mores: { "The loader is fixed.": "Retries back off now.", "The Mina tickets are open.": "Three of them are for the fee table." },
        })
        yield* finish("loader", "The loader is fixed.")
        yield* nextPlayback
        yield* wait(2)
        yield* speak
        yield* wait(14)
        yield* finish("mina", "The Mina tickets are open.")
        yield* nextPlayback
        // Once it has said all of it, in the moment left for a reply.
        yield* wait(10)
        yield* speak
        yield* wait(14)
        const replies = yield* journal.since(0, { kinds: ["reply"] })
        return { played: [...played], renders: renders(), responded: [...responded], replies: replies.map(({ said, detail }) => [said, (detail as { intent: string }).intent]) }
      }),
    )
    expect(result.played).toEqual(["yapd. The loader is fixed.", "Retries back off now.", "yapd. The Mina tickets are open.", "Three of them are for the fee table."])
    // Each headline and each rest once.
    expect(result.renders).toBe(4)
    expect(result.responded).toEqual([])
    expect(result.replies).toEqual([
      ["Retries back off now.", "answer"],
      ["Three of them are for the fee table.", "answer"],
    ])
  })

  test("'more' begun while yapd's own voice could still get into the microphone is the model's to make something of", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, speak, wait, nextPlayback, responded } = yield* make("More.", {
          quickly: true,
          echoing: 1000,
          answer: "Retries back off now.",
          mores: { "The loader is fixed.": "Retries back off now." },
        })
        yield* finish("loader", "The loader is fixed.")
        yield* nextPlayback
        yield* speak
        yield* wait(14)
        return { responded: [...responded] }
      }),
    )
    expect(result.responded).toEqual(["More."])
  })

  test("the rest the model gives for 'more' with him addressed is played as it was rendered as the headline began, not rendered again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, speak, wait, nextPlayback, played, renders } = yield* make("More.", {
          quickly: true,
          echoing: 1000,
          answer: "Sir, retries back off now.",
          mores: { "The loader is fixed.": "Retries back off now." },
        })
        yield* finish("loader", "The loader is fixed.")
        yield* nextPlayback
        yield* speak
        yield* wait(14)
        return { played: [...played], renders: renders() }
      }),
    )
    expect(result.played).toEqual(["yapd. The loader is fixed.", "Retries back off now."])
    expect(result.renders).toBe(2)
  })

  test("an update he heard keeps its id across a restart, and is said again in full, its rest too, with none left for more", async () => {
    const result = await run(
      Effect.gen(function* () {
        const journal = Journal.fromStore(yield* Store.make(":memory:"))
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const { finish, wait, heard } = yield* make(undefined, { journal, mores: { "The loader is fixed.": "Retries back off now." } })
            yield* finish("loader", "The loader is fixed.")
            yield* wait(11)
            // Held as progress, he never heard it, so it isn't one to hear again.
            yield* journal.write({ at: 30_000, kind: "update", thread: "claude:review", project: "yapd", said: "yapd. Pass 7 is running.", detail: { held: "progress" } })
            return yield* heard
          }),
        )
        const rows = yield* journal.since(0, { kinds: ["update"] })
        const { heard, replay, wait, played, lastHeard } = yield* make(undefined, { journal })
        const after = yield* heard
        const replayed = yield* replay(after[0]!)
        yield* wait(11)
        return { before, after, rows: rows.map(({ id }) => String(id)), replayed, played: [...played], more: Option.map(yield* lastHeard, ({ update }) => update.more) }
      }),
    )
    expect(result.before).toEqual([result.rows[0]!])
    expect(result.after).toEqual(result.before)
    expect(result.replayed).toBe("queued")
    expect(result.played).toEqual(["yapd. The loader is fixed. Retries back off now."])
    expect(result.more).toEqual(Option.some(undefined))
  })

  test("the updates he heard last are kept through a restart however many were kept quiet or held since", async () => {
    const result = await run(
      Effect.gen(function* () {
        const journal = Journal.fromStore(yield* Store.make(":memory:"))
        const ids: Array<string> = []
        for (let i = 1; i <= 5; i++) {
          const id = yield* journal.write({ at: i * 1000, kind: "update", thread: `claude:s${i}`, project: "yapd", said: `yapd. Update ${i}.`, heardAt: i * 1000 + 500 })
          ids.unshift(String(Option.getOrThrow(id)))
        }
        // A noisy muted thread, progress held for the digest and a night in quiet.
        for (let i = 0; i < 60; i++) {
          yield* journal.write({ at: 10_000 + i, kind: "update", thread: "claude:noisy", project: "yapd", said: "yapd. Still going.", detail: i % 2 === 0 ? { muted: true } : { held: "progress" } })
        }
        const { heard } = yield* make(undefined, { journal })
        return { ids, heard: yield* heard }
      }),
    )
    expect(result.heard).toEqual(result.ids)
  })

  test("muting a thread keeps quiet what of it was held for later, so neither the digest nor the rundown brings it up", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, wait, journal } = yield* make(undefined, { mutes, progressMessages: ["Lint is still running.", "Tests are still running."] })
        yield* finish("noisy", "Lint is still running.")
        yield* wait(11)
        yield* finish("other", "Tests are still running.")
        yield* wait(11)
        const before = (yield* journal.held(0)).map(({ said }) => said)
        const controls = Option.getOrThrow(made.controls)
        yield* controls.mute({ key: sessionKey("noisy") })
        const updates = yield* journal.since(0, { kinds: ["update"] })
        return { before, after: (yield* journal.held(0)).map(({ said }) => said), quiet: updates.map((kept) => [kept.said, quieted(kept)]) }
      }),
    )
    expect(result.before).toEqual(["yapd. Lint is still running.", "yapd. Tests are still running."])
    expect(result.after).toEqual(["yapd. Tests are still running."])
    expect(result.quiet).toEqual([
      ["yapd. Lint is still running.", true],
      ["yapd. Tests are still running.", false],
    ])
  })

  test("progress held of work he's since been told the outcome of is out of date, and never comes up in the digest", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, wait, journal, played } = yield* make(undefined, { progressMessages: ["Pass 7 is running.", "The Mina checks are running."] })
        yield* finish("review", "Pass 7 is running.")
        yield* wait(11)
        yield* finish("mina", "The Mina checks are running.")
        yield* wait(11)
        yield* finish("review", "The review is clean and merged.")
        yield* wait(11)
        return { played: [...played], held: (yield* journal.held(0)).map(({ said }) => said) }
      }),
    )
    expect(result.played).toEqual(["yapd. The review is clean and merged."])
    expect(result.held).toEqual(["yapd. The Mina checks are running."])
  })

  test("a reply to an update heard before a restart, tied to its thread, reaches that thread through T3 Code", async () => {
    const result = await run(
      Effect.gen(function* () {
        const journal = Journal.fromStore(yield* Store.make(":memory:"))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { handle, wait } = yield* make(undefined, { journal, link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }) })
            yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
            yield* wait(11)
          }),
        )
        const t3 = yield* handing
        const { heard, replay, speak, wait, nextPlayback, followUps } = yield* make("Use the fee table.", { journal, hands: t3.hands })
        yield* replay((yield* heard)[0]!)
        yield* nextPlayback
        yield* speak
        yield* wait(4)
        return { sent: t3.sent(), relayed: [...followUps], told: yield* nextPlayback }
      }),
    )
    expect(result.sent).toEqual(["t-tezos: Use the fee table."])
    expect(result.relayed).toEqual([])
    expect(result.told).toBe("Okay, passed on.")
  })

  test("words that change how yapd talks, said over an update, plainly his, change it there and never reach the agent or the model", async () => {
    const result = await run(
      Effect.gen(function* () {
        const changed: Array<string> = []
        const { finish, talk, wait, played, responded, followUps } = yield* make("Focus.", {
          command: (heard) =>
            heard === "Focus." ? Option.some(Effect.sync(() => void changed.push("focus")).pipe(Effect.as("Only what needs you until three."))) : Option.none(),
        })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(14)
        return { played: [...played], responded: [...responded], followUps: [...followUps], changed }
      }),
    )
    expect(result.changed).toEqual(["focus"])
    expect(result.played).toEqual(["yapd. Still going.", "Only what needs you until three."])
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
  })
  for (const [words, line] of [["Focus.", "Only what needs you until three."], ["I'm back.", ""]] as const) {
    test(`"${words}" said partway through an update that needs him is done, then the update carries on, heard only once all of it is`, async () => {
      const result = await run(
        Effect.gen(function* () {
          const asked: Array<boolean> = []
          const question = "Should I keep the historical rounding or recompute?"
          const { finish, talk, wait, played, responded, followUps, journal } = yield* make(words, {
            urgentMessages: [question],
            command: (heard, asks) => {
              asked.push(asks)
              return heard === words ? Option.some(Effect.succeed(line)) : Option.none()
            },
          })
          const heardAt = Effect.map(journal.since(0, { kinds: ["update"] }), (rows) => rows.map(({ heardAt }) => heardAt))
          yield* finish("tezos", question)
          yield* wait(1)
          yield* talk
          yield* wait(5)
          const early = yield* heardAt
          yield* wait(30)
          return { played: [...played], responded: [...responded], followUps: [...followUps], early, late: yield* heardAt, asked }
        }),
      )
      expect(result.asked).toEqual([true])
      expect(result.played).toEqual(line === "" ? ["yapd. Should I keep the historical rounding or recompute?", "yapd. Should I keep the historical rounding or recompute?"] : ["yapd. Should I keep the historical rounding or recompute?", line, "yapd. Should I keep the historical rounding or recompute?"])
      expect(result.responded).toEqual([])
      expect(result.followUps).toEqual([])
      expect(result.early).toEqual([undefined])
      expect(result.late[0]).toBeNumber()
    })
  }

  test("muting the thread partway through its question is done, then the question carries on, as what needs him always comes through", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const question = "Should I keep the historical rounding or recompute?"
        const { finish, talk, wait, played, responded, followUps } = yield* make("Mute it.", { mutes, urgentMessages: [question] })
        yield* finish("tezos", question)
        yield* wait(1)
        yield* talk
        yield* wait(36)
        return { played: [...played], responded: [...responded], followUps: [...followUps], muted: (yield* mutes.list).length }
      }),
    )
    expect(result.muted).toBe(1)
    expect(result.played[0]).toBe("yapd. Should I keep the historical rounding or recompute?")
    expect(result.played.at(-1)).toBe("yapd. Should I keep the historical rounding or recompute?")
    expect(result.played).toHaveLength(3)
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
  })

  test("words that may be his answer to an update that asks him something go to the model, never taken for how yapd talks", async () => {
    const result = await run(
      Effect.gen(function* () {
        const question = "Should I write the migration guide in full or keep it short?"
        const changed: Array<string> = []
        const { finish, talk, wait, played, responded, followUps } = yield* make("Keep it short.", {
          urgentMessages: [question],
          command: (heard, asks) => Option.map(Brain.modeCommand(heard, asks), ({ how }) => Effect.sync(() => void changed.push(how)).pipe(Effect.as("I'll keep it short."))),
        })
        yield* finish("tezos", question)
        yield* wait(1)
        yield* talk
        yield* wait(20)
        return { played: [...played], responded: [...responded], followUps: [...followUps], changed }
      }),
    )
    expect(result.changed).toEqual([])
    expect(result.responded).toEqual(["Keep it short."])
    expect(result.followUps).toEqual(["tezos sent: Keep it short."])
    expect(result.played).toEqual(["yapd. Should I write the migration guide in full or keep it short?", "Okay, passed on."])
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
          run: { status: "completed", final: "The fast tests pass.", others: [], natives: ["s-tezos"], previous: Option.none(), userMessageId: Option.none(), startedAt: started },
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
          run: { status: "completed", final: "The fast tests pass.", others: [], natives: ["s-tezos"], previous: Option.none(), userMessageId: Option.none(), startedAt: ended },
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
              run: { status: "completed", final: message, others: [], natives: [], previous: Option.none(), userMessageId: Option.none(), startedAt },
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
          run: { status: "completed", final: "The fee table is in.", others: [], natives: ["tezos"], previous: Option.none(), userMessageId: Option.none(), startedAt },
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
          run: { status: "completed", final: "The fee table is in.", others: [], natives: ["tezos"], previous: Option.none(), userMessageId: Option.none(), startedAt: first },
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
          run: { status: "completed", final: "The loader is refactored.", others: [], natives: ["tezos"], previous: Option.none(), userMessageId: Option.none(), startedAt: second },
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
          run: { status: "completed", final: "The loader is refactored.", others: [], natives: ["native-loader"], previous: Option.none(), userMessageId: Option.none(), startedAt },
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
          run: { status: "completed", final: message, others: [], natives: ["tezos"], previous: Option.none(), userMessageId: Option.none(), startedAt },
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

  test("while yapd is off, a muted update is kept as muted, not as what came in while it was off, and its hook is never kept waiting", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { finish, toggle, wait, journal, followUps, played } = yield* make(undefined, { mutes })
        yield* mutes.mute({ key: sessionKey("noisy") })
        yield* toggle(false)
        yield* finish("noisy", "Still going.", true)
        yield* wait(11)
        yield* toggle(true)
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { kept: kept.map(({ said, detail }) => [said, quieted({ detail } as Journal.Kept), (detail as { held?: string }).held]), followUps: [...followUps], played: [...played] }
      }),
    )
    expect(result.kept).toEqual([["yapd. Still going.", true, undefined]])
    expect(result.followUps).toEqual([])
    expect(result.played).toEqual([])
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
    // Told of now in its own words, the turn kept quiet isn't what he missed too. In others, it may be another turn, so it's still his to hear.
    expect(result.missed).toBe(message === "Which network first?" ? 0 : 1)
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

  test("the first turn of work yapd started is said, however quick or slight, even after a restart", async () => {
    const asked = "Find out whether Apple shipped an API for third-party glucose sensors on the Watch."
    const answer = "Apple hasn't shipped one."
    const glucose = { machine: "Rosie", id: "t-glucose" }
    /** The ledger's row for starting it, written before it was asked for, with its words and the id of the message it started with. */
    const start = { at: 0, digest: Ledger.digest(asked), kind: "start" as const, messageId: "yapd:u1:0:m" }
    /** The daemon, with the thread muted and its answer what the summary takes for slight. */
    const research = Effect.gen(function* () {
      const mutes = yield* muting
      yield* mutes.mute({ key: Mutes.key.thread(glucose), called: "the glucose question" })
      return yield* make(undefined, {
        mutes,
        link: () => Effect.succeedSome(glucose),
        sent: (to, since) => Effect.succeed(Threads.same(to, glucose) ? [start].filter(({ at }) => at >= since) : []),
        trivialMessages: [answer, "Nothing more on it."],
      })
    })
    const quickly = await run(
      Effect.gen(function* () {
        const { handle, made, wait, played } = yield* research
        // Ready in a minute, it answers in five seconds, which its hook skips as a turn he was watching.
        yield* wait(60)
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-glucose", cwd: "/t3/scratch/glucose", prompt: asked }, { project: "glucose", host: hostname() }, false)
        yield* wait(5)
        const at = yield* Clock.currentTimeMillis
        yield* stopHere(handle, "s-glucose", answer)
        yield* wait(20)
        const skipped = [...played]
        // T3 Code's word that it finished, with the id of the message yapd started it with.
        // Told of outside his projects, with no project to name.
        yield* made.finished({
          ...unhooked(answer, "run-1", (yield* made.power).turns),
          about: glucose,
          project: "",
          turn: { prompt: Option.some(asked), message: answer },
          at,
          run: { status: "completed", final: answer, others: [], natives: ["s-glucose"], previous: Option.none(), userMessageId: Option.some(start.messageId), startedAt: at - 5_000 },
          answering: true,
        })
        yield* wait(11)
        return { skipped, played: [...played] }
      }),
    )
    expect(quickly).toEqual({ skipped: [], played: [answer] })
    // With no prompt seen, as after a restart, only what's kept tells: its first turn is his, and the next isn't.
    const restarted = await run(
      Effect.gen(function* () {
        const { handle, wait, played } = yield* research
        yield* wait(600)
        yield* stopHere(handle, "s-glucose", answer)
        yield* wait(11)
        yield* stopHere(handle, "s-glucose", "Nothing more on it.")
        yield* wait(11)
        return [...played]
      }),
    )
    expect(restarted).toEqual([`yapd. ${answer}`])
  })

  test("after a restart, a later turn of work yapd started isn't taken for its first when T3 Code says its run began with another message", async () => {
    const answer = "Apple hasn't shipped one."
    const glucose = { machine: "Rosie", id: "t-glucose" }
    const start = { at: 0, digest: Ledger.digest("Find out whether Apple shipped an API for glucose sensors."), kind: "start" as const, messageId: "yapd:u1:0:m" }
    /** What's said of a turn with no prompt seen, as after a restart, whose run began with `message`, in a thread he muted. */
    const said = (message: Option.Option<Option.Option<string>>) =>
      run(
        Effect.gen(function* () {
          const mutes = yield* muting
          yield* mutes.mute({ key: Mutes.key.thread(glucose), called: "the glucose question" })
          const { handle, wait, played } = yield* make(undefined, {
            mutes,
            link: () => Effect.succeedSome(glucose),
            sent: (to, since) => Effect.succeed(Threads.same(to, glucose) ? [start].filter(({ at }) => at >= since) : []),
            began: () => Effect.succeed(message),
          })
          yield* wait(600)
          yield* stopHere(handle, "s-glucose", answer)
          yield* wait(11)
          return [...played]
        }),
      )
    // Its first turn was stopped, and he typed the next himself: that one is muted like any other.
    expect(await said(Option.some(Option.some("t3:typed")))).toEqual([])
    expect(await said(Option.some(Option.none()))).toEqual([])
    // Its first turn, or one T3 Code can't say of, is his answer.
    expect(await said(Option.some(Option.some(start.messageId)))).toEqual([`yapd. ${answer}`])
    expect(await said(Option.none())).toEqual([`yapd. ${answer}`])
  })

  test("the first turn of work yapd started whose hook couldn't find its thread in time, and took it for slight, is said from T3 Code's word", async () => {
    const asked = "Find out whether Apple shipped an API for glucose sensors."
    const answer = "Apple hasn't shipped one."
    const glucose = { machine: "Rosie", id: "t-glucose" }
    const start = { at: 0, digest: Ledger.digest(asked), kind: "start" as const, messageId: "yapd:u1:0:m" }
    const result = await run(
      Effect.gen(function* () {
        const { handle, made, wait, played, flush } = yield* make(undefined, {
          // Just restarted, T3 Code takes too long to say which thread the hook is of.
          link: () => Effect.as(Effect.sleep("5 seconds"), Option.some(glucose)),
          sent: (to, since) => Effect.succeed(Threads.same(to, glucose) ? [start].filter(({ at }) => at >= since) : []),
          trivialMessages: [answer],
        })
        yield* wait(600)
        const at = yield* Clock.currentTimeMillis
        // With no prompt seen, as after a restart.
        yield* stopHere(handle, "s-glucose", answer)
        // T3 Code's word asks what came of its Stop before that's known, and waits for it.
        const asking = yield* Effect.fork(made.stopped(["s-glucose"]))
        yield* flush
        const waited = Option.isNone(yield* Fiber.poll(asking))
        yield* wait(4)
        const ran: Notices.Finished["run"] = {
          status: "completed",
          final: answer,
          others: [],
          natives: ["s-glucose"],
          previous: Option.none(),
          userMessageId: Option.some(start.messageId),
          startedAt: at - 30_000,
        }
        const hooked = Notices.hooked(yield* Fiber.join(asking), ran, ran.startedAt)
        yield* made.finished({
          ...unhooked(answer, "run-1", (yield* made.power).turns),
          about: glucose,
          project: "",
          turn: { prompt: Option.some(asked), message: answer },
          at,
          run: ran,
          answering: true,
        })
        yield* wait(11)
        return { waited, hooked, played: [...played] }
      }),
    )
    expect(result).toEqual({ waited: true, hooked: false, played: [answer] })
  })

  test("the first turn of work yapd started whose Stop comes just as T3 Code's word is handed on waits for what comes of it, and is said from that word when it's dropped", async () => {
    const asked = "Find out whether Apple shipped an API for glucose sensors."
    const answer = "Apple hasn't shipped one."
    const glucose = { machine: "Rosie", id: "t-glucose" }
    const start = { at: 0, digest: Ledger.digest(asked), kind: "start" as const, messageId: "yapd:u1:0:m" }
    const result = await run(
      Effect.gen(function* () {
        const { handle, made, wait, played, flush } = yield* make(undefined, {
          // Just restarted, T3 Code takes too long to say which thread the hook is of.
          link: () => Effect.as(Effect.sleep("5 seconds"), Option.some(glucose)),
          sent: (to, since) => Effect.succeed(Threads.same(to, glucose) ? [start].filter(({ at }) => at >= since) : []),
          trivialMessages: [answer],
        })
        yield* wait(600)
        const at = yield* Clock.currentTimeMillis
        const ran: Notices.Finished["run"] = {
          status: "completed",
          final: answer,
          others: [],
          natives: ["s-glucose"],
          previous: Option.none(),
          userMessageId: Option.some(start.messageId),
          startedAt: at - 30_000,
        }
        // T3 Code's word finds no Stop yet, which comes, with no prompt seen, as after a restart, just before it's handed on.
        const hooked = Notices.hooked(yield* made.stopped(["s-glucose"]), ran, ran.startedAt)
        yield* stopHere(handle, "s-glucose", answer)
        const handing = yield* Effect.fork(
          made.finished({
            ...unhooked(answer, "run-1", (yield* made.power).turns),
            about: glucose,
            project: "",
            turn: { prompt: Option.some(asked), message: answer },
            at,
            run: ran,
            answering: true,
          }),
        )
        yield* flush
        const waited = Option.isNone(yield* Fiber.poll(handing))
        yield* wait(4)
        yield* Fiber.join(handing)
        yield* wait(11)
        return { hooked, waited, played: [...played] }
      }),
    )
    expect(result).toEqual({ hooked: false, waited: true, played: [answer] })
  })

  test("a slight reply to a message yapd sent, its hook tied to its thread, stays skipped: T3 Code's word leaves it to its hook", async () => {
    const message = "Switch to the Dexcom table."
    const reply = "Done, switched."
    const glucose = { machine: "Rosie", id: "t-glucose" }
    const rows = [
      { at: 0, digest: Ledger.digest("Find out whether Apple shipped an API for glucose sensors."), kind: "start" as const, messageId: "yapd:u1:0:m" },
      { at: 600_000, digest: Ledger.digest(message), kind: "message" as const, messageId: "yapd:u2:0:m" },
    ]
    const result = await run(
      Effect.gen(function* () {
        const { handle, made, wait, played, condensed } = yield* make(undefined, {
          link: () => Effect.succeedSome(glucose),
          sent: (to, since) => Effect.succeed(Threads.same(to, glucose) ? rows.filter(({ at }) => at >= since) : []),
          began: () => Effect.succeedSome(Option.some("yapd:u2:0:m")),
          trivialMessages: [reply],
        })
        yield* wait(600)
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-glucose", cwd: "/code/yapd", prompt: message }, { project: "yapd", host: hostname() }, false)
        yield* wait(30)
        const at = yield* Clock.currentTimeMillis
        yield* stopHere(handle, "s-glucose", reply)
        yield* wait(20)
        // T3 Code's word that its run finished, begun with the message yapd sent.
        const ran: Notices.Finished["run"] = {
          status: "completed",
          final: reply,
          others: [],
          natives: ["s-glucose"],
          previous: Option.none(),
          userMessageId: Option.some("yapd:u2:0:m"),
          startedAt: 600_000,
        }
        const hooked = Notices.hooked(yield* made.stopped(["s-glucose"]), ran, ran.startedAt)
        yield* made.finished({
          ...unhooked(reply, "run-2", (yield* made.power).turns),
          about: glucose,
          turn: { prompt: Option.some(message), message: reply },
          at,
          run: ran,
          answering: true,
        })
        yield* wait(30)
        return { hooked, condensed: condensed.map(({ message }) => message), played: [...played] }
      }),
    )
    expect(result).toEqual({ hooked: true, condensed: [reply], played: [] })
  })

  test("a follow-up sent soon after work yapd started isn't taken for its first turn when T3 Code says which message began its run", async () => {
    const asked = "Find out whether Apple shipped an API for glucose sensors."
    const followUp = "Also compare Dexcom."
    const reply = "Dexcom has one for its G7."
    const glucose = { machine: "Rosie", id: "t-glucose" }
    const rows = [
      { at: 0, digest: Ledger.digest(asked), kind: "start" as const, messageId: "yapd:u1:0:m" },
      { at: 20_000, digest: Ledger.digest(followUp), kind: "message" as const, messageId: "yapd:u2:0:m" },
    ]
    /** What comes of his follow-up's reply in quiet, told of by its hook or by T3 Code's word, whose run began with the follow-up. */
    const kept = (how: "hook" | "word") =>
      run(
        Effect.gen(function* () {
          const { handle, made, wait, played, journal } = yield* make(undefined, {
            link: () => Effect.succeedSome(glucose),
            sent: (to, since) => Effect.succeed(Threads.same(to, glucose) ? rows.filter(({ at }) => at >= since) : []),
            began: () => Effect.succeedSome(Option.some("yapd:u2:0:m")),
            holding: Effect.succeedSome("quiet"),
          })
          // Its first answer came at five seconds; he sent the follow-up at twenty.
          yield* wait(20)
          if (how === "hook") {
            yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-glucose", cwd: "/code/yapd", prompt: followUp }, { project: "yapd", host: hostname() }, false)
            yield* wait(60)
            yield* stopHere(handle, "s-glucose", reply)
          } else {
            yield* wait(5)
            yield* made.finished({
              ...unhooked(reply, "run-2", (yield* made.power).turns),
              about: glucose,
              turn: { prompt: Option.some(followUp), message: reply },
              at: 25_000,
              run: { status: "completed", final: reply, others: [], natives: ["s-glucose"], previous: Option.none(), userMessageId: Option.some("yapd:u2:0:m"), startedAt: 20_000 },
              answering: true,
            })
          }
          yield* wait(11)
          return { played: [...played], held: (yield* journal.since(0, { kinds: ["update"] })).map(heldFor) }
        }),
      )
    // It answers his message, which quiet never holds: only the first turn of the work is kept for the morning.
    expect(await kept("word")).toEqual({ played: [`yapd. ${reply}`], held: [undefined] })
    expect(await kept("hook")).toEqual({ played: [`yapd. ${reply}`], held: [undefined] })
  })

  test("a research answer that comes in quiet is held for the morning, and said at once in focus", async () => {
    const asked = "Find out whether Apple shipped an API for third-party glucose sensors on the Watch."
    const sent = "Also check the fee table."
    const kept = (mode: "quiet" | "focus") =>
      run(
        Effect.gen(function* () {
          const ledger: Record<string, ReadonlyArray<{ readonly at: number; readonly digest: string; readonly kind: Ledger.Kind }>> = {
            "t-glucose": [{ at: 0, digest: Ledger.digest(asked), kind: "start" }],
            "t-tezos": [],
          }
          const { handle, wait, played, journal } = yield* make(undefined, {
            link: (session) => Effect.succeedSome({ machine: "Rosie", id: `t-${session}` }),
            sent: (to, since) => Effect.succeed((ledger[to.id] ?? []).filter(({ at }) => at >= since)),
            holding: Effect.succeed(Option.some(mode)),
          })
          const turn = (session: string, prompt: string, message: string) =>
            Effect.gen(function* () {
              yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: session, cwd: "/code/yapd", prompt }, { project: "yapd", host: hostname() }, false)
              yield* wait(60)
              yield* stopHere(handle, session, message)
              yield* wait(11)
            })
          // Started minutes ago, as a worktree can take, it's told by its words.
          yield* wait(300)
          yield* turn("glucose", asked, "Apple hasn't shipped one.")
          // The answer to his own message comes through either way, as ever.
          ledger["t-tezos"] = [{ at: yield* Clock.currentTimeMillis, digest: Ledger.digest(sent), kind: "message" }]
          yield* turn("tezos", sent, "The fee table is right.")
          const updates = yield* journal.since(0, { kinds: ["update"] })
          return { played: [...played], held: updates.map((entry) => [entry.said, heldFor(entry)]) }
        }),
      )
    expect(await kept("quiet")).toEqual({
      played: ["yapd. The fee table is right."],
      held: [
        ["yapd. Apple hasn't shipped one.", "quiet"],
        ["yapd. The fee table is right.", undefined],
      ],
    })
    expect((await kept("focus")).played).toEqual(["yapd. Apple hasn't shipped one.", "yapd. The fee table is right."])
  })

  test("a research answer waiting to be said as quiet begins, or cut off by a dictation in quiet, is held for the morning, but not by focus", async () => {
    const asked = "Find out whether Apple shipped an API for third-party glucose sensors on the Watch."
    const answer = "Apple hasn't shipped one."
    const kept = (how: "waiting" | "cut off", hold: "quiet" | "focus") =>
      run(
        Effect.gen(function* () {
          let mode = Option.none<"focus" | "quiet">()
          const { made, handle, finish, wait, dictate, played, journal } = yield* make(undefined, {
            link: (session) => Effect.succeedSome({ machine: "Rosie", id: `t-${session}` }),
            sent: (to, since) => Effect.succeed(to.id === "t-glucose" ? [{ at: 0, digest: Ledger.digest(asked), kind: "start" as const }].filter(({ at }) => at >= since) : []),
            holding: Effect.sync(() => mode),
          })
          yield* wait(300)
          yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "glucose", cwd: "/code/yapd", prompt: asked }, { project: "yapd", host: hostname() }, false)
          yield* wait(60)
          // Waiting behind another update, or being said itself.
          if (how === "waiting") yield* finish("other", "Something long.")
          yield* stopHere(handle, "glucose", answer)
          yield* wait(1)
          mode = Option.some(hold)
          yield* made.hold(hold)
          if (how === "cut off") {
            const dictation = yield* dictate
            yield* wait(2)
            yield* Scope.close(dictation, Exit.void)
          }
          for (let i = 0; i < 3; i++) yield* wait(11)
          const updates = yield* journal.since(0, { kinds: ["update"] })
          return { played: [...played], held: updates.filter(({ said }) => said === `yapd. ${answer}`).map(heldFor) }
        }),
      )
    expect(await kept("waiting", "quiet")).toEqual({ played: ["yapd. Something long."], held: ["quiet"] })
    expect(await kept("cut off", "quiet")).toEqual({ played: [`yapd. ${answer}`], held: ["quiet"] })
    // Focus never holds what he asked for.
    expect(await kept("waiting", "focus")).toEqual({ played: ["yapd. Something long.", `yapd. ${answer}`], held: [undefined] })
    expect(await kept("cut off", "focus")).toEqual({ played: [`yapd. ${answer}`, `yapd. ${answer}`], held: [undefined] })
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

  test("a Stop in a folder of T3 Code's scratch project is summed up and kept as outside his projects, never by that folder's generated name", async () => {
    const dated = "/t3/scratch/2026-10-13-this-is-a-test-from-0a081e43"
    const result = await run(
      Effect.gen(function* () {
        const asked: Array<string> = []
        const { handle, nextEvent, projects, journal } = yield* make(undefined, {
          outside: (machine, directory) => Effect.sync(() => void asked.push(`${machine} ${directory}`)).pipe(Effect.as(directory.startsWith("/t3/scratch/"))),
        })
        // Its hook names it by its folder, having no repository to name it by.
        const stop = (session: string, cwd: string, project: string, message: string) =>
          handle("claude", { hook_event_name: "Stop", session_id: session, cwd, last_assistant_message: message }, { project, host: hostname() }, false)
        yield* stop("s-glucose", dated, "2026-10-13-this-is-a-test-from-0a081e43", "Apple has no such API.")
        yield* nextEvent("Ready:")
        // Work in one of his projects is still summed up in it.
        yield* stop("s-loader", "/code/yapd", "yapd", "The loader is fixed.")
        yield* nextEvent("Ready:")
        return { asked, projects: [...projects], kept: (yield* journal.since(0, { kinds: ["update"] })).map(({ project }) => project) }
      }),
    )
    expect(result).toEqual({ asked: [`Rosie ${dated}`, "Rosie /code/yapd"], projects: ["", "yapd"], kept: ["", "yapd"] })
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

describe("Lines listened to from their end", () => {
  /** What he says, for as long as it takes to be his, begun now, ending once `after` seconds have gone by. */
  const saying = (microphone: Queue.Queue<Float32Array>, flush: Effect.Effect<unknown>, wait: (seconds: number) => Effect.Effect<void>, after: number) =>
    Effect.gen(function* () {
      yield* Queue.offerAll(microphone, Array.from({ length: 30 }, () => new Float32Array(512).fill(0.9)))
      yield* flush
      yield* wait(after)
      yield* Queue.offerAll(microphone, Array.from({ length: defaults.silence }, () => new Float32Array(512)))
      yield* flush
    })

  test.each([
    ["as it ends", 9.5],
    ["in the wait after it", 11],
  ] as const)("'Mute.' said %s, over a notice that can be answered, turns yapd off without working anything out", async (_, at) => {
    const result = await run(
      Effect.gen(function* () {
        const { made, notice, microphone, flush, wait, responded } = yield* make("Mute.", { off: true })
        const followUp: Array<string> = []
        yield* notice("f", "Tezos failed: rate limited.", { followUp, after: true })
        yield* wait(at)
        yield* saying(microphone, flush, wait, 1)
        return { on: (yield* made.power).on, followUp, responded: [...responded] }
      }),
    )
    expect(result).toEqual({ on: false, followUp: [], responded: [] })
  })

  test.each([
    ["a failure", "Tezos failed: rate limited.", false],
    ["a 'done' line", "On it, sir: the Tezos migration.", true],
  ] as const)("with an answer waiting, 'Mute.' begun 0.1 s after %s ends turns yapd off; with nothing said, the answer follows 2 s after it ends, with no pause of its own", async (_, spoken, done) => {
    const after = (mute: boolean) =>
      run(
        Effect.gen(function* () {
          const { made, notice, microphone, flush, wait, played } = yield* make(mute ? "Mute." : undefined, { off: true, microphone: true })
          yield* notice("f", spoken, { followUp: [], after: true, done })
          yield* wait(1)
          yield* notice("a", "The Mina one is still running its tests, sir.", { answer: true })
          yield* wait(9.1)
          if (mute) {
            yield* saying(microphone, flush, wait, 0.5)
            return { on: (yield* made.power).on, played: [...played] }
          }
          // Two seconds after it ended, and a beat, but not the pause between lines.
          yield* wait(1.9)
          const before = [...played]
          yield* wait(0.15)
          return { before, played: [...played] }
        }),
      )
    expect(await after(true)).toEqual({ on: false, played: [spoken] })
    expect(await after(false)).toEqual({ before: [spoken], played: [spoken, "The Mina one is still running its tests, sir."] })
  })

  test("with two answers queued, a follow-up begun a second after the first ends goes to the first, not the second", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, speak, played } = yield* make(undefined, { microphone: true, transcripts: ["Tell it to rerun them."] })
        const followUp: Array<string> = []
        yield* notice("first", "The loader fix is running its tests, sir.", { answer: true, followUp })
        yield* wait(1)
        yield* notice("second", "Nothing else needs you, sir.", { answer: true, followUp })
        yield* wait(10)
        yield* speak
        yield* wait(1)
        return { followUp, played: [...played] }
      }),
    )
    expect(result).toEqual({ followUp: ["first: Tell it to rerun them."], played: ["The loader fix is running its tests, sir.", "Nothing else needs you, sir."] })
  })

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

  test.each([
    ["went, says so from its end, and what he says after it is taken up", false],
    ["couldn't be sent says so without listening, so nothing said after it goes anywhere", true],
  ] as const)("a reply cut off by a dictation that %s", async (_, fails) => {
    const result = await run(
      Effect.gen(function* () {
        const following: Array<string> = []
        const { finish, speak, wait, dictate, played } = yield* make("Merge it.", {
          following,
          transcripts: ["Merge it.", "Send it again."],
          send: () => Effect.sleep("3 seconds").pipe(Effect.zipRight(fails ? Effect.fail(new RelayError({ reason: "T3 Code isn't answering." })) : Effect.void)),
        })
        yield* finish("a", "The PR is ready.")
        yield* speak
        yield* wait(1)
        yield* Scope.close(yield* dictate, Exit.void)
        // Sent or not, then said to the end.
        yield* wait(3)
        yield* wait(10)
        yield* speak
        yield* wait(4)
        return { following, played: [...played] }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready.", fails ? "yapd. T3 Code isn't answering." : "yapd. Okay, passed on."])
    // Gone through a hook, which leaves nothing "scratch that" takes back, a bare no after it is never told as said back to what it did.
    expect(result.following).toEqual(fails ? [] : ["yapd. Okay, passed on. Send it again."])
  })

  test("a reply cut off by a dictation that went by yapd's own hand is followed up from its end as said back to what it did, that reply and nothing since", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const following: Array<string> = []
        const { handle, speak, wait, dictate, nextEvent, nextPlayback, played } = yield* make("Use the fee table.", {
          following,
          // T3 Code slow to take it, so the dictation cuts the reply off before it's sent.
          hands: { ...t3.hands, run: (step, act, given) => Effect.zipRight(Effect.sleep("3 seconds"), t3.hands.run(step, act, given)) },
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
          transcripts: ["Use the fee table.", "No."],
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." }, { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* wait(1)
        yield* Scope.close(yield* dictate, Exit.void)
        // Sent, then said to the end.
        yield* wait(3)
        yield* wait(10)
        yield* speak
        yield* wait(4)
        const steered = Option.map(yield* t3.ledger.latest("1 hour"), ({ utterance }) => utterance)
        return { following, sent: t3.sent(), played: [...played], steered }
      }),
    )
    expect(result.sent).toEqual(["t-tezos: Use the fee table."])
    expect(result.played).toEqual(["yapd. The migration compiles.", "yapd. Okay, passed on."])
    // A no to it takes back the reply it says went, by the request it went under, never what the dictation that cut it off did.
    expect(result.following).toEqual([`yapd. Okay, passed on. No., after what it did under ${Option.getOrThrow(result.steered)}`])
  })

  test("a late line that reads his message back never listens, so nothing said after it goes anywhere", async () => {
    const result = await run(
      Effect.gen(function* () {
        const following: Array<string> = []
        const { handle, finish, speak, wait, dictate, nextPlayback, nextEvent, heard, replay, played } = yield* make("Merge it.", {
          following,
          transcripts: ["Merge it.", "Run the checks.", "Send it again."],
        })
        yield* finish("a", "The PR is ready.")
        yield* nextPlayback
        yield* speak
        yield* wait(1)
        yield* Scope.close(yield* dictate, Exit.void)
        // Heard again, what he says over it waits behind the first.
        const [id] = yield* heard
        yield* replay(id!)
        yield* wait(1)
        yield* nextPlayback
        yield* speak
        yield* nextPlayback
        yield* wait(3)
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/tmp", prompt: "Merge it." }, { project: "yapd" }, false)
        yield* finish("a", "Merged it.")
        // Sent once the turn it waited behind ended, then said once what's ahead of it has been.
        yield* wait(3)
        yield* nextEvent("Ready: yapd. Sent the queued message")
        const sent = (said: string) => said.startsWith("yapd. Sent the queued message")
        for (let second = 0; second < 60 && !played.some(sent); second++) yield* wait(1)
        // Said to the end, then he says something right after.
        yield* wait(10)
        yield* speak
        yield* wait(4)
        return { line: played.find(sent), following }
      }),
    )
    expect(result.line).toBe("yapd. Sent the queued message: Run the checks.")
    expect(result.following.filter((followed) => followed.startsWith("yapd. Sent the queued message"))).toEqual([])
  })
})

describe("Daemon turned off by 'Mute.'", () => {
  /** The updates kept, what each said, when it was heard, and why it was held, if it was. */
  const kept = (journal: Journal.Journal["Type"]) =>
    Effect.map(journal.since(0, { kinds: ["update"] }), (rows) => rows.map(({ said, heardAt, detail }) => [said, heardAt, (detail as { held?: string }).held]))

  test("a bare 'Mute.' over an update turns yapd off at once, with no model call, and keeps it and what waits unheard", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, talk, flush, wait, played, responded, followUps, journal, logged } = yield* make("Mute.", { off: true })
        yield* finish("a", "The PR is ready.")
        yield* finish("b", "The tests pass.")
        yield* wait(1)
        yield* talk
        yield* flush
        // With no time gone by for anything to be worked out.
        const { on } = yield* made.power
        yield* wait(30)
        return { on, played: [...played], responded: [...responded], followUps: [...followUps], kept: yield* kept(journal), logged: logged.filter((line) => line.startsWith("Turned")) }
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
    expect(result.logged).toEqual(["Turned off: he said mute", "Turned off"])
  })

  test("'Mute, mute.' said over yapd's first seconds, while its own voice can still get into the microphone, turns it off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, talk, flush, wait, responded, journal } = yield* make("Mute, mute.", { off: true, echoing: 30 })
        yield* finish("a", "The PR is ready.")
        yield* wait(1)
        yield* talk
        yield* flush
        const { on } = yield* made.power
        yield* wait(30)
        return { on, responded: [...responded], kept: yield* kept(journal) }
      }),
    )
    expect(result.on).toBe(false)
    expect(result.responded).toEqual([])
    expect(result.kept).toEqual([["yapd. The PR is ready.", undefined, "off"]])
  })

  test("'Mute.' over yapd's first seconds of a line about muting may be its own voice, so it's only a stop, and yapd stays on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, talk, wait, followUps } = yield* make("Mute.", { off: true, echoing: 30, quickly: true })
        yield* finish("a", "I muted the flaky alerts.")
        yield* wait(1)
        yield* talk
        yield* wait(11)
        return { on: (yield* made.power).on, followUps: [...followUps] }
      }),
    )
    expect(result.on).toBe(true)
    expect(result.followUps).toEqual([])
  })

  test("'Mute.' over an agent's question being asked turns yapd off and gives what answers it nothing, so nothing reaches the agent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, notice, talk, flush, wait, followUps } = yield* make("Mute.", { off: true, microphone: true })
        const answers: Array<string> = []
        const question: Array<string> = []
        yield* notice("q", "The Tezos migration asks: keep the historical rounding, or recompute?", { question, answers })
        yield* wait(1)
        yield* talk
        yield* flush
        const { on } = yield* made.power
        yield* wait(30)
        return { on, answers, question, followUps: [...followUps] }
      }),
    )
    expect(result.on).toBe(false)
    expect(result.answers).toEqual([])
    expect(result.question).toEqual([])
    expect(result.followUps).toEqual([])
  })

  test("'Mute.' over a notice nothing else said over it is for, like a failure, turns yapd off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, notice, talk, flush, wait, played, stopped, responded } = yield* make("Mute.", { off: true })
        yield* notice("f", "Tezos failed: rate limited.")
        yield* wait(1)
        yield* talk
        yield* flush
        return { on: (yield* made.power).on, played: [...played], stopped: [...stopped], responded: [...responded] }
      }),
    )
    expect(result).toEqual({ on: false, played: ["Tezos failed: rate limited."], stopped: ["Tezos failed: rate limited."], responded: [] })
  })

  test("'Mute.' said as a notice ends, heard out only once it has, still turns yapd off, before what waits behind the notice is said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, notice, finish, microphone, flush, wait, played, journal } = yield* make("Mute.", { off: true })
        yield* notice("f", "Tezos failed: rate limited.")
        yield* finish("a", "The PR is ready.")
        // He begins half a second before it ends, and the silence that tells he's stopped comes once it has.
        yield* wait(9.5)
        yield* Queue.offerAll(microphone, Array.from({ length: 30 }, () => new Float32Array(512).fill(0.9)))
        yield* flush
        yield* wait(1)
        yield* Queue.offerAll(microphone, Array.from({ length: defaults.silence }, () => new Float32Array(512)))
        yield* flush
        const { on } = yield* made.power
        yield* wait(30)
        return { on, played: [...played], kept: yield* kept(journal) }
      }),
    )
    expect(result).toEqual({ on: false, played: ["Tezos failed: rate limited."], kept: [["yapd. The PR is ready.", undefined, "off"]] })
  })

  test("'Mute.' begun a moment after a notice, with something waiting behind it, still turns yapd off before that's said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, notice, finish, microphone, flush, wait, played, journal } = yield* make("Mute.", { off: true })
        yield* notice("f", "Tezos failed: rate limited.")
        yield* finish("a", "The PR is ready.")
        // He begins 0.2 s after it ends, and the silence that tells he's stopped comes past the pause between lines.
        yield* wait(10.2)
        yield* Queue.offerAll(microphone, Array.from({ length: 30 }, () => new Float32Array(512).fill(0.9)))
        yield* flush
        yield* wait(0.5)
        yield* Queue.offerAll(microphone, Array.from({ length: defaults.silence }, () => new Float32Array(512)))
        yield* flush
        const { on } = yield* made.power
        yield* wait(30)
        return { on, played: [...played], kept: yield* kept(journal) }
      }),
    )
    expect(result).toEqual({ on: false, played: ["Tezos failed: rate limited."], kept: [["yapd. The PR is ready.", undefined, "off"]] })
  })

  test("with nothing waiting behind a notice, 'Mute.' said a second after it still turns yapd off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, notice, wait, talk, played } = yield* make("Mute.", { off: true })
        yield* notice("f", "Tezos failed: rate limited.")
        yield* wait(11)
        yield* talk
        return { on: (yield* made.power).on, played: [...played] }
      }),
    )
    expect(result).toEqual({ on: false, played: ["Tezos failed: rate limited."] })
  })

  test.each([
    ["while it plays", 5],
    ["a second after it ends", 11],
  ] as const)("an answer queued behind a notice like 'Let me check.' %s is said as soon as it can be, never held for the moment after it", async (_, at) => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, wait, played } = yield* make(undefined, { off: true, microphone: true })
        yield* notice("c", "Let me check.", { answer: true })
        yield* wait(at)
        yield* notice("a", "Tezos is still running.", { answer: true })
        // Once the notice has ended, or at once once it has, after what was the usual pause between lines, and a moment more at most.
        yield* wait(Math.max(10, at) - at + 0.6)
        return [...played]
      }),
    )
    expect(result).toEqual(["Let me check.", "Tezos is still running."])
  })

  test("anything else said over such a notice neither stops it nor is worked out, as before", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, notice, talk, wait, played, stopped, responded } = yield* make("Mute it.", { off: true })
        const heard: Array<string> = []
        yield* notice("f", "Tezos failed: rate limited.", { heard })
        yield* wait(1)
        yield* talk
        yield* wait(10)
        return { on: (yield* made.power).on, played: [...played], stopped: [...stopped], responded: [...responded], heard }
      }),
    )
    expect(result).toEqual({ on: true, played: ["Tezos failed: rate limited."], stopped: [], responded: [], heard: ["f"] })
  })

  test("'mute it' over an update still mutes its thread, and yapd stays on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, talk, wait, played, responded, followUps } = yield* make("Mute it.", { mutes, off: true })
        yield* finish("noisy", "Still going.")
        yield* wait(1)
        yield* talk
        yield* wait(11)
        return { on: (yield* made.power).on, played: [...played], responded: [...responded], followUps: [...followUps], mutes: (yield* mutes.list).map(({ key }) => key) }
      }),
    )
    expect(result.on).toBe(true)
    expect(result.played).toEqual(["yapd. Still going.", "Muted it. I'll still tell you if it needs you."])
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
    expect(result.mutes).toEqual([sessionKey("noisy")])
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

  test("'unmute it' or 'mute it' over an update said again for the menu's row is about that row, by its key, however the update was tied", async () => {
    const over = (said: "Unmute it." | "Mute it.") =>
      run(
        Effect.gen(function* () {
          const mutes = yield* muting
          const { finish, talk, wait, played, responded, heard, replay } = yield* make(said, { mutes })
          // Its link to the thread timed out, so it was heard under its session, which the thread's row shows.
          yield* finish("fees", "Comparing fee tables.")
          yield* wait(11)
          // Long past listening for a reply to it.
          yield* wait(60)
          const [id] = yield* heard
          if (said === "Unmute it.") yield* mutes.mute({ key: "t3:Rosie:t-fees", called: "the fee tables" })
          yield* replay(id!, "t3:Rosie:t-fees")
          yield* wait(1)
          yield* talk
          yield* wait(11)
          return { played: [...played].slice(1), responded: [...responded], mutes: (yield* mutes.list).map(({ key }) => key) }
        }),
      )
    expect(await over("Unmute it.")).toEqual({ played: ["yapd. Comparing fee tables.", "Unmuted it."], responded: [], mutes: [] })
    expect(await over("Mute it.")).toEqual({
      played: ["yapd. Comparing fee tables.", "Muted it. I'll still tell you if it needs you."],
      responded: [],
      mutes: ["t3:Rosie:t-fees"],
    })
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

/** What a journal entry was held for, if it was. */
const heldFor = (kept: Journal.Kept) => (kept.detail as { readonly held?: string } | undefined)?.held

describe("Daemon while off", () => {
  test("a Stop that waits is let go of at once, and its update is summed up and kept unheard, with its rest and how much it needs him, never rendered or played", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, toggle, wait, journal, played, renders, warms } = yield* make(undefined, {
          waitingHooks: true,
          mores: { "The migration is merged.": "Two follow-ups are left in the ticket." },
          urgentMessages: ["Which network first?"],
        })
        yield* toggle(false)
        // A hook that waits gets its empty reply at once, rather than for as long as an update takes.
        const hook = yield* Effect.fork(finish("a", "The migration is merged.", true))
        yield* wait(0)
        const replied = yield* Fiber.poll(hook)
        yield* finish("b", "Which network first?", true)
        yield* wait(30)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return {
          replied: Option.map(replied, Exit.isSuccess),
          kept: kept.map((row) => [row.said, row.heardAt, heldFor(row), (row.detail as { more?: string; priority?: string }).more, (row.detail as { priority?: string }).priority]),
          played: [...played],
          renders: renders(),
          warms: warms(),
        }
      }),
    )
    expect(result.replied).toEqual(Option.some(true))
    expect(result.kept).toEqual([
      ["yapd. The migration is merged.", undefined, "off", "Two follow-ups are left in the ticket.", "done"],
      ["yapd. Which network first?", undefined, "off", undefined, "needs-you"],
    ])
    expect(result).toMatchObject({ played: [], renders: 0, warms: 0 })
  })

  test("what needs him, what couldn't be summed up and the answer to what he sent its thread are kept unheard too, and none of it is said once yapd is on again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const asked = "Also run the integration tests."
        const ledger: Array<{ readonly at: number; readonly digest: string | null }> = []
        const { handle, finish, toggle, wait, journal, played } = yield* make(undefined, {
          urgentMessages: ["The deploy failed."],
          unsummarizable: ["Garbled."],
          link: (session) => Effect.succeed(session === "s-tezos" ? Option.some({ machine: "Rosie", id: "t-tezos" }) : Option.none()),
          sent: (to, since) => Effect.succeed(to.id === "t-tezos" ? ledger.filter(({ at }) => at >= since) : []),
        })
        yield* toggle(false)
        yield* finish("deploy", "The deploy failed.")
        yield* finish("garbled", "Garbled.")
        // He sent it by the shortcut while yapd was off, and its answer comes in.
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt: asked }, { project: "yapd", host: hostname() }, false)
        ledger.push({ at: (yield* Clock.currentTimeMillis) - 1000, digest: Ledger.digest(asked) })
        yield* wait(120)
        yield* stopHere(handle, "s-tezos", "Integration tests pass.")
        yield* wait(11)
        yield* toggle(true)
        yield* wait(30)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: kept.map((row) => [row.said, row.heardAt, heldFor(row)]) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.kept).toEqual([
      ["yapd. The deploy failed.", undefined, "off"],
      ["yapd finished a turn, but I couldn't summarize it.", undefined, "off"],
      ["yapd. Integration tests pass.", undefined, "off"],
    ])
  })

  test("muting a thread later keeps quiet only what a mute would have: what needs him, what couldn't be summed up and the answer to what he sent stay unmuted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const asked = "Also run the integration tests."
        const ledger: Array<{ readonly at: number; readonly digest: string | null }> = []
        const mutes = yield* muting
        const { made, handle, finish, toggle, wait, journal } = yield* make(undefined, {
          mutes,
          urgentMessages: ["Which network first?"],
          unsummarizable: ["Garbled."],
          link: (session) => Effect.succeed(session === "s-tezos" ? Option.some({ machine: "Rosie", id: "t-tezos" }) : Option.none()),
          sent: (to, since) => Effect.succeed(to.id === "t-tezos" ? ledger.filter(({ at }) => at >= since) : []),
        })
        yield* toggle(false)
        yield* finish("asks", "Which network first?")
        yield* finish("garbled", "Garbled.")
        yield* finish("noisy", "Still going.")
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "s-tezos", cwd: "/code/yapd", prompt: asked }, { project: "yapd", host: hostname() }, false)
        ledger.push({ at: (yield* Clock.currentTimeMillis) - 1000, digest: Ledger.digest(asked) })
        yield* wait(120)
        yield* stopHere(handle, "s-tezos", "Integration tests pass.")
        yield* wait(11)
        const keys = [sessionKey("asks"), sessionKey("garbled"), sessionKey("noisy"), Mutes.key.thread({ machine: "Rosie", id: "t-tezos" })]
        for (const key of keys) yield* mutes.mute({ key })
        yield* made.silence(keys)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return kept.map((row) => [row.said, heldFor(row), quieted(row)])
      }),
    )
    expect(result).toEqual([
      ["yapd. Which network first?", "off", false],
      ["yapd finished a turn, but I couldn't summarize it.", "off", false],
      ["yapd. Still going.", "off", true],
      ["yapd. Integration tests pass.", "off", false],
    ])
  })

  test("a turn no hook told of while yapd is off is kept unheard under its key, and its own Stop coming once it's on isn't said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, toggle, wait, journal, played, nextEvent } = yield* make()
        yield* toggle(false)
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Held update for yapd, for later (off)")
        yield* toggle(true)
        yield* handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/code/yapd", last_assistant_message: "The loader is fixed." }, { project: "yapd" }, false)
        yield* wait(30)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: kept.map((row) => [row.key, row.heardAt, heldFor(row)]) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.kept).toEqual([["done:Rosie:run-1", undefined, "off"]])
  })

  test("a turn no hook told of, waiting to be said as yapd is turned off, is kept unheard once, and its own Stop coming after isn't kept or said again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, handle, toggle, wait, journal, played, nextEvent } = yield* make()
        yield* finish("a", "The PR is ready.")
        yield* nextEvent("Ready:")
        // Waiting behind it as he turns yapd off.
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* wait(1)
        yield* toggle(false)
        yield* handle("claude", { hook_event_name: "Stop", session_id: "native-loader", cwd: "/code/yapd", last_assistant_message: "The loader is fixed." }, { project: "yapd" }, false)
        yield* wait(11)
        yield* toggle(true)
        yield* wait(30)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], kept: kept.map((row) => [row.said, row.heardAt, heldFor(row)]) }
      }),
    )
    expect(result.played).toEqual(["yapd. The PR is ready."])
    expect(result.kept).toEqual([
      ["yapd. The PR is ready.", undefined, "off"],
      ["yapd. The loader is fixed.", undefined, "off"],
    ])
  })

  test("turning off while an update is being made ready lets its hook go at once, and the update is kept unheard as what came in while it was off", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, toggle, wait, journal, played, followUps } = yield* make(undefined, { renderSeconds: 5 })
        yield* finish("a", "The PR is ready.", true)
        yield* wait(1)
        yield* toggle(false)
        const letGo = [...followUps]
        yield* wait(5)
        yield* wait(30)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { letGo, after: [...followUps], played: [...played], kept: kept.map((row) => [row.said, row.heardAt, heldFor(row)]) }
      }),
    )
    expect(result.letGo).toEqual(["claude:a let go"])
    // Let go of once.
    expect(result.after).toEqual(["claude:a let go"])
    expect(result.played).toEqual([])
    expect(result.kept).toEqual([["yapd. The PR is ready.", undefined, "off"]])
  })

  test("what he asks while yapd is off is answered with nothing listened for after it, a question it asks left open for the shortcut, and nothing else is said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, toggle, wait, speak, played, listened, finish } = yield* make("Tell it to merge.")
        yield* toggle(false)
        const followUp: Array<string> = []
        const heard: Array<string> = []
        const asked: Array<string> = []
        const answers: Array<string> = []
        yield* notice("answer", "Distribox is migrated, sir.", { answer: true, followUp, heard })
        yield* wait(5)
        yield* speak
        yield* wait(11)
        yield* notice("which", "The Tezos migration or the Mina tickets, sir?", { question: asked, answers, heard })
        yield* wait(11)
        yield* speak
        yield* wait(11)
        // What came of what he asked, which on would be listened to from its end.
        yield* notice("started", "Started the parser fix, sir.", { done: true, followUp, after: true, heard })
        yield* wait(11)
        yield* speak
        yield* wait(11)
        // Of its own accord, nothing.
        yield* notice("failed", "The Tezos migration failed.")
        yield* finish("a", "The PR is ready.")
        yield* wait(30)
        return { played: [...played], followUp, heard, asked, answers, listened: listened.length }
      }),
    )
    expect(result.played).toEqual(["Distribox is migrated, sir.", "The Tezos migration or the Mina tickets, sir?", "Started the parser fix, sir."])
    expect(result).toMatchObject({ followUp: [], answers: [], listened: 0, heard: ["answer", "which", "started"], asked: ["which unanswered"] })
  })

  test("turned on again, what it was saying or about to say in answer to what he asked while it was off is stopped and dropped, never heard", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { notice, toggle, wait, played, stopped } = yield* make()
        yield* toggle(false)
        const heard: Array<string> = []
        const gone: Array<string> = []
        yield* notice("first", "Distribox is migrated, sir.", { answer: true, heard, gone })
        yield* notice("second", "The Tezos one is still running, sir.", { answer: true, heard, gone })
        yield* wait(2)
        yield* toggle(true)
        yield* wait(30)
        return { played: [...played], stopped: [...stopped], heard, gone: gone.toSorted() }
      }),
    )
    expect(result).toEqual({ played: ["Distribox is migrated, sir."], stopped: ["Distribox is migrated, sir."], heard: [], gone: ["first", "second"] })
  })

  test("what he hears is heard only once it's said to the end, and progress of the same work is out of date only once he hears how it went, not as that's queued", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { finish, toggle, wait, journal } = yield* make(undefined, { progressMessages: ["Pass 7 is running."] })
        const heard = Effect.map(journal.since(0, { kinds: ["update"] }), (kept) => kept.map((row) => [row.said, row.heardAt !== undefined, heldFor(row)]))
        yield* finish("review", "Pass 7 is running.")
        yield* finish("other", "Something long.")
        yield* finish("review", "The review is merged.")
        // Queued behind the other line, and then cut off by turning yapd off.
        const queued = yield* heard
        yield* wait(11)
        yield* wait(5)
        yield* toggle(false)
        const cut = yield* heard
        yield* toggle(true)
        yield* finish("review", "The review is merged, again.")
        yield* wait(11)
        return { queued, cut, after: yield* heard }
      }),
    )
    expect(result.queued).toEqual([
      ["yapd. Pass 7 is running.", false, "progress"],
      ["yapd. Something long.", false, undefined],
      ["yapd. The review is merged.", false, undefined],
    ])
    expect(result.cut).toEqual([
      ["yapd. Pass 7 is running.", false, "progress"],
      ["yapd. Something long.", true, undefined],
      ["yapd. The review is merged.", false, "off"],
    ])
    expect(result.after).toEqual([
      ["yapd. Pass 7 is running.", true, "progress"],
      ["yapd. Something long.", true, undefined],
      ["yapd. The review is merged.", false, "off"],
      ["yapd. The review is merged, again.", true, undefined],
    ])
  })
})

describe("Daemon holding what a failure was left to", () => {
  for (const [held, options] of [
    ["focus", { holding: Effect.succeedSome("focus" as const) }],
    ["progress", { progressMessages: ["The provider had an error, so I stopped."] }],
  ] as const) {
    test(`a failure left to the Stop that told of it is said after all once that Stop's update is held for ${held}`, async () => {
      const result = await run(
        Effect.gen(function* () {
          const { made, finish, nextEvent } = yield* make(undefined, options)
          const told: Array<string> = []
          yield* finish("held", "The provider had an error, so I stopped.")
          yield* nextEvent(`Held update for yapd, for later (${held})`)
          yield* Effect.flatMap(made.stopped(["held"]), (stops) => made.unheard(stops, Effect.sync(() => void told.push("held"))))
          return told
        }),
      )
      expect(result).toEqual(["held"])
    })
  }

  test("a failure left to a Stop whose update is kept as what came in while yapd was off, being read, waiting or coming in then, is handed on to be kept apart, and muting the thread later never keeps it quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, finish, toggle, nextEvent, wait, journal } = yield* make(undefined, { mutes })
        /** A failure as Notices keeps one while yapd is off: unheard, under its key. */
        const failed = (session: string) =>
          Effect.flatMap(made.stopped([session]), (stops) =>
            made.unheard(
              stops,
              Effect.asVoid(journal.claim({ at: 0, kind: "notice", thread: `claude:${session}`, key: `fail:${session}`, said: `${session} failed.`, detail: { failure: "provider_error" } })),
            ),
          )
        // Being read, and waiting to be, as he turns it off.
        yield* finish("reading", "The provider had an error, so I stopped.")
        yield* finish("waiting", "The model is down, so I stopped.")
        yield* wait(1)
        yield* toggle(false)
        // And coming in while it's off.
        yield* finish("off", "The provider failed, so I stopped.")
        yield* nextEvent("Held update for yapd, for later (off)")
        for (const session of ["reading", "waiting", "off"]) yield* failed(session)
        yield* toggle(true)
        yield* wait(30)
        const keys = ["reading", "waiting", "off"].map(sessionKey)
        for (const key of keys) yield* mutes.mute({ key })
        yield* made.silence(keys)
        const kept = (yield* journal.since(0, { kinds: ["update", "notice"] })).toSorted((one, other) => one.kind.localeCompare(other.kind) || one.id - other.id)
        return kept.map((row) => [row.kind, row.said, row.heardAt, quieted(row)])
      }),
    )
    expect(result).toEqual([
      ["notice", "reading failed.", undefined, false],
      ["notice", "waiting failed.", undefined, false],
      ["notice", "off failed.", undefined, false],
      ["update", "yapd. The provider had an error, so I stopped.", undefined, true],
      ["update", "yapd. The model is down, so I stopped.", undefined, true],
      ["update", "yapd. The provider failed, so I stopped.", undefined, true],
    ])
  })

  test("after a restart in the middle of a turn, the answer to what he said back through its hook before then is said, never held as progress", async () => {
    const result = await run(
      Effect.gen(function* () {
        const journal = Journal.fromStore(yield* Store.make(":memory:"))
        // Before the restart: he said "keep going" over its update, which went back through its hook.
        yield* journal.write({ at: 0, kind: "update", thread: "claude:review", said: "yapd. Pass 7 found two issues.", detail: { priority: "done" } })
        yield* journal.write({ at: 5_000, kind: "sent", thread: "claude:review", text: "Keep going with the review." })
        const { finish, wait, played } = yield* make(undefined, { journal, progressMessages: ["Pass 8 is running.", "Pass 9 is running."] })
        yield* wait(60)
        // Its Stop, the first of its session since the restart, with no prompt known.
        yield* finish("review", "Pass 8 is running.")
        yield* wait(11)
        // Not the first of its session since the restart, the next is progress as ever.
        yield* finish("review", "Pass 9 is running.")
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. Pass 8 is running."])
  })
})

/** What a catch-up of everything would tell him of now, as the journal has it: each row's words, a thread at a time, oldest first. */
const catchingUp = (journal: Journal.Journal["Type"]) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.map(Missed.gather(journal, { now, spoke: 0, coming: [], desk: { threads: [], away: [] } }), ({ groups }) => groups.flatMap(({ rows }) => rows)),
  )

describe("Daemon, one turn kept twice", () => {
  const loader = { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }) }
  const stop = (message: string, needsYou = false) =>
    ({ hook_event_name: "Stop", session_id: "native-loader", cwd: "/tmp", last_assistant_message: message, ...(needsYou ? { needs_you: true } : {}) }) as const

  test("a question kept unheard in its hook's place while yapd is off, then asked by its Stop come late while it's still off, is told of once, and both are heard once that is", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, journal } = yield* make(undefined, { ...loader, urgentMessages: ["Which network first?"] })
        yield* toggle(false)
        yield* made.finished(unhooked("Which network first?", "run-1", (yield* made.power).turns))
        yield* wait(11)
        yield* handle("claude", stop("Which network first?", true), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        const told = yield* catchingUp(journal)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        // He hears what a catch-up told him of to the end.
        yield* journal.markHeard(told.map(({ id }) => id), yield* Clock.currentTimeMillis)
        const after = yield* journal.since(0, { kinds: ["update"] })
        return { told: told.map(({ said }) => said), kept: kept.map((row) => [row.key, heldFor(row)]), heard: after.map(({ heardAt }) => heardAt !== undefined), newest: told[0]?.id === kept[1]?.id }
      }),
    )
    expect(result.told).toEqual(["yapd. Which network first?"])
    expect(result.kept).toEqual([
      ["done:Rosie:run-1", "off"],
      [undefined, "off"],
    ])
    // The Stop's is what's told, and hearing it hears the one it took the place of.
    expect(result.newest).toBe(true)
    expect(result.heard).toEqual([true, true])
  })

  test("a turn of two questions kept unheard in its hook's place while yapd is off, whose Stop come late asks only the last, is told of with both, and neither is heard before it's told", async () => {
    const both = "Which network, mainnet or testnet? Which deployment, staging or production?"
    const last = "Which deployment, staging or production?"
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, journal } = yield* make(undefined, { ...loader, urgentMessages: [both, last] })
        yield* toggle(false)
        yield* made.finished(unhooked(both, "run-1", (yield* made.power).turns))
        yield* wait(11)
        yield* handle("claude", stop(last, true), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        const told = yield* catchingUp(journal)
        return { told: told.map(({ said }) => said).toSorted() }
      }),
    )
    // Its Stop tells less than it did, so it doesn't take its place: the question asked first is never hidden behind the last.
    expect(result.told).toEqual([`yapd. ${both}`, `yapd. ${last}`].toSorted())
  })

  for (const [how, options] of [
    ["muted", { mutes: true }],
    ["held for focus", { holding: Effect.succeedSome("focus" as const) }],
    ["held as progress", { progressMessages: ["The loader is fixed."] }],
  ] as const) {
    test(`a turn kept in its hook's place ${how}, whose Stop comes late needing him while yapd is off, is told of once in a catch-up`, async () => {
      const result = await run(
        Effect.gen(function* () {
          const mutes = yield* muting
          const { made, handle, wait, toggle, journal } = yield* make(undefined, {
            ...loader,
            ...("mutes" in options ? { mutes } : {}),
            ...("holding" in options ? { holding: options.holding } : {}),
            ...("progressMessages" in options ? { progressMessages: options.progressMessages } : {}),
          })
          if ("mutes" in options) yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
          yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
          yield* wait(11)
          yield* toggle(false)
          yield* handle("claude", stop("The loader is fixed.", true), { project: "yapd", host: hostname() }, false)
          yield* wait(11)
          return { told: (yield* catchingUp(journal)).map((row) => [row.said, heldFor(row)]), kept: (yield* journal.since(0, { kinds: ["update"] })).length }
        }),
      )
      expect(result.kept).toBe(2)
      expect(result.told).toEqual([["yapd. The loader is fixed.", "off"]])
    })
  }

  test("once yapd restarted, a newer turn of the session that ends on the same few words as one kept unheard in its hook's place is its own, kept and told of beside it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const journal = Journal.fromStore(yield* Store.make(":memory:"))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { made, wait, toggle } = yield* make(undefined, { ...loader, journal })
            yield* toggle(false)
            yield* made.finished(unhooked("Which network first?", "run-1", (yield* made.power).turns))
            yield* wait(11)
          }),
        )
        const { handle, wait, toggle } = yield* make(undefined, { ...loader, journal })
        yield* toggle(false)
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "native-loader", cwd: "/tmp", prompt: "Start over on the bridge." }, { project: "yapd", host: hostname() }, false)
        yield* wait(120)
        yield* handle("claude", stop("Which network first?", true), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        return (yield* catchingUp(journal)).map(({ said, key }) => [said, key])
      }),
    )
    expect(result).toEqual([
      ["yapd. Which network first?", "done:Rosie:run-1"],
      ["yapd. Which network first?", undefined],
    ])
  })

  test("once yapd restarted, a Stop needing him in the words of a turn said in its hook's place and heard before is said: whose turn it is can't be told across a restart", async () => {
    const result = await run(
      Effect.gen(function* () {
        const journal = Journal.fromStore(yield* Store.make(":memory:"))
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const { made, wait, played } = yield* make(undefined, { ...loader, journal, urgentMessages: ["Which network first?"] })
            yield* made.finished(unhooked("Which network first?", "run-1", (yield* made.power).turns))
            yield* wait(11)
            return [...played]
          }),
        )
        // A newer turn of the same session, whose prompt came before the restart, asks the same again.
        const { handle, wait, played } = yield* make(undefined, { ...loader, journal })
        yield* handle("claude", stop("Which network first?", true), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        return { before, after: [...played], kept: (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.key, row.heardAt !== undefined]) }
      }),
    )
    expect(result.before).toEqual(["yapd. Which network first?"])
    expect(result.after).toEqual(["yapd. Which network first?"])
    expect(result.kept).toEqual([
      ["done:Rosie:run-1", true],
      [undefined, true],
    ])
  })

  test("a late Stop in words that can't be told, needing him, said over the next run's turn kept quiet in its hook's place, leaves that turn his to hear", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, handle, wait, played, nextEvent, journal } = yield* make(undefined, { ...loader, mutes })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        yield* made.finished(unhooked("The docs are swept.", "run-2", (yield* made.power).turns))
        yield* nextEvent("Muted update for yapd")
        // The run before's Stop, late, in words neither run's are known by.
        yield* handle("claude", stop("I need the staging password.", true), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return {
          played: [...played],
          kept: kept.map((row) => [row.said, row.heardAt !== undefined, (row.detail as { replaces?: number }).replaces]),
          missed: (yield* journal.unheard(0, 10)).map(({ said }) => said),
        }
      }),
    )
    expect(result.played).toEqual(["yapd. I need the staging password."])
    expect(result.kept).toEqual([
      ["yapd. The docs are swept.", false, undefined],
      ["yapd. I need the staging password.", true, undefined],
    ])
    expect(result.missed).toEqual(["yapd. The docs are swept."])
  })

  test("a turn waiting to be said in its hook's place, whose own Stop takes its place, is noted as heard only once he heard the Stop", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, handle, wait, played, nextEvent, journal } = yield* make(undefined, loader)
        yield* finish("playing", "Something long.")
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready: yapd. The loader")
        yield* handle("claude", stop("The loader is fixed."), { project: "yapd", host: hostname() }, false)
        yield* wait(1)
        const waiting = (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.key ?? row.thread, row.heardAt !== undefined])
        for (let index = 0; index < 3; index++) yield* wait(11)
        const after = (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.key ?? row.thread, row.heardAt !== undefined])
        return { played: [...played], waiting, after, missed: (yield* journal.unheard(0, 10)).length }
      }),
    )
    expect(result.played).toEqual(["yapd. Something long.", "yapd. The loader is fixed."])
    expect(result.waiting).toEqual([
      ["claude:playing", false],
      ["done:Rosie:run-1", false],
      ["t-loader", false],
    ])
    expect(result.after).toEqual([
      ["claude:playing", true],
      ["done:Rosie:run-1", true],
      ["t-loader", true],
    ])
    expect(result.missed).toBe(0)
  })

  test("a turn waiting to be said in its hook's place, whose Stop leaves nothing to say, as a quick turn, is still his to hear", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, handle, wait, played, nextEvent, journal } = yield* make(undefined, loader)
        yield* finish("playing", "Something long.")
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready: yapd. The loader")
        yield* handle("claude", { hook_event_name: "UserPromptSubmit", session_id: "native-loader", cwd: "/tmp", prompt: "Go on." }, { project: "yapd", host: hostname() }, false)
        yield* handle("claude", stop("The loader is fixed."), { project: "yapd", host: hostname() }, false)
        yield* nextEvent("Skipped quick turn")
        for (let index = 0; index < 3; index++) yield* wait(11)
        return { played: [...played], unheard: (yield* journal.unheard(0, 10)).map(({ said }) => said) }
      }),
    )
    expect(result.played).toEqual(["yapd. Something long."])
    expect(result.unheard).toEqual(["yapd. The loader is fixed."])
  })

  test("a question kept unheard in its hook's place while yapd is off, heard in a catch-up, isn't told again by its Stop come late", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, played, journal } = yield* make(undefined, { ...loader, urgentMessages: ["Which network first?"] })
        yield* toggle(false)
        yield* made.finished(unhooked("Which network first?", "run-1", (yield* made.power).turns))
        yield* wait(11)
        const told = yield* catchingUp(journal)
        yield* journal.markHeard(told.map(({ id }) => id), yield* Clock.currentTimeMillis)
        yield* toggle(true)
        yield* handle("claude", stop("Which network first?", true), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        yield* wait(11)
        return {
          told: told.map(({ said }) => said),
          played: [...played],
          kept: (yield* journal.since(0, { kinds: ["update", "action"] })).map((row) => [row.kind, row.key ?? (row.detail as { through?: string }).through]),
        }
      }),
    )
    expect(result.told).toEqual(["yapd. Which network first?"])
    expect(result.played).toEqual([])
    expect(result.kept).toEqual([
      ["update", "done:Rosie:run-1"],
      ["action", "done:Rosie:run-1"],
    ])
  })

  test("a turn kept unheard in its hook's place while yapd is off, heard in a catch-up, still lets its Stop through when the Stop needs him and it didn't", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, played, journal } = yield* make(undefined, loader)
        yield* toggle(false)
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* wait(11)
        yield* journal.markHeard((yield* catchingUp(journal)).map(({ id }) => id), yield* Clock.currentTimeMillis)
        yield* toggle(true)
        yield* handle("claude", stop("The loader is fixed.", true), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The loader is fixed."])
  })

  test("a turn held as progress in its hook's place, put aside as out of date by newer work he heard, still lets its Stop through when it couldn't be summed up", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, played, nextEvent } = yield* make(undefined, {
          ...loader,
          progressMessages: ["The loader migration is halfway done."],
          unsummarizable: ["Update: the loader migration is halfway done."],
        })
        yield* made.finished(unhooked("The loader migration is halfway done.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Held update for yapd, for later (progress)")
        // Newer work on the same thread, heard to the end, which puts what was held as progress of it aside.
        yield* handle("claude", { ...stop("The tests are green."), session_id: "native-tests" }, { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        yield* handle("claude", stop("Update: the loader migration is halfway done."), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        yield* wait(11)
        return [...played]
      }),
    )
    expect(result).toEqual(["yapd. The tests are green.", "yapd finished a turn, but I couldn't summarize it."])
  })

  // The question T3 Code's word told of, and its own Stop come late in the same words, which the model fails on.
  const question = "Which network should the bridge use first?"
  const garbled = "Then: which network should the bridge use first?"
  const couldnt = "yapd finished a turn, but I couldn't summarize it."

  test("a question kept unheard in its hook's place while yapd is off, whose Stop come late couldn't be summed up, is told of beside it in a catch-up, and heard only once it is", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, journal } = yield* make(undefined, { ...loader, urgentMessages: [question], unsummarizable: [garbled] })
        yield* toggle(false)
        yield* made.finished(unhooked(question, "run-1", (yield* made.power).turns))
        yield* wait(11)
        yield* handle("claude", stop(garbled), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        const told = yield* catchingUp(journal)
        // He hears the line that couldn't sum it up, and only then the question.
        yield* journal.markHeard(told.filter(({ said }) => said === couldnt).map(({ id }) => id), yield* Clock.currentTimeMillis)
        const first = (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.said, row.heardAt !== undefined])
        yield* journal.markHeard(told.filter(({ said }) => said !== couldnt).map(({ id }) => id), yield* Clock.currentTimeMillis)
        const then = (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.said, row.heardAt !== undefined])
        return { told: told.map(({ said }) => said).toSorted(), first, then }
      }),
    )
    expect(result.told).toEqual([`yapd. ${question}`, couldnt].toSorted())
    expect(result.first).toEqual([
      [`yapd. ${question}`, false],
      [couldnt, true],
    ])
    expect(result.then).toEqual([
      [`yapd. ${question}`, true],
      [couldnt, true],
    ])
  })

  test("a question kept unheard in its hook's place while yapd is off, whose Stop come late once it's on couldn't be summed up, is still his to hear once that's said", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, played, journal } = yield* make(undefined, { ...loader, urgentMessages: [question], unsummarizable: [garbled] })
        yield* toggle(false)
        yield* made.finished(unhooked(question, "run-1", (yield* made.power).turns))
        yield* wait(11)
        yield* toggle(true)
        yield* handle("claude", stop(garbled), { project: "yapd", host: hostname() }, false)
        for (let index = 0; index < 3; index++) yield* wait(11)
        return {
          played: [...played],
          kept: (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.said, row.heardAt !== undefined]),
          told: (yield* catchingUp(journal)).map(({ said }) => said),
        }
      }),
    )
    expect(result.played).toEqual([couldnt])
    expect(result.kept).toEqual([
      [`yapd. ${question}`, false],
      [couldnt, true],
    ])
    expect(result.told).toEqual([`yapd. ${question}`])
  })

  test("a question waiting to be said in its hook's place, whose Stop couldn't be summed up and is said instead, is still his to hear", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { made, finish, handle, wait, played, nextEvent, journal } = yield* make(undefined, { ...loader, urgentMessages: [question], unsummarizable: [garbled] })
        yield* finish("playing", "Something long.")
        yield* made.finished(unhooked(question, "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready: yapd. Which network")
        yield* handle("claude", stop(garbled), { project: "yapd", host: hostname() }, false)
        for (let index = 0; index < 4; index++) yield* wait(11)
        return {
          played: [...played],
          kept: (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.said, row.heardAt !== undefined]),
          unheard: (yield* journal.unheard(0, 10)).map(({ said }) => said),
        }
      }),
    )
    expect(result.played).toEqual(["yapd. Something long.", couldnt])
    expect(result.kept).toEqual([
      ["yapd. Something long.", true],
      [`yapd. ${question}`, false],
      [couldnt, true],
    ])
    expect(result.unheard).toEqual([`yapd. ${question}`])
  })

  test("the answer to what he sent a thread, kept unheard in its hook's place while yapd is off, whose Stop come late couldn't be summed up, is told of beside it in a catch-up", async () => {
    const answer = "The bridge uses the testnet first, as you asked."
    const result = await run(
      Effect.gen(function* () {
        const { made, handle, wait, toggle, journal } = yield* make(undefined, { ...loader, unsummarizable: [`Done. ${answer}`] })
        yield* toggle(false)
        yield* made.finished({ ...unhooked(answer, "run-1", (yield* made.power).turns), answering: true })
        yield* wait(11)
        yield* handle("claude", stop(`Done. ${answer}`), { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        const told = yield* catchingUp(journal)
        yield* journal.markHeard(told.filter(({ said }) => said === couldnt).map(({ id }) => id), yield* Clock.currentTimeMillis)
        return {
          told: told.map(({ said }) => said).toSorted(),
          kept: (yield* journal.since(0, { kinds: ["update"] })).map((row) => [row.said, row.heardAt !== undefined]),
        }
      }),
    )
    expect(result.told).toEqual([`yapd. ${answer}`, couldnt].toSorted())
    expect(result.kept).toEqual([
      [`yapd. ${answer}`, false],
      [couldnt, true],
    ])
  })

  test("a late Stop in words that can't be told, which couldn't be summed up, is said though the next run's turn kept quiet in its hook's place was heard since", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { made, handle, wait, played, logged, nextEvent, journal } = yield* make(undefined, { ...loader, mutes, unsummarizable: ["I need the staging password."] })
        yield* mutes.mute({ key: Mutes.key.thread({ machine: "Rosie", id: "t-loader" }) })
        yield* made.finished(unhooked("The docs are swept.", "run-2", (yield* made.power).turns))
        yield* nextEvent("Muted update for yapd")
        // He hears it, as in a catch-up.
        yield* journal.markHeard((yield* journal.since(0, { kinds: ["update"] })).map(({ id }) => id), yield* Clock.currentTimeMillis)
        // The run before's Stop, late, in words neither run's are known by.
        yield* handle("claude", stop("I need the staging password."), { project: "yapd", host: hostname() }, false)
        for (let index = 0; index < 3; index++) yield* wait(11)
        return { played: [...played], skipped: logged.some((line) => line.startsWith("Skipped update, heard already")) }
      }),
    )
    expect(result.played).toEqual([couldnt])
    expect(result.skipped).toBe(false)
  })
})

describe("Daemon reminders", () => {
  test("a thread he asked to hear finish is said as one, the reminder then its update, however he muted it, and both are heard together", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        const journal = Journal.fromStore(store)
        const reminders = Reminders.make(store, journal)
        const mutes = yield* Mutes.make(store)
        const loader = { machine: "Rosie", id: "t-loader" }
        yield* mutes.mute({ key: Mutes.key.thread(loader) })
        yield* reminders.add({ at: -120_000, heard: "Tell me when the loader one finishes.", text: "", event: "finished", machine: "Rosie", thread: "t-loader", called: "the loader fix" })
        const apart: Array<string> = []
        const finishing = Reminders.finishing({
          reminders,
          desk: () => Effect.succeed({ threads: [], away: [] }),
          lines: Effect.succeed(Persona.plain),
          announce: (spoken) => Effect.sync(() => void apart.push(spoken)),
        })
        const { made, wait, played } = yield* make(undefined, { journal, mutes, finishing })
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* wait(11)
        const kept = yield* journal.since(-200_000, { kinds: ["notice", "update"] })
        return { played: [...played], kept: kept.map(({ kind, said, heardAt }) => [kind, said, heardAt !== undefined]), pending: (yield* reminders.pending).length, apart }
      }),
    )
    expect(result.played).toEqual(["The loader fix has finished, as you asked. yapd. The loader is fixed."])
    expect(result.kept).toEqual([
      ["notice", "The loader fix has finished, as you asked.", true],
      ["update", "yapd. The loader is fixed.", true],
    ])
    expect(result.pending).toBe(0)
    // Heard with its update, it's never said again on its own.
    expect(result.apart).toEqual([])
  })

  test("a reminder that led an update dropped before he heard it, as its thread started again, is said on its own under the entry it fired under", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        const journal = Journal.fromStore(store)
        const reminders = Reminders.make(store, journal)
        yield* reminders.add({ at: -120_000, heard: "Tell me when the loader one finishes, I need to call the bank.", text: "call the bank", event: "finished", machine: "Rosie", thread: "t-loader", called: "the loader fix" })
        const apart: Array<{ readonly spoken: string; readonly key: string; readonly kept: boolean }> = []
        const finishing = Reminders.finishing({
          reminders,
          desk: () => Effect.succeed({ threads: [], away: [] }),
          lines: Effect.succeed(Persona.plain),
          announce: (spoken, entry, kept) => Effect.sync(() => void apart.push({ spoken, key: entry.key, kept: Option.isSome(kept) })),
        })
        const { made, wait, played, finish, nextEvent } = yield* make(undefined, { journal, finishing })
        // It waits behind something else being said, and the thread starts again meanwhile.
        yield* finish("a", "Something else first.")
        yield* made.finished(unhooked("The loader is fixed.", "run-1", (yield* made.power).turns))
        yield* nextEvent("Ready: yapd. The loader")
        yield* made.overtaken({ machine: "Rosie", id: "t-loader" })
        yield* wait(11)
        yield* wait(11)
        const kept = yield* journal.since(-200_000, { kinds: ["notice"] })
        return { played: [...played], apart, kept: kept.map(({ key, heardAt }) => [key, heardAt !== undefined]) }
      }),
    )
    expect(result.played).toEqual(["yapd. Something else first."])
    // Fired once, it's handed over once, on its own, under the entry it fired under, unheard until it's said.
    expect(result.apart).toEqual([{ spoken: "The loader fix has finished. You asked me to remind you then: call the bank.", key: "remind:1", kept: true }])
    expect(result.kept).toEqual([["remind:1", false]])
  })

  /** What a hook's turn of the loader fix, which he asked to hear finish, is led by, and what's left waiting, when how it went reads as `ended`. */
  const hooked = (message: string, ended?: Reminders.Ending) =>
    run(
      Effect.gen(function* () {
        const store = yield* Store.make(":memory:")
        const journal = Journal.fromStore(store)
        const reminders = Reminders.make(store, journal)
        yield* reminders.add({ at: -120_000, heard: "Tell me when the loader one finishes.", text: "", event: "finished", machine: "Rosie", thread: "t-loader", called: "the loader fix" })
        const finishing = Reminders.finishing({
          reminders,
          desk: () => Effect.succeed({ threads: [], away: [] }),
          lines: Effect.succeed(Persona.plain),
          announce: () => Effect.void,
        })
        const { handle, wait, played } = yield* make(undefined, {
          journal,
          finishing,
          link: () => Effect.succeedSome({ machine: "Rosie", id: "t-loader" }),
          ...(ended === undefined ? {} : { ending: () => Effect.succeed(ended) }),
        })
        yield* handle("claude", { hook_event_name: "Stop", session_id: "s-loader", cwd: "/code/yapd", last_assistant_message: message }, { project: "yapd", host: hostname() }, false)
        yield* wait(11)
        return { played: [...played], pending: (yield* reminders.pending).length }
      }),
    )

  test("a hook's turn of a thread he asked to hear finish that failed is led by why it stopped, never that it finished", async () => {
    const result = await hooked("The provider failed, so I stopped.", { _tag: "Failed", why: "the model provider had an error." })
    expect(result.played).toEqual(["The loader fix stopped, before finishing: the model provider had an error. yapd. The provider failed, so I stopped."])
    expect(result.pending).toBe(0)
  })

  test("a hook's turn of a thread he asked to hear finish whose run can't be read, as on rig, says it stopped working on it, never that it finished", async () => {
    const result = await hooked("The provider failed, so I stopped.")
    expect(result.played).toEqual(["The loader fix has stopped working on it, as you asked to hear. yapd. The provider failed, so I stopped."])
    expect(result.pending).toBe(0)
  })

  test("a hook's turn of a thread he asked to hear finish that he stopped leaves it waiting for its next", async () => {
    const result = await hooked("Stopped as you asked.", { _tag: "Stopped" })
    expect(result.played).toEqual(["yapd. Stopped as you asked."])
    expect(result.pending).toBe(1)
  })

  test("a hook's turn of a thread he asked to hear finish that went well says it finished", async () => {
    const result = await hooked("The loader is fixed.", { _tag: "Finished" })
    expect(result.played).toEqual(["The loader fix has finished, as you asked. yapd. The loader is fixed."])
    expect(result.pending).toBe(0)
  })
})

/** The Jarvis thread, and the review T3 Code runs as its subagent, by their keys. */
const jarvis = { machine: "Rosie", id: "t-jarvis" }
const jarvisKey = Mutes.key.thread(jarvis)
const review = { machine: "Rosie", id: "t-review" }
const reviewKey = Mutes.key.thread(review)

/** The review, as a hook of it is found. */
const reviewed: Threads.Linked = { _tag: "Subagent", child: review, called: "Sol review", head: Option.some({ ref: jarvis, called: "the Jarvis companion" }) }

/** A hook of the Jarvis thread's own session, or else of T3 Code's review of it. */
const jarvisOrReview = (session: string) => Effect.succeedSome<Threads.Linked>(session === "s-jarvis" ? { _tag: "Thread", ref: jarvis } : reviewed)

/** What's kept of an update in the journal: under which thread, and how it was kept quiet, if it was. */
const keptAs = (kept: Journal.Kept) => {
  const detail = kept.detail as { readonly muted?: boolean; readonly subagent?: boolean; readonly head?: string; readonly held?: string; readonly session?: string }
  return { thread: kept.thread, muted: detail.muted === true, subagent: detail.subagent === true, head: detail.head, held: detail.held, session: detail.session }
}

describe("Daemon with a thread's subagents", () => {
  test("a subagent's update is kept to yapd by default, whatever it is, off or in focus too: never rendered, its hook let go of, kept quiet under it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        let focus = false
        const { handle, wait, played, renders, followUps, journal, power } = yield* make(undefined, {
          mutes,
          linked: jarvisOrReview,
          urgentMessages: ["One release blocker is left."],
          unsummarizable: ["The loader is unreadable."],
          holding: Effect.sync(() => (focus ? Option.some("focus" as const) : Option.none())),
        })
        const stop = (session: string, message: string) =>
          handle("claude", { hook_event_name: "Stop", session_id: session, cwd: "/code/yapd", last_assistant_message: message }, { project: "yapd", host: hostname() }, true).pipe(
            Effect.zipRight(wait(1)),
          )
        yield* stop("s-review-1", "The review is clean.")
        yield* stop("s-review-2", "One release blocker is left.")
        yield* stop("s-review-3", "The loader is unreadable.")
        yield* power(false)
        yield* stop("s-review-4", "Found two nits.")
        yield* power(true)
        focus = true
        yield* stop("s-review-5", "Found three nits.")
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], renders: renders(), followUps: [...followUps], kept: kept.map(keptAs) }
      }),
    )
    expect(result.played).toEqual([])
    expect(result.renders).toBe(0)
    // Every hook that waited is let go of; none waits while yapd is off.
    expect(result.followUps).toEqual(["claude:s-review-1 let go", "claude:s-review-2 let go", "claude:s-review-3 let go", "claude:s-review-5 let go"])
    // Never as what came in while yapd was off, nor held for focus: kept quiet, under the review, with the thread it's part of.
    expect(result.kept).toEqual(
      [1, 2, 3, 4, 5].map((index) => ({ thread: "t-review", muted: true, subagent: true, head: "t-jarvis", held: undefined, session: `claude:s-review-${index}` })),
    )
  })

  test("a subagent's update is said once he has its thread's read, led by that thread, kept quiet once he mutes that thread, but what needs him still said, and that mute never moved", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        yield* mutes.read({ key: jarvisKey }, true)
        const { talk, wait, played, responded, journal, handle } = yield* make("Unmute it.", { mutes, linked: jarvisOrReview, urgentMessages: ["One release blocker is left."] })
        yield* stopHere(handle, "s-review-1", "The review is clean.")
        yield* wait(11)
        yield* mutes.mute({ key: jarvisKey })
        yield* stopHere(handle, "s-review-2", "Found two nits.")
        yield* wait(11)
        yield* stopHere(handle, "s-review-3", "One release blocker is left.")
        yield* wait(1)
        // Over a subagent's update, it's the review that's unmuted, if it was muted, never the thread it's part of.
        yield* talk
        yield* wait(11)
        const kept = yield* journal.since(0, { kinds: ["update"] })
        return { played: [...played], responded: [...responded], mutes: (yield* mutes.list).map(({ key }) => key), kept: kept.map(keptAs) }
      }),
    )
    expect(result.played).toEqual(["For the Jarvis companion: The review is clean.", "For the Jarvis companion: One release blocker is left.", "It isn't muted."])
    expect(result.responded).toEqual([])
    expect(result.mutes).toEqual([jarvisKey])
    expect(result.kept.map(({ thread, muted, subagent }) => [thread, muted, subagent])).toEqual([
      ["t-review", false, true],
      ["t-review", true, true],
      ["t-review", false, true],
    ])
  })

  test("finding a hook's thread late never holds its update up longer than ever, unless one of T3 Code's own subagents there was still to be read, and then ten seconds at most", async () => {
    const said = (link: (promising: Deferred.Deferred<void>) => Effect.Effect<Option.Option<Threads.Linked>>) =>
      run(
        Effect.gen(function* () {
          const { handle, wait, played, logged, journal } = yield* make(undefined, { linked: (_session, _cwd, promising) => link(promising) })
          yield* stopHere(handle, "s-slow", "The loader is fixed.")
          const at: Array<number> = []
          for (let second = 1; second <= 12; second++) {
            yield* wait(1)
            if (played.length > 0 && at.length === 0) at.push(second)
          }
          const kept = yield* journal.since(0, { kinds: ["update"] })
          return { at: at[0], kept: kept.map(keptAs).map(({ thread, muted }) => [thread, muted]), ranOut: logged.includes("Not linked: ran out of time looking among subagents") }
        }),
      )
    // A thread's own, said untied at three seconds, as ever, however soon it's found after.
    expect(await said(() => Effect.as(Effect.sleep("8 seconds"), Option.some<Threads.Linked>({ _tag: "Thread", ref: jarvis })))).toEqual({
      at: 3,
      kept: [["claude:s-slow", false]],
      ranOut: false,
    })
    // A subagent found in six seconds, while one was to be read, is kept to yapd.
    const promised = (answer: Effect.Effect<Option.Option<Threads.Linked>>) => (promising: Deferred.Deferred<void>) => Effect.zipRight(Deferred.succeed(promising, undefined), answer)
    expect(await said(promised(Effect.as(Effect.sleep("6 seconds"), Option.some(reviewed))))).toEqual({ at: undefined, kept: [["t-review", true]], ranOut: false })
    // Never found, it's said at ten seconds, the old way, which is logged.
    expect(await said(promised(Effect.never))).toEqual({ at: 10, kept: [["claude:s-slow", false]], ranOut: true })
  })

  test("'read me its subagents' over a thread's update reads them from then on, saying some were kept, and 'scratch that' keeps them to yapd again, never asking the model", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        const { handle, talk, wait, played, responded, followUps } = yield* make("Read me its subagents.", {
          mutes,
          linked: jarvisOrReview,
          transcripts: ["Read me its subagents.", "Scratch that."],
          answer: "Say that again?",
        })
        // Kept to yapd, before he asked.
        yield* stopHere(handle, "s-review-1", "The review is clean.")
        yield* wait(1)
        yield* stopHere(handle, "s-jarvis", "The Jarvis work is merged.")
        yield* wait(1)
        yield* talk
        const reading = yield* mutes.reads(jarvisKey)
        yield* wait(2)
        yield* talk
        yield* wait(11)
        return { played: [...played], responded: [...responded], followUps: [...followUps], reading, after: yield* mutes.reads(jarvisKey) }
      }),
    )
    expect(result.played).toEqual([
      "yapd. The Jarvis work is merged.",
      "From now on I'll read you its subagents. Ask me what they said for the ones so far.",
      "Back to keeping its subagents to myself.",
    ])
    expect(result.reading).toBe(true)
    expect(result.after).toBe(false)
    expect(result.responded).toEqual([])
    expect(result.followUps).toEqual([])
  })

  test("over a subagent's update, 'mute it for an hour' mutes only it, 'stop reading its subagents' is its thread's, and anything else about its subagents is the shortcut's, never sent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const mutes = yield* muting
        yield* mutes.read({ key: jarvisKey }, true)
        const { handle, talk, wait, played, responded, followUps } = yield* make("Mute it for an hour.", {
          mutes,
          linked: jarvisOrReview,
          transcripts: ["Mute it for an hour.", "Can you read me the subagents?", "Keep its subagents to yourself.", "Have a subagent review it.", "Stop reading its subagents."],
          send: () => Effect.void,
        })
        yield* stopHere(handle, "s-review-1", "The review is clean.")
        for (let index = 0; index < 5; index++) {
          yield* wait(1)
          yield* talk
          yield* wait(4)
        }
        yield* wait(11)
        return {
          played: [...played],
          responded: [...responded],
          followUps: [...followUps],
          mutes: (yield* mutes.list).map(({ key, called, ends }) => [key, called, ends]),
          reading: yield* mutes.reads(jarvisKey),
        }
      }),
    )
    const elsewhere = "Ask me that with the shortcut. Over an update, say read its subagents, or stop reading them."
    expect(result.played.slice(0, 2)).toEqual(["For the Jarvis companion: The review is clean.", expect.stringMatching(/^Muted it until .+\. I'll still tell you if it needs you\.$/)])
    expect(result.played.slice(2)).toEqual([elsewhere, elsewhere, "Okay, passed on.", "I'll keep its subagents to myself."])
    // Only what's for the agent reaches it.
    expect(result.responded).toEqual(["Have a subagent review it."])
    expect(result.followUps).toEqual(["s-review-1 sent: Have a subagent review it."])
    expect(result.mutes).toEqual([[reviewKey, "Sol review", 60 * 60_000 + 1_000]])
    expect(result.reading).toBe(false)
  })

  test("no longer reading a thread's subagents drops what of them waits, whatever it is, and keeps quiet what was held, but never the thread's own; muting the thread spares what needs him", async () => {
    const queued = (stopping: "read" | "mute") =>
      run(
        Effect.gen(function* () {
          const mutes = yield* muting
          yield* mutes.read({ key: jarvisKey }, true)
          const { made, handle, finish, wait, played, journal, power } = yield* make(undefined, {
            mutes,
            linked: jarvisOrReview,
            urgentMessages: ["One release blocker is left."],
            unsummarizable: ["The loader is unreadable."],
          })
          // Held as yapd was off, what needs him too.
          yield* power(false)
          yield* stopHere(handle, "s-review-0", "One release blocker is left.")
          yield* power(true)
          // Waiting behind what's being said.
          yield* finish("front", "Something else first.")
          yield* stopHere(handle, "s-review-1", "One release blocker is left.")
          yield* stopHere(handle, "s-review-2", "The loader is unreadable.")
          yield* stopHere(handle, "s-review-3", "Found two nits.")
          yield* stopHere(handle, "s-jarvis", "The Jarvis work is merged.")
          const controls = Option.getOrThrow(made.controls)
          yield* stopping === "read" ? controls.subagents({ key: jarvisKey }, false) : controls.mute({ key: jarvisKey })
          yield* wait(60)
          const kept = yield* journal.since(0, { kinds: ["update"] })
          return { played: [...played], kept: kept.filter(({ thread }) => thread === "t-review").map(keptAs).map(({ muted, held }) => [muted, held]) }
        }),
      )
    const stopped = await queued("read")
    expect(stopped.played).toEqual(["yapd. Something else first.", "yapd. The Jarvis work is merged."])
    expect(stopped.kept).toEqual([
      [true, "off"],
      [true, undefined],
      [true, undefined],
      [true, undefined],
    ])
    const muted = await queued("mute")
    expect(muted.played).toEqual([
      "yapd. Something else first.",
      "For the Jarvis companion: One release blocker is left.",
      "For the Jarvis companion: yapd finished a turn, but I couldn't summarize it.",
    ])
  })
})

describe("Daemon handing over what's yapd's to do", () => {
  const minaThread = (overrides: Record<string, unknown> = {}) => thread("t-mina", "Open the Mina SSV2 bug tickets", overrides)
  /** A thread's handle on the desk the model was shown. */
  const handleOf = (situation: Brain.Situation, id: string) => situation.desk.threads.find(({ ref }) => ref.id === id)?.handle ?? ""
  /** The Tezos migration's Stop, tied to its thread, waiting for his reply when it's `hooked`, needing him when it asks. */
  const tezosStop = (handle: Handle, hooked = false, message = "The migration compiles.") =>
    handle("claude", { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: message }, { project: "yapd", host: hostname() }, hooked)

  test("'tell the Mina one to wait' over a Tezos update goes to the Mina thread, never the Tezos agent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, talk, wait, nextEvent, nextPlayback, played, followUps, responded, asked } = yield* assisted(
          (situation) => Brain.decision({ act: "send", target: handleOf(situation, "t-mina"), text: "Wait for the Tezos migration before merging.", how: "now" }),
          {
            says: "Tell the Mina one to wait.",
            hands: t3.hands,
            t3,
            link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
            handsOver: () => true,
            handing: {},
          },
          [tezos(), minaThread()],
        )
        yield* tezosStop(handle)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* talk
        for (let second = 0; second < 30; second++) yield* wait(1)
        return { sent: t3.sent(), relayed: [...followUps], played: [...played], responded: [...responded], asked: asked.length }
      }),
    )
    // The Responder handed it over, and the Brain sent it to the Mina tickets, through T3 Code, once.
    expect(result.responded).toEqual(["Tell the Mina one to wait."])
    expect(result.asked).toBe(1)
    expect(result.sent).toEqual(["t-mina: Wait for the Tezos migration before merging."])
    expect(result.relayed).toEqual([])
    expect(result.played).toEqual(["yapd. The migration compiles.", "On it: Open the Mina SSV2 bug tickets."])
  })

  test.each([
    ["a hooked update", "hooked"],
    ["a rig update tied by owner, its thread on the desk", "owner"],
  ] as const)("over %s, 'tell it to rebase', handed over, goes through its waiting hook; 'tell the Mina one to wait and tell it to rebase' sends both to the Mina one through T3 Code, and with 'tell this one to rebase' leaves the rebase, said; nothing reaches the update's own thread through T3 Code", async (_, how) => {
    const over = (said: string) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const { handle, talk, wait, nextEvent, nextPlayback, played, followUps } = yield* assisted(
            (situation) => {
              const heard = situation.utterance.heard.toLowerCase()
              // "It", as the model is shown it: the update's own thread, by its handle, or after a step to the Mina one, that one;
              // "this one" is still the update's own.
              if (heard.startsWith("tell it to rebase")) {
                return Brain.decision({ act: "send", target: Option.match(Brain.focused(situation), { onNone: () => "", onSome: ({ handle }) => handle }), text: "Rebase onto master." })
              }
              if (heard.startsWith("tell this one to rebase")) return Brain.decision({ act: "send", target: Brain.ownHandle(situation) ?? "", text: "Rebase onto master." })
              return Brain.decision({ act: "send", target: handleOf(situation, "t-mina"), text: "Wait for the Tezos migration.", rest: heard.slice(heard.indexOf(" and ") + " and ".length).replace(/\.$/, "") })
            },
            {
              says: said,
              hands: t3.hands,
              t3,
              // Here, its hook waits for his reply; from rig, it's only known to be from the thread, which is on the desk.
              ...(how === "hooked"
                ? { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }) }
                : { owner: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }) }),
              handsOver: () => true,
              handing: {},
            },
            [tezos(), minaThread()],
          )
          yield* handle(
            "claude",
            { hook_event_name: "Stop", session_id: "s-tezos", cwd: "/code/yapd", last_assistant_message: "The migration compiles." },
            { project: "yapd", host: how === "hooked" ? hostname() : "rig.local" },
            how === "hooked",
          )
          yield* nextEvent("Ready:")
          yield* nextPlayback
          yield* talk
          for (let second = 0; second < 30; second++) yield* wait(1)
          return { sent: t3.sent(), relayed: [...followUps].filter((line) => line.includes("sent:")), played: [...played].slice(1) }
        }),
      )
    const own = await over("Tell it to rebase.")
    expect(own.relayed).toEqual(["s-tezos sent: Rebase onto master."])
    expect(own.sent).toEqual([])
    const both = await over("Tell the Mina one to wait and tell it to rebase.")
    expect(both.sent).toEqual(["t-mina: Wait for the Tezos migration.", "t-mina: Rebase onto master."])
    expect(both.relayed).toEqual([])
    expect(both.played).toEqual(["On it: Open the Mina SSV2 bug tickets. On it."])
    const left = await over("Tell the Mina one to wait and tell this one to rebase.")
    expect(left.sent).toEqual(["t-mina: Wait for the Tezos migration."])
    expect(left.relayed).toEqual([])
    expect(left.played).toEqual(["On it: Open the Mina SSV2 bug tickets. I left that: tell this one to rebase."])
  })

  test("over a hooked Tezos update, 'tell the migration one to wait', asked which, answered 'the Tezos one', sends nothing through T3 Code and says it was left; and a reply to a late 'On it' over a hooked update never reaches its thread through T3 Code", async () => {
    const asked = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, talk, wait, nextEvent, nextPlayback, played, followUps } = yield* assisted(
          // Unsure which he meant, the Mina tickets likelier: asked, between the two.
          (situation) => Brain.decision({ act: "send", target: handleOf(situation, "t-mina"), others: handleOf(situation, "t-tezos"), sure: "low", text: "Wait." }),
          {
            says: "Tell the migration one to wait.",
            transcripts: ["Tell the migration one to wait.", "The Tezos one."],
            hands: t3.hands,
            t3,
            link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
            handsOver: () => true,
            handing: {},
          },
          [tezos(), minaThread()],
        )
        yield* tezosStop(handle, true)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* talk
        // Asked which, he answers.
        for (let second = 0; second < 3; second++) yield* wait(1)
        yield* talk
        for (let second = 0; second < 30; second++) yield* wait(1)
        return { sent: t3.sent(), relayed: [...followUps].filter((line) => line.includes("sent:")), played: [...played].slice(1) }
      }),
    )
    expect(asked.played).toEqual(["Open the Mina SSV2 bug tickets or Migrate Tezos Integration?", "I left that: Tell the migration one to wait."])
    expect(asked.sent).toEqual([])
    expect(asked.relayed).toEqual([])
    // Said right after a late "On it" for a reply that went through its hook, "it" is still a thread whose hook waits.
    const late = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, speak, talk, wait, dictate, nextEvent, nextPlayback, played, followUps } = yield* assisted(
          (situation) => Brain.decision({ act: "send", target: handleOf(situation, "t-tezos"), text: "Rebase onto master." }),
          {
            says: "Use the fee table.",
            transcripts: ["Use the fee table.", "And tell it to rebase."],
            hands: t3.hands,
            t3,
            link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
            handing: {},
          },
          [tezos(), minaThread()],
        )
        yield* tezosStop(handle, true)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* speak
        yield* wait(1)
        // Cut off by a dictation before the reply is sent through the hook, it says so later, from its end.
        yield* Scope.close(yield* dictate, Exit.void)
        yield* wait(3)
        yield* wait(10)
        yield* talk
        for (let second = 0; second < 20; second++) yield* wait(1)
        return { sent: t3.sent(), relayed: [...followUps].filter((line) => line.includes("sent:")), played: [...played].slice(1) }
      }),
    )
    expect(late.relayed).toEqual(["s-tezos sent: Use the fee table."])
    expect(late.sent).toEqual([])
    expect(late.played).toEqual(["yapd. Okay, passed on.", "I left that: And tell it to rebase."])
  })

  test("over a hooked Tezos update, a follow-up to what a handoff answered, and something new said back to what it asked, never reach its thread through T3 Code", async () => {
    /** He hands `said` over a hooked Tezos update, as the model takes it, then says `then` back to what came of it. */
    const followed = (said: string, then: string, model: (situation: Brain.Situation) => Brain.Decision) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const { handle, talk, wait, nextEvent, nextPlayback, played, followUps } = yield* assisted(
            model,
            {
              says: said,
              transcripts: [said, then],
              hands: t3.hands,
              t3,
              link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
              handsOver: () => true,
              handing: {},
            },
            [tezos(), minaThread()],
          )
          yield* tezosStop(handle, true)
          yield* nextEvent("Ready:")
          yield* nextPlayback
          yield* talk
          for (let second = 0; second < 3; second++) yield* wait(1)
          yield* talk
          for (let second = 0; second < 30; second++) yield* wait(1)
          return { sent: t3.sent(), relayed: [...followUps].filter((line) => line.includes("sent:")), played: [...played].slice(1) }
        }),
      )
    const rebase = (situation: Brain.Situation) => Brain.decision({ act: "send", target: handleOf(situation, "t-tezos"), text: "Rebase onto master." })
    // Told how it's doing, "tell it to rebase" over the answer is left, its hook still waiting.
    const answered = await followed("How's it doing?", "Tell it to rebase.", (situation) =>
      situation.utterance.heard === "How's it doing?" ? Brain.decision({ act: "answer", target: handleOf(situation, "t-tezos"), spoken: "It compiles." }) : rebase(situation),
    )
    expect(answered.played).toEqual(["It compiles.", "I left that: Tell it to rebase."])
    expect(answered.sent).toEqual([])
    expect(answered.relayed).toEqual([])
    // Asked which, a message to it instead is something new, left too.
    const asked = await followed("Tell the migration one to wait.", "No, tell it to rebase.", (situation) =>
      situation.utterance.heard === "No, tell it to rebase."
        ? rebase(situation)
        : Brain.decision({ act: "send", target: handleOf(situation, "t-mina"), others: handleOf(situation, "t-tezos"), sure: "low", text: "Wait." }),
    )
    expect(asked.played).toEqual(["Open the Mina SSV2 bug tickets or Migrate Tezos Integration?", "I left that: No, tell it to rebase."])
    expect(asked.sent).toEqual([])
    expect(asked.relayed).toEqual([])
  })

  test("'settle it' over a hooked Tezos update settles its thread in T3 Code, sending it nothing, though he isn't at hand; over a session tied to no thread, there's none to settle, and nothing goes", async () => {
    const settled = (hooked: boolean) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const { handle, talk, wait, nextEvent, played, followUps } = yield* assisted(
            // "It", as the model is shown it: the update's own thread, by its handle, or none.
            (situation) => Brain.decision({ act: "tidy", how: "settle", target: Option.match(Brain.focused(situation), { onNone: () => "", onSome: ({ handle }) => handle }) }),
            {
              says: "Settle it.",
              hands: t3.hands,
              t3,
              ...(hooked ? { link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }) } : {}),
              handsOver: () => true,
              handing: {},
            },
            [tezos(), minaThread()],
          )
          yield* tezosStop(handle, hooked)
          yield* nextEvent("Ready:")
          yield* talk
          for (let second = 0; second < 30; second++) yield* wait(1)
          return { commands: t3.commands(), relayed: [...followUps].filter((line) => line.includes("sent:")), played: [...played].slice(1) }
        }),
      )
    const hooked = await settled(true)
    expect(hooked.commands).toEqual(["t-tezos: thread.settle"])
    expect(hooked.relayed).toEqual([])
    const untied = await settled(false)
    expect(untied.commands).toEqual([])
    expect(untied.relayed).toEqual([])
    expect(untied.played).toEqual(["This session has no T3 Code thread to settle."])
  })

  test("'scratch that' after 'settle it' over a hooked Tezos update unsettles its thread, sending it nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, talk, wait, nextEvent, nextPlayback, played, followUps } = yield* assisted(
          // "It", as the model is shown it, the update's own thread by its handle, which "scratch that" names too.
          (situation) => {
            const it = Option.match(Brain.focused(situation), { onNone: () => "", onSome: ({ handle }) => handle })
            return situation.utterance.heard === "Settle it." ? Brain.decision({ act: "tidy", how: "settle", target: it }) : Brain.decision({ act: "undo", target: it })
          },
          {
            says: "Settle it.",
            transcripts: ["Settle it.", "Scratch that."],
            hands: t3.hands,
            t3,
            link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
            handsOver: () => true,
            handing: {},
          },
          [tezos(), minaThread()],
        )
        yield* tezosStop(handle, true)
        yield* nextEvent("Ready:")
        yield* nextPlayback
        yield* talk
        // Said once its line has played, as it's listened to after.
        for (let second = 0; second < 11; second++) yield* wait(1)
        yield* talk
        for (let second = 0; second < 30; second++) yield* wait(1)
        return { commands: t3.commands(), relayed: [...followUps].filter((line) => line.includes("sent:")), played: [...played].slice(1) }
      }),
    )
    expect(result.commands).toEqual(["t-tezos: thread.settle", "t-tezos: thread.unsettle"])
    expect(result.relayed).toEqual([])
    expect(result.played).toEqual(["Settled: Migrate Tezos Integration.", "Unsettled: Migrate Tezos Integration."])
  })

  test("'scratch that' handed over after the 'On it' of a message passed through a hook, with a dictation's message to Mina sent a minute before, takes nothing back without asking, and asks about Mina's by name; after one yapd sent itself, it takes back that message alone", async () => {
    /** With `it`, the model names the update's own thread, "it", for what's taken back. */
    const scratched = (hooked: boolean, it = false) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const { handle, speak, talk, wait, nextEvent, played, dictating } = yield* assisted(
            (situation) =>
              situation.utterance.via === "shortcut"
                ? Brain.decision({ act: "send", target: handleOf(situation, "t-mina"), text: "Wait for the Tezos migration." })
                : Brain.decision({ act: "undo", target: it ? handleOf(situation, "t-tezos") : "" }),
            {
              says: "Use the fee table.",
              transcripts: ["Use the fee table.", "Scratch that."],
              hands: t3.hands,
              t3,
              link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
              handsOver: (heard) => heard === "Scratch that.",
              handing: {},
            },
            [tezos(), minaThread()],
          )
          yield* dictating("Tell the Mina one to wait.")
          yield* wait(10)
          yield* wait(50)
          yield* tezosStop(handle, hooked)
          yield* nextEvent("Ready: yapd.")
          yield* wait(1)
          yield* speak
          // Sent, then said; "scratch that" over its line.
          for (let second = 0; second < 4; second++) yield* wait(1)
          yield* talk
          for (let second = 0; second < 30; second++) yield* wait(1)
          return { commands: t3.commands(), played: [...played] }
        }),
      )
    // Through its hook, which leaves nothing to take back: Mina's message, a minute before, is asked about by name, never taken back.
    const hooked = await scratched(true)
    expect(hooked.commands).toEqual(["t-mina: message.dispatch"])
    expect(hooked.played.at(-1)).toContain("Open the Mina SSV2 bug tickets")
    expect(hooked.played.at(-1)).toMatch(/\?$/)
    // Taken as naming "it", it still reaches what was done last, Mina's message, which is asked about the same, never taken back.
    const named = await scratched(true, true)
    expect(named.commands).toEqual(["t-mina: message.dispatch"])
    expect(named.played.at(-1)).toBe(hooked.played.at(-1))
    // By yapd's own hand, it's that message that's taken back, never Mina's: read already, it can only be told to ignore it, which is asked.
    const steered = await scratched(false)
    expect(steered.commands).toEqual(["t-mina: message.dispatch", "t-tezos: message.dispatch"])
    expect(steered.played.at(-1)).toBe("It's already read it. Shall I tell it to ignore that?")
  })

  test("a hooked update ended by a handoff leaves its Stop hook waiting as a dismissal does, so a reply to it heard again goes through it; put back after a handoff, its hook still waits, and a reply over it when it's read again goes through it", async () => {
    const asks = "Should I drop the old fee table, or keep both?"
    const over = (needsYou: boolean) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const { handle, talk, wait, nextEvent, played, followUps, heard, replay } = yield* assisted(
            (situation) => Brain.decision({ act: "answer", target: handleOf(situation, "t-mina"), spoken: "The Mina tickets are filed." }),
            {
              says: "Use the fee table.",
              transcripts: ["What's the Mina one doing?", "Use the fee table."],
              hands: t3.hands,
              t3,
              link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
              handsOver: (said) => said.startsWith("What's"),
              handing: {},
              urgentMessages: [asks],
            },
            [tezos(), minaThread()],
          )
          yield* tezosStop(handle, true, needsYou ? asks : "The migration compiles.")
          yield* nextEvent("Ready: yapd.")
          yield* wait(1)
          yield* talk
          for (let second = 0; second < 30; second++) yield* wait(1)
          // Heard to the end, or once it's read again, it's asked for again from the menu.
          if (!needsYou) {
            const [id] = yield* heard
            yield* replay(id!)
          }
          yield* wait(1)
          yield* talk
          for (let second = 0; second < 30; second++) yield* wait(1)
          return { sent: t3.sent(), hook: [...followUps], played: [...played] }
        }),
      )
    // Ended by the answer, as by a dismissal, its hook waits on, and a reply to it heard again goes through it.
    const ended = await over(false)
    expect(ended.played).toEqual(["yapd. The migration compiles.", "The Mina tickets are filed.", "yapd. The migration compiles.", "Okay, passed on."])
    expect(ended.hook).toEqual(["s-tezos sent: Use the fee table."])
    expect(ended.sent).toEqual([])
    // Put back, read again after the answer, its hook waiting all the while.
    const putBack = await over(true)
    expect(putBack.played).toEqual([`yapd. ${asks}`, "The Mina tickets are filed.", `yapd. ${asks}`, "Okay, passed on."])
    expect(putBack.hook).toEqual(["s-tezos sent: Use the fee table."])
    expect(putBack.sent).toEqual([])
  })

  test("a handoff over an update that needs him, cut off before its end, reads it again from where it stopped once the handoff's answer is said, for a look, 'show me its PR', 'mute the Tezos one' and new work turned down while he isn't at hand alike, even with a dictation starting just as it's put back; a message to its agent or a dismissal ends it; if yapd restarts first, a catch-up still has it", async () => {
    const asks = "Should I drop the old fee table, or keep both?"
    /** He hands `said` over, as the model takes it, over the Tezos update that asks him that, after a dictation, so he's at hand, unless he's `away`. */
    const over = (said: string, model: (situation: Brain.Situation) => Brain.Decision, given: { readonly dictating?: boolean; readonly away?: boolean } = {}) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const mutes = yield* muting
          const { handle, talk, wait, nextEvent, played, playedFrom, dictate, dictating, restarted } = yield* assisted(
            (situation) => (situation.utterance.via === "shortcut" ? Brain.decision({ act: "answer", spoken: "Nothing else needs you." }) : model(situation)),
            {
              says: said,
              hands: t3.hands,
              t3,
              mutes,
              link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
              handsOver: () => true,
              handing: {},
              urgentMessages: [asks],
            },
            [tezos(), minaThread()],
          )
          if (given.away !== true) {
            yield* dictating("Does anything need me?")
            for (let second = 0; second < 20; second++) yield* wait(1)
          }
          yield* tezosStop(handle, false, asks)
          yield* nextEvent("Ready: yapd.")
          yield* wait(1)
          yield* talk
          // A dictation starting just as it's put back, which the answer and then the update wait behind.
          if (given.dictating === true) {
            yield* Scope.close(yield* dictate, Exit.void)
          }
          yield* wait(1)
          // Before it's read again, as when yapd restarts: a catch-up still has it.
          const missed = (yield* (yield* restarted).missed).groups.flatMap(({ rows }) => rows.map(({ said }) => said))
          for (let second = 0; second < 40; second++) yield* wait(1)
          const update = `yapd. ${asks}`
          const after = played.slice(played.indexOf(update) + 1)
          return {
            played: after,
            again: after.includes(update),
            from: playedFrom.filter((_, index) => played[index] === update),
            missed: missed.includes(update),
            sent: t3.sent(),
            mutes: (yield* mutes.list).map(({ key }) => key),
          }
        }),
      )
    const minaHandle = (situation: Brain.Situation) => handleOf(situation, "t-mina")
    const tezosHandle = (situation: Brain.Situation) => handleOf(situation, "t-tezos")
    // A look, something shown, a mute: each read again, from a moment before where he cut in, once the answer's said.
    const looked = await over("What's the Mina one doing?", (situation) => Brain.decision({ act: "answer", target: minaHandle(situation), spoken: "The Mina tickets are filed." }))
    expect(looked.played.slice(0, 2)).toEqual(["The Mina tickets are filed.", `yapd. ${asks}`])
    expect(looked.from).toEqual([0, 0.5])
    expect(looked.missed).toBe(true)
    const shown = await over("Show me its PR.", (situation) => Brain.decision({ act: "show", how: "pr", target: tezosHandle(situation) }))
    expect(shown.again).toBe(true)
    expect(shown.from).toEqual([0, 0.5])
    const muted = await over("Mute the Tezos one.", (situation) => Brain.decision({ act: "mute", how: "mute", target: tezosHandle(situation) }))
    expect(muted.mutes).toEqual(["t3:Rosie:t-tezos"])
    expect(muted.again).toBe(true)
    expect(muted.from).toEqual([0, 0.5])
    // New work turned down while he isn't at hand, which answers nothing it asked.
    const refused = await over("Let's start a new project to fix the flaky test.", () => Brain.decision({ act: "start", text: "Fix the flaky test." }), { away: true })
    expect(refused.played.slice(0, 2)).toEqual(["Ask me that with the shortcut.", `yapd. ${asks}`])
    expect(refused.from).toEqual([0, 0.5])
    // Even with a dictation starting just as it's put back.
    const dictated = await over("What's the Mina one doing?", (situation) => Brain.decision({ act: "answer", target: minaHandle(situation), spoken: "The Mina tickets are filed." }), { dictating: true })
    expect(dictated.again).toBe(true)
    expect(dictated.from.at(-1)).toBe(0.5)
    // A message to its agent, or a dismissal, ends it: never read again, and heard, so no catch-up has it.
    const passed = await over("Tell it to keep both.", (situation) => Brain.decision({ act: "send", target: tezosHandle(situation), text: "Keep both tables." }))
    expect(passed.sent).toEqual(["t-tezos: Keep both tables."])
    expect(passed.again).toBe(false)
    expect(passed.missed).toBe(false)
    const dismissed = await over("Thanks, that's all.", () => Brain.decision({ act: "dismiss" }))
    expect(dismissed.again).toBe(false)
    expect(dismissed.missed).toBe(false)
  }, 30_000)

  test("'mute the Tezos one' over an update mutes it in the Brain's one model call, never the Responder's, and nothing about mutes reaches an agent, even when the model makes a message of it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const mutes = yield* muting
        const { finish, talk, wait, played, followUps, responded, asked, dictating } = yield* assisted(
          (situation) =>
            situation.utterance.via === "shortcut"
              ? Brain.decision({ act: "answer", spoken: "Nothing else needs you." })
              : situation.utterance.heard.startsWith("Mute")
                ? Brain.decision({ act: "mute", how: "mute", target: handleOf(situation, "t-tezos") })
                : // A message of it, to the session he's hearing, which nothing about mutes ever is.
                  Brain.decision({ act: "send", target: "", text: "I'll mute you if you keep logging." }),
          {
            says: "Mute the Tezos one.",
            transcripts: ["Mute the Tezos one.", "Tell it I'll mute it if it keeps logging."],
            hands: t3.hands,
            t3,
            mutes,
            handsOver: () => true,
            handing: {},
          },
          [tezos(), minaThread()],
        )
        yield* dictating("Does anything need me?")
        for (let second = 0; second < 20; second++) yield* wait(1)
        yield* finish("noisy", "Still logging.")
        yield* wait(1)
        yield* talk
        for (let second = 0; second < 20; second++) yield* wait(1)
        const muted = { responded: [...responded], asked: asked.length, mutes: (yield* mutes.list).map(({ key }) => key) }
        yield* finish("noisy", "Still logging, louder.")
        yield* wait(1)
        yield* talk
        for (let second = 0; second < 20; second++) yield* wait(1)
        return { muted, responded: [...responded], sent: t3.sent(), relayed: [...followUps].filter((line) => line.includes("sent:")), said: played.at(-1) }
      }),
    )
    // The mute hook handed it over, so only the Brain was asked, once: the dictation needed no model.
    expect(result.muted).toEqual({ responded: [], asked: 1, mutes: ["t3:Rosie:t-tezos"] })
    // About mutes in other words, handed over by the Responder, a message the model made of it reaches no one.
    expect(result.responded).toEqual(["Tell it I'll mute it if it keeps logging."])
    expect(result.sent).toEqual([])
    expect(result.relayed).toEqual([])
    // Said in his words, never the model's.
    expect(result.said).toBe("I left that: Tell it I'll mute it if it keeps logging.")
  }, 30_000)

  test("words over an update's first seconds with nothing after a pause, handed over, are never acted on: no send, mute, mode, card or tidy, at most code's own question to stop, after which the update is read again from where it stopped, needs him or not", async () => {
    /** He says `said` over the Tezos update's first seconds, which may all be yapd's own voice, as the model takes it. */
    const over = (said: string, model: (situation: Brain.Situation) => Brain.Decision) =>
      run(
        Effect.gen(function* () {
          const t3 = yield* handing
          const mutes = yield* muting
          const { handle, talk, wait, nextEvent, played, playedFrom, show, dictating, asked } = yield* assisted(
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
          return {
            played: played.slice(played.indexOf(update)),
            from: playedFrom.filter((_, index) => played[index] === update),
            sent: t3.commands(),
            mutes: yield* mutes.list,
            shown: Option.isSome(yield* show.seen),
            asked: asked.length,
          }
        }),
      )
    const tezosHandle = (situation: Brain.Situation) => handleOf(situation, "t-tezos")
    const minaHandle = (situation: Brain.Situation) => handleOf(situation, "t-mina")
    for (const [said, model] of [
      ["Show me the PR.", (situation: Brain.Situation) => Brain.decision({ act: "show", how: "pr", target: tezosHandle(situation) })],
      ["Tell the Mina one to wait.", (situation: Brain.Situation) => Brain.decision({ act: "send", target: minaHandle(situation), text: "Wait." })],
      ["Mute the Tezos one.", (situation: Brain.Situation) => Brain.decision({ act: "mute", how: "mute", target: tezosHandle(situation) })],
      ["Let me focus till three.", () => Brain.decision({ act: "mode", how: "focus" })],
      ["Settle it.", (situation: Brain.Situation) => Brain.decision({ act: "tidy", how: "settle", target: tezosHandle(situation) })],
    ] as const) {
      const result = await over(said, model)
      // Let go: picked up again a word or two back, nothing done, sent, muted, tidied or shown.
      expect(result.sent).toEqual([])
      expect(result.mutes).toEqual([])
      expect(result.shown).toBe(false)
      expect(result.played.every((line) => line === "yapd. The migration compiles.")).toBe(true)
      expect(result.from.length).toBeGreaterThan(1)
    }
    // A stop is only asked about, in code's own question, and the update, which needed nothing of him, is read again after it.
    const stopped = await over("Stop the Mina tickets.", (situation) => Brain.decision({ act: "stop", target: minaHandle(situation) }))
    expect(stopped.sent).toEqual([])
    expect(stopped.played).toEqual(["yapd. The migration compiles.", "Stop Open the Mina SSV2 bug tickets?", "yapd. The migration compiles."])
    expect(stopped.from.at(-1)).toBeGreaterThan(0)
  }, 30_000)

  test("handed over while he isn't at hand, as a TV's talk may be, what only his word does, turned down, never puts him at hand, alone or with more after it, so the next such talk handed over is turned down too", async () => {
    const more = "Okay everyone, focus mode till three, and then quiet."
    const said = ["Okay everyone, focus mode till three.", more, "Right, focus mode till three."]
    const result = await run(
      Effect.gen(function* () {
        const t3 = yield* handing
        const { handle, talk, wait, nextEvent, played } = yield* assisted(
          (situation) => Brain.decision({ act: "mode", how: "focus", ...(situation.utterance.heard === more ? { rest: "and then quiet" } : {}) }),
          {
            says: more,
            transcripts: said,
            hands: t3.hands,
            t3,
            link: () => Effect.succeedSome({ machine: "Rosie", id: "t-tezos" }),
            handsOver: () => true,
            handing: {},
          },
          [tezos(), minaThread()],
        )
        // Nothing dictated, nothing said back taken up: he isn't at hand. Each said over an update of its own.
        for (const message of ["The migration compiles.", "The tests pass.", "The fee table is in."]) {
          yield* tezosStop(handle, false, message)
          yield* nextEvent(`Ready: yapd. ${message}`)
          yield* talk
          for (let second = 0; second < 40; second++) yield* wait(1)
        }
        return [...played]
      }),
    )
    expect(result.filter((line) => line.startsWith("yapd."))).toEqual(["yapd. The migration compiles.", "yapd. The tests pass.", "yapd. The fee table is in."])
    // Every one of them turned down, the last too.
    expect(result.at(1)).toBe("Ask me that with the shortcut.")
    expect(result.at(3)).toContain("Ask me that with the shortcut.")
    expect(result.slice(4)).toEqual(["yapd. The fee table is in.", "Ask me that with the shortcut."])
  }, 30_000)
})
