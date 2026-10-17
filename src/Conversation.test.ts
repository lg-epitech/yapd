import type { Socket } from "bun"
import { describe, expect, test } from "bun:test"
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Runtime,
  Schema,
  type Scope,
  TestClock,
  TestContext,
} from "effect"
import { Audio, native } from "./Audio.ts"
import * as Condenser from "./Condenser.ts"
import * as Conversation from "./Conversation.ts"
import { between, cut, unfinished, unsaid } from "./Conversation.ts"
import { defaults } from "./Endpointer.ts"
import { Relays } from "./Relay.ts"
import * as Helper from "./Helper.ts"
import { Model, ModelError } from "./Model.ts"
import * as Responder from "./Responder.ts"
import { clean, Transcriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import * as Journal from "./Journal.ts"
import * as Persona from "./Persona.ts"
import { KokoroError, type Started, Voice } from "./Voice.ts"
import * as Words from "./Words.ts"

const update: Conversation.Update = {
  session: "s",
  project: "yapd",
  turn: { prompt: Option.none(), message: "The PR is ready." },
  needsYou: false,
  spoken: "The PR is ready.",
  audio: "/tmp/update.wav",
  thread: { agent: "claude", session: "s", cwd: "/tmp", message: "The PR is ready.", origin: {} },
  at: 0,
}

/**
 * Plays a whole conversation against a microphone the test talks into, with the provider taking five seconds to reply,
 * taking what's said to Sam for talk with someone else, and the relay `sending` seconds to send. With `over`, it's that
 * update that's read, and with `present`, while he's at hand. With `reply`, that's what the Responder answers, still after
 * five seconds; with `handing`, what's yapd's to do is handed to it; and with `off`, "Mute." turns yapd off. With `fast`,
 * what it gives a reply for is answered at once, without the model, as the Responder's quick replies are.
 */
const conversation = (
  said: ReadonlyArray<string>,
  sending = 0,
  given: {
    readonly over?: Conversation.Update
    readonly present?: boolean
    readonly reply?: (heard: string) => Responder.Reply
    readonly handing?: NonNullable<Parameters<typeof Conversation.make>[0]["over"]>
    readonly off?: Effect.Effect<void>
    readonly fast?: (heard: string) => Responder.Reply | undefined
  } = {},
) =>
  Effect.gen(function* () {
    const microphone = yield* Queue.unbounded<Float32Array>()
    /** What was played, in order. */
    const played: Array<string> = []
    const heard: Array<string> = []
    const sent: Array<string> = []
    const late: Array<string> = []
    const transcripts = [...said]
    const layer = Layer.mergeAll(
      Layer.succeed(Persona.Persona, {
        lines: Effect.succeed(Persona.plain),
        onIt: () => Effect.succeed(Persona.plain.onIt),
        said: () => Effect.void,
      }),
      Journal.memory,
      Layer.succeed(Audio, {
        play: (path) =>
          Effect.sync(() => void played.push(path)).pipe(Effect.as({
            duration: 10,
            confirmed: true,
            finished: Effect.sleep("10 seconds"),
            stop: Effect.succeed(2),
            volume: () => Effect.void,
          })),
        microphone: Effect.succeed(Option.some(microphone)),
        echo: () => Effect.succeed(false),
        rest: Effect.void,
        warm: Effect.void,
        tick: Effect.void,
      }),
      // Each frame holds the probability that it's speech.
      Layer.succeed(Vad, { make: Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)) }),
      Layer.succeed(Transcriber, {
        transcribe: () => Effect.sync(() => transcripts.shift() ?? ""),
        ready: Effect.succeed(true),
      }),
      Layer.succeed(Responder.Responder, {
        respond: ({ heard: text }) => {
          const fast = given.fast?.(text)
          return fast !== undefined
            ? Effect.succeed({ reply: fast, source: "quick" as const })
            : Effect.sync(() => heard.push(text)).pipe(
                Effect.zipRight(Effect.sleep("5 seconds")),
                Effect.as({
                  reply:
                    given.reply?.(text) ??
                    (text.startsWith("Sam,")
                      ? { intent: "resume" as const, spoken: "", message: "" }
                      : { intent: "send" as const, spoken: "Okay.", message: text }),
                  source: "model" as const,
                }),
              )
        },
      }),
      Layer.succeed(Relays, {
        send: (_, text) => Effect.sleep(`${sending} seconds`).pipe(Effect.zipRight(Effect.sync(() => void sent.push(text)))),
      }),
      Layer.succeed(Voice, { render: () => Effect.void }),
    )
    const context = yield* Layer.build(layer)
    const made = yield* Conversation.make({
      dir: "/tmp",
      moved: () => Effect.succeed(false),
      send: (update, message) => Context.get(context, Relays).send(update.thread, message).pipe(Effect.as("sent" as const)),
      late: (_, spoken) => Effect.sync(() => void late.push(spoken)),
      replied: Effect.void,
      saying: () => Effect.void,
      withholds: () => Effect.succeed(false),
      ...(given.handing === undefined ? {} : { over: given.handing }),
      ...(given.off === undefined ? {} : { off: given.off }),
    }).pipe(Effect.provide(context))
    const fiber = yield* Effect.fork(made.converse(given.over ?? update, Effect.void, given.present === undefined ? {} : { present: given.present }))
    // Lets the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    // As long as the microphone's, so what's heard lasts as long as it would.
    const frames = (probability: number, count: number) =>
      Queue.offerAll(microphone, Array.from({ length: count }, () => new Float32Array(512).fill(probability))).pipe(
        Effect.zipRight(flush),
      )
    const speak = frames(0.9, 10).pipe(Effect.zipRight(frames(0, defaults.silence)))
    const wait = (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush))
    /** Asks a question instead, once the update has been given up on, which takes what's said after "yes" for an answer. */
    const ask = (answers: Array<string>) =>
      Fiber.interrupt(fiber).pipe(
        Effect.zipRight(
          Effect.fork(
            made.ask({
              audio: "/tmp/question.wav",
              spoken: "Which project is it for?",
              answer: (heard) =>
                Effect.succeed(heard.startsWith("Yes") ? Option.some(Effect.sync(() => void answers.push(heard))) : Option.none()),
            }),
          ),
        ),
      )
    /** Says an answer instead, once the update has been given up on, which takes anything but talk with Sam for a follow-up. */
    const say = (followUps: Array<string>) =>
      Fiber.interrupt(fiber).pipe(
        Effect.zipRight(
          Effect.fork(
            made.answer({
              audio: "/tmp/answer.wav",
              spoken: "It's fixing the tests.",
              followUp: (heard) => Effect.succeed(heard.startsWith("Sam,") ? Option.none() : Option.some(Effect.sync(() => void followUps.push(heard)))),
            }),
          ),
        ),
      )
    return {
      ...made,
      fiber,
      played,
      heard,
      sent,
      late,
      speak,
      wait,
      ask,
      say,
      frames,
      disconnect: Queue.shutdown(microphone),
    }
  })

