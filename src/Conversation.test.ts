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
  Option,
  Queue,
  Random,
  Runtime,
  Schema,
  type Scope,
  TestClock,
  TestContext,
} from "effect"
import { Audio, AudioError, native } from "./Audio.ts"
import * as Condenser from "./Condenser.ts"
import * as Conversation from "./Conversation.ts"
import { between, cut, theirs, together, unechoed, unfaded, unfinished } from "./Conversation.ts"
import { defaults } from "./Endpointer.ts"
import { Relays } from "./Relay.ts"
import * as Helper from "./Helper.ts"
import { Model, ModelError } from "./Model.ts"
import * as Responder from "./Responder.ts"
import { clean, TranscribeError, Transcriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import * as Journal from "./Journal.ts"
import * as Persona from "./Persona.ts"
import { ProcessError } from "./Process.ts"
import * as Settings from "./Settings.ts"
import * as Store from "./Store.ts"
import { Voice, Warmth } from "./Voice.ts"

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
 * taking what's said to Sam for talk with someone else, the relay `sending` seconds to send, and follow-ups going out
 * as `result` says: sent, queued, or held back as the session has moved on. `render` renders what's said back, and
 * with `unplayable`, nothing but the update can be played, as when the audio helper goes down after it. With `afplay`,
 * what's said back plays like afplay, which can't say it's playing, and either plays to the end or can't play at all.
 * With `model`, replies are worked out by the provider's responder with that model instead, and the persona's
 * lines are `lines`, or the plain ones. With `persona`, it's that one that picks and is told the lines.
 */
const conversation = (
  said: ReadonlyArray<string>,
  sending = 0,
  deliveries: ReadonlyArray<Effect.Effect<void>> = [],
  result: "sent" | "queued" | "moved" = "sent",
  given: {
    readonly render?: Context.Tag.Service<Voice>["render"]
    readonly unplayable?: boolean
    readonly afplay?: "plays" | "fails"
    readonly lines?: Persona.Lines
    readonly model?: Layer.Layer<Model>
    readonly persona?: Context.Tag.Service<Persona.Persona>
  } = {},
) =>
  Effect.gen(function* () {
    const microphone = yield* Queue.unbounded<Float32Array>()
    const heard: Array<string> = []
    const sent: Array<string> = []
    const late: Array<string> = []
    const saying: Array<string> = []
    /** The lines the persona was told are being said. */
    const noted: Array<string> = []
    const transcripts = [...said]
    let dispatches = 0
    let replies = 0
    const lines = given.lines ?? Persona.plain
    const persona = Layer.succeed(Persona.Persona, given.persona ?? {
      lines: Effect.succeed(lines),
      onIt: () => Effect.succeed(lines.onIt),
      said: (line) => Effect.sync(() => void noted.push(line)),
    })
    const layer = Layer.mergeAll(
      persona,
      Journal.memory,
      Layer.succeed(Audio, {
        play: (path) =>
          given.unplayable === true && path !== update.audio
            ? Effect.fail(new AudioError({ message: "The audio helper didn't start playing" }))
            : Effect.succeed({
                duration: 10,
                confirmed: given.afplay === undefined || path === update.audio,
                finished:
                  given.afplay === "fails" && path !== update.audio
                    ? Effect.fail(new AudioError({ message: "Could not play" }))
                    : Effect.sleep("10 seconds"),
                stop: Effect.succeed(2),
                volume: () => Effect.void,
              }),
        microphone: Effect.succeed(Option.some(microphone)),
        echo: () => Effect.succeed(undefined),
        rest: Effect.void,
        warm: Effect.void,
      }),
      // Each frame holds the probability that it's speech.
      Layer.succeed(Vad, { make: Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)) }),
      Layer.succeed(Transcriber, { transcribe: () => Effect.sync(() => transcripts.shift() ?? "") }),
      given.model === undefined
        ? Layer.succeed(Responder.Responder, {
            respond: ({ heard: text }) =>
              Effect.sync(() => heard.push(text)).pipe(
                Effect.zipRight(Effect.sleep("5 seconds")),
                Effect.as(
                  text.startsWith("Sam,")
                    ? { intent: "resume" as const, spoken: "", message: "" }
                    : { intent: "send" as const, spoken: text.startsWith("Just") ? "" : "Okay.", message: text },
                ),
              ),
          })
        : Responder.ProviderResponder.pipe(Layer.provide(Layer.merge(given.model, persona))),
      Layer.succeed(Relays, {
        send: (_, text) => Effect.suspend(() => deliveries[dispatches++] ?? Effect.sleep(`${sending} seconds`)).pipe(
          Effect.zipRight(Effect.sync(() => void sent.push(text))),
        ),
      }),
      Layer.succeed(Voice, { render: given.render ?? (() => Effect.void) }),
    )
    const context = yield* Layer.build(layer)
    const made = yield* Conversation.make({
      dir: "/tmp",
      moved: () => Effect.succeed(result === "moved"),
      send: (update, message) =>
        Context.get(context, Relays).send(update.thread, message).pipe(Effect.as(result === "queued" ? "queued" : "sent")),
      late: (_, spoken) => Effect.sync(() => void late.push(spoken)),
      replied: Effect.sync(() => void replies++),
      saying: (_, line) => Effect.sync(() => void saying.push(line)),
    }).pipe(Effect.provide(context))
    const fiber = yield* Effect.fork(made.converse(update))
    // Lets the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    // As long as the microphone's, so what's heard lasts as long as it would.
    const frames = (probability: number, count: number) =>
      Queue.offerAll(microphone, Array.from({ length: count }, () => new Float32Array(512).fill(probability))).pipe(
        Effect.zipRight(flush),
      )
    const speak = frames(0.9, 10).pipe(Effect.zipRight(frames(0, defaults.silence)))
    const wait = (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush))
    /** Asks a question instead, once the update has been given up on, which `answer` works out what's said to. */
    const question = (answer: Conversation.Question["answer"]) =>
      Fiber.interrupt(fiber).pipe(Effect.zipRight(Effect.fork(made.ask({ audio: "/tmp/question.wav", answer }))))
    /** One that takes what's said after "yes" for an answer. */
    const ask = (answers: Array<string>) =>
      question((heard) =>
        Effect.succeed(heard.startsWith("Yes") ? Option.some(Effect.sync(() => void answers.push(heard))) : Option.none()),
      )
    return { ...made, fiber, heard, sent, late, saying, noted, speak, wait, question, ask, frames, disconnect: Queue.shutdown(microphone), replies: () => replies }
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

  test("tells when the user trailed off", () => {
    expect(unfinished("Can you please get that merged in and tell the agent to...")).toBe(true)
    expect(unfinished("Merge it and…")).toBe(true)
    expect(unfinished("Merge it and then tell the agent to.")).toBe(true)
    expect(unfinished("Merge it, and")).toBe(true)
    expect(unfinished("Please merge it.")).toBe(false)
    expect(unfinished("Which PR was that?")).toBe(false)
  })

  test("joins what the user said on either side of a pause", () => {
    expect(together("Merge it and tell the agent to...", "update the deployment.")).toBe(
      "Merge it and tell the agent to update the deployment.",
    )
    expect(together("Merge it.", "")).toBe("Merge it.")
  })

  test("replies once the user has stopped", async () => {
    const { heard, sent } = await run(["Please merge it."], (speak, wait) => Effect.zipRight(speak, wait(5)))
    expect(heard).toEqual(["Please merge it."])
    expect(sent).toEqual(["Please merge it."])
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

  test("settles the words already heard when the microphone disconnects during more speech", async () => {
    const sent = await scoped(
      Effect.gen(function* () {
        const { speak, wait, frames, disconnect, sent } = yield* conversation(["Please merge it."])
        yield* speak
        yield* wait(2)
        yield* frames(0.9, defaults.confirm)
        yield* disconnect
        yield* wait(5)
        return sent
      }),
    )
    expect(sent).toEqual(["Please merge it."])
  })
})

