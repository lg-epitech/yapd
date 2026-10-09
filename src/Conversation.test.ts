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
import { between, cut, together, unfinished, whose } from "./Conversation.ts"
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
      Fiber.interrupt(fiber).pipe(Effect.zipRight(Effect.fork(made.ask({ audio: "/tmp/question.wav", spoken: "Which project is it for?", answer }))))
    /** One that takes what's said after "yes" for an answer. */
    const ask = (answers: Array<string>) =>
      question((heard) =>
        Effect.succeed(heard.startsWith("Yes") ? Option.some(Effect.sync(() => void answers.push(heard))) : Option.none()),
      )
    /** Says an answer instead, once the update has been given up on, which takes anything but talk with Sam for a follow-up, noting in `through` each time it's said to the end. */
    const say = (followUps: Array<string>, through: Array<string> = []) =>
      Fiber.interrupt(fiber).pipe(
        Effect.zipRight(
          Effect.fork(
            made.answer({
              audio: "/tmp/answer.wav",
              spoken: "It's fixing the tests.",
              followUp: (heard) => Effect.succeed(heard.startsWith("Sam,") ? Option.none() : Option.some(Effect.sync(() => void followUps.push(heard)))),
              through: Effect.sync(() => void through.push("through")),
            }),
          ),
        ),
      )
    return { ...made, fiber, heard, sent, late, saying, noted, speak, wait, question, ask, say, frames, disconnect: Queue.shutdown(microphone), replies: () => replies }
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

describe("Answers", () => {
  test("takes what the user says right after an answer for a follow-up, once it's been heard to the end", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const { say, speak, wait } = yield* conversation(["Tell it to fix the tests."])
        const answering = yield* say(followUps, through)
        yield* wait(10)
        // Heard as soon as it's said to the end, with the microphone still open.
        const heard = [...through]
        yield* wait(2)
        yield* speak
        return { followed: yield* Fiber.join(answering), followUps, heard, through }
      }),
    )
    expect(result).toEqual({ followed: true, followUps: ["Tell it to fix the tests."], heard: ["through"], through: ["through"] })
  })

  test("stops listening after an answer as soon as after an update, sooner than after a question", async () => {
    /** Whether it's still listening once it's been quiet for three seconds after it was said, or else whether something came of it. */
    const quiet = (question: boolean) =>
      scoped(
        Effect.gen(function* () {
          const { say, ask, wait } = yield* conversation([])
          const saying = yield* (question ? ask([]) : say([]))
          yield* wait(10)
          yield* wait(3)
          return Option.isNone(yield* Fiber.poll(saying)) ? "listening" : yield* Fiber.join(saying)
        }),
      )
    expect(await quiet(false)).toBe(false)
    expect(await quiet(true)).toBe("listening")
  })

  test("stops an answer the user talks over and takes what they said for a follow-up, though it wasn't heard to the end", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const { say, speak, wait } = yield* conversation(["Stop."])
        const answering = yield* say(followUps, through)
        yield* wait(3)
        yield* speak
        return { followed: yield* Fiber.join(answering), followUps, through }
      }),
    )
    expect(result).toEqual({ followed: true, followUps: ["Stop."], through: [] })
  })

  test("picks an answer up where it was cut off when what's said over it isn't for yapd, then listens again once it's heard to the end", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const { say, speak, wait } = yield* conversation(["Sam, dinner's in five.", "And tell it to open a PR."])
        const answering = yield* say(followUps, through)
        yield* wait(3)
        yield* speak
        // Picked up a little before where it was stopped, and played to the end.
        yield* wait(10)
        const heard = [...through]
        yield* wait(1)
        yield* speak
        return { followed: yield* Fiber.join(answering), followUps, heard }
      }),
    )
    expect(result).toEqual({ followed: true, followUps: ["And tell it to open a PR."], heard: ["through"] })
  })
})