/** Talks, then waits for the reply to be sent and read out. */
const run = (
  said: ReadonlyArray<string>,
  talk: (speak: Effect.Effect<void>, wait: (seconds: number) => Effect.Effect<void>) => Effect.Effect<unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { fiber, heard, sent, speak, wait } = yield* conversation(said)
      yield* talk(speak, wait)
      yield* wait(20)
      yield* Fiber.join(fiber)
      return { heard, sent }
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  )

const scoped = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Conversation", () => {
  test("keeps the part of a line that was heard", () => {
    expect(cut("one two three four", 0.5)).toBe("one two…")
    expect(cut("one two three four", 0)).toBe("one…")
    expect(cut("one two three four", 1)).toBe("one two three four")
  })

  test("keeps the rest of a line that wasn't said yet, which is nothing once it all was", () => {
    expect(unsaid("one two three four", 0.5)).toBe("three four")
    expect(unsaid("one two three four", 0)).toBe("two three four")
    expect(unsaid("one two three four", 1)).toBe("")
    expect(unsaid("one", 0.5)).toBe("")
  })

  test("tells when the user trailed off", () => {
    expect(unfinished("Can you please get that merged in and tell the agent to...")).toBe(true)
    expect(unfinished("Merge it and…")).toBe(true)
    expect(unfinished("Merge it and then tell the agent to.")).toBe(true)
    expect(unfinished("Merge it, and")).toBe(true)
    expect(unfinished("Please merge it.")).toBe(false)
    expect(unfinished("Which PR was that?")).toBe(false)
  })

  test("takes in what the user adds while it works out a reply", async () => {
    const { heard, sent } = await run(
      ["Can you please get that merged in.", "When that's done, update the deployment."],
      (speak, wait) => Effect.all([speak, wait(2), speak, wait(5)]),
    )
    expect(heard).toEqual([
      "Can you please get that merged in.",
      "Can you please get that merged in. When that's done, update the deployment.",
    ])
    expect(sent).toEqual(["Can you please get that merged in. When that's done, update the deployment."])
  })

  test("waits for the rest when the user trails off", async () => {
    const { heard, sent } = await run(
      ["Get that merged in and tell the agent to...", "update the deployment."],
      (speak, wait) => Effect.all([speak, wait(2), speak, wait(5)]),
    )
    // Only asked once: it hadn't started on the first half when they carried on.
    expect(heard).toEqual(["Get that merged in and tell the agent to update the deployment."])
    expect(sent).toEqual(["Get that merged in and tell the agent to update the deployment."])
  })

  test("settles a reply when the microphone disconnects during an unconfirmed onset", async () => {
    const sent = await scoped(
      Effect.gen(function* () {
        const { speak, wait, frames, disconnect, sent } = yield* conversation(["Please merge it."])
        yield* speak
        yield* wait(2)
        yield* frames(0.9, 1)
        yield* disconnect
        yield* wait(3)
        return sent
      }),
    )
    expect(sent).toEqual(["Please merge it."])
  })

  test("bounds an unconfirmed onset when the microphone stops producing frames", async () => {
    const sent = await scoped(
      Effect.gen(function* () {
        const { speak, wait, frames, sent } = yield* conversation(["Please merge it."])
        yield* speak
        yield* wait(2)
        yield* frames(0.9, 1)
        yield* wait(3)
        expect(sent).toEqual([])
        yield* wait(40)
        return sent
      }),
    )
    expect(sent).toEqual(["Please merge it."])
  })
})

describe("What code acts on alone", () => {
  test("waits for speech he resumes: a yes, a breath, then more, over an update that asked, is worked out whole and never sent alone", async () => {
    const asking: Conversation.Update = { ...update, needsYou: true, spoken: "The PR is up. Should I merge it?" }
    const result = await scoped(
      Effect.gen(function* () {
        // A plain yes goes ahead at once, without the model; anything more is the model's.
        const { fiber, frames, wait, heard, sent } = yield* conversation(["Yes.", "but not the tests"], 0, {
          over: asking,
          fast: (said) => (said === "Yes." ? { intent: "send", spoken: "On it.", message: "Yes." } : undefined),
        })
        yield* wait(10)
        yield* frames(0.9, 10)
        yield* frames(0, defaults.silence)
        // 0.8 s of quiet in all: he carries on a tenth of a second after what he'd said came in.
        yield* wait(0.1)
        const before = [...sent]
        yield* frames(0.9, 10)
        yield* frames(0, defaults.silence)
        yield* wait(26)
        yield* Fiber.join(fiber)
        return { before, heard, sent }
      }),
    )
    expect(result).toEqual({ before: [], heard: ["Yes. but not the tests"], sent: ["Yes. but not the tests"] })
  })
})