describe("Follow-ups", () => {
  test("sends consecutive messages while listening to the same update", async () => {
    const result = await run(["Please merge it.", "Then deploy it."], (speak, wait) => Effect.gen(function* () {
      yield* speak
      yield* wait(5)
      yield* speak
      yield* wait(5)
    }))
    expect(result.sent).toEqual(["Please merge it.", "Then deploy it."])
  })

  test("tells yapd of each reply taken in over an update, so it takes the place of a question, but not of talk with someone else", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const { fiber, sent, speak, wait, replies } = yield* conversation(["Sam, can you grab the coffee?", "Please merge it."])
        yield* speak
        yield* wait(5)
        const aside = replies()
        yield* speak
        yield* wait(5)
        yield* wait(20)
        yield* Fiber.join(fiber)
        return { aside, replies: replies(), sent }
      }),
    )
    expect(result).toEqual({ aside: 0, replies: 1, sent: ["Please merge it."] })
  })

  test("tells yapd of each line it says back over an update, which is then what the user heard last", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const { fiber, speak, wait, saying } = yield* conversation(["Sam, can you grab the coffee?", "Please merge it."])
        yield* speak
        yield* wait(5)
        const aside = [...saying]
        yield* speak
        yield* wait(5)
        yield* wait(20)
        yield* Fiber.join(fiber)
        return { aside, saying }
      }),
    )
    expect(result).toEqual({ aside: [], saying: ["Okay."] })
  })

  test("says the persona's line for going ahead when the reply passed on says nothing of its own", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const { fiber, sent, speak, wait, saying } = yield* conversation(["Just merge it."])
        yield* speak
        yield* wait(5)
        yield* wait(20)
        yield* Fiber.join(fiber)
        return { sent, saying }
      }),
    )
    expect(result).toEqual({ sent: ["Just merge it."], saying: ["On it."] })
  })

  test("says a line of the persona's own in place of an \"On it\" the model wrote anyway, before whatever more it had to say", async () => {
    const follow = (spoken: string, address = "sir") =>
      scoped(
        Effect.gen(function* () {
          const { layer } = scripted([{ intent: "send", spoken, message: "Merge the staging branch." }])
          const lines = { ...Persona.plain, onIt: "Right away, sir.", address }
          const { fiber, sent, speak, wait, saying } = yield* conversation(["Merge it."], 0, [], "sent", { lines, model: layer })
          yield* speak
          yield* wait(20)
          yield* Fiber.join(fiber)
          return { sent, saying }
        }),
      )
    expect(await follow("On it, sir.")).toEqual({ sent: ["Merge the staging branch."], saying: ["Right away, sir."] })
    expect((await follow("On it, sir. I took that to mean the staging branch.")).saying).toEqual(["Right away, sir. I took that to mean the staging branch."])
    // Addressing him too while the lines don't say how yet.
    expect((await follow("On it, sir.", "")).saying).toEqual(["Right away, sir."])
    expect((await follow("On it, sir. I took that to mean the staging branch.", "")).saying).toEqual(["Right away, sir. I took that to mean the staging branch."])
    // Anything else it had to say is said as it is.
    expect((await follow("I took that to mean the staging branch.")).saying).toEqual(["I took that to mean the staging branch."])
  })

  test("tells the persona only the line said of a follow-up, never one for going ahead when it's queued or held back", async () => {
    const follow = (result: "sent" | "queued" | "moved") =>
      scoped(
        Effect.gen(function* () {
          const { fiber, speak, wait, saying, noted } = yield* conversation(["Just merge it."], 0, [], result)
          yield* speak
          yield* wait(5)
          yield* wait(20)
          yield* Fiber.join(fiber)
          return { saying, noted }
        }),
      )
    expect(await follow("sent")).toEqual({ saying: ["On it."], noted: ["On it."] })
    expect(await follow("queued")).toEqual({ saying: [Persona.plain.queued], noted: [Persona.plain.queued] })
    expect(await follow("moved")).toEqual({ saying: [Conversation.movedOn], noted: [Conversation.movedOn] })
  })

  test("tells the persona a line is said only once it plays, never when it can't be rendered or played, or a dictation cuts in first", async () => {
    const follow = (given: Parameters<typeof conversation>[4], dictation = false) =>
      scoped(
        Effect.gen(function* () {
          const { fiber, speak, wait, noted } = yield* conversation(["Just merge it."], 0, [], "sent", given)
          yield* speak
          yield* wait(5)
          if (dictation) yield* Fiber.interrupt(fiber)
          yield* wait(20)
          return { exit: (yield* Fiber.await(fiber))._tag, noted }
        }),
      )
    const failing = () => Effect.fail(new ProcessError({ command: "say", code: 1, stderr: "It couldn't render." }))
    expect(await follow({ render: failing })).toEqual({ exit: "Failure", noted: [] })
    expect(await follow({ unplayable: true })).toEqual({ exit: "Failure", noted: [] })
    // As a dictation does, while it's still rendering.
    expect(await follow({ render: () => Effect.sleep("10 seconds") }, true)).toEqual({ exit: "Failure", noted: [] })
    expect(await follow({})).toEqual({ exit: "Success", noted: ["On it."] })
  })

  test("with afplay, tells the persona a line is said only once it has played to the end, never when afplay can't play it", async () => {
    const follow = (afplay: "plays" | "fails") =>
      scoped(
        Effect.gen(function* () {
          const { fiber, speak, wait, noted } = yield* conversation(["Just merge it."], 0, [], "sent", { afplay })
          yield* speak
          yield* wait(5)
          // The line is playing.
          yield* wait(5)
          const during = [...noted]
          yield* wait(20)
          return { exit: (yield* Fiber.await(fiber))._tag, during, noted }
        }),
      )
    expect(await follow("fails")).toEqual({ exit: "Failure", during: [], noted: [] })
    expect(await follow("plays")).toEqual({ exit: "Success", during: [], noted: ["On it."] })
  })

  test("sends what the user said even when the conversation is cut off meanwhile, and says so later", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const { fiber, sent, late, noted, speak, wait, sending } = yield* conversation(["Please merge it."], 3)
        yield* speak
        // The reply is worked out, and on its way to the agent.
        yield* wait(6)
        const during = { sent: [...sent], sending: yield* sending("s") }
        // As a dictation does.
        yield* Fiber.interrupt(fiber)
        yield* wait(3)
        return { during, sent, late, noted, sending: yield* sending("s") }
      }),
    )
    expect(result.during).toEqual({ sent: [], sending: true })
    expect(result.sent).toEqual(["Please merge it."])
    expect(result.late).toEqual(["Okay."])
    // Whatever says it later tells the persona, once it plays.
    expect(result.noted).toEqual([])
    expect(result.sending).toBe(false)
  })

  test("two replies passed on before either is said, like two said later, get different lines of his own, said without a repeat", async () => {
    const mine = ["Right away, sir.", "Very good, sir.", "Consider it done, sir."]
    const result = await scoped(
      Effect.gen(function* () {
        const persona = Context.get(
          yield* Layer.build(
            Persona.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(Warmth, { warm: () => Effect.void }),
                  Layer.scoped(Settings.Settings, Effect.map(Store.make(":memory:"), Settings.fromStore)),
                  Layer.succeed(Model, { ask: () => Effect.die("There's no style to write lines in") }),
                ),
              ),
              Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_ON_IT", mine.join("|")]])))),
            ),
          ),
          Persona.Persona,
        )
        const { fiber, converse, speak, wait, late } = yield* conversation(["Just merge it.", "Just deploy it."], 3, [], "sent", { persona })
        // Each sent, then cut off by a dictation before it's said, so it's said later.
        yield* speak
        yield* wait(6)
        yield* Fiber.interrupt(fiber)
        yield* wait(3)
        const again = yield* Effect.fork(converse(update))
        yield* speak
        yield* wait(6)
        yield* Fiber.interrupt(again)
        yield* wait(3)
        // Then each plays in turn.
        yield* Effect.forEach(late, persona.said)
        return { late, next: yield* persona.onIt() }
      }).pipe(Effect.withRandom(Random.fixed([0]))),
    )
    // Each picks the first it may, as both would without knowing of the other.
    expect(result).toEqual({ late: ["Right away, sir.", "Very good, sir."], next: "Right away, sir." })
  })

  test("tracks pending deliveries by update", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const oldStarted = yield* Deferred.make<void>()
        const newStarted = yield* Deferred.make<void>()
        const oldDone = yield* Deferred.make<void>()
        const newDone = yield* Deferred.make<void>()
        const { fiber, converse, speak, wait, sending, sent } = yield* conversation(["Explain the old update.", "Explain the new update."], 0, [
          Deferred.succeed(oldStarted, undefined).pipe(Effect.zipRight(Deferred.await(oldDone))),
          Deferred.succeed(newStarted, undefined).pipe(Effect.zipRight(Deferred.await(newDone))),
        ])
        yield* speak
        yield* wait(6)
        yield* Deferred.await(oldStarted)
        yield* Fiber.interrupt(fiber)
        const fresh = { ...update, at: 1, spoken: "Here's the answer." }
        yield* Effect.forkScoped(converse(fresh))
        yield* wait(0)
        const before = { old: yield* sending("s", update), fresh: yield* sending("s", fresh) }
        yield* speak
        yield* wait(6)
        yield* Deferred.await(newStarted)
        yield* Deferred.succeed(newDone, undefined)
        yield* wait(0)
        const afterNew = { old: yield* sending("s", update), fresh: yield* sending("s", fresh), session: yield* sending("s") }
        yield* Deferred.succeed(oldDone, undefined)
        yield* wait(0)
        return { before, afterNew, sending: yield* sending("s"), sent }
      }),
    )
    expect(result.before).toEqual({ old: true, fresh: false })
    expect(result.afterNew).toEqual({ old: true, fresh: false, session: true })
    expect(result.sending).toBe(false)
    expect(result.sent).toEqual(["Explain the new update.", "Explain the old update."])
  })
})