describe("Telling yapd's own voice from the user's", () => {
  const saying = "Over in yapd, the tests pass now"

  test("takes nothing, or what Whisper makes up, for its own voice", () => {
    for (const heard of [
      "", "Thank you.", "- Verse.", "End of song.", "Thank you. Thank you.", "Okay.", "Thanks.", "So,", "Hello?", "Mm-hmm.", "Uh-huh.",
      "Please subscribe.", "Thank you, bye.", "Thank you so much for watching.", "I'll see you next time.", "you you you",
      "Subtitles by the Amara.org community", "Okay, thanks.", "Of course.", "Excuse me.", "Good morning.", "What the hell?", "Jesus Christ.",
    ]) {
      expect([heard, whose(heard, saying)]).toEqual([heard, "echo"])
    }
  })

  test("takes its own voice for its own when Whisper writes its name as a word it knows, like \"yapped\" for \"yapd\"", () => {
    for (const heard of ["Over in yapped.", "Over in Japan.", "Over in Yappy.", "Overin Yapti.", "Over in yapped, the tests pass.", "In yapped.", "Over in your app."]) {
      expect([heard, whose(heard, saying)]).toEqual([heard, "echo"])
    }
    const question = "Which one, sir: yapd or the docs site?"
    for (const heard of ["Which one, sir? Yapped.", "Which one? Yapped.", "Which one, sir? Yap, or the dock site?", "One, sir? Yapped."]) {
      expect([heard, whose(heard, question)]).toEqual([heard, "echo"])
    }
    // His own words still are his, said over it.
    expect(whose("Hold on, which PR was that?", saying)).toBe("his")
    expect(whose("Neither, start a new project.", question)).toBe("his")
  })

  test("takes the words it says around its name for its own, with its name misheard as another word, or two of its words as two others", () => {
    for (const heard of ["In Japan.", "In yacht.", "Japan, the."]) {
      expect([heard, whose(heard, "In yapd, the tests pass now")]).toEqual([heard, "echo"])
    }
    for (const heard of ["Of Erin yapped.", "Of her in yapped.", "Over in Rennie app tests.", "In Rennie app tests."]) {
      expect([heard, whose(heard, saying)]).toEqual([heard, "echo"])
    }
  })

  test("takes a word beside its words for its name misheard only when it sounds like it, never a word of his like \"Deploy\" in \"Deploy it.\"", () => {
    for (const heard of ["Deploy it.", "Retry it.", "Fix it.", "Kill it.", "Is it done?"]) {
      expect([heard, whose(heard, "the build is green. It wants to know whether to")]).toEqual([heard, "his"])
    }
    expect(whose("The other one.", "Over in rig, the migration is still running")).toBe("his")
    expect(whose("Over in production.", saying)).toBe("his")
    // As Whisper writes its name, said as it is.
    expect(whose("Rick, it.", "the migration on rig, it wants")).toBe("echo")
  })

  test("takes its own voice for its own with its name written as two words or misheard, or a word of its put another way", () => {
    for (const [heard, line] of [
      ["Over in your app, the tests pass now.", "Over in yapd, the tests pass now and the"],
      ["Over in your app, the tests", "Over in yapd, the tests pass now and the"],
      ["Over in Rennie app, the tests pass.", "Over in yapd, the tests pass now and the"],
      ["Codex failed on your app, the build broke.", "Codex failed on yapd, the build broke on the main branch"],
      ["Over in home lab, Claude finished the migration.", "Over in homelab, Claude finished the migration and the tests"],
      ["Over in back end, the tests pass.", "Over in backend, the tests pass now and the pull request"],
      ["Over in note book, the tests pass.", "Over in notebook, the tests pass now and the pull request"],
      ["Over in tea three code, Codex fixed the flaky login test.", "Over in t3code, Codex fixed the flaky login test and pushed"],
      ["Rick, the migration finished.", "Over in rig, the migration finished and the build is green"],
      ["Kodak's fixed the failing login test.", "Codex fixed the failing login test and pushed the branch, sir"],
      ["So the test is passed now.", "Over in yapd, the tests pass now and the"],
      ["The tests are passing now.", "Over in yapd, the tests pass now and the"],
    ] as const) {
      expect([heard, whose(heard, line)]).toEqual([heard, "echo"])
    }
    // Words of his in its name's place, which don't sound like it.
    expect(whose("Fix the tests.", "Over in yapd, the tests pass now and the")).toBe("mixed")
    expect(whose("Over in production, merge it.", "Over in yapd, the tests pass now and the")).toBe("his")
    expect(whose("The tests are not passing now.", "Over in yapd, the tests pass now and the")).toBe("mixed")
  })

  test("takes what yapd was saying for its own voice, misheard or not, even with a word misheard as its voice stops getting in", () => {
    expect(whose("Over in yapd, the tests pass.", saying)).toBe("echo")
    expect(whose("Over in yap D, the test pass.", saying)).toBe("echo")
    expect(whose("Codecs finished the migrations.", "Codex finished the migration and")).toBe("echo")
    expect(whose("Over and yeah the test past.", `${saying} and the pull request`)).toBe("echo")
    expect(whose("Codecs. Yap.", "Codex on yapd")).toBe("echo")
    expect(whose("Over in yapd, the tests pass. Now in the pool.", `${saying} and the pull request is ready`)).toBe("echo")
    // Whisper says a word again on noise.
    expect(whose("Over in yapd yapd, the tests pass.", saying)).toBe("echo")
  })

  test("takes a stop yapd was saying for its own voice, even cut off partway through a longer word", () => {
    expect(whose("Stop.", "I'll stop the tests now")).toBe("echo")
    expect(whose("Next.", "The tests pass. Next, I'll open")).toBe("echo")
    expect(whose("Stop.", "Codex on yapd stopped after the tests failed, sir.")).toBe("echo")
    expect(whose("Codex on yapd stop.", "Codex on yapd stopped after the tests failed, sir.")).toBe("echo")
    expect(whose("It's still wait", "The pull request is open and it's still waiting on CI.")).toBe("echo")
    expect(whose("The agent skip", "The agent skipped the flaky test and pushed.")).toBe("echo")
    expect(whose("Codex is stop", "Codex is stopping the server.")).toBe("echo")
  })

  test("takes words of the user's own for him, however common, and a word on its own, like \"Yes.\"", () => {
    const line = "Codex finished the migration on yapd and all the tests pass now. Do you want me to open the pull request?"
    for (const heard of ["Not now.", "What did you do?", "Do it.", "Merge it.", "Yes.", "Yeah.", "No.", "Docs."]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
    }
    // His, though a common word of it is one of yapd's too, even its first.
    expect(whose("So, tell it to run the migration again.", `${saying} and the pull request is ready for review, so I can merge it`)).toBe("his")
    expect(whose("In production, merge it.", saying)).toBe("his")
    expect(whose("Yes.", "Send it again?")).toBe("his")
    // Once yapd has stopped talking, none of it can be its voice, but what Whisper makes up still is nobody's.
    expect(whose("Docs.", "")).toBe("his")
    expect(whose("Thank you.", "")).toBe("echo")
  })

  test("takes everyday words of his for his, unless they're what yapd is saying, in order, or what Whisper makes up", () => {
    const line = "Codex on yapd finished the migration, and all the tests pass"
    for (const heard of [
      "How did that go?", "Who is it?", "Where is it?", "Can you do it now?", "What did it do?", "Is that all?", "Who did that?", "Don't.", "Got it.",
      "Good.", "Why did it do that?", "What was that about?",
    ]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
    }
    const question = "Shall I merge the pull request, sir?"
    for (const heard of ["Don't do it.", "Go for it.", "Don't."]) {
      expect([heard, whose(heard, question)]).toEqual([heard, "his"])
    }
    // A word of its, and words of his it isn't saying, "don't" above all, which turns what it says around.
    expect(whose("Don't merge it.", question)).toBe("mixed")
    expect(whose("The tests don't pass.", saying)).toBe("mixed")
    // Its own, with a common word Whisper puts in among its words.
    expect(whose("And all the", line)).toBe("echo")
    expect(whose("Over in yapd and the tests pass.", saying)).toBe("echo")
  })

  test("takes a sentence of his for his, though it has a word or a phrase of what Whisper makes up in it", () => {
    const line = "Codex finished the migration on yapd and all the tests pass now. Do you want me to open the pull request?"
    for (const heard of ["Post it in the release channel.", "Pause the video.", "Is it watching the files?", "Turn the music down.", "Excuse me, what did it do?"]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
    }
    const long = `${saying} and the pull request is ready for review, so I can merge it`
    for (const heard of ["Merge it, then post in the channel.", "I'm sorry, don't merge it."]) {
      expect([heard, whose(heard, long)]).toEqual([heard, "mixed"])
    }
  })

  test("takes a stop or a wait yapd isn't saying for him, wherever it comes in what he says", () => {
    const line = "Codex finished the migration on yapd and all the tests pass now. Do you want me to open the pull request?"
    for (const heard of ["Hold on.", "Hold on, which tests?", "Wait, did it run the integration tests?"]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
    }
    const long = `${saying} and the pull request is ready`
    for (const heard of ["Stop.", "Thank you. Wait.", "Hold on, which PR was that?", "Wait, which pull request?"]) {
      expect([heard, whose(heard, long)]).toEqual([heard, "his"])
    }
    expect(whose("Tell it to stop the migration.", "Claude is still running the migration, sir.")).toBe("his")
    // Its longer word starts the same, but with more after it, it wasn't cut off there.
    expect(whose("Stop it.", "Codex stopped the server")).toBe("his")
    expect(whose("Wait, merge it.", "Codex is waiting on your approval")).toBe("his")
  })

  test("takes a stop or a wait yapd isn't saying, with nothing but its own voice before it or after, for some of each", () => {
    const long = `${saying} and the pull request is ready`
    for (const heard of [
      "Over in yapd, the tests pass. Stop.", "Over in yapd. Not now.", "Over in yapped. Not now.", "Over in yapd. No, wait.",
      "Over in yapd, the tests skip this one.", "Over in yapd, the tests pass. Hold on, which PR was that?", "Tell it to wait. in yapd, the tests",
      "Stop. in yapd, the tests",
    ]) {
      expect([heard, whose(heard, long)]).toEqual([heard, "mixed"])
    }
    expect(whose("Over in t3code, wait a second.", "Over in t3code, Codex fixed the flaky login test and pushed the branch, sir.")).toBe("mixed")
    expect(whose("yapd's tests, hold on.", "yapd's tests are failing on the main branch")).toBe("mixed")
  })

  test("takes what Whisper makes up of everyday words over yapd's for its own voice, unless it's said just so", () => {
    const line = "Codex on yapd finished the migration, and all the tests pass"
    for (const heard of [
      "I'm going to go.", "Let's go.", "I'm sorry.", "I don't know.", "That's it.", "That's all.", "Come on.", "Here we go.",
      "I'll see you in the next one.", "See you guys.", "Thank you for your attention.", "I'll be right back.", "Have a nice day.",
      "Take care.", "Good luck.", "Welcome back.",
    ]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "echo"])
    }
    for (const heard of ["Not now.", "Do it.", "What did you do?", "Which one?", "Go on."]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
    }
  })

  test("takes words of his with words of its that tell its voice for some of each", () => {
    const long = `${saying} and the pull request is ready`
    for (const heard of [
      "Over in yapd. Don't merge it until the review is done.", "Over in yapd, the tests pass now open a PR", "Over in yapd, the tests pass now which PR",
      "Over in Japan, tell it to open a PR.", "Over in your app. Don't merge it.", "Tests pass, flaky build.", "The tests are flaky.",
    ]) {
      expect([heard, whose(heard, long)]).toEqual([heard, "mixed"])
    }
    expect(whose("Close the pull request.", "Codex opened the pull request, sir.")).toBe("mixed")
    expect(whose("Send it again? Yes.", "Send it again?")).toBe("mixed")
    expect(whose("Over in t3code, what failed?", "Over in t3code, Codex fixed the flaky login test and pushed the branch, sir.")).toBe("mixed")
    // Its words, then one of his where its next word would be, unlike it.
    for (const heard of ["The tests failed.", "The tests broke.", "Is the pull request merged?"]) {
      expect([heard, whose(heard, long)]).toEqual([heard, "mixed"])
    }
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
 * Lines with yapd's own voice getting into the microphone over their first
 * second, with its name misheard, as Whisper writes it, and how many frames
 * of it: heard as another word, and with two of its words heard as two others
 * or the rest heard as a sentence of its own, which may look like his.
 */
const misheard: ReadonlyArray<readonly [string, string, number]> = [
  [long.spoken.replace("Over in", "In"), "In Japan.", 12],
  [long.spoken, "Of Erin yapped. The tests pass now.", 30],
  [long.spoken, "Over in yapd, the tests pass. Now in the pool.", 40],
]

/**
 * Reads `long` out over the helper protocol, or what `spoken` says instead,
 * with a fake helper that starts a new voice processor for the first line, as
 * after yapd has rested, and says how far a line got when it's stopped by the
 * clock. The test talks into its microphone with frames whose value is how
 * likely each is speech, and the fake Whisper hears in what it's given the
 * words `words` has for each value, in the order they're said, or what
 * `whole` has for all of its values together, as when it hears a word the
 * test cut in two whole, taking `delays` seconds over the first few, or fails
 * with `failing`. What's said is taken as `intent`, which is to pass it on
 * unless it says otherwise, and what yapd says back is kept in `rendered`.
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
    /** Whether the clock moves on as frames come in, as it does live, rather than only when told to. */
    readonly live?: boolean
    /** How long working out what to do about what's said takes, in seconds, as a model call does: at once unless said. */
    readonly responding?: number
  } = {},
) =>
  Effect.gen(function* () {
    const runSync = Runtime.runSync(yield* Effect.runtime<never>())
    const commands: Array<string> = []
    /** Where each line was played from, in seconds. */
    const plays: Array<number> = []
    const transcribed: Array<string> = []
    const sent: Array<string> = []
    /** What yapd says back, like asking him to say it again, in order. */
    const rendered: Array<string> = []
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
          return Effect.sleep(`${options.responding ?? 0} seconds`).pipe(
            Effect.as({ intent, spoken: intent === "send" ? "Okay." : "", message: intent === "send" ? heard : "" }),
          )
        },
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
      rendered,
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

  test("stops for the user talking on past them about a second in, rather than once he's finished, and passes on all he said as Whisper heard it whole", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
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
  test("stops about a second into what the user runs on from its own voice, and asks him to say it again, rather than take any of it in", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.95, "Which PR was that?"], [0.96, "Which PR was that?"]])
        yield* helper.wait(1)
        yield* helper.talk(0.8, 20)
        yield* helper.wait(2.2)
        // He starts before Silero has heard the end of yapd's voice.
        yield* helper.talk(0, 5)
        yield* helper.talk(0.95, 10)
        const early = [...helper.commands]
        yield* helper.talk(0.95, 15)
        const later = [...helper.commands]
        yield* helper.talk(0.95, 10)
        yield* helper.quiet
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.96, 20)
        yield* helper.quiet
        return { early, later, before, commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.early).toEqual(["play"])
    // About a second into what he said, then asked to say it again.
    expect(result.later).toEqual(["play", "stop"])
    expect(result.commands.slice(0, 3)).toEqual(["play", "stop", "play"])
    expect(result.rendered[0]).toBe(Persona.plain.misheard)
    expect(result.before).toEqual([])
    expect(result.sent).toEqual(["Which PR was that?"])
    expect(result.replies).toEqual(["Which PR was that?"])
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

  test("lets go of all sorts of what Whisper makes up", async () => {
    const madeUp = [
      "Okay.", "Mm-hmm.", "Thank you, bye.", "I'll see you next time.", "Thank you so much for watching.", "Let's go.", "I'm going to go.",
      "I'll see you in the next one.",
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

  test("doesn't take a question's own words getting through for an answer, but takes his once it's asked", async () => {
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
        yield* helper.quiet
        const echoed = [...answers]
        yield* helper.wait(1)
        yield* helper.finish
        yield* helper.talk(0.9, 30)
        yield* helper.quiet
        return { echoed, answered: yield* Fiber.join(asking), answers, transcribed: helper.transcribed }
      }),
    )
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

  test("asks the user to say it all again when what's made out with what he said turns out its voice, rather than drop any of it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes three seconds over what he said, while its voice gets in again.
        const helper = yield* overHelper([[0.9, "Hold on."], [0.8, "the tests pass now and the pull request"], [0.91, "Hold on."]], { delays: [3] })
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
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, before, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      stopped: ["play", "stop"],
      before: [],
      rendered: [Persona.plain.misheard, "Okay."],
      sent: ["Hold on."],
      replies: ["Hold on."],
    })
  })

  test("asks the user to say it all again when the rest of what he says, after a pause, lines up with its words while the first is still being made out", async () => {
    const said = "Tell it to stop the migration."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes two seconds over the first part.
        const helper = yield* overHelper([[0.9, "Tell it to stop."], [0.8, "The migration."], [0.91, said]], {
          delays: [2],
          spoken: "Over in rig, the migration is still running and the build is green. It wants to know whether to deploy, sir.",
        })
        yield* helper.wait(0.8)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 12)
        yield* helper.quiet
        yield* helper.wait(2)
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, commands: helper.commands.slice(0, 3), rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      before: [],
      commands: ["play", "stop", "play"],
      rendered: [Persona.plain.misheard, "Okay."],
      sent: [said],
      replies: [said],
    })
  })

  test("lets go of its voice still coming in just after it stops for him, rather than adding it to what he said while it works out what to do", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Working out what to do takes two seconds, as a model call does.
        const helper = yield* overHelper([[0.9, "Tell it to open a PR."], [0.8, "the tests pass now"]], { responding: 2 })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        const stopped = [...helper.commands]
        // The last of its voice, still coming in once it has stopped.
        yield* helper.talk(0.8, 6)
        yield* helper.quiet
        yield* helper.wait(3)
        return { stopped, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], sent: ["Tell it to open a PR."], replies: ["Tell it to open a PR."] })
  })

  test("asks the user to say it all again when what he adds while it works out what to do runs on from the last of its voice", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper(
          [[0.9, "Tell it to open a PR."], [0.8, "the tests pass now"], [0.91, "and merge it"], [0.92, "Tell it to open a PR and merge it."]],
          { responding: 2 },
        )
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        // The last of its voice, still coming in once it has stopped, and what he carries on with straight after.
        yield* helper.talk(0.8, 6)
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.92, 20)
        yield* helper.quiet
        yield* helper.wait(3)
        return { before, commands: helper.commands.slice(0, 3), rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      before: [],
      commands: ["play", "stop", "play"],
      rendered: [Persona.plain.misheard, "Okay."],
      sent: ["Tell it to open a PR and merge it."],
      replies: ["Tell it to open a PR and merge it."],
    })
  })
  test("doesn't stop for a word of its own cut off partway by a look at what's been said so far, like the \"stop\" of \"stopped\"", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Codex on yapd stop"], [0.81, "ped after the tests failed."]], {
          spoken: "Codex on yapd stopped after the tests failed, sir. It says the database migration needs your approval before it can carry on.",
          whole: [[0.8, 0.81], "Codex on yapd stopped after the tests failed."],
          live: true,
        })
        yield* helper.wait(0.3)
        // A look about a second in, partway through "stopped".
        yield* helper.talk(0.8, 36)
        yield* helper.talk(0.81, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      commands: ["play"],
      transcribed: ["Codex on yapd stop", "Codex on yapd stopped after the tests failed."],
      sent: [],
      replies: [],
    })
  })
  test("passes on all the user says across the end of them, made out whole, with a \"hold on\" of his in it, though some of it is yapd's words", async () => {
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

  test("passes on all the user says across the end of them, though Whisper takes a while to make it out", async () => {
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

  test("makes out what the user says across the end of them whole, as Whisper hears it", async () => {
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
    expect(result).toEqual({ commands: ["play", "stop"], transcribed: ["Not now."], sent: ["Not now."], replies: ["Not now."] })
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

  test("doesn't add its own voice, paused as what the user said before is made out to be his, to what he said, but asks him to say it again", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on."], [0.8, "the tests pass now and the pull request"], [0.91, "Hold on."]], { delays: [3] })
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.talk(0.8, 10)
        yield* helper.talk(0, 5)
        yield* helper.wait(2)
        const stopped = [...helper.commands]
        yield* helper.quiet
        yield* helper.wait(1)
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, before, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], before: [], sent: ["Hold on."], replies: ["Hold on."] })
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

  test("doesn't stop for its own voice with its name misheard, though the rest is heard as words of their own or a sentence of its own, nor send or note it", async () => {
    for (const [spoken, heard, frames] of misheard) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, heard]], { spoken, live: true })
          yield* helper.wait(0.3)
          yield* helper.talk(0.8, frames)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([heard, result]).toEqual([heard, { commands: ["play"], sent: [], replies: [] }])
    }
  }, 30_000)

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

  test("stops for a stop of the user's run straight on from its own voice, and asks him to say it again, rather than pass on its words with his", async () => {
    const said = "Hold on, which PR was that?"
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, said], [0.91, said]])
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, commands: helper.commands.slice(0, 3), rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ before: [], commands: ["play", "stop", "play"], rendered: [Persona.plain.misheard, "Okay."], sent: [said], replies: [said] })
  })
  test("stops for a few words the user talks straight on from its own voice with, in the same sentence, and asks him to say them again", async () => {
    for (const said of ["open a PR", "which PR"]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          // Whisper runs what he says on from its voice, without a full stop between.
          const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass now"], [0.9, said], [0.91, said]], { live: true })
          yield* helper.talk(0.8, 30)
          yield* helper.talk(0.9, 20)
          yield* helper.quiet
          yield* helper.wait(1)
          // Long enough for it to ask him once he's finished.
          yield* helper.wait(2)
          const before = [...helper.sent]
          yield* helper.finish
          yield* helper.talk(0.91, 20)
          yield* helper.quiet
          yield* helper.wait(1)
          return { before, commands: helper.commands.slice(0, 3), sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { before: [], commands: ["play", "stop", "play"], sent: [said], replies: [said] }])
    }
  }, 30_000)
  test("stops for the user's question about what it just said, and passes it on whole, though it ends in its words", async () => {
    // Made out once he's done, and, talking on, partway through and again once he's done.
    for (const [at, said, frames] of [[1, "Wait, which pull request?", 20], [0.8, "Hold on, what about the tests?", 20], [0.5, "Hold on a second, what about the tests?", 45]] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said]], { live: true })
          yield* helper.wait(at)
          yield* helper.talk(0.9, frames)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands.slice(0, 2), sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { commands: ["play", "stop"], sent: [said], replies: [said] }])
    }
  }, 30_000)

  test("stops for a stop of the user's that its own voice runs on into, and asks him to say it again, rather than pass on its words with his", async () => {
    for (const said of ["Stop.", "Tell it to wait."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said], [0.8, "in yapd, the tests"], [0.91, said]])
          yield* helper.wait(0.3)
          yield* helper.talk(0.9, 12)
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          // Long enough for it to ask him once he's finished.
          yield* helper.wait(2)
          const before = [...helper.sent]
          yield* helper.finish
          yield* helper.talk(0.91, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          return { before, commands: helper.commands.slice(0, 3), rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([
        said,
        { before: [], commands: ["play", "stop", "play"], rendered: [Persona.plain.misheard, "Okay."], sent: [said], replies: [said] },
      ])
    }
  })
  test("stops for the user about a second in though its own voice runs on after him, and asks him to say it again, a stop of his and all", async () => {
    for (const said of ["Skip this one.", "Which PR was that?"]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said], [0.8, "in yapd, the tests pass now"], [0.91, said]])
          yield* helper.wait(0.3)
          yield* helper.talk(0.9, 15)
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 25)
          const early = [...helper.commands]
          yield* helper.talk(0.8, 15)
          yield* helper.wait(1)
          yield* helper.quiet
          yield* helper.wait(1)
          // Long enough for it to ask him once he's finished.
          yield* helper.wait(2)
          const before = [...helper.sent]
          yield* helper.finish
          yield* helper.talk(0.91, 15)
          yield* helper.quiet
          yield* helper.wait(1)
          return { early, before, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([
        said,
        { early: ["play", "stop"], before: [], rendered: [Persona.plain.misheard, "Okay."], sent: [said], replies: [said] },
      ])
    }
  })
  test("keeps the word that only fills a pause he starts with over them, when he talks on past them, as all of it is made out whole", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Begun just before its voice stops getting in, and gone on with past that.
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

  test("asks the user to say his answer again when it runs on from the last of its question's voice, and takes that", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.8, "Which one, sir: yapd or the docs"], [0.82, "site?"], [0.9, "Yapd."], [0.91, "Yapd."]], { duration: 3 })
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
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...answers]
        yield* helper.finish
        yield* helper.talk(0.91, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ before: [], rendered: [Persona.plain.misheard], answered: true, answers: ["Yapd."] })
  })
  test("takes a quick yes to a short question it asked over them, said as its voice fades, just as he said it", async () => {
    for (const said of ["Yes.", "Yeah.", "Yes, please."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const answers: Array<string> = []
          const helper = yield* overHelper([[0.9, said]], { duration: 1.2 })
          yield* Fiber.interrupt(helper.fiber)
          const asking = yield* Effect.fork(
            helper.ask({
              audio: "/tmp/question.wav",
              spoken: "Send it again?",
              answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
            }),
          )
          // Over the last of it, and on past its end.
          yield* helper.wait(1)
          yield* helper.talk(0.9, 6)
          yield* helper.wait(0.2)
          yield* helper.finish
          yield* helper.talk(0.9, 6)
          yield* helper.quiet
          yield* helper.wait(1)
          return { rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
        }),
      )
      expect([said, result]).toEqual([said, { rendered: [], answered: true, answers: [said] }])
    }
  }, 30_000)

  test("asks the user to say his yes again when it runs on from the last of a short question's voice, and takes that", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.8, "Send it"], [0.82, "again?"], [0.9, "Yes."], [0.91, "Yes."]], { duration: 1.2 })
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Send it again?",
            answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(0.2)
        yield* helper.talk(0.8, 20)
        yield* helper.wait(1)
        yield* helper.finish
        // The last of its voice, then him a moment later, before Silero has heard the end of it.
        yield* helper.talk(0.82, 3)
        yield* helper.talk(0, 6)
        yield* helper.talk(0.9, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...answers]
        yield* helper.finish
        yield* helper.talk(0.91, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ before: [], rendered: [Persona.plain.misheard], answered: true, answers: ["Yes."] })
  })
  test("asks the user to say his reply again when it runs on from the last of a short line's voice, and passes that on", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Codex opened the"], [0.82, "pull request."], [0.9, "Merge"], [0.91, "it."], [0.92, "Merge it."]], {
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
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.92, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ before: [], sent: ["Merge it."], replies: ["Merge it."] })
  })
  test("asks the user to say his answer again when it's one of the question's last words, begun over them and gone on past its voice, and takes that", async () => {
    for (const said of ["The docs site.", "Yapd."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const answers: Array<string> = []
          const helper = yield* overHelper([[0.9, said], [0.91, said]], { duration: 3 })
          yield* Fiber.interrupt(helper.fiber)
          const asking = yield* Effect.fork(
            helper.ask({
              audio: "/tmp/question.wav",
              spoken: "Which one, sir: yapd or the docs site?",
              answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
            }),
          )
          // Begun as it ends, and gone on past the last of its voice.
          yield* helper.wait(2.8)
          yield* helper.talk(0.9, 6)
          yield* helper.finish
          yield* helper.talk(0.9, 22)
          yield* helper.quiet
          yield* helper.wait(1)
          // Long enough for it to ask him once he's finished.
          yield* helper.wait(2)
          const before = [...answers]
          yield* helper.finish
          yield* helper.talk(0.91, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          return { before, rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
        }),
      )
      expect([said, result]).toEqual([said, { before: [], rendered: [Persona.plain.misheard], answered: true, answers: [said] }])
    }
  }, 30_000)

  test("asks the user to say it all again when what he adds after it stopped for him lines up with its words but goes on past its voice", async () => {
    const said = "Tell it to stop the migration."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to stop."], [0.8, "The migration."], [0.91, said]], {
          live: true,
          spoken: "Over in rig, the migration is still running and the build is green. It wants to know whether to deploy, sir.",
          responding: 2,
        })
        yield* helper.wait(0.8)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        const stopped = [...helper.commands]
        // Begun as the last of its voice comes in, and gone on past it.
        yield* helper.talk(0.8, 25)
        yield* helper.quiet
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...helper.sent]
        yield* helper.finish
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(3)
        return { stopped, before, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], before: [], rendered: [Persona.plain.misheard, "Okay."], sent: [said], replies: [said] })
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

  test("doesn't stop for a word of its own cut off by a look and heard as a stop, though no word it says starts like one", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const spoken = "Codex is resizing the storage volume for the database now, sir, and then it will restart the server once that's done."
        // "Storage", cut off partway by a look, then heard whole.
        const helper = yield* overHelper([[0.8, "Codex is resizing the stop"], [0.81, "rage volume for the database."]], {
          spoken,
          whole: [[0.8, 0.81], "Codex is resizing the storage volume for the database."],
        })
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 36)
        yield* helper.wait(1.1)
        yield* helper.talk(0.81, 20)
        yield* helper.wait(0.6)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], sent: [], replies: [] })
  })

  test("asks the user to say it again when his words run on from its own voice, and passes on what he says then whole, never what was left of the first", async () => {
    const said = "Don't merge it until the review is done."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd."], [0.9, said], [0.91, said]], { live: true })
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 12)
        yield* helper.talk(0.9, 40)
        yield* helper.quiet
        yield* helper.wait(1)
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], sent: [...helper.sent], replies: [...(yield* helper.replies)] }
        yield* helper.finish
        yield* helper.talk(0.91, 40)
        yield* helper.quiet
        yield* helper.wait(1)
        return { asked, transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    // Stopped about a second in, then asked to say it again, with nothing taken in meanwhile.
    expect(result.asked).toEqual({ commands: ["play", "stop", "play"], rendered: [Persona.plain.misheard], sent: [], replies: [] })
    expect(result.transcribed.at(-2)).toBe(`Over in yapd. ${said}`)
    expect(result.transcribed.at(-1)).toBe(said)
    expect(result.sent).toEqual([said])
    expect(result.replies).toEqual([said])
  })

  test("waits for the user to finish before asking him to say it again, taking nothing he goes on with after a pause for what he says again", async () => {
    for (const [first, pause, rest] of [
      ["Don't merge it", 0.3, "until the review is done."],
      ["Don't merge it until the review is done.", 0.6, "And ping me when it's green."],
    ] as const) {
      const again = `${first} ${rest}`
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, "Over in yapd."], [0.9, first], [0.91, rest], [0.92, again]], { live: true })
          yield* helper.wait(0.3)
          yield* helper.talk(0.8, 12)
          yield* helper.talk(0.9, 30)
          yield* helper.quiet
          yield* helper.wait(pause)
          yield* helper.talk(0.91, 30)
          yield* helper.quiet
          const asking = [...helper.commands]
          yield* helper.wait(2)
          const asked = { commands: [...helper.commands], sent: [...helper.sent] }
          yield* helper.finish
          yield* helper.talk(0.92, 50)
          yield* helper.quiet
          yield* helper.wait(1)
          return { asking, asked, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      // Not asked over what he went on with, nor while he might still go on, and nothing taken in till he says it again.
      expect([first, result]).toEqual([
        first,
        {
          asking: ["play", "stop"],
          asked: { commands: ["play", "stop", "play"], sent: [] },
          rendered: [Persona.plain.misheard, "Okay."],
          sent: [again],
          replies: [again],
        },
      ])
    }
  }, 30_000)

  test("asks the user to say it again once more when he goes on with what he was saying just as it asks, rather than take that for all he said", async () => {
    const said = "Tell it to open the pull request."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Tell it to open"], [0.95, "the pull request."], [0.96, said]])
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        // Just as it starts asking, too soon for him to have heard it.
        yield* helper.wait(1.6)
        yield* helper.talk(0.95, 15)
        yield* helper.quiet
        const before = [...helper.sent]
        yield* helper.wait(2)
        yield* helper.finish
        yield* helper.talk(0.96, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, commands: helper.commands.slice(0, 5), rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      before: [],
      commands: ["play", "stop", "play", "stop", "play"],
      rendered: [Persona.plain.misheard, Persona.plain.misheard, "Okay."],
      sent: [said],
      replies: [said],
    })
  })

  test("ends a line that played to the end while what he said over it was made out, when he doesn't say it again, rather than say it twice", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes three seconds, by when the line has played to the end.
        const helper = yield* overHelper([[0.9, "Codex is done. Merge it."]], { delays: [3], duration: 2, spoken: "Codex is done, sir." })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.finish
        yield* helper.wait(4)
        yield* helper.finish
        yield* helper.wait(4)
        const done = yield* Fiber.poll(helper.fiber)
        return { done: Option.isSome(done), plays: helper.plays, rendered: helper.rendered, sent: helper.sent }
      }),
    )
    // The line, then asking him to say it again, and nothing more.
    expect(result).toEqual({ done: true, plays: [0, 0], rendered: [Persona.plain.misheard], sent: [] })
  })

  test("makes out one look at a time, however long Whisper takes, and only one look at what's been said so far while it's under way", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass now and the pull request"]], { live: true, delays: [3, 3, 3, 3] })
        yield* helper.wait(0.3)
        // Long enough for a look about a second in, and another a second later.
        yield* helper.talk(0.8, 80)
        yield* helper.quiet
        const started = helper.transcribed.length
        yield* helper.wait(8)
        return { started, looks: helper.transcribed.length, commands: helper.commands, sent: helper.sent }
      }),
    )
    // The first look so far, and all of it once that's done.
    expect(result).toEqual({ started: 1, looks: 2, commands: ["play"], sent: [] })
  })

  test("doesn't take its own voice asking him to say it again for what he says again", async () => {
    const said = "Tell it to open a PR."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Lines as short as asking him is, so where its words fall in it is known.
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, said], [0.85, Persona.plain.misheard], [0.91, said]], {
          duration: 2,
          spoken: "Over in yapd, the tests pass now, sir.",
        })
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1.6)
        // Its voice asking him gets into the microphone, which still hasn't learnt it.
        yield* helper.wait(0.2)
        yield* helper.talk(0.85, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        const asking = [...helper.commands]
        yield* helper.finish
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return { asking, rendered: helper.rendered, sent: helper.sent }
      }),
    )
    expect(result).toEqual({ asking: ["play", "stop", "play"], rendered: [Persona.plain.misheard, "Okay."], sent: [said] })
  })

  test("picks up from before where the user began, not before what Whisper made up of its voice, when what's made out together wasn't meant for it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes three seconds over what it makes up.
        const helper = yield* overHelper([[0.8, "Thank you."], [0.9, "Hold on, merge it."]], { intent: "resume", delays: [3] })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(1.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(2)
        return { plays: helper.plays, sent: helper.sent }
      }),
    )
    // A second and a half before he began, two seconds in.
    expect(result).toEqual({ plays: [0, 0.5], sent: [] })
  })

  test("picks up from before where the user began when he doesn't say it again, having taken in nothing", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Tell it to open a PR."]])
        yield* helper.wait(2)
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(2)
        yield* helper.finish
        // Long enough for him to have said it again.
        yield* helper.wait(4)
        return { commands: helper.commands, plays: helper.plays, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.commands.slice(0, 4)).toEqual(["play", "stop", "play", "play"])
    // The update again, a second and a half before he began, two seconds in.
    expect(result.plays).toEqual([0, 0, 0.5])
    expect(result).toMatchObject({ sent: [], replies: [] })
  })

  test("picks up from before where the user began when what it stopped for a second in turns out all its own voice once it's made out whole", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // A look partway hears a word of his, which Whisper hears as its own once it has all of it.
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.81, "Merge it now"], [0.82, "and the"]], {
          whole: [[0.8, 0.81, 0.82], "Over in yapd, the tests pass now and the pull request."],
          live: true,
        })
        yield* helper.wait(1)
        yield* helper.talk(0.8, 30)
        yield* helper.talk(0.81, 10)
        const stopped = [...helper.commands]
        yield* helper.talk(0.82, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, commands: helper.commands, plays: helper.plays, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.stopped).toEqual(["play", "stop"])
    // Again from a second and a half before he began, with nothing asked or taken in.
    expect(result).toMatchObject({ commands: ["play", "stop", "play"], plays: [0, 0], rendered: [], sent: [], replies: [] })
  })

  test("passes on what the user starts saying as it stops, whole, though it ends in its words, like \"Tell it to stop the migration.\"", async () => {
    const said = "Tell it to stop the migration."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.91, "Tell it to"], [0.92, "stop the migration."]], {
          live: true,
          duration: 2.5,
          spoken: "Claude is still running the migration, sir.",
          whole: [[0.91, 0.92], said],
        })
        yield* helper.wait(2)
        yield* helper.talk(0.91, 16)
        yield* helper.finish
        yield* helper.talk(0.92, 30)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands.slice(0, 1), rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], rendered: ["Okay."], sent: [said], replies: [said] })
  })

  test("stops for a stop or a wait over them, and acts on just what was said", async () => {
    for (const said of ["Stop.", "Hold on."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said]], { intent: said === "Stop." ? "dismiss" : "send", live: true })
          yield* helper.wait(0.8)
          yield* helper.talk(0.9, 10)
          yield* helper.quiet
          yield* helper.wait(1)
          const exit = yield* Fiber.poll(helper.fiber)
          return { commands: helper.commands.slice(0, 2), done: Option.isSome(exit), sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      // A stop ends the update, and a wait is passed on as it's taken.
      expect([said, result]).toEqual([
        said,
        { commands: ["play", "stop"], done: said === "Stop.", sent: said === "Stop." ? [] : [said], replies: [said] },
      ])
    }
  }, 30_000)

  test("stops for everyday words of his over them, and passes them on as he said them, though they're only words nearly anything has", async () => {
    for (const said of ["Why did it do that?", "Don't do it."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said]], { live: true })
          yield* helper.wait(1)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands.slice(0, 2), sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { commands: ["play", "stop"], sent: [said], replies: [said] }])
    }
  }, 30_000)

  test("stops for a word of his beside its words over them, and passes it on, rather than take it for its name misheard", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Deploy it."]], { live: true, spoken: "The build is green. It wants to know whether to deploy, sir." })
        yield* helper.wait(1.8)
        yield* helper.talk(0.9, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands.slice(0, 2), sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], sent: ["Deploy it."], replies: ["Deploy it."] })
  })

  test("doesn't stop for its own voice with its name written as two words, as a look at it about a second in sees it, nor ask him anything", async () => {
    for (const [spoken, soFar, rest] of [
      [long.spoken, "Over in your app, the tests", "pass now."],
      ["Over in homelab, Claude finished the migration and the tests pass, sir. Shall I open the pull request?", "Over in home lab, Claude finished", "the migration."],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, soFar], [0.81, rest]], { live: true, spoken, whole: [[0.8, 0.81], `${soFar} ${rest}`] })
          yield* helper.wait(0.3)
          yield* helper.talk(0.8, 36)
          yield* helper.talk(0.81, 15)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands, looks: helper.transcribed.length, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([soFar, result]).toEqual([soFar, { commands: ["play"], looks: 2, rendered: [], sent: [], replies: [] }])
    }
  }, 30_000)

  test("passes on what the user says over them on either side of a pause, as he said it, like \"Don't... merge it yet.\"", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Don't..."], [0.91, "merge it yet."]], {
          live: true,
          spoken: "Over in yapd, Codex opened the pull request and the checks are all green now, sir. Shall I merge it?",
        })
        yield* helper.wait(0.3)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.talk(0, 3)
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(4)
        return { transcribed: helper.transcribed, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ transcribed: ["Don't...", "merge it yet."], sent: ["Don't merge it yet."], replies: ["Don't merge it yet."] })
  })

  test("takes a short answer of everyday words over the end of a short question it asked over them, just as he said it", async () => {
    for (const said of ["Go for it.", "Don't."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const answers: Array<string> = []
          const helper = yield* overHelper([[0.9, said]], { duration: 2.2 })
          yield* Fiber.interrupt(helper.fiber)
          const asking = yield* Effect.fork(
            helper.ask({
              audio: "/tmp/question.wav",
              spoken: "Shall I merge the pull request, sir?",
              answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
            }),
          )
          yield* helper.wait(1.8)
          yield* helper.talk(0.9, 8)
          yield* helper.finish
          yield* helper.talk(0.9, 4)
          yield* helper.quiet
          yield* helper.wait(1)
          return { rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
        }),
      )
      expect([said, result]).toEqual([said, { rendered: [], answered: true, answers: [said] }])
    }
  }, 30_000)

  test("can't ask a question without its words, which tell its own voice getting into the microphone from an answer", () => {
    // @ts-expect-error Without them, any of its voice that got through would be taken for him.
    const unspoken: Conversation.Question = { audio: "/tmp/question.wav", answer: () => Effect.succeed(Option.none()) }
    expect(unspoken.audio).toBe("/tmp/question.wav")
  })
})