describe("Follow-ups", () => {
  test("sends what the user said even when the conversation is cut off meanwhile, and says so later", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const { fiber, sent, late, speak, wait, sending } = yield* conversation(["Please merge it."], 3)
        yield* speak
        // The reply is worked out, and on its way to the agent.
        yield* wait(6)
        const during = { sent: [...sent], sending: yield* sending("s") }
        // As a dictation does.
        yield* Fiber.interrupt(fiber)
        yield* wait(3)
        return { during, sent, late, sending: yield* sending("s") }
      }),
    )
    expect(result.during).toEqual({ sent: [], sending: true })
    expect(result.sent).toEqual(["Please merge it."])
    expect(result.late).toEqual(["Okay."])
    expect(result.sending).toBe(false)
  })
})

describe("Answers", () => {
  test("the microphone stays open 3 s after an update, 6 s after an answer, 8 s after a question or an update that asks one while he's at hand", async () => {
    const asking: Conversation.Update = { ...update, needsYou: true, spoken: "The PR is up. Should I merge it?" }
    /** Whether it's still listening once it's been quiet for `seconds` after the line was said. */
    const quiet = (line: "update" | "asking" | "away" | "answer" | "question", seconds: number) =>
      scoped(
        Effect.gen(function* () {
          const { fiber, say, ask, wait } = yield* conversation([], 0, line === "asking" || line === "away" ? { over: asking, present: line === "asking" } : {})
          const saying = line === "answer" ? yield* say([]) : line === "question" ? yield* ask([]) : fiber
          yield* wait(10)
          yield* wait(seconds)
          return Option.isNone(yield* Fiber.poll(saying))
        }),
      )
    for (const [line, seconds] of [
      ["update", 3],
      // Asking him something while he's away, it may be the room that answers, so it's as long as after any update.
      ["away", 3],
      ["answer", 6],
      ["question", 8],
      ["asking", 8],
    ] as const) {
      expect([line, await quiet(line, seconds - 0.1), await quiet(line, seconds)]).toEqual([line, true, false])
    }
  })
})

describe("What yapd was saying when he began", () => {
  test("finds the words said around a time by where they fall in the line", () => {
    const line = "one two three four five six seven eight nine ten"
    expect(between(line, 10, 2, 5)).toBe("three four five")
    expect(between(line, 10, -2, 2)).toBe("one two")
    expect(between(line, 10, 8, 12)).toBe("nine ten")
    expect(between(line, 0, 2, 5)).toBe(line)
  })
})

/** An update long enough that where its words fall can be told from how far into it yapd is: two and a half a second, over ten seconds. */
const long: Conversation.Update = {
  ...update,
  spoken: "Over in yapd, the tests pass now and the pull request is ready for review, so I can merge it whenever you say the word, sir.",
}

/** What yapd says of `long` around its first second, as what he says over that is given to the model. */
const first = "Over in yapd, the tests pass now and the pull request is ready"

/**
 * Reads `long` out over the helper protocol, with a fake helper that starts a
 * new voice processor for the first line, as after yapd has rested, and says
 * how far a line got when it's stopped by the clock. The test talks into its
 * microphone with frames whose value is how likely each is speech, and the
 * fake Whisper hears in what it's given the words `words` has for each value,
 * in the order they're said. What's said is taken as `reply` has it, which is
 * to pass it on unless it says otherwise, all the model is given is kept in
 * `responded`, and what yapd says back in `rendered`. With `ask`, it asks a
 * question in the same words instead, which takes anything said for its
 * answer, kept in `offered`.
 */