describe("Questions", () => {
  test("takes what the user says right after a question for its answer", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const { ask, speak, wait } = yield* conversation(["Yes, in yapd."])
        const asking = yield* ask(answers)
        yield* wait(10)
        // Still listening, longer than after an update.
        yield* wait(5)
        yield* speak
        return { answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ answered: true, answers: ["Yes, in yapd."] })
  })

  test("tells the answer how much of all the user said was speech, when they carry on after a pause", async () => {
    const tried = await scoped(
      Effect.gen(function* () {
        const tried: Array<readonly [string, number]> = []
        const { question, frames, wait } = yield* conversation(["Thank", "you."])
        // Working it out takes a while, as with the model, so there's time to carry on.
        const asking = yield* question((heard, voiced) =>
          Effect.sync(() => void tried.push([heard, Math.round(voiced * 1000)])).pipe(
            Effect.zipRight(Effect.sleep("5 seconds")),
            Effect.as(Option.some(Effect.void)),
          ),
        )
        // A word, a pause, then the rest, each with the quiet before it that's kept.
        yield* frames(0, defaults.lead)
        yield* frames(0.9, 6)
        yield* frames(0, defaults.silence)
        yield* frames(0, defaults.lead)
        yield* frames(0.9, 30)
        yield* frames(0, defaults.silence)
        yield* wait(5)
        yield* Fiber.join(asking)
        return tried
      }),
    )
    // In milliseconds: 6 frames of speech, then 30 more.
    expect(tried).toEqual([["Thank", 192], ["Thank you.", 1152]])
  })

  test("leaves a question unanswered when nothing is said, or nothing meant for it", async () => {
    const silent = await scoped(
      Effect.gen(function* () {
        const { ask, wait } = yield* conversation([])
        const asking = yield* ask([])
        yield* wait(10)
        yield* wait(8)
        return yield* Fiber.join(asking)
      }),
    )
    expect(silent).toBe(false)
    const unrelated = await scoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const { ask, speak, wait } = yield* conversation(["Dinner's ready!"])
        const asking = yield* ask(answers)
        yield* wait(10)
        yield* speak
        return { answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(unrelated).toEqual({ answered: false, answers: [] })
  })
})