describe("Answers over their first words, while yapd's own voice can still get into the microphone", () => {
  /** An answer in `spoken`'s words that takes anything but talk with Sam for a follow-up, noting in `through` each time it's said to the end. */
  const answer = (followUps: Array<string>, through: Array<string>, spoken = long.spoken): Conversation.Answer => ({
    audio: "/tmp/answer.wav",
    spoken,
    followUp: (heard) => Effect.succeed(heard.startsWith("Sam,") ? Option.none() : Option.some(Effect.sync(() => void followUps.push(heard)))),
    through: Effect.sync(() => void through.push("through")),
  })

  test("carries on over its own voice getting through, taking none of it for a follow-up, and has the answer heard once it's said to the end", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const helper = yield* overHelper([[0.8, "Over in yapped, the tests pass."]])
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const answering = yield* Effect.fork(helper.answer(answer(followUps, through)))
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        const during = helper.commands.slice(asked)
        yield* helper.wait(9)
        yield* helper.finish
        const heard = [...through]
        yield* helper.wait(3)
        return { during, heard, followed: yield* Fiber.join(answering), followUps, through, transcribed: helper.transcribed }
      }),
    )
    // Never stopped for, nor even ducked, and heard as soon as it was said to the end.
    expect(result).toEqual({
      during: ["play"],
      heard: ["through"],
      followed: false,
      followUps: [],
      through: ["through"],
      transcribed: ["Over in yapped, the tests pass."],
    })
  })

  test("carries on over its own voice with its name misheard, though the rest is heard as words of their own or a sentence of its own, taking none of it for a follow-up", async () => {
    for (const [spoken, heard, frames] of misheard) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const followUps: Array<string> = []
          const through: Array<string> = []
          const helper = yield* overHelper([[0.8, heard]], { live: true })
          yield* Fiber.interrupt(helper.fiber)
          const asked = helper.commands.length
          const answering = yield* Effect.fork(helper.answer(answer(followUps, through, spoken)))
          yield* helper.wait(0.3)
          yield* helper.talk(0.8, frames)
          yield* helper.quiet
          yield* helper.wait(1)
          const during = helper.commands.slice(asked)
          yield* helper.wait(9)
          yield* helper.finish
          yield* helper.wait(3)
          return { during, followed: yield* Fiber.join(answering), followUps, through }
        }),
      )
      expect([heard, result]).toEqual([heard, { during: ["play"], followed: false, followUps: [], through: ["through"] }])
    }
  }, 30_000)

  test("stops for a follow-up run on from its own voice over them, asks him to say it again, takes that for the follow-up, and leaves the answer unheard", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Tell it to open a PR."], [0.91, "Tell it to open a PR."]])
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const answering = yield* Effect.fork(helper.answer(answer(followUps, through)))
        yield* helper.wait(0.3)
        // His words run straight on from its own voice getting through.
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 15)
        const talking = helper.commands.slice(asked)
        yield* helper.quiet
        // Long enough for it to ask him once he's finished.
        yield* helper.wait(2)
        const before = [...followUps]
        yield* helper.finish
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        const followed = yield* Fiber.join(answering)
        // Long past where it would have been said to the end.
        yield* helper.wait(20)
        return { talking, before, commands: helper.commands.slice(asked), rendered: helper.rendered, followed, followUps, through }
      }),
    )
    // Still talking until it was made out to be him, and cut off then, so never heard to the end.
    expect(result).toEqual({
      talking: ["play"],
      before: [],
      commands: ["play", "stop", "play"],
      rendered: [Persona.plain.misheard],
      followed: true,
      followUps: ["Tell it to open a PR."],
      through: [],
    })
  })

  test("stops for a follow-up over them once Whisper has made out it's him, takes it just as he said it, and leaves the answer unheard", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const helper = yield* overHelper([[0.9, "Tell it to open a PR."]])
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const answering = yield* Effect.fork(helper.answer(answer(followUps, through)))
        yield* helper.wait(0.3)
        yield* helper.talk(0.9, 15)
        const talking = helper.commands.slice(asked)
        yield* helper.quiet
        const followed = yield* Fiber.join(answering)
        yield* helper.wait(20)
        return { talking, commands: helper.commands.slice(asked), followed, followUps, through }
      }),
    )
    expect(result).toEqual({ talking: ["play"], commands: ["play", "stop"], followed: true, followUps: ["Tell it to open a PR."], through: [] })
  })
  test("has an answer heard when it's said to the end while a follow-up over them is still being made out, and takes that once it's him", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        // Whisper takes three seconds over it, by when the answer has been said to the end.
        const helper = yield* overHelper([[0.9, "Tell it to deploy."]], { duration: 2, delays: [3] })
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const answering = yield* Effect.fork(helper.answer(answer(followUps, through, "Codex opened the pull request, sir.")))
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1.5)
        yield* helper.finish
        const heard = [...through]
        const before = [...followUps]
        yield* helper.wait(1.5)
        return { heard, before, commands: helper.commands.slice(asked), followed: yield* Fiber.join(answering), followUps, through }
      }),
    )
    expect(result).toEqual({
      heard: ["through"],
      before: [],
      commands: ["play"],
      followed: true,
      followUps: ["Tell it to deploy."],
      through: ["through"],
    })
  })

  test("can't say an answer without its words, which tell its own voice getting into the microphone from a follow-up", () => {
    // @ts-expect-error Without them, any of its voice that got through would be taken for him, and sent on as what he said.
    const unspoken: Conversation.Answer = { audio: "/tmp/answer.wav", followUp: () => Effect.succeed(Option.none()) }
    expect(unspoken.audio).toBe("/tmp/answer.wav")
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