const overHelper = (
  words: ReadonlyArray<readonly [number, string]>,
  options: {
    /** How long each line lasts, in seconds. */
    readonly duration?: number
    readonly reply?: (interruption: Responder.Interruption) => Responder.Reply
    /** Whether the clock moves on as frames come in, as it does live, rather than only when told to. */
    readonly live?: boolean
    /** How long working out what to do about what's said takes, in seconds, as a model call does: at once unless said. */
    readonly responding?: number
    readonly ask?: boolean
    /** What's yapd's to do, handed to its assistant: with none, what the Responder answers is all. */
    readonly handing?: NonNullable<Parameters<typeof Conversation.make>[0]["over"]>
    /**
     * Whether what it says is out in parts: its first part, at `part`, lasting
     * so many seconds and words, while its whole, `duration` long, renders
     * until `whole` says.
     */
    readonly parts?: { readonly duration: number; readonly words: number }
  } = {},
) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    /** Each command with when it came, in seconds since the first line started playing, and the volume it asked for. */
    const timeline: Array<{ readonly type: string; readonly at: number; readonly value?: number }> = []
    /** Where each line was played from, in seconds, and its file. */
    const plays: Array<number> = []
    const files: Array<string> = []
    const transcribed: Array<string> = []
    const sent: Array<string> = []
    /** All a reply was worked out from, in order. */
    const responded: Array<Responder.Interruption> = []
    /** What yapd says back, in order. */
    const rendered: Array<string> = []
    const offered: Array<string> = []
    let first: number | undefined
    /** The update's first part, when it's out in parts, and its whole as it renders. */
    const part = "/tmp/update.first.wav"
    const whole = yield* Deferred.make<number, KokoroError>()
    const render: Started = {
      first: Effect.succeed(part),
      words: Effect.succeed(Option.fromNullable(options.parts?.words)),
      whole: Deferred.await(whole),
      done: Deferred.isDone(whole),
      abandon: Effect.void,
    }
    let connection: Socket<Helper.Decoder> | undefined
    let running = false
    let playing: { readonly id: string; readonly since: number; readonly from: number } | undefined
    /** What the socket hasn't taken yet, since it takes only so much at once. */
    const unsent: Array<Uint8Array> = []
    const drain = () => {
      while (connection !== undefined && unsent.length > 0) {
        const next = unsent[0]!
        const written = connection.write(next)
        if (written < next.length) {
          unsent[0] = next.subarray(Math.max(0, written))
          return
        }
        unsent.shift()
      }
    }
    const write = (bytes: Uint8Array) => {
      unsent.push(bytes)
      if (unsent.length === 1) drain()
    }
    const send = (event: object) => write(Helper.encode(event))
    const now = () => runSync(Clock.currentTimeMillis)
    yield* Effect.addFinalizer(() => Effect.sync(() => connection?.terminate()))
    const launch = (path: string) =>
      Effect.tryPromise({
        try: () =>
          Bun.connect<Helper.Decoder>({
            unix: path,
            socket: {
              open: (socket) => {
                socket.data = new Helper.Decoder()
                connection = socket
                send({ type: "hello", permission: "authorized" })
              },
              data: (socket, data) => {
                for (const message of socket.data.push(data)) {
                  const command = JSON.parse(new TextDecoder().decode(message.payload)) as {
                    readonly type: string
                    readonly id?: string
                    readonly path?: string
                    readonly from?: number
                    readonly value?: number
                  }
                  if (command.type === "play") first ??= now()
                  timeline.push({ type: command.type, at: (now() - (first ?? now())) / 1000, ...(command.value === undefined ? {} : { value: command.value }) })
                  if (command.type === "play") {
                    if (!running) send({ type: "active", listening: true })
                    running = true
                    playing = { id: command.id ?? "", since: now(), from: command.from ?? 0 }
                    plays.push(playing.from)
                    files.push(command.path ?? "")
                    send({ type: "playing", id: command.id, duration: command.path === part ? (options.parts?.duration ?? 0) : (options.duration ?? 10) })
                  } else if (command.type === "stop") {
                    send({
                      type: "stopped",
                      ...(playing === undefined ? {} : { id: playing.id, at: playing.from + (now() - playing.since) / 1000 }),
                    })
                    playing = undefined
                  } else if (command.type === "rest") {
                    running = false
                    playing = undefined
                  }
                }
              },
              drain,
            },
          }),
        catch: (cause) => new Helper.HelperError({ message: "Could not connect the fake helper", cause }),
      })
    const device = yield* native(launch, () =>
      Effect.succeed({ duration: 0, confirmed: false, finished: Effect.void, stop: Effect.succeed(0), volume: () => Effect.void }),
    )
    const layer = Layer.mergeAll(
      Layer.succeed(Audio, Context.get(device, Audio)),
      Layer.succeed(Persona.Persona, { lines: Effect.succeed(Persona.plain), onIt: () => Effect.succeed(Persona.plain.onIt), said: () => Effect.void }),
      Journal.memory,
      // Each frame holds the probability that it's speech.
      Layer.succeed(Vad, { make: Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)) }),
      Layer.succeed(Transcriber, {
        transcribe: (audio) =>
          Effect.sync(() => {
            const heard = words
              .flatMap(([value, text]) => {
                const at = audio.indexOf(Math.fround(value))
                return at < 0 ? [] : [[at, text] as const]
              })
              .sort(([one], [other]) => one - other)
              .map(([, text]) => text)
              .join(" ")
            transcribed.push(heard)
            return heard
          }),
        ready: Effect.succeed(true),
      }),
      Layer.succeed(Responder.Responder, {
        respond: (interruption) =>
          Effect.sync(() => void responded.push(interruption)).pipe(
            Effect.zipRight(Effect.sleep(`${options.responding ?? 0} seconds`)),
            Effect.as({ reply: options.reply?.(interruption) ?? { intent: "send" as const, spoken: "Okay.", message: interruption.heard }, source: "model" as const }),
          ),
      }),
      Layer.succeed(Voice, { render: (text) => Effect.sync(() => void rendered.push(text)) }),
    )
    const context = yield* Layer.build(layer)
    const made = yield* Conversation.make({
      dir: "/tmp",
      moved: () => Effect.succeed(false),
      send: (_, message) => Effect.sync(() => void sent.push(message)).pipe(Effect.as("sent" as const)),
      late: () => Effect.void,
      replied: Effect.void,
      saying: () => Effect.void,
      withholds: () => Effect.succeed(false),
      ...(options.handing === undefined ? {} : { over: options.handing }),
    }).pipe(Effect.provide(context))
    // Lets the helper, the microphone and the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(async () => {
      while (unsent.length > 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const frames = (value: number, count: number) =>
      Effect.sync(() => {
        const samples = new Float32Array(512).fill(value)
        const message = new Uint8Array(5 + samples.byteLength)
        message[0] = Helper.Kind.pcm
        new DataView(message.buffer).setUint32(1, samples.byteLength)
        message.set(new Uint8Array(samples.buffer), 5)
        for (let frame = 0; frame < count; frame++) write(message)
      }).pipe(Effect.zipRight(flush))
    // Live, a few frames at a time, each once it has lasted as long as it does.
    const talk = (value: number, count: number) =>
      options.live === true
        ? Effect.forEach(
            Array.from({ length: Math.ceil(count / 4) }, (_, index) => Math.min(4, count - index * 4)),
            (some) => TestClock.adjust(`${some * 32} millis`).pipe(Effect.zipRight(frames(value, some))),
            { discard: true },
          )
        : frames(value, count)
    const respond = (heard: string) =>
      Effect.sync(() => void offered.push(heard)).pipe(
        Effect.zipRight(Effect.sleep(`${options.responding ?? 0} seconds`)),
        Effect.as(Option.some(Effect.void)),
      )
    yield* Effect.fork(
      options.ask === true
        ? made.ask({ audio: "/tmp/question.wav", spoken: long.spoken, answer: respond })
        : made.converse({ ...long, ...(options.parts === undefined ? {} : { first: part, render }) }, Effect.void),
    )
    yield* flush
    yield* flush
    return {
      timeline,
      plays,
      files,
      transcribed,
      sent,
      responded,
      rendered,
      offered,
      talk,
      quiet: talk(0, defaults.silence),
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
      finish: Effect.sync(() => {
        if (playing !== undefined) send({ type: "finished", id: playing.id })
        playing = undefined
      }).pipe(Effect.zipRight(flush)),
      /** The update's whole rendered. */
      whole: Deferred.succeed(whole, options.duration ?? 10).pipe(Effect.zipRight(flush)),
      replies: Effect.map(Effect.flatMap(Journal.Journal, (journal) => journal.since(0)), (entries) => entries.map(({ text }) => text)).pipe(
        Effect.provide(context),
      ),
      /** All the journal kept. */
      journal: Effect.flatMap(Journal.Journal, (journal) => journal.since(0)).pipe(Effect.provide(context)),
    }
  })