describe("Telling yapd's own voice from the user's", () => {
  const saying = "Over in yapd, the tests pass now"

  test("takes nothing, or what Whisper makes up, for nobody", () => {
    for (const heard of [
      "", "Thank you.", "- Verse.", "End of song.", "Thank you. Thank you.", "Okay.", "Thanks.", "Yeah.", "So,", "Hello?", "Mm-hmm.",
      "Uh-huh.", "Please subscribe.", "Thank you, bye.", "Thank you so much for watching.", "I'll see you next time.", "you you you",
      "Subtitles by the Amara.org community", "Okay, thanks.", "Yeah, okay.", "Okay, okay. Yes.", "Of course.", "Excuse me.",
      "Good morning.", "What the hell?", "Jesus Christ.",
    ]) {
      expect([heard, theirs(heard, saying)]).toEqual([heard, false])
    }
  })

  test("takes its own voice for its own when Whisper writes its name as a word it knows, like \"yapped\" for \"yapd\"", () => {
    for (const heard of ["Over in yapped.", "Over in Japan.", "Over in Yappy.", "Overin Yapti.", "Over in yapped, the tests pass."]) {
      expect([heard, theirs(heard, saying)]).toEqual([heard, false])
    }
    const question = "Which one, sir: yapd or the docs site?"
    for (const heard of ["Which one, sir? Yapped.", "Which one? Yapped.", "Which one, sir? Yap, or the dock site?"]) {
      expect([heard, theirs(heard, question)]).toEqual([heard, false])
    }
    // His own words still are, said over it.
    expect(theirs("Hold on, which PR was that?", saying)).toBe(true)
    expect(theirs("Neither, start a new project.", question)).toBe(true)
  })

  test("takes what's mostly the words yapd was saying for its own voice, misheard or not", () => {
    expect(theirs("Over in yapd, the tests pass.", saying)).toBe(false)
    expect(theirs("Over in yap D, the test pass.", saying)).toBe(false)
    expect(theirs("Codecs finished the migrations.", "Codex finished the migration and")).toBe(false)
    expect(theirs("Over and yeah the test past.", `${saying} and the pull request`)).toBe(false)
    // Where nothing else tells.
    expect(theirs("Codecs. Yap.", "Codex on yapd")).toBe(false)
    // As many of his as of yapd's could be either, so it's let go rather than cut yapd off.
    expect(theirs("Tests pass, flaky build.", saying)).toBe(false)
  })

  test("takes a stop yapd was saying for its own voice, even cut off partway through a longer word", () => {
    expect(theirs("Stop.", "I'll stop the tests now")).toBe(false)
    expect(theirs("Next.", "The tests pass. Next, I'll open")).toBe(false)
    expect(theirs("Stop.", "Codex on yapd stopped after the tests failed, sir.")).toBe(false)
    expect(theirs("Codex on yapd stop.", "Codex on yapd stopped after the tests failed, sir.")).toBe(false)
    expect(theirs("It's still wait", "The pull request is open and it's still waiting on CI.")).toBe(false)
    expect(theirs("The agent skip", "The agent skipped the flaky test and pushed.")).toBe(false)
    expect(theirs("Codex is stop", "Codex is stopping the server.")).toBe(false)
  })

  test("takes two words of the user's own for him, however common, and a stop yapd isn't saying, even over its words", () => {
    const line = "Codex finished the migration on yapd and all the tests pass now. Do you want me to open the pull request?"
    for (const heard of ["Hold on.", "Not now.", "What did you do?", "Do it.", "Merge it.", "Hold on, which tests?", "Wait, did it run the integration tests?"]) {
      expect([heard, theirs(heard, line)]).toEqual([heard, true])
    }
    expect(theirs("Hold on, which tests?", saying)).toBe(true)
    expect(theirs("The tests are flaky.", saying)).toBe(true)
    expect(theirs("Over in yapd, the tests pass. Stop.", saying)).toBe(true)
    expect(theirs("Thank you. Wait.", saying)).toBe(true)
    expect(theirs("Stop.", saying)).toBe(true)
  })

  test("takes what Whisper makes up of everyday words over yapd's for nobody, unless it's said just so", () => {
    const line = "Codex on yapd finished the migration, and all the tests pass"
    for (const heard of [
      "I'm going to go.", "Let's go.", "I'm sorry.", "I don't know.", "That's it.", "That's all.", "Come on.", "Here we go.",
      "I'll see you in the next one.", "See you guys.", "Thank you for your attention.", "I'll be right back.", "Have a nice day.",
      "Take care.", "Good luck.", "Welcome back.",
    ]) {
      expect([heard, theirs(heard, line)]).toEqual([heard, false])
    }
    for (const heard of ["Not now.", "Do it.", "What did you do?", "Which one?", "Go on."]) {
      expect([heard, theirs(heard, line)]).toEqual([heard, true])
    }
    // Once yapd has stopped talking, none of it can be its voice.
    expect(theirs("No.", "", 1)).toBe(true)
  })

  test("takes a word of his for him once yapd has stopped talking, but never what Whisper makes up", () => {
    expect(theirs("Docs.", saying)).toBe(false)
    expect(theirs("Docs.", "", 1)).toBe(true)
    expect(theirs("Thank you.", "", 1)).toBe(false)
  })

  test("leaves its own voice out of either end of what the user said, but none of his words", () => {
    // Before him, and after him, with or without the full stop Whisper puts between them.
    expect(unechoed("Over in yapd, the tests pass. Hold on, which PR was that?", saying)).toBe("Hold on, which PR was that?")
    expect(unechoed("Hold on. in yapd, the tests", saying)).toBe("Hold on.")
    expect(unechoed("Hold on in yap D the tests", saying)).toBe("Hold on")
    expect(unechoed("Over in Japan the tests hold on which PR", saying)).toBe("hold on which PR")
    expect(unechoed("Thank you. Over in yapd. Stop.", saying)).toBe("Stop.")
    // A stop of his is never taken for one of its words misheard.
    expect(unechoed("Over in yapd, stop the tests.", saying)).toBe("stop")
    // A word of its here and there in what he says is his.
    expect(unechoed("Hold on, which tests?", saying)).toBe("Hold on, which tests?")
    expect(unechoed("Wait, did it run the integration tests?", saying)).toBe("Wait, did it run the integration tests?")
    expect(unechoed("Over in yapd, the tests pass.", saying)).toBe("")
    // Once it has stopped, none of it can be its voice.
    expect(unechoed("Over in yapd, the tests pass.", "")).toBe("Over in yapd, the tests pass.")
  })

  test("leaves the last of its voice out of what the user says straight after it stops, as long as he said more", () => {
    const question = "Which one, sir: yapd or the docs site?"
    expect(unfaded("site? Yapd.", question)).toBe("Yapd.")
    expect(unfaded("docs site Yapd", question)).toBe("Yapd")
    expect(unfaded("Which one, sir: yapd or the docs site? Yapd.", question)).toBe("Yapd.")
    // All of it its words, he may have said them back to it.
    expect(unfaded("The docs site.", question)).toBe("The docs site.")
    expect(unfaded("site.", question)).toBe("site.")
  })

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

/**
 * Reads `long` out over the helper protocol, or what `spoken` says instead,
 * with a fake helper that starts a new voice processor for the first line, as
 * after yapd has rested, and says how far a line got when it's stopped by the
 * clock. The test talks into its microphone with frames whose value is how
 * likely each is speech, and the fake Whisper hears in what it's given the
 * words `words` has for each value, in the order they're said, or what
 * `whole` has for all of its values together, as when it hears a word cut in
 * two whole, taking `delays` seconds over the first few, or fails with
 * `failing`. What's said is taken as `intent`, which is to pass it on unless
 * it says otherwise.
 */
const overHelper = (
  words: ReadonlyArray<readonly [number, string]>,
  options: {
    readonly delays?: ReadonlyArray<number>
    readonly spoken?: string
    /** How long each line lasts, in seconds. */
    readonly duration?: number
    readonly intent?: Responder.Intent
    readonly failing?: boolean
    readonly whole?: readonly [ReadonlyArray<number>, string]
  } = {},
) =>
  Effect.gen(function* () {
    const runSync = Runtime.runSync(yield* Effect.runtime<never>())
    const commands: Array<string> = []
    /** Where each line was played from, in seconds. */
    const plays: Array<number> = []
    const transcribed: Array<string> = []
    const sent: Array<string> = []
    const waits = [...(options.delays ?? [])]
    let interrupted = 0
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
                    readonly from?: number
                  }
                  commands.push(command.type)
                  if (command.type === "play") {
                    if (!running) send({ type: "active", listening: true })
                    running = true
                    playing = { id: command.id ?? "", since: now(), from: command.from ?? 0 }
                    plays.push(playing.from)
                    send({ type: "playing", id: command.id, duration: options.duration ?? 10 })
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
          Effect.gen(function* () {
            const together = options.whole !== undefined && options.whole[0].every((value) => audio.includes(Math.fround(value)))
            const heard = together
              ? options.whole![1]
              : words
                  .flatMap(([value, text]) => {
                    const at = audio.indexOf(Math.fround(value))
                    return at < 0 ? [] : [[at, text] as const]
                  })
                  .sort(([one], [other]) => one - other)
                  .map(([, text]) => text)
                  .join(" ")
            transcribed.push(heard)
            const delay = waits.shift() ?? 0
            if (delay > 0) yield* Effect.sleep(`${delay} seconds`).pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted++)))
            if (options.failing === true) return yield* new TranscribeError({ cause: "No model" })
            return heard
          }),
      }),
      Layer.succeed(Responder.Responder, {
        respond: ({ heard }) => {
          const intent = options.intent ?? "send"
          return Effect.succeed({ intent, spoken: intent === "send" ? "Okay." : "", message: intent === "send" ? heard : "" })
        },
      }),
      Layer.succeed(Voice, { render: () => Effect.void }),
    )
    const context = yield* Layer.build(layer)
    const made = yield* Conversation.make({
      dir: "/tmp",
      moved: () => Effect.succeed(false),
      send: (_, message) => Effect.sync(() => void sent.push(message)).pipe(Effect.as("sent" as const)),
      late: () => Effect.void,
      replied: Effect.void,
      saying: () => Effect.void,
    }).pipe(Effect.provide(context))
    // Lets the helper, the microphone and the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(async () => {
      while (unsent.length > 0) await new Promise((resolve) => setTimeout(resolve, 10))
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const talk = (value: number, count: number) =>
      Effect.sync(() => {
        const samples = new Float32Array(512).fill(value)
        const message = new Uint8Array(5 + samples.byteLength)
        message[0] = Helper.Kind.pcm
        new DataView(message.buffer).setUint32(1, samples.byteLength)
        message.set(new Uint8Array(samples.buffer), 5)
        for (let frame = 0; frame < count; frame++) write(message)
      }).pipe(Effect.zipRight(flush))
    const fiber = yield* Effect.fork(made.converse({ ...long, spoken: options.spoken ?? long.spoken }))
    yield* flush
    yield* flush
    return {
      ...made,
      fiber,
      commands,
      plays,
      transcribed,
      sent,
      interrupted: () => interrupted,
      talk,
      quiet: talk(0, defaults.silence),
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
      finish: Effect.sync(() => {
        if (playing !== undefined) send({ type: "finished", id: playing.id })
        playing = undefined
      }).pipe(Effect.zipRight(flush)),
      /** The helper quits, taking the microphone with it. */
      quit: Effect.sync(() => connection?.terminate()).pipe(Effect.zipRight(flush)),
      replies: Effect.map(Effect.flatMap(Journal.Journal, (journal) => journal.since(0)), (entries) => entries.map(({ text }) => text)).pipe(
        Effect.provide(context),
      ),
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

describe("Over its first words, while yapd's own voice can still get into the microphone", () => {
  test("carries on over its own voice getting through, sending and noting nothing", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."]])
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        const during = [...helper.commands]
        yield* helper.wait(9)
        yield* helper.finish
        yield* helper.wait(3)
        const exit = yield* Fiber.await(helper.fiber)
        return { during, exit: exit._tag, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    // Heard and made out, but never stopped for, nor even ducked.
    expect(result.transcribed).toEqual(["Over in yapd, the tests pass."])
    expect(result.during).toEqual(["play"])
    expect(result).toMatchObject({ exit: "Success", sent: [], replies: [] })
  })

  test("lets go of what Whisper makes up of its voice", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Thank you."], [0.81, "- Verse."]])
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.talk(0.81, 10)
        yield* helper.quiet
        return { commands: helper.commands, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], transcribed: ["Thank you.", "- Verse."], sent: [], replies: [] })
  })

  test("stops for the user once Whisper has made out it's him, and takes it like any interruption", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]])
        yield* helper.talk(0.9, 10)
        // Still talking: it could be its own voice until it's made out.
        const talking = [...helper.commands]
        yield* helper.quiet
        return { talking, commands: helper.commands, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.talking).toEqual(["play"])
    expect(result.commands.slice(0, 2)).toEqual(["play", "stop"])
    // Made out once, and that's what's taken in, said and noted.
    expect(result.transcribed).toEqual(["Hold on, merge it."])
    expect(result.sent).toEqual(["Hold on, merge it."])
    expect(result.replies).toEqual(["Hold on, merge it."])
  })

  test("stops at once after them, without waiting on what's still being made out of talk over them, and loses none of either", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes five seconds over the first.
        const helper = yield* overHelper([[0.91, "Hold on."], [0.92, "Merge it."]], { delays: [5] })
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.wait(3.5)
        yield* helper.talk(0.92, defaults.confirm)
        const stopped = [...helper.commands]
        yield* helper.talk(0.92, 6)
        yield* helper.quiet
        const before = [...helper.sent]
        yield* helper.wait(2)
        return { stopped, before, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.stopped).toEqual(["play", "volume", "stop"])
    expect(result.before).toEqual([])
    // Each made out on its own, and passed on in the order he said it once the first was.
    expect(result.transcribed).toEqual(["Hold on.", "Merge it."])
    expect(result.sent).toEqual(["Hold on. Merge it."])
    expect(result.replies).toEqual(["Hold on. Merge it."])
  })

  test("doesn't stop when its own voice carries on past them, and lets it go once it ends", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "the tests pass now and the pull request"]])
        yield* helper.wait(2.5)
        yield* helper.talk(0.8, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.8, 40)
        yield* helper.quiet
        return { commands: helper.commands, looks: helper.transcribed.length, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.commands).toEqual(["play"])
    // Looked at as it went on, and once more at the end.
    expect(result.looks).toBeGreaterThan(1)
    expect(result).toMatchObject({ sent: [], replies: [] })
  })

  test("stops for the user talking on past them about a second in, rather than once he's finished, and keeps what he said over them", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Too little over them to tell on its own, the last word cut off where yapd's voice stopped getting in.
        const helper = yield* overHelper([[0.93, "Listen, Jarvis,"], [0.94, "I need to tell you something."]])
        yield* helper.wait(2.5)
        yield* helper.talk(0.93, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.94, 20)
        const early = [...helper.commands]
        yield* helper.talk(0.94, 15)
        const later = [...helper.commands]
        yield* helper.talk(0.94, 30)
        yield* helper.quiet
        return { early, later, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.early).toEqual(["play"])
    expect(result.later).toEqual(["play", "stop"])
    expect(result.sent).toEqual(["Listen, Jarvis, I need to tell you something."])
    expect(result.replies).toEqual(["Listen, Jarvis, I need to tell you something."])
  })

  test("stops as soon as what the user said over them is made out, when he talks on past them", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Enough to tell, less the last word, cut off where yapd's voice stopped getting in.
        const helper = yield* overHelper([[0.93, "Hold on, Jarvis,"], [0.94, "I need to tell you something."]])
        yield* helper.wait(2.5)
        yield* helper.talk(0.93, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.94, 5)
        const early = [...helper.commands]
        yield* helper.talk(0.94, 30)
        yield* helper.quiet
        return { early, sent: helper.sent }
      }),
    )
    expect(result.early).toEqual(["play", "stop"])
    expect(result.sent).toEqual(["Hold on, Jarvis, I need to tell you something."])
  })

  test("tells the user talking after them from its own voice running on into what he says, and passes on only his", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.95, "Hold on, which PR was that?"]])
        yield* helper.wait(1)
        yield* helper.talk(0.8, 20)
        yield* helper.wait(2.2)
        // He starts before Silero has heard the end of yapd's voice.
        yield* helper.talk(0, 5)
        yield* helper.talk(0.95, 20)
        const early = [...helper.commands]
        yield* helper.talk(0.95, 15)
        const later = [...helper.commands]
        yield* helper.talk(0.95, 10)
        yield* helper.quiet
        return { early, later, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.early).toEqual(["play"])
    // About a second into what he said.
    expect(result.later).toEqual(["play", "stop"])
    expect(result.sent).toEqual(["Hold on, which PR was that?"])
    expect(result.replies).toEqual(["Hold on, which PR was that?"])
  })

  test("doesn't take a stop yapd is saying itself, getting into the microphone, for the user", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Next."]], {
          spoken: "The tests pass. Next, I'll open the pull request once the checks are green, so it's ready for you to review.",
        })
        yield* helper.wait(1)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        return { commands: helper.commands, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], transcribed: ["Next."], sent: [], replies: [] })
  })

  test("lets go of all sorts of what Whisper makes up, and of a word on its own", async () => {
    const madeUp = [
      "Okay.", "Mm-hmm.", "Thank you, bye.", "I'll see you next time.", "Thank you so much for watching.", "Absolutely.", "Let's go.",
      "I'm going to go.", "I'll see you in the next one.",
    ]
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper(madeUp.map((text, index) => [0.8 + index / 100, text] as const))
        for (const [index] of madeUp.entries()) {
          yield* helper.talk(0.8 + index / 100, 10)
          yield* helper.quiet
        }
        return { commands: helper.commands, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], transcribed: madeUp, sent: [], replies: [] })
  })

  test("stops for a short interruption in words yapd is saying too, like the \"on\" of \"hold on\"", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on."]], {
          spoken: "The agent on yapd finished the interruption fix. It added a check on the first three seconds, and all the tests pass.",
        })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        return { commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.commands.slice(0, 2)).toEqual(["play", "stop"])
    expect(result).toMatchObject({ sent: ["Hold on."], replies: ["Hold on."] })
  })

  test("goes back to before the user began when he wasn't talking to it, since it only stopped once it made out it was him", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]], { intent: "resume" })
        yield* helper.wait(2)
        yield* helper.talk(0.9, 10)
        yield* helper.wait(1.5)
        yield* helper.quiet
        return { commands: helper.commands, plays: helper.plays }
      }),
    )
    expect(result.commands.slice(0, 3)).toEqual(["play", "stop", "play"])
    // A second and a half before he began, two seconds in, rather than before where it stopped, three and a half seconds in.
    expect(result.plays).toEqual([0, 0.5])
  })

  test("lets what it's making out decide how a line ends that finishes meanwhile, however long that takes", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // A line short enough to be over before Whisper is done, which takes longer than yapd waits for a reply.
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]], { delays: [10], duration: 2, spoken: "Codex is done, sir." })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.finish
        for (let second = 0; second < 10; second++) yield* helper.wait(1)
        return { sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ sent: ["Hold on, merge it."], replies: ["Hold on, merge it."] })
  })

  test("still passes on what it was making out when the helper quits meanwhile", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]], { delays: [5] })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.quit
        yield* helper.wait(5)
        return { sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ sent: ["Hold on, merge it."], replies: ["Hold on, merge it."] })
  })

  test("carries on when Whisper can't make out what may be its own voice", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]], { failing: true })
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        const during = [...helper.commands]
        yield* helper.wait(10)
        yield* helper.finish
        yield* helper.wait(3)
        const exit = yield* Fiber.await(helper.fiber)
        return { during, exit: exit._tag, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ during: ["play"], exit: "Success", sent: [], replies: [] })
  })

  test("lets go of what it's making out when the update is cut off, like by a dictation", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]], { delays: [5] })
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* Fiber.interrupt(helper.fiber)
        yield* helper.wait(5)
        return { interrupted: helper.interrupted(), sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ interrupted: 1, sent: [], replies: [] })
  })

  test("doesn't take a question's own words getting through for an answer, but takes one he carries on with once it's asked", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.8, "Which one, sir?"], [0.85, "Or the docs site?"], [0.9, "The docs site."]], { duration: 3.5 })
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Which one, sir: yapd or the docs site?",
            answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(2)
        yield* helper.talk(0.85, 10)
        const echoed = [...answers]
        yield* helper.wait(1)
        yield* helper.finish
        // Straight after it stops, while the last of its voice may still be coming in, so he carries on past that.
        yield* helper.talk(0.9, 30)
        yield* helper.quiet
        return { echoed, answered: yield* Fiber.join(asking), answers, transcribed: helper.transcribed }
      }),
    )
    // Only what he said after the question passed on.
    expect(result).toEqual({
      echoed: [],
      answered: true,
      answers: ["The docs site."],
      transcribed: ["Which one, sir?", "Or the docs site?", "The docs site."],
    })
  })

  test("lets go of the last of its voice coming in just after a line ends, rather than taking that for him", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Codex opened the"], [0.82, "pull request."]], {
          duration: 2,
          spoken: "Codex opened the pull request, sir.",
        })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 20)
        yield* helper.wait(1.5)
        yield* helper.finish
        yield* helper.talk(0.82, 3)
        yield* helper.quiet
        yield* helper.wait(4)
        const exit = yield* Fiber.await(helper.fiber)
        return { exit: exit._tag, commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ exit: "Success", commands: ["play"], sent: [], replies: [] })
  })

  test("doesn't take the last of a question's own voice, coming in just after it's asked, for an answer", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.8, "Which one, sir? Yapd or the docs"], [0.85, "Site."]], { duration: 3 })
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Which one, sir: yapd or the docs site?",
            answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 40)
        yield* helper.wait(2.5)
        yield* helper.finish
        yield* helper.talk(0.85, 3)
        yield* helper.quiet
        yield* helper.wait(9)
        return { answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ answered: false, answers: [] })
  })

  test("lets go of its voice still coming in once it has stopped for him, rather than adding it to what he said", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes three seconds over what he said, while its voice gets in again.
        const helper = yield* overHelper([[0.9, "Hold on."], [0.8, "the tests pass now and the pull request"]], { delays: [3] })
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.talk(0.8, 10)
        yield* helper.wait(2)
        const stopped = [...helper.commands]
        // The last of its voice, still coming in after it stopped.
        yield* helper.talk(0.8, 3)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], sent: ["Hold on."], replies: ["Hold on."] })
  })

  test("doesn't stop for a word of its own cut off partway by a look at what's been said so far, like the \"stop\" of \"stopped\"", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Codex on yapd stop"], [0.81, "ped after the tests failed."]], {
          spoken: "Codex on yapd stopped after the tests failed, sir. It says the database migration needs your approval before it can carry on.",
        })
        yield* helper.wait(0.3)
        // A look about a second in, partway through "stopped".
        yield* helper.talk(0.8, 36)
        yield* helper.talk(0.81, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], sent: [], replies: [] })
  })

  test("doesn't stop for a word of its own cut off where its voice stopped getting in, like the \"wait\" of \"waiting\"", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Codex is still wait."], [0.81, "ing on CI before it can merge."]], {
          spoken: "Codex is still waiting on CI before it can merge the pull request, sir. The checks usually take about ten minutes.",
        })
        yield* helper.wait(2.5)
        yield* helper.talk(0.8, 12)
        yield* helper.wait(0.6)
        yield* helper.talk(0.81, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], sent: [], replies: [] })
  })

  test("doesn't put a word of its own voice, cut off where it stopped getting in, before what the user says after", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // "Codex" as Whisper hears the end of it.
        const helper = yield* overHelper([[0.8, "Kodak."], [0.95, "Hold on, which PR was that?"]])
        yield* helper.wait(2.7)
        yield* helper.talk(0.8, 8)
        yield* helper.wait(0.4)
        yield* helper.talk(0.95, 45)
        yield* helper.quiet
        return { sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ sent: ["Hold on, which PR was that?"], replies: ["Hold on, which PR was that?"] })
  })

  test("keeps what the user goes on to say past them once what he said over them is his, though it's in yapd's words", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.93, "Hold on, tell it to"], [0.94, "merge the pull request."]])
        yield* helper.wait(2.3)
        yield* helper.talk(0.93, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.94, 30)
        yield* helper.quiet
        yield* helper.wait(4)
        return { commands: helper.commands.slice(0, 2), sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "stop"],
      sent: ["Hold on, tell it to merge the pull request."],
      replies: ["Hold on, tell it to merge the pull request."],
    })
  })

  test("keeps what the user went on to say past them, in yapd's words, when what he said over them is made out only after", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes three seconds over what he said over them.
        const helper = yield* overHelper([[0.93, "Hold on, tell it to"], [0.94, "merge the pull request."]], { delays: [3] })
        yield* helper.wait(2.3)
        yield* helper.talk(0.93, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.94, 30)
        yield* helper.quiet
        yield* helper.wait(4)
        return { sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ sent: ["Hold on, tell it to merge the pull request."], replies: ["Hold on, tell it to merge the pull request."] })
  })

  test("makes out a short interruption across the end of them whole, when neither side of it is enough on its own", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.93, "Not"], [0.94, "now."]])
        yield* helper.wait(2.7)
        yield* helper.talk(0.93, 8)
        yield* helper.wait(0.5)
        yield* helper.talk(0.94, 8)
        yield* helper.quiet
        yield* helper.wait(4)
        return { commands: helper.commands.slice(0, 2), transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], transcribed: ["Not", "now.", "Not now."], sent: ["Not now."], replies: ["Not now."] })
  })

  test("ends a line that finished while what turns out to be its own voice was still being made out, once it's let go", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes longer than the line has left.
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."]], { delays: [5], duration: 2, spoken: "Over in yapd, the tests pass." })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(1.5)
        yield* helper.finish
        for (let second = 0; second < 10; second++) yield* helper.wait(1)
        const done = yield* Fiber.poll(helper.fiber)
        return { done: Option.isSome(done), sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ done: true, sent: [], replies: [] })
  })

  test("doesn't add its own voice, paused as what the user said before is made out to be his, to what he said", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on."], [0.8, "the tests pass now and the pull request"]], { delays: [3] })
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.talk(0.8, 10)
        yield* helper.talk(0, 5)
        yield* helper.wait(2)
        const stopped = [...helper.commands]
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], sent: ["Hold on."], replies: ["Hold on."] })
  })

  test("doesn't stop for its own voice with its name heard as a word Whisper knows, like \"yapped\", nor send or note it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapped."]])
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], transcribed: ["Over in yapped."], sent: [], replies: [] })
  })

  test("doesn't take a question's own voice with its name misheard for an answer, nor stop asking it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.8, "Which one, sir? Yapped."]], { duration: 3.5 })
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Which one, sir: yapd or the docs site?",
            answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 30)
        yield* helper.quiet
        const during = helper.commands.slice(asked)
        yield* helper.wait(3)
        yield* helper.finish
        yield* helper.wait(9)
        return { during, answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ during: ["play"], answered: false, answers: [] })
  })

  test("passes on only what the user says after its own voice, when he talks straight on from it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Hold on, which PR was that?"]])
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands.slice(0, 2), sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], sent: ["Hold on, which PR was that?"], replies: ["Hold on, which PR was that?"] })
  })

  test("passes on only what the user said before its own voice ran on into it", async () => {
    for (const said of ["Stop.", "Tell it to wait."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said], [0.8, "in yapd, the tests"]])
          yield* helper.wait(0.3)
          yield* helper.talk(0.9, 12)
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands.slice(0, 2), sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { commands: ["play", "stop"], sent: [said], replies: [said] }])
    }
  })

  test("stops for the user about a second in though its own voice runs on after him, and passes on only his", async () => {
    for (const said of ["Skip this one.", "Which PR was that?"]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said], [0.8, "in yapd, the tests pass now"]])
          yield* helper.wait(0.3)
          yield* helper.talk(0.9, 15)
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 25)
          const early = [...helper.commands]
          yield* helper.talk(0.8, 15)
          yield* helper.wait(1)
          yield* helper.quiet
          yield* helper.wait(1)
          return { early, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { early: ["play", "stop"], sent: [said], replies: [said] }])
    }
  })

  test("keeps the word that only fills a pause he starts with over them, when he talks on past them", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // "Tell" cut in two where yapd's voice stopped getting in.
        const helper = yield* overHelper([[0.93, "So, tell"], [0.94, "it to run the migration again."]], {
          whole: [[0.93, 0.94], "So, tell it to run the migration again."],
        })
        yield* helper.wait(2.8)
        yield* helper.talk(0.93, 8)
        yield* helper.wait(0.3)
        yield* helper.talk(0.94, 40)
        yield* helper.quiet
        yield* helper.wait(4)
        return { commands: helper.commands.slice(0, 2), sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "stop"],
      sent: ["So, tell it to run the migration again."],
      replies: ["So, tell it to run the migration again."],
    })
  })

  test("takes a quick answer to a question it asked over them, said as the last of its voice comes in", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.8, "Which one, sir: yapd or the docs"], [0.82, "site?"], [0.9, "Yapd."]], { duration: 3 })
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Which one, sir: yapd or the docs site?",
            answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(2)
        yield* helper.talk(0.8, 20)
        yield* helper.wait(1)
        yield* helper.finish
        // The last of its voice, then him a moment later, before Silero has heard the end of it.
        yield* helper.talk(0.82, 3)
        yield* helper.talk(0, 6)
        yield* helper.talk(0.9, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ answered: true, answers: ["Yapd."] })
  })

  test("takes a quick reply to a short line it said over them, said as the last of its voice comes in", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Codex opened the"], [0.82, "pull request."], [0.9, "Merge"], [0.91, "it."]], {
          duration: 2,
          spoken: "Codex opened the pull request, sir.",
        })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 20)
        yield* helper.wait(1.5)
        yield* helper.finish
        yield* helper.talk(0.82, 3)
        yield* helper.talk(0, 6)
        yield* helper.talk(0.9, 7)
        yield* helper.talk(0.91, 5)
        yield* helper.quiet
        yield* helper.wait(1)
        return { sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ sent: ["Merge it."], replies: ["Merge it."] })
  })

  test("takes a quick answer to a question it asked over them when none of its voice comes in after", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.9, "Yapd."]], { duration: 3 })
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Which one, sir: yapd or the docs site?",
            answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(3)
        yield* helper.finish
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ answered: true, answers: ["Yapd."] })
  })
})