const overHelperScoped = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    test.pipe(
      Effect.scoped,
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_SHORTCUT", "none"]]))),
      Effect.provide(TestContext.TestContext),
    ),
  )

/** Seconds, to the millisecond, as the clock tells them. */
const seconds = (value: number) => Math.round(value * 1000) / 1000

describe("Over its first seconds, while yapd's own voice can still get into the microphone", () => {
  test("ducks at his first sound and stops once it's clearly speech, as later in a line", async () => {
    /** The commands sent from when he begins talking `at` seconds into the line, `needed` frames of speech making it speech. */
    const over = (at: number, needed: number) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "Hold on."]], { live: true, reply: () => ({ intent: "dismiss", spoken: "", message: "" }) })
          yield* helper.wait(at)
          yield* helper.talk(0.9, 1)
          const ducked = [...helper.timeline]
          yield* helper.talk(0.9, needed - 1)
          const stopped = [...helper.timeline]
          yield* helper.talk(0.9, 6)
          yield* helper.quiet
          yield* helper.wait(1)
          return { ducked, stopped }
        }),
      )
    // Two frames more over its first seconds, as its own voice ducked often stops being speech by then, and his never does.
    for (const [at, needed] of [[0.3, defaults.wary], [4, defaults.confirm]] as const) {
      const result = await over(at, needed)
      // Turned down with the first frame of his voice, and stopped with the frame that makes it speech, a few frames later.
      expect([at, result.ducked]).toEqual([at, [{ type: "play", at: 0 }, { type: "volume", at: seconds(at + 0.032), value: 0.25 }]])
      expect([at, result.stopped.slice(2)]).toEqual([at, [{ type: "stop", at: seconds(at + 0.032 * needed) }]])
    }
  })

  test("turns back up for a sound that never becomes speech, as later in a line", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on."]], { live: true })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 2)
        yield* helper.talk(0, defaults.abandon)
        yield* helper.wait(1)
        return { commands: helper.timeline.map(({ type, value }) => (value === undefined ? type : `${type} ${value}`)), transcribed: helper.transcribed }
      }),
    )
    expect(result).toEqual({ commands: ["play", "volume 0.25", "volume 1"], transcribed: [] })
  })

  test("keeps and logs none of a secret said over it, whatever the model makes of it, like a remember he's told to ask with his shortcut", async () => {
    const secret = "Remember that the staging key is sk-live-4f9a8b7c6d5e."
    /** What's logged and kept of his secret when the model answers it with `spoken`, and he says `over` halfway through that, which it lets be. */
    const answered = async (spoken: string, over?: string) => {
      const lines: Array<string> = []
      const logger = Logger.make(({ message }) => {
        lines.push((Array.isArray(message) ? message : [message]).join(" "))
      })
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, secret], ...(over === undefined ? [] : [[0.8, over] as const])], {
            reply: ({ heard }) => (heard === secret ? { intent: "answer", spoken, message: "" } : { intent: "dismiss", spoken: "", message: "" }),
          })
          yield* helper.wait(1)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          yield* helper.wait(1)
          if (over !== undefined) {
            // Five seconds into the answer's ten, long past when its own voice could get into the microphone.
            yield* helper.wait(4)
            yield* helper.talk(0.8, 47)
            yield* helper.quiet
            yield* helper.wait(1)
          }
          return { journal: yield* helper.journal }
        }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
      )
      return { ...result, lines }
    }
    // Neither what he said nor the model's answer saying it back is logged or kept.
    const echoed = await answered("I won't keep sk-live-4f9a8b7c6d5e, sir. Ask me that with your shortcut.")
    expect(echoed.journal.map(({ text, said }) => ({ text, said }))).toEqual([{ text: undefined, said: undefined }])
    expect(JSON.stringify(echoed.journal)).not.toContain("4f9a8b7c6d5e")
    expect(echoed.lines.filter((line) => line.includes("4f9a8b7c6d5e"))).toEqual([])
    // Nor what he hadn't heard of that answer when he talks over it, which a few words of may not show to be one, like the last
    // digits of a code.
    const talkedOver = await answered("I won't keep the key ending four eight one five nine two, sir. Ask me that with your shortcut.", "Thanks.")
    expect(talkedOver.journal.map(({ text, said }) => ({ text, said }))).toEqual([{ text: undefined, said: undefined }, { text: "Thanks.", said: "" }])
    expect(JSON.stringify(talkedOver.journal)).not.toContain("nine two")
  })

  test("logs none of a secret said over a question, whatever comes of it", async () => {
    const lines: Array<string> = []
    const logger = Logger.make(({ message }) => {
      lines.push((Array.isArray(message) ? message : [message]).join(" "))
    })
    const offered = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Remember that the staging key is sk-live-4f9a8b7c6d5e."]], { ask: true })
        yield* helper.wait(4)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return helper.offered
      }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
    )
    expect(offered).toEqual(["Remember that the staging key is sk-live-4f9a8b7c6d5e."])
    expect(lines.filter((line) => line.includes("4f9a8b7c6d5e"))).toEqual([])
  })

  test("a message the Responder makes of what may all be yapd's own words, with nothing after a pause, reaches no thread: it's handed to yapd's assistant, while one surely his is sent as before", async () => {
    // "Stop the Mina tickets." over its "the Mina tickets are", which the Responder would send: handed over, let go there, nothing sent.
    const handed: Array<string> = []
    const letGo = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Stop the Mina tickets."]], {
          handing: () => (heard) =>
            Effect.sync(() => void handed.push(heard)).pipe(Effect.as<Conversation.Handed>({ _tag: "Resume", source: "model", ms: 0, routed: "resume, stop" })),
        })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return { responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })), sent: helper.sent, rendered: helper.rendered, replies: yield* helper.replies }
      }),
    )
    expect(letGo).toEqual({ responded: [{ heard: "Stop the Mina tickets.", echo: first }], sent: [], rendered: [], replies: [] })
    expect(handed).toEqual(["Stop the Mina tickets."])
    // Surely his, with words after a pause or begun with none of yapd's voice in the microphone, it's the Responder's send, never handed over;
    // so is any, with no assistant to hand it to.
    const sending = { intent: "send", spoken: "Okay.", message: "Stop the Mina tickets." } as const
    const read = (echo: string | undefined, afterPause: string, over: boolean) =>
      Effect.runPromise(
        Conversation.reading({
          heard: "Stop the Mina tickets.",
          voiced: 1,
          afterPause,
          halt: false,
          echo,
          needsYou: false,
          hooked: Option.none(),
          may: true,
          respond: () => Effect.succeed({ reply: sending, source: "model" }),
          ...(over ? { over: () => () => Effect.die("handed over") } : {}),
          shortcut: Effect.succeed("Ask me that with the shortcut, sir."),
        }),
      )
    for (const [echo, afterPause, over] of [["the Mina tickets are", "Stop the Mina tickets.", true], [undefined, "", true], ["the Mina tickets are", "", false]] as const) {
      expect([echo, afterPause, over, (await read(echo, afterPause, over)).reply]).toEqual([echo, afterPause, over, sending])
    }
  })

  test("gives what he said after a pause apart only when yapd's own voice may be in what came before", async () => {
    const after = (at: number) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "Hmm, hold on."], [0.91, "Merge it."], [0.92, "And deploy."]], { responding: 2 })
          yield* helper.wait(at)
          yield* helper.talk(0, defaults.lead)
          yield* helper.talk(0.9, 20)
          yield* helper.quiet
          // He goes on before the reply to it is ready, twice.
          yield* helper.wait(0.5)
          yield* helper.talk(0.91, 20)
          yield* helper.quiet
          yield* helper.wait(0.5)
          yield* helper.talk(0.92, 20)
          yield* helper.quiet
          yield* helper.wait(3)
          return helper.responded.map(({ heard, echo, afterPause }) => ({ heard, told: echo !== undefined, afterPause }))
        }),
      )
    // Begun over its first seconds.
    // All he said after the first pause, however many more there were.
    expect(await after(1)).toEqual([
      { heard: "Hmm, hold on.", told: true, afterPause: undefined },
      { heard: "Hmm, hold on. Merge it.", told: true, afterPause: "Merge it." },
      { heard: "Hmm, hold on. Merge it. And deploy.", told: true, afterPause: "Merge it. And deploy." },
    ])
    // Begun once its own voice was learnt, all of it is his, so nothing is set apart.
    expect(await after(4)).toEqual([
      { heard: "Hmm, hold on.", told: false, afterPause: undefined },
      { heard: "Hmm, hold on. Merge it.", told: false, afterPause: undefined },
      { heard: "Hmm, hold on. Merge it. And deploy.", told: false, afterPause: undefined },
    ])
  })
})

describe("A line out in parts", () => {
  /** Its first part plays four seconds of the twelve all of it does, and says its first seven words. */
  const parts = { duration: 4, words: 7 }
  /** Talk with someone else, which it carries on from a little before where it stopped. */
  const elsewhere = (): Responder.Reply => ({ intent: "resume", spoken: "", message: "" })
  /** What the model was told yapd had said of the line when he cut in, and what it hadn't yet. */
  const told = (responded: ReadonlyArray<Responder.Interruption>) => responded.map(({ lines, unsaid }) => [lines.at(-1)?.text, unsaid])
  const part = "/tmp/update.first.wav"

  test("cutting in maps to the right place in the whole: during the first part, during the whole after it, and between them", async () => {
    const at = (fraction: number) => [cut(long.spoken, fraction), unsaid(long.spoken, fraction)]
    // During its first part, three and a half seconds in: a place in the whole too, which it carries on from a little before.
    const during = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Sam, dinner's ready."]], { parts, duration: 12, reply: elsewhere })
        yield* helper.whole
        yield* helper.wait(3.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { told: told(helper.responded), files: helper.files, plays: helper.plays.map(seconds) }
      }),
    )
    expect(during).toEqual({ told: [at(3.5 / 12)], files: [part, long.audio], plays: [0, 2] })
    // During the whole, a second past the first part's end: the whole took over inside the quiet that part ends in, and the helper
    // counts from the whole's own start, so the first part's length isn't added again.
    const after = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Sam, dinner's ready."]], { parts, duration: 12, reply: elsewhere })
        yield* helper.whole
        yield* helper.wait(3.85)
        yield* helper.wait(1.15)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { told: told(helper.responded), files: helper.files, plays: helper.plays.map(seconds) }
      }),
    )
    expect(after).toEqual({ told: [at(5 / 12)], files: [part, long.audio, long.audio], plays: [0, 3.85, 3.5] })
    // Once the first part has played to its end, with the whole still rendering: where that part ended, and the whole never starts
    // from there, only from a little before, as after any talk not meant for it.
    const between = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Sam, dinner's ready."]], { parts, duration: 12, reply: elsewhere })
        yield* helper.wait(4)
        yield* helper.finish
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.whole
        yield* helper.wait(1)
        return { told: told(helper.responded), files: helper.files, plays: helper.plays.map(seconds) }
      }),
    )
    expect(between).toEqual({ told: [at(4 / 12)], files: [part, long.audio], plays: [0, 2.5] })
  })
})