describe("Responder", () => {
  test("gives the model the update and the conversation so far", () => {
    const prompt = Responder.prompt(
      {
        project: "yapd",
        turn: { prompt: Option.some("Why do retries fail?"), message: "The secret was rotated." },
        needsYou: false,
        lines: [{ speaker: "yapd", text: "The secret…" }],
        heard: "When was it rotated?",
      },
      Option.none(),
    )
    expect(prompt).toContain("Project: yapd")
    expect(prompt).toContain("User's prompt to the agent:\nWhy do retries fail?")
    expect(prompt).toContain("Agent's message:\nThe secret was rotated.")
    expect(prompt).toContain("You: The secret…")
    expect(prompt.endsWith("What the user just said:\nWhen was it rotated?")).toBe(true)
  })

  test("leaves out the prompt when there was none", () => {
    const prompt = Responder.prompt(
      { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Got it." },
      Option.none(),
    )
    expect(prompt).not.toContain("User's prompt")
    expect(prompt).not.toContain("How the user wants you to talk")
  })

  test("talks the way the user asked", () => {
    const prompt = Responder.prompt(
      { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Which PR?" },
      Option.some("Call me sir."),
    )
    expect(prompt).toContain("How the user wants you to talk")
    expect(prompt).toContain("Call me sir.")
  })

  test("says whether the agent is waiting on the user", () => {
    const interruption = (needsYou: boolean) =>
      Responder.prompt(
        {
          project: "yapd",
          turn: { prompt: Option.none(), message: "Checks are running, I'll report back." },
          needsYou,
          lines: [],
          heard: "Sounds good.",
        },
        Option.none(),
      )
    expect(interruption(true)).toContain("The agent is waiting on the user")
    expect(interruption(false)).toContain("The agent isn't waiting on the user.")
  })

  test("only sends an acknowledgement that answers the agent", () => {
    const prompt = Responder.prompt(
      { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Okay." },
      Option.none(),
    )
    expect(prompt).toContain(`That includes acknowledging, like "sounds good"`)
    expect(prompt).toContain(`Agreeing with what the agent already said it would do changes nothing, so that's "dismiss".`)
  })

  test("passes on every step without saying it back", () => {
    const prompt = Responder.prompt(
      {
        project: "yapd",
        turn: { prompt: Option.none(), message: "The PR is open." },
        needsYou: false,
        lines: [],
        heard: "Get that merged in and when that's done update my master worktree and the deployment.",
      },
      Option.none(),
    )
    expect(prompt).toContain("Keep every request they made, in their order")
    // Going ahead, yapd says a line of its own, so the model only adds what more there is, and is never taught to say "On it".
    expect(prompt).toContain(
      `- For "send", empty: you say your usual line that it's in hand. Only when there's more they must know than that, say just that, in a few words, like "I took that to mean the staging branch." Don't repeat back what they asked for`,
    )
    expect(prompt).not.toMatch(/\bon it\b/i)
  })

  test("doesn't send a reply that tells the agent to do nothing", () => {
    const prompt = Responder.prompt(
      {
        project: "yapd",
        turn: { prompt: Option.none(), message: "Want me to update the ticket?" },
        needsYou: true,
        lines: [],
        heard: "Keep the ticket as it is, and don't do anything else.",
      },
      Option.none(),
    )
    expect(prompt).toContain(`So is telling it to do nothing, leave something as it is, or not go ahead`)
  })
})

describe("Condenser", () => {
  test("gives the model the project, the prompt, the message and the style", () => {
    const prompt = Condenser.prompt(
      "yapd",
      { prompt: Option.some("Why do retries fail?"), message: "The secret was rotated." },
      Option.some("Call me sir."),
    )
    expect(prompt).toContain("Call me sir.")
    expect(prompt).toContain("Project: yapd")
    expect(prompt).toContain("User's prompt:\nWhy do retries fail?")
    expect(prompt.endsWith("Agent's message:\nThe secret was rotated.")).toBe(true)
  })

  test("counts a reply that only repeats what the user said as trivial", () => {
    const prompt = Condenser.prompt(
      "yapd",
      { prompt: Option.some("Sounds good."), message: "Understood. The checks are still running." },
      Option.none(),
    )
    expect(prompt).toContain(`a reply that only confirms what the user just said or restates work they already know about`)
  })

  test("talks plainly without a style", () => {
    const prompt = Condenser.prompt("yapd", { prompt: Option.none(), message: "Done." }, Option.none())
    expect(prompt).not.toContain("How the user wants you to talk")
    expect(prompt).not.toContain("User's prompt")
  })

  test("keeps a summary that already names the project", () => {
    expect(Condenser.introduce("yapd", "yapd's tests pass now.")).toBe("yapd's tests pass now.")
    expect(Condenser.introduce("cryptio-sources", "Over in Cryptio Sources, it's merged.")).toBe(
      "Over in Cryptio Sources, it's merged.",
    )
  })

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

  test("has everything yapd says spoken as the assistant, in English, and only what can be said", () => {
    const interruption = { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Merge it." }
    expect(Condenser.prompt("yapd", interruption.turn, Option.none())).toContain(Condenser.aloud)
    expect(Responder.prompt(interruption, Option.none())).toContain(Condenser.aloud)
    expect(Condenser.aloud).toContain("never about an agent or a session, or what you asked one to do")
    // Never "On it", which yapd says in his own words, so nothing the model is told teaches it to write that.
    expect(Condenser.aloud).toContain(`Talk about the work as yours, like "I've fixed the loader" or "we're nearly there", never`)
    expect(Condenser.prompt("yapd", interruption.turn, Option.some("Call me sir."))).not.toMatch(/\bon it\b/i)
    expect(Condenser.aloud).toContain("Translate titles, headings and quotes too")
    expect(Condenser.aloud).toContain("a wallet, email or street address")
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
  test("translates a summary that let another language through", async () => {
    const { asked, layer } = scripted([
      { priority: "done", spoken: "In right price, I've added the table before “Données traitées,” sir." },
      { spoken: "In right price, I've added the table before the processed data section, sir." },
    ])
    const summary = await Effect.runPromise(
      Effect.flatMap(Condenser.Condenser, ({ condense }) =>
        condense("right-price", { prompt: Option.none(), message: "J'ai ajouté le tableau avant « Données traitées »." }),
      ).pipe(Effect.provide(Condenser.ProviderCondenser.pipe(Layer.provide(layer)))),
    )
    expect(summary).toEqual({ priority: "done", spoken: "In right price, I've added the table before the processed data section, sir." })
    expect(asked[1]).toContain("What's about to be said:\nIn right price, I've added the table before “Données traitées,” sir.")
  })

  test("asks nothing more when it's all in English", async () => {
    const { asked, layer } = scripted([{ priority: "done", spoken: "yapd's tests pass now." }])
    await Effect.runPromise(
      Effect.flatMap(Condenser.Condenser, ({ condense }) => condense("yapd", { prompt: Option.none(), message: "Les tests passent." })).pipe(
        Effect.provide(Condenser.ProviderCondenser.pipe(Layer.provide(layer))),
      ),
    )
    expect(asked).toHaveLength(1)
  })

  test("translates what's said back, but leaves the message in the user's language", async () => {
    const { layer } = scripted([
      { intent: "send", spoken: "C'est noté, monsieur.", message: "Fusionne la branche." },
      { spoken: "Noted, sir." },
    ])
    const reply = await Effect.runPromise(
      Effect.flatMap(Responder.Responder, ({ respond }) =>
        respond({ project: "yapd", turn: { prompt: Option.none(), message: "C'est prêt." }, needsYou: false, lines: [], heard: "Fusionne la branche." }),
      ).pipe(Effect.provide(Responder.ProviderResponder.pipe(Layer.provide(Layer.merge(layer, Persona.Plain))))),
    )
    expect(reply).toEqual({ intent: "send", spoken: "Noted, sir.", message: "Fusionne la branche." })
  })
})

describe("quick replies", () => {
  const reply = (heard: string, message = "The PR is up. Should I merge it?", needsYou = true, said?: string) =>
    Effect.runSync(
      Responder.quick(
        { project: "yapd", turn: { prompt: Option.none(), message }, needsYou, lines: said === undefined ? [] : [{ speaker: "yapd", text: said }], heard },
        Effect.succeed("On it, sir."),
      ),
    )

  test("goes ahead at once when the agent asked", () => {
    const heard = "The PR is up. Should I merge it?"
    expect(reply("Yeah, go ahead.", heard, true, heard)).toEqual({ intent: "send", spoken: "On it, sir.", message: "Yeah, go ahead." })
    expect(reply("yes please", heard, true, heard)).toEqual({ intent: "send", spoken: "On it, sir.", message: "Yes please." })
    // As yapd said it, when the agent buried its question.
    expect(reply("Yes.", "Done. Shall I merge? The docs are updated too.", true, "Over in yapd, it's done. Shall I merge it?")?.intent).toBe("send")
  })

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
          },
          Effect.succeed("On it, sir."),
        ),
      ),
    ).toBeUndefined()
    // Cut off before the question was heard.
    expect(reply("Yes.", "The PR is up. Should I merge it?", true, "The PR…")).toBeUndefined()
  })

  test("takes a nod as enough when nothing was asked", () => {
    expect(reply("Thank you, sir.", "The PR is up.", false)).toEqual({ intent: "dismiss", spoken: "", message: "" })
    expect(reply("Okay, cool.", "The PR is up.", false)?.intent).toBe("dismiss")
    expect(reply("Skip it.")?.intent).toBe("dismiss")
    expect(reply("Merge the other one too.", "The PR is up.", false)).toBeUndefined()
  })

  test("picks a line for going ahead only for a reply that goes ahead", () => {
    let taken = 0
    const onIt = Effect.sync(() => (++taken % 2 === 0 ? "Very good, sir." : "Right away, sir."))
    const heard = "The PR is up. Should I merge it?"
    const reply = (said: string, message = heard) =>
      Effect.runSync(
        Responder.quick(
          { project: "yapd", turn: { prompt: Option.none(), message }, needsYou: message === heard, lines: [{ speaker: "yapd", text: message }], heard: said },
          onIt,
        ),
      )
    expect(reply("Thanks.", "The PR is up.")?.intent).toBe("dismiss")
    expect(reply("Yes, but rebase it first.")).toBeUndefined()
    expect(reply("Enough.")?.intent).toBe("dismiss")
    expect(taken).toBe(0)
    expect(reply("Go ahead.")?.spoken).toBe("Right away, sir.")
    expect(reply("Yes.")?.spoken).toBe("Very good, sir.")
    expect(taken).toBe(2)
  })
})

describe("Transcriber", () => {
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