describe("Condenser", () => {
  test("names the project up front when the summary leaves it out", () => {
    expect(Condenser.introduce("yapd", "The tests pass now.")).toBe("yapd. The tests pass now.")
    expect(Condenser.introduce("api", "It's rapid now.")).toBe("api. It's rapid now.")
  })

  test("finds the project in the summary with its accents and spacing", () => {
    expect(Condenser.introduce("A26-ift-2007-Equipe9", "For A26 IFT 2007 Équipe 9, the pseudocode is ready.")).toBe(
      "For A26 IFT 2007 Équipe 9, the pseudocode is ready.",
    )
  })

  test("never reads out a generated name", () => {
    expect(Condenser.speakable("cryptio-sources")).toBe(true)
    expect(Condenser.speakable("2026-10-06-ocr-this-picture-and-provide-5c529e6b")).toBe(false)
    expect(Condenser.speakable("notes-3d31aa2d")).toBe(false)
    expect(Condenser.introduce("2026-10-06-ocr-this-picture-and-provide-5c529e6b", "Both tables are in.")).toBe("Both tables are in.")
  })

  test("tells English from what slipped through in another language", () => {
    expect(Condenser.english("In right price, the examples come from Trois-Rivières, sir.")).toBe(true)
    expect(Condenser.english("Hélène’s invoice for €2,880 is sent.")).toBe(true)
    expect(Condenser.english("I've added the table before “Données traitées,” sir.")).toBe(false)
    expect(Condenser.english("Dans laurent, le fanion marque le début de chaque trame.")).toBe(false)
    expect(Condenser.english("Москва is done.")).toBe(false)
    expect(Condenser.english("テストは通りました。")).toBe(false)
  })
})

/** A model that gives the answers in order, and keeps what it was asked. */
const scripted = (answers: ReadonlyArray<unknown>) => {
  const asked: Array<string> = []
  const layer = Layer.succeed(Model, {
    ask: (schema, prompt) =>
      Effect.suspend(() => {
        asked.push(prompt)
        return Schema.decodeUnknown(schema)(answers[asked.length - 1])
      }).pipe(Effect.mapError((cause) => new ModelError({ cause }))),
  })
  return { asked, layer }
}

describe("Language check", () => {
  test("translates what's said back, but leaves the message in the user's language", async () => {
    const { layer } = scripted([
      { intent: "send", spoken: "C'est noté, monsieur.", message: "Fusionne la branche." },
      { spoken: "Noted, sir." },
    ])
    const { reply } = await Effect.runPromise(
      Effect.flatMap(Responder.Responder, ({ respond }) =>
        respond({ project: "yapd", turn: { prompt: Option.none(), message: "C'est prêt." }, needsYou: false, lines: [], heard: "Fusionne la branche.", voiced: 1, lateBy: 0 }),
      ).pipe(Effect.provide(Responder.ProviderResponder.pipe(Layer.provide(Layer.merge(layer, Persona.Plain))))),
    )
    expect(reply).toEqual({ intent: "send", spoken: "Noted, sir.", message: "Fusionne la branche." })
  })
})

describe("more, and how yapd talks, over an update", () => {
  const over = (heard: string, more?: string, echo?: string) => ({
    project: "yapd",
    turn: { prompt: Option.none(), message: "Fixed the loader. Retries back off now." },
    needsYou: false,
    lines: [{ speaker: "yapd" as const, text: "yapd's loader is fixed." }],
    heard,
    ...(more === undefined ? {} : { more }),
    ...(echo === undefined ? {} : { echo }),
    voiced: 1,
    lateBy: 0,
  })
  const quickly = (interruption: Responder.Interruption) => Effect.runSync(Responder.quick(interruption, Effect.succeed("On it, sir.")))

  test("asking for more of a headline gets the rest without the model, only in so many words, plainly his, and only when there's more", () => {
    const rest = "Retries back off now, and the flaky test is gone."
    for (const heard of ["More.", "Tell me more.", "More, please.", "Details?", "What else?"]) {
      expect(quickly(over(heard, rest))).toEqual({ intent: "answer", spoken: rest, message: "" })
    }
    // Over its own first seconds, the model weighs it; with nothing more, or more said around it, so does the model.
    expect(quickly(over("More.", rest, "yapd's loader"))).toBeUndefined()
    expect(quickly(over("More."))).toBeUndefined()
    expect(quickly(over("More tests, please.", rest))).toBeUndefined()
  })
})

describe("quick replies", () => {
  const reply = (heard: string, message = "The PR is up. Should I merge it?", needsYou = true, said?: string) =>
    Effect.runSync(
      Responder.quick(
        { project: "yapd", turn: { prompt: Option.none(), message }, needsYou, lines: said === undefined ? [] : [{ speaker: "yapd", text: said }], heard, voiced: 1, lateBy: 0 },
        Effect.succeed("On it, sir."),
      ),
    )

  test("leaves anything more than a plain yes to the model", () => {
    expect(reply("Yes, but rebase it first.")).toBeUndefined()
    expect(reply("No.")).toBeUndefined()
    expect(reply("Thanks.")).toBeUndefined()
    // A yes to something that asked nothing, or a question cut off before it was asked.
    expect(reply("Yes.", "The PR is up.", false)).toBeUndefined()
    expect(reply("Yes.", "Done. Shall I merge? The docs are updated too.", true, "Over in yapd, it's…")).toBeUndefined()
    // Once it's been answered, another yes could mean anything.
    expect(
      Effect.runSync(
        Responder.quick(
          {
            project: "yapd",
            turn: { prompt: Option.none(), message: "The PR is up. Should I merge it?" },
            needsYou: true,
            lines: [
              { speaker: "yapd", text: "The PR is up. Should I merge it?" },
              { speaker: "user", text: "Yes." },
              { speaker: "yapd", text: "On it, sir." },
            ],
            heard: "Yes.",
            voiced: 1,
            lateBy: 0,
          },
          Effect.succeed("On it, sir."),
        ),
      ),
    ).toBeUndefined()
    // Cut off before the question was heard.
    expect(reply("Yes.", "The PR is up. Should I merge it?", true, "The PR…")).toBeUndefined()
  })
})

describe("Transcriber", () => {
  test("only 'Mute.' on its own, however often Whisper heard it, is his emergency off, and only so many words turn yapd back on", () => {
    for (const heard of ["Mute.", "mute mute", "Mute, mute, mute.", "Jarvis, mute.", "Mute, sir!"]) expect(Words.halts(heard)).toBe(true)
    for (const heard of ["Mute it.", "Mute that for an hour.", "Mute the Tezos one.", "What's muted?", "Unmute.", "Mute it, mute it.", "Mute?", "Mute, mute?", ""]) expect(Words.halts(heard)).toBe(false)
    for (const heard of ["Unmute.", "Un-mute.", "Turn on.", "Turn it on, please.", "Jarvis, turn yourself on.", "Turn back on.", "Unmute, unmute."]) expect(Words.wakes(heard)).toBe(true)
    for (const heard of ["Unmute it.", "Unmute the Tezos one.", "Turn on the lights.", "Turn it off.", "Mute.", "Unmute?", "Turn on?", ""]) expect(Words.wakes(heard)).toBe(false)
  })

  test("drops what Whisper writes for sounds that aren't words", () => {
    expect(clean(" [BLANK_AUDIO]")).toBe("")
    expect(clean(" (coughs) Merge it  now.")).toBe("Merge it now.")
  })
})

describe("Helper", () => {
  test("splits messages back out however the stream is chunked", () => {
    const first = Helper.encode({ type: "hello" })
    const pcm = new Uint8Array([Helper.Kind.pcm, 0, 0, 0, 8, ...new Uint8Array(new Float32Array([0.5, -0.25]).buffer)])
    const stream = new Uint8Array([...first, ...pcm])
    const decoder = new Helper.Decoder()
    const messages = [...decoder.push(stream.slice(0, 3)), ...decoder.push(stream.slice(3, 12)), ...decoder.push(stream.slice(12))]
    expect(messages.map(({ kind }) => kind)).toEqual([Helper.Kind.json, Helper.Kind.pcm])
    expect(JSON.parse(new TextDecoder().decode(messages[0]?.payload))).toEqual({ type: "hello" })
    expect([...new Float32Array(messages[1]!.payload.buffer)]).toEqual([0.5, -0.25])
  })
})

describe("the rest of an update", () => {
  test("is the model's answer to 'more' when that's the rest with him addressed before or after it, and nothing else", () => {
    const more = "Requests back off from half a second up to thirty seconds."
    expect(Conversation.restOf(more, more)).toBe(true)
    expect(Conversation.restOf("Sir, requests back off from half a second up to thirty seconds.", more)).toBe(true)
    expect(Conversation.restOf("Requests back off from half a second up to thirty seconds, sir.", more)).toBe(true)
    expect(Conversation.restOf("Sir, requests back off from a second up to a minute.", more)).toBe(false)
    expect(Conversation.restOf("Requests back off.", more)).toBe(false)
    expect(Conversation.restOf("Sir.", "")).toBe(false)
  })
})

describe("what's yapd's to do, said over an update", () => {
  const handedOver = (): Responder.Reply => ({ intent: "assistant", spoken: "", message: "" })

  test("'Mute.' said during the Brain's call turns yapd off at once and runs no Act", async () => {
    let offs = 0
    const ran: Array<string> = []
    const thinking = await scoped(
      Effect.gen(function* () {
        const handing = () => (heard: string) =>
          Effect.sleep("3 seconds").pipe(
            Effect.as<Conversation.Handed>({
              _tag: "Act",
              aims: false,
              doubted: false,
              run: () => Effect.sync(() => void ran.push(heard)),
              source: "model",
              ms: 3000,
              routed: "act, show",
            }),
          )
        const { fiber, played, speak, wait } = yield* conversation(["Show me the Mina one.", "Mute."], 0, { reply: handedOver, handing, off: Effect.sync(() => void offs++) })
        yield* speak
        yield* wait(6)
        yield* speak
        yield* wait(20)
        yield* Fiber.join(fiber)
        return { played: [...played] }
      }),
    )
    expect(offs).toBe(1)
    expect(ran).toEqual([])
    expect(thinking.played).toEqual([update.audio])
  })
})
