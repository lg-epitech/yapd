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
import { between, cut, own, together, unfinished } from "./Conversation.ts"
import { defaults } from "./Endpointer.ts"
import { Relays } from "./Relay.ts"
import * as Helper from "./Helper.ts"
import { Model, ModelError } from "./Model.ts"
import * as Responder from "./Responder.ts"
import { clean, Transcriber } from "./Transcriber.ts"
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
    /** What Whisper was told to listen for, each time it heard something. */
    const glossaries: Array<ReadonlyArray<string>> = []
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
        echo: () => Effect.succeed(false),
        rest: Effect.void,
        warm: Effect.void,
      }),
      // Each frame holds the probability that it's speech.
      Layer.succeed(Vad, { make: Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)) }),
      Layer.succeed(Transcriber, {
        transcribe: (_, terms) =>
          Effect.sync(() => {
            glossaries.push(terms ?? [])
            return transcripts.shift() ?? ""
          }),
      }),
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
      withholds: () => Effect.succeed(false),
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
    /** Asks a question instead, once the update has been given up on, which `answer` works out what's said to, with options called `terms`. */
    const question = (answer: Conversation.Question["answer"], terms?: ReadonlyArray<string>) =>
      Fiber.interrupt(fiber).pipe(
        Effect.zipRight(
          Effect.fork(made.ask({ audio: "/tmp/question.wav", spoken: "Which project is it for?", answer, ...(terms === undefined ? {} : { terms }) })),
        ),
      )
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
    return {
      ...made,
      fiber,
      heard,
      sent,
      late,
      saying,
      noted,
      speak,
      wait,
      question,
      ask,
      say,
      frames,
      disconnect: Queue.shutdown(microphone),
      replies: () => replies,
      glossaries: () => glossaries,
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

  test("an answer to a question is heard with its options as Whisper's glossary", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const { question, speak, wait, glossaries } = yield* conversation(["The ghost net one."])
        const asking = yield* question((heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))), ["Mainnet", "Ghostnet"])
        yield* wait(10)
        yield* speak
        return { answered: yield* Fiber.join(asking), answers, glossaries: glossaries() }
      }),
    )
    expect(result).toEqual({ answered: true, answers: ["The ghost net one."], glossaries: [["Mainnet", "Ghostnet"]] })
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

  test("takes nothing, or only what Whisper makes up of a voice it can't make out, for its own voice", () => {
    for (const heard of [
      "", "Thank you.", "- Verse.", "End of song.", "Thank you. Thank you.", "you you you", "Bye bye.", "Please subscribe.",
      "Thank you so much for watching.", "I'll see you next time.", "Subtitles by the Amara.org community", "Of course.", "Excuse me.",
      "Good morning.", "What the hell?", "That's it.", "I don't know.", "Take care.", "Let's go.",
    ]) {
      expect([heard, own(heard, saying)]).toEqual([heard, true])
    }
  })

  test("never takes words that only fill a pause, said on their own, for its own voice, unless it's saying them, as they may be him taking it in", () => {
    for (const heard of ["Okay, thanks.", "Okay.", "Thanks.", "Hello?", "Mm-hmm.", "Thank you, bye."]) {
      expect([heard, own(heard, saying)]).toEqual([heard, false])
    }
    expect(own("Okay.", "Okay, so the tests pass now")).toBe(true)
  })

  test("takes what yapd was saying for its own voice, misheard or not, its name and all", () => {
    for (const [heard, line] of [
      ["Over in yapd, the tests pass.", saying], ["Over in yap D, the test pass.", saying], ["Over in yapped.", saying], ["Over in Japan.", saying],
      ["Overin Yapti.", saying], ["Over in your app.", saying], ["Of Erin yapped.", saying], ["Over in Rennie app tests.", saying],
      ["Over in yapd yapd, the tests pass.", saying], ["So the test is passed now.", saying], ["over and yet.", `${saying} and the PR is ready`],
      ["Which one, sir? Yapped.", "Which one, sir: yapd or the docs site?"], ["Codecs finished the migrations.", "Codex finished the migration and"],
      ["Over in tea three code, Codex fixed the flaky login test.", "Over in t3code, Codex fixed the flaky login test and pushed"],
      ["Rick, the migration finished.", "Over in rig, the migration finished and the build is green"],
      ["Kodak's fixed the failing login test.", "Codex fixed the failing login test and pushed the branch, sir"],
      ["Over in yapd, the tests pass. Now in the pool.", `${saying} and the pull request is ready`],
      ["Codex is resizing the stop rage volume.", "Codex is resizing the storage volume for the database now"],
      // A word of its cut off, as its "stopped" heard as "stop".
      ["Stop.", "Codex on yapd stopped after the tests failed, sir."], ["Next.", "The tests pass. Next, I'll open"],
    ] as const) {
      expect([heard, own(heard, line)]).toEqual([heard, true])
    }
  })

  test("never takes what has a word of his for its own voice, however much of the rest is its words, nor a word on its own it isn't saying", () => {
    const long = `${saying} and the pull request is ready for review, so I can merge it`
    for (const [heard, line] of [
      ["Which PR was that?", `${saying} and the pull request is ready`], ["Which PR was that?", "Over in yapd, the PR was merged and the tests pass"],
      ["Tell it to revert it.", "Over in yapd, Codex reverted the migration and the tests pass"], ["Got it.", saying], ["Stop.", saying],
      ["Hold on, which PR was that?", saying], ["Over in production, merge it.", saying], ["Over in yapd. Don't merge it until the review is done.", long],
      ["The tests failed.", long], ["Fix the tests.", long], ["The tests are not passing now.", long], ["Neither, start a new project.", "Which one, sir: yapd or the docs site?"],
      ["Merge it.", "Shall I merge the pull request, sir?"], ["Yes.", "Shall I merge the pull request, sir?"], ["Deploy it.", "the build is green. It wants to know whether to"],
    ] as const) {
      expect([heard, own(heard, line)]).toEqual([heard, false])
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

/** What yapd says of `long` around its first second, as what he says over that is given to the model. */
const first = "Over in yapd, the tests pass now and the pull request is ready"

/**
 * Reads `long` out over the helper protocol, or what `spoken` says instead,
 * with a fake helper that starts a new voice processor for the first line, as
 * after yapd has rested, and says how far a line got when it's stopped by the
 * clock. The test talks into its microphone with frames whose value is how
 * likely each is speech, and the fake Whisper hears in what it's given the
 * words `words` has for each value, in the order they're said. What's said
 * is taken as `reply` has it, which is to pass it on unless it says
 * otherwise, all the model is given is kept in `responded`, and what yapd
 * says back in `rendered`. With `answer`, it says an answer of yapd's in the
 * same words instead, which takes anything said for a follow-up, kept in
 * `followed`, unless `follow` says otherwise, and all it's offered, with
 * what yapd was saying around then when it's told that, in `offered`.
 */
const overHelper = (
  words: ReadonlyArray<readonly [number, string]>,
  options: {
    readonly spoken?: string
    /** How long each line lasts, in seconds. */
    readonly duration?: number
    readonly reply?: (interruption: Responder.Interruption) => Responder.Reply
    /** Whether the clock moves on as frames come in, as it does live, rather than only when told to. */
    readonly live?: boolean
    /** How long working out what to do about what's said takes, in seconds, as a model call does: at once unless said. */
    readonly responding?: number
    readonly answer?: boolean
    /** Whether the answer takes what's said for a follow-up, as the model would. */
    readonly follow?: (heard: string, echo?: string) => boolean
  } = {},
) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const commands: Array<string> = []
    /** Each command with when it came, in seconds since the first line started playing, and the volume it asked for. */
    const timeline: Array<{ readonly type: string; readonly at: number; readonly value?: number }> = []
    /** Where each line was played from, in seconds. */
    const plays: Array<number> = []
    const transcribed: Array<string> = []
    const sent: Array<string> = []
    /** All a reply was worked out from, in order. */
    const responded: Array<Responder.Interruption> = []
    /** What yapd says back, in order. */
    const rendered: Array<string> = []
    const followed: Array<string> = []
    const offered: Array<{ readonly heard: string; readonly echo?: string }> = []
    let first: number | undefined
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
                    readonly value?: number
                  }
                  commands.push(command.type)
                  if (command.type === "play") first ??= now()
                  timeline.push({ type: command.type, at: (now() - (first ?? now())) / 1000, ...(command.value === undefined ? {} : { value: command.value }) })
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
      }),
      Layer.succeed(Responder.Responder, {
        respond: (interruption) =>
          Effect.sync(() => void responded.push(interruption)).pipe(
            Effect.zipRight(Effect.sleep(`${options.responding ?? 0} seconds`)),
            Effect.as(options.reply?.(interruption) ?? { intent: "send" as const, spoken: "Okay.", message: interruption.heard }),
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
    const spoken = options.spoken ?? long.spoken
    const fiber = yield* Effect.fork(
      options.answer === true
        ? made.answer({
            audio: "/tmp/answer.wav",
            spoken,
            followUp: (heard, _, echo) =>
              Effect.sync(() => {
                offered.push({ heard, ...(echo === undefined ? {} : { echo }) })
                return (options.follow?.(heard, echo) ?? true) ? Option.some(Effect.sync(() => void followed.push(heard))) : Option.none()
              }),
          })
        : Effect.as(made.converse({ ...long, spoken }), false),
    )
    yield* flush
    yield* flush
    return {
      fiber,
      commands,
      timeline,
      plays,
      transcribed,
      sent,
      responded,
      rendered,
      followed,
      offered,
      talk,
      quiet: talk(0, defaults.silence),
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
      finish: Effect.sync(() => {
        if (playing !== undefined) send({ type: "finished", id: playing.id })
        playing = undefined
      }).pipe(Effect.zipRight(flush)),
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

/** Seconds, to the millisecond, as the clock tells them. */
const seconds = (value: number) => Math.round(value * 1000) / 1000

/** What yapd says back to what's said over its first seconds that the model takes for a question. */
const answered = "The one for the loader, sir."

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
          return { ducked, stopped, responded: helper.responded.map(({ heard }) => heard) }
        }),
      )
    // Two frames more over its first seconds, as its own voice ducked often stops being speech by then, and his never does.
    for (const [at, needed] of [[0.3, defaults.wary], [1, defaults.wary], [4, defaults.confirm]] as const) {
      const result = await over(at, needed)
      // Turned down with the first frame of his voice, and stopped with the frame that makes it speech, a few frames later.
      expect([at, result.ducked]).toEqual([at, [{ type: "play", at: 0 }, { type: "volume", at: seconds(at + 0.032), value: 0.25 }]])
      expect([at, result.stopped.slice(2)]).toEqual([at, [{ type: "stop", at: seconds(at + 0.032 * needed) }]])
      expect([at, result.responded]).toEqual([at, ["Hold on."]])
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

  test("takes \"Which PR was that?\" said over its first second whole, giving the model what yapd was saying around then, and says the answer", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Which PR was that?"]], { reply: () => ({ intent: "answer", spoken: answered, message: "" }) })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          commands: helper.commands,
          responded: helper.responded,
          rendered: helper.rendered,
          sent: helper.sent,
          replies: yield* helper.replies,
        }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "volume", "stop", "play"],
      responded: [
        {
          project: "yapd",
          turn: long.turn,
          needsYou: false,
          lines: [{ speaker: "yapd", text: "Over in yapd,…" }],
          heard: "Which PR was that?",
          echo: first,
        },
      ],
      rendered: [answered],
      sent: [],
      replies: ["Which PR was that?"],
    })
  })

  test.each(["Okay, thanks.", "Got it."])("follows the model's dismissal of %p said over its first second, falling quiet for good", async (said) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, said]], { reply: () => ({ intent: "dismiss", spoken: "", message: "" }) })
        yield* helper.wait(1)
        // Going on past where it stopped, so surely his.
        yield* helper.talk(0, defaults.lead)
        yield* helper.talk(0.9, 16)
        yield* helper.quiet
        yield* helper.wait(15)
        return {
          commands: helper.commands,
          responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })),
          rendered: helper.rendered,
          sent: helper.sent,
          replies: yield* helper.replies,
          done: Option.isSome(yield* Fiber.poll(helper.fiber)),
        }
      }),
    )
    expect(result).toEqual({ commands: ["play", "volume", "stop"], responded: [{ heard: said, echo: first }], rendered: [], sent: [], replies: [said], done: true })
  })

  test("sends \"Tell it to revert it.\" said over its first second whole, as any message for the agent is sent", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to revert it."]])
        yield* helper.wait(1)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          commands: helper.commands,
          responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })),
          rendered: helper.rendered,
          sent: helper.sent,
          replies: yield* helper.replies,
        }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "volume", "stop", "play"],
      responded: [{ heard: "Tell it to revert it.", echo: first }],
      rendered: ["Okay."],
      sent: ["Tell it to revert it."],
      replies: ["Tell it to revert it."],
    })
  })

  test("says the model's line asking him to say it again, and takes his reply to it as after an answer", async () => {
    const again = "I didn't catch all of that, sir. Once more?"
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "the pull request merge it"], [0.91, "Merge the pull request."]], {
          // As the model would, when what he said hangs on words that may be yapd's own.
          reply: ({ echo, heard }) =>
            echo !== undefined && heard.includes("pull request")
              ? { intent: "answer", spoken: again, message: "" }
              : { intent: "send", spoken: "", message: heard },
        })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], sent: [...helper.sent] }
        // Said to the end, it listens for his reply.
        yield* helper.wait(2)
        yield* helper.finish
        yield* helper.wait(1)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return { asked, responded: helper.responded, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.asked).toEqual({ commands: ["play", "volume", "stop", "play"], rendered: [again], sent: [] })
    expect(result.responded.map(({ heard, echo, lines }) => ({ heard, echo, lines }))).toEqual([
      { heard: "the pull request merge it", echo: first, lines: [{ speaker: "yapd", text: "Over in yapd,…" }] },
      {
        heard: "Merge the pull request.",
        echo: undefined,
        lines: [
          { speaker: "yapd", text: "Over in yapd,…" },
          { speaker: "user", text: "the pull request merge it" },
          { speaker: "yapd", text: again },
        ],
      },
    ])
    expect(result).toMatchObject({ sent: ["Merge the pull request."], replies: ["the pull request merge it", "Merge the pull request."] })
    // Its usual line that it's in hand, as for any message passed on.
    expect(result.rendered).toEqual([again, Persona.plain.onIt])
  })

  test.each([
    ["nothing Whisper can make out", ""],
    ["what Whisper makes up", "Thank you."],
    ["yapd's own words around then", "Over in yapd, the tests pass."],
    ["yapd's own words with its name misheard", "Of Erin yapped. The tests pass now."],
  ])("picks up again from just before where it stopped, saying nothing and asking nobody, when what stopped it is heard as %s", async (_, heard) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper(heard === "" ? [] : [[0.8, heard]])
        yield* helper.wait(2.5)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          commands: helper.commands,
          plays: helper.plays,
          transcribed: helper.transcribed,
          responded: helper.responded,
          rendered: helper.rendered,
          sent: helper.sent,
          replies: yield* helper.replies,
        }
      }),
    )
    // A moment before where it stopped, two and a half seconds in.
    expect(result).toEqual({
      commands: ["play", "volume", "stop", "play"],
      plays: [0, 1.7],
      transcribed: [heard],
      responded: [],
      rendered: [],
      sent: [],
      replies: [],
    })
  })

  test("keeps listening however often its own voice stopped it over its first seconds, unlike for talk that wasn't meant for it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Stop."]], { reply: () => ({ intent: "dismiss", spoken: "", message: "" }) })
        for (let time = 0; time < 4; time++) {
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 10)
          yield* helper.quiet
        }
        // Past its first three seconds since.
        yield* helper.wait(2)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { plays: helper.plays.map(seconds), responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })), commands: helper.commands.slice(-2) }
      }),
    )
    // Each time from a moment before where it stopped, which is its start again this early.
    expect(result).toEqual({ plays: [0, 0, 0, 0, 0], responded: [{ heard: "Stop.", echo: undefined }], commands: ["volume", "stop"] })
  })

  test("takes all he says over its first seconds whole, though he goes on for longer than the line it stopped would have lasted", async () => {
    const said = "Tell it to split the migration in two, run the first half tonight and the rest tomorrow once the backups are done."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, said]], { duration: 4, live: true })
        yield* helper.wait(0.5)
        // Twenty seconds without a pause long enough to end it.
        yield* helper.talk(0.9, 625)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, responded: helper.responded.map(({ heard }) => heard), sent: helper.sent }
      }),
    )
    expect(result).toEqual({ commands: ["play", "volume", "stop", "play"], responded: [said], sent: [said] })
  }, 30_000)

  test("tells the model nothing of its own voice for what he begins past its first seconds, and takes even its own words then to the model, as ever", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."]], { reply: () => ({ intent: "resume", spoken: "", message: "" }) })
        yield* helper.wait(4)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, plays: helper.plays, responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })) }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "volume", "stop", "play"],
      plays: [0, 2.5],
      responded: [{ heard: "Over in yapd, the tests pass.", echo: undefined }],
    })
  })

  test("tells the model nothing of its own voice for a reply begun once yapd has finished talking, though within its first seconds", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Which PR was that?"]], { duration: 2, reply: () => ({ intent: "answer", spoken: answered, message: "" }) })
        yield* helper.wait(2)
        yield* helper.finish
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })), rendered: helper.rendered }
      }),
    )
    expect(result).toEqual({ commands: ["play", "play"], responded: [{ heard: "Which PR was that?", echo: undefined }], rendered: [answered] })
  })

  test("picks an answer of yapd's up again when its own voice stopped it over its first seconds, taking none of that for a follow-up, and takes his whole", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapped, the tests pass."], [0.9, "Tell it to open a PR."]], { answer: true })
        yield* helper.wait(2)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        const picked = { commands: [...helper.commands], plays: [...helper.plays], followed: [...helper.followed] }
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        return { picked, commands: helper.commands, followed: yield* Fiber.join(helper.fiber), followUps: helper.followed }
      }),
    )
    expect(result).toEqual({
      picked: { commands: ["play", "volume", "stop", "play"], plays: [0, 1.2], followed: [] },
      commands: ["play", "volume", "stop", "play", "volume", "stop"],
      followed: true,
      followUps: ["Tell it to open a PR."],
    })
  })

  test("gives the model what yapd was saying around when he began over its answer, and keeps listening however often the model takes that for its own voice", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // As the model would take yapd's own "Two thr-" heard as other words, and his stop.
        const helper = yield* overHelper([[0.8, "Two fred."], [0.9, "Stop."]], { answer: true, follow: (_, echo) => echo === undefined })
        for (let time = 0; time < 4; time++) {
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 10)
          yield* helper.quiet
        }
        // Past its first three seconds since.
        yield* helper.wait(2)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        return {
          offered: helper.offered.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          plays: helper.plays.map(seconds),
          commands: helper.commands.slice(-2),
          followed: yield* Fiber.join(helper.fiber),
          followUps: helper.followed,
        }
      }),
    )
    expect(result).toEqual({
      offered: [...Array.from({ length: 4 }, () => ({ heard: "Two fred.", told: true })), { heard: "Stop.", told: false }],
      // Each time from a moment before where it stopped, which is its start again this early.
      plays: [0, 0, 0, 0, 0],
      commands: ["volume", "stop"],
      followed: true,
      followUps: ["Stop."],
    })
  })

  test("keeps listening however often the model takes what stopped it over its first seconds for its own voice, picking up just before each time", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Two threads need you. The teaser is important."], [0.9, "Stop."]], {
          reply: ({ echo }) => ({ intent: echo === undefined ? "dismiss" : "resume", spoken: "", message: "" }),
        })
        for (let time = 0; time < 4; time++) {
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 10)
          yield* helper.quiet
        }
        yield* helper.wait(2)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          plays: helper.plays.map(seconds),
          commands: helper.commands.slice(-2),
          done: Option.isSome(yield* Fiber.poll(helper.fiber)),
        }
      }),
    )
    expect(result).toEqual({
      responded: [...Array.from({ length: 4 }, () => ({ heard: "Two threads need you. The teaser is important.", told: true })), { heard: "Stop.", told: false }],
      plays: [0, 0, 0, 0, 0],
      commands: ["volume", "stop"],
      done: true,
    })
  })

  test.each([
    ["no longer than its own voice can go on after it stops, which it may all have been, at once", 12, [{ heard: "Cup day of", told: true }]],
    ["going on past that, which is surely his trailing off, only after a moment more", 16, []],
  ] as const)("works out what's said over its first seconds that ends on a word like \"of\" %s", async (_, frames, soon) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Cup day of"]], { reply: () => ({ intent: "resume", spoken: "", message: "" }) })
        yield* helper.wait(0.5)
        yield* helper.talk(0, defaults.lead)
        yield* helper.talk(0.9, frames)
        yield* helper.quiet
        yield* helper.wait(1)
        return helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined }))
      }),
    )
    expect(result).toEqual([...soon])
  })

  test("after three times talk that wasn't meant for it past its first seconds, reads the rest without listening", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper makes nothing of it, as of a TV in the next room.
        const helper = yield* overHelper([])
        yield* helper.wait(4)
        for (let time = 0; time < 4; time++) {
          yield* helper.talk(0.8, 10)
          yield* helper.quiet
          yield* helper.wait(0.5)
        }
        return { commands: helper.commands, transcribed: helper.transcribed, responded: helper.responded }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "volume", "stop", "play", "volume", "stop", "play", "volume", "stop", "play"],
      transcribed: ["", "", ""],
      responded: [],
    })
  })

  /** What's said as a line ends, `at` seconds into its `duration`, `frames` long, and what came of it. */
  const ending = (
    at: number,
    frames: number,
    given: { readonly spoken: string; readonly duration: number; readonly heard: string; readonly answer?: boolean; readonly finished: boolean },
  ) =>
    overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, given.heard]], { spoken: given.spoken, duration: given.duration, answer: given.answer === true })
        yield* helper.wait(at)
        // What the microphone keeps from just before he begins.
        yield* helper.talk(0, defaults.lead)
        yield* helper.talk(0.9, 1)
        // The line plays to its end before it's clearly speech, or it's stopped first.
        if (given.finished) yield* helper.finish
        yield* helper.talk(0.9, frames - 1)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          commands: helper.commands,
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          sent: helper.sent,
          offered: helper.offered.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          done: Option.isSome(yield* Fiber.poll(helper.fiber)),
        }
      }),
    )

  test("takes a reply in yapd's own words begun as a line ends within its first seconds for his, as after any line", async () => {
    const asked = { spoken: "The PR is ready, sir. Merge it?", duration: 2, heard: "Merge it." }
    // Begun in its last moment, played to its end before it's clearly speech.
    expect(await ending(1.95, 16, { ...asked, finished: true })).toEqual({
      commands: ["play", "volume", "play"],
      responded: [{ heard: "Merge it.", told: false }],
      sent: ["Merge it."],
      offered: [],
      done: false,
    })
    // Begun over its last word, which it's stopped for.
    expect(await ending(1.8, 16, { ...asked, finished: false })).toEqual({
      commands: ["play", "volume", "stop", "play"],
      responded: [{ heard: "Merge it.", told: false }],
      sent: ["Merge it."],
      offered: [],
      done: false,
    })
    // A follow-up naming what its answer just said.
    expect(
      await ending(2.75, 18, {
        spoken: "Two threads need you: the Tezos importer and the menu bar app.",
        duration: 2.8,
        heard: "The menu bar app.",
        answer: true,
        finished: true,
      }),
    ).toEqual({ commands: ["play", "volume"], responded: [], sent: [], offered: [{ heard: "The menu bar app.", told: false }], done: true })
  })

  test("listens on for his reply, taking nothing of its own, when only its own last words got into the microphone as a line ended within its first seconds", async () => {
    const after = (reply: boolean, answer: boolean) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, "Ready."], [0.9, "Merge it."]], { spoken: "The PR is ready.", duration: 2, answer })
          yield* helper.wait(1.95)
          yield* helper.talk(0, defaults.lead)
          // Its own "ready", no longer than its voice dying away after, which plays to its end before it's clearly speech.
          yield* helper.talk(0.8, 1)
          yield* helper.finish
          yield* helper.talk(0.8, defaults.wary - 1)
          yield* helper.quiet
          // His reply, a second on.
          yield* helper.wait(1)
          if (reply) {
            yield* helper.talk(0.9, 16)
            yield* helper.quiet
          }
          yield* helper.wait(1)
          const before = Option.isSome(yield* Fiber.poll(helper.fiber))
          yield* helper.wait(10)
          return {
            commands: helper.commands,
            responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
            sent: helper.sent,
            offered: helper.offered.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
            before,
            done: Option.isSome(yield* Fiber.poll(helper.fiber)),
          }
        }),
      )
    expect(await after(true, false)).toMatchObject({ commands: ["play", "volume", "play"], responded: [{ heard: "Merge it.", told: false }], sent: ["Merge it."] })
    expect(await after(true, true)).toMatchObject({ commands: ["play", "volume"], offered: [{ heard: "Merge it.", told: false }], done: true })
    // With none, it falls quiet once the usual moment for a reply is up.
    expect(await after(false, false)).toEqual({ commands: ["play", "volume"], responded: [], sent: [], offered: [], before: false, done: true })
  })

  test.each(["Stop.", "Thank you."])("takes \"%s\" over its first seconds for his once it goes on past where yapd stopped, though yapd was saying \"stopped\" and Whisper makes up \"Thank you.\", and for its own voice when it doesn't", async (heard) => {
    const over = (frames: number) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, heard]], {
            spoken: "Over in yapd, the agent stopped at the next step and is waiting on you, sir.",
            duration: 5,
            reply: () => ({ intent: "dismiss", spoken: "", message: "" }),
          })
          yield* helper.wait(0.3)
          yield* helper.talk(0, defaults.lead)
          yield* helper.talk(0.9, frames)
          yield* helper.quiet
          yield* helper.wait(1)
          return {
            commands: helper.commands,
            plays: helper.plays,
            responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
            done: Option.isSome(yield* Fiber.poll(helper.fiber)),
          }
        }),
      )
    // Sixteen frames of speech, half a second past where it stopped.
    expect(await over(16)).toEqual({ commands: ["play", "volume", "stop"], plays: [0], responded: [{ heard, told: true }], done: true })
    // Twelve, no longer than its own voice can go on after.
    expect(await over(12)).toEqual({ commands: ["play", "volume", "stop", "play"], plays: [0, 0], responded: [], done: false })
  })
})

describe("Once its own voice has stopped a line over its first seconds, and it picked up again", () => {
  /** Commands as they're read, with the volume they asked for. */
  const read = (timeline: ReadonlyArray<{ readonly type: string; readonly value?: number }>) =>
    timeline.map(({ type, value }) => (value === undefined ? type : `${type} ${value}`))

  test.each([
    ["its words tell", "Over in yapd, the tests pass.", []],
    ["the model judged", "Cup day.", [{ heard: "Cup day.", told: true }]],
  ] as const)("only ducks for more of its own voice over the rest of that line's first seconds, as %s, and turns back up once it ends short of what stops it", async (_, heard, asked) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, heard]], { live: true, reply: () => ({ intent: "resume", spoken: "", message: "" }) })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, defaults.wary)
        yield* helper.quiet
        const once = read(helper.timeline)
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, defaults.capped - 1)
        yield* helper.talk(0, defaults.abandon)
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, defaults.capped - 1)
        yield* helper.talk(0, defaults.abandon)
        yield* helper.wait(1)
        return {
          once,
          after: read(helper.timeline).slice(once.length),
          plays: helper.plays,
          transcribed: helper.transcribed,
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
        }
      }),
    )
    expect(result).toEqual({
      once: ["play", "volume 0.25", "stop", "play"],
      after: ["volume 0.25", "volume 1", "volume 0.25", "volume 1"],
      plays: [0, 0],
      transcribed: [heard],
      responded: [...asked],
    })
  })

  test("still ducks at his first sound, stops once he's surely talking, takes all he says whole, and takes a new line's first stop at once again", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Which PR was that?"]], {
          live: true,
          reply: ({ heard }) => (heard === "Which PR was that?" ? { intent: "answer", spoken: answered, message: "" } : { intent: "resume", spoken: "", message: "" }),
        })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, defaults.wary)
        yield* helper.quiet
        yield* helper.wait(0.3)
        const before = helper.timeline.length
        const began = (yield* Clock.currentTimeMillis) / 1000
        yield* helper.talk(0.9, 1)
        const ducked = helper.timeline.slice(before)
        yield* helper.talk(0.9, defaults.capped - 1)
        const stopped = helper.timeline.slice(before)
        yield* helper.talk(0.9, 20)
        yield* helper.quiet
        yield* helper.wait(0.2)
        // yapd's answer, a new line, still within its first seconds: its own voice, heard as nothing, stops it as the first time did.
        const answering = helper.timeline.length
        yield* helper.talk(0.7, defaults.wary)
        const anew = read(helper.timeline.slice(answering))
        yield* helper.quiet
        yield* helper.wait(1)
        const start = helper.timeline[0]!.at
        return {
          ducked: ducked.map(({ type, at, value }) => ({ type, at: seconds(at + start - began), value })),
          stopped: stopped.map(({ type, at }) => ({ type, at: seconds(at + start - began) })).slice(1),
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          rendered: helper.rendered,
          anew,
          plays: helper.plays,
        }
      }),
    )
    expect(result).toEqual({
      // Turned down with the first frame of his voice, and stopped with the frame that makes it surely his.
      ducked: [{ type: "volume", at: 0.032, value: 0.25 }],
      stopped: [{ type: "stop", at: seconds(0.032 * defaults.capped) }],
      responded: [{ heard: "Which PR was that?", told: true }],
      rendered: [answered],
      anew: ["volume 0.25", "stop"],
      plays: [0, 0, 0, 0],
    })
  })

  test("takes what Whisper makes up for his then, but yapd's own words still for its voice", async () => {
    const over = (heard: string) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.7, "Over in yapd."], [0.9, heard]], { reply: () => ({ intent: "dismiss", spoken: "", message: "" }) })
          yield* helper.wait(0.5)
          yield* helper.talk(0.7, defaults.wary)
          yield* helper.quiet
          yield* helper.wait(0.5)
          yield* helper.talk(0.9, defaults.capped)
          yield* helper.quiet
          yield* helper.wait(1)
          return { plays: helper.plays, responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })) }
        }),
      )
    expect(await over("Thank you.")).toEqual({ plays: [0, 0], responded: [{ heard: "Thank you.", told: true }] })
    expect(await over("Over in yapd, the tests pass.")).toEqual({ plays: [0, 0, 0], responded: [] })
  })

  test("takes yapd's own words he says back as his once they go on past where it would have stopped without the cap", async () => {
    const over = (more: number) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, "Over in yapd."], [0.9, "The tests pass."]], { live: true, reply: () => ({ intent: "dismiss", spoken: "", message: "" }) })
          yield* stoppedOnItself(helper)
          yield* helper.talk(0, defaults.lead)
          yield* helper.talk(0.9, defaults.capped + more)
          yield* helper.quiet
          yield* helper.wait(1)
          return helper.responded.map(({ heard }) => heard)
        }),
      )
    // Going on as far past where a stop would have come without the cap as his words must, they're his.
    expect(await over(11)).toEqual(["The tests pass."])
    // No further than its own voice can go on, they may be its own.
    expect(await over(7)).toEqual([])
  })

  test("only ducks for more of its own voice over an answer's first seconds too", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."]], { answer: true, live: true })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, defaults.wary)
        yield* helper.quiet
        const once = read(helper.timeline)
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, defaults.capped - 1)
        yield* helper.talk(0, defaults.abandon)
        yield* helper.wait(1)
        return { once, after: read(helper.timeline).slice(once.length), offered: helper.offered }
      }),
    )
    expect(result).toEqual({ once: ["play", "volume 0.25", "stop", "play"], after: ["volume 0.25", "volume 1"], offered: [] })
  })

  /** Its own voice stops the line at once, as Whisper's "Over in yapd" for its own words tells, and it picks up again with the cap on. */
  const stoppedOnItself = (helper: Effect.Effect.Success<ReturnType<typeof overHelper>>) =>
    Effect.gen(function* () {
      yield* helper.wait(0.5)
      yield* helper.talk(0.8, defaults.wary)
      yield* helper.quiet
      yield* helper.wait(0.3)
    })

  test("stops for a word of his too short to stop for at once, like a lone \"No.\", once Whisper hears it isn't its own voice", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "No."]], {
          live: true,
          reply: ({ heard }) => (heard === "No." ? { intent: "dismiss", spoken: "", message: "" } : { intent: "resume", spoken: "", message: "" }),
        })
        yield* stoppedOnItself(helper)
        const before = helper.timeline.length
        yield* helper.talk(0.9, defaults.capped - 1)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          after: read(helper.timeline.slice(before)),
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          done: (yield* Fiber.join(helper.fiber)) === false,
        }
      }),
    )
    expect(result).toEqual({ after: ["volume 0.25", "volume 1", "stop"], responded: [{ heard: "No.", told: true }], done: true })
  })

  test("keeps his first word whole with what he says after a pause, as one", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "No,"], [0.95, "leave it as it is."]], {
          live: true,
          reply: ({ heard }) => (heard === "Over in yapd, the tests pass." ? { intent: "resume", spoken: "", message: "" } : { intent: "dismiss", spoken: "", message: "" }),
        })
        yield* stoppedOnItself(helper)
        yield* helper.talk(0.9, defaults.wary + 2)
        // A pause too long to keep in the lead-in, but not long enough to end what he says.
        yield* helper.talk(0, defaults.abandon + 4)
        yield* helper.talk(0.95, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return helper.responded.map(({ heard }) => heard)
      }),
    )
    expect(result).toEqual(["No, leave it as it is."])
  })

  test("plays on, turned back up, when Whisper hears only its own words in a sound too short to stop for", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."]], { live: true })
        yield* stoppedOnItself(helper)
        const before = helper.timeline.length
        yield* helper.talk(0.8, defaults.capped - 1)
        yield* helper.quiet
        yield* helper.wait(1)
        return { after: read(helper.timeline.slice(before)), plays: helper.plays, transcribed: helper.transcribed.length, responded: helper.responded }
      }),
    )
    expect(result).toEqual({ after: ["volume 0.25", "volume 1"], plays: [0, 0], transcribed: 2, responded: [] })
  })

  test("offers a word of his too short to stop for at once over an answer for a follow-up", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Stop."]], { answer: true, live: true })
        yield* stoppedOnItself(helper)
        yield* helper.talk(0.9, defaults.wary)
        yield* helper.quiet
        yield* helper.wait(1)
        return { offered: helper.offered.map(({ heard, echo }) => ({ heard, told: echo !== undefined })), followed: helper.followed }
      }),
    )
    expect(result).toEqual({ offered: [{ heard: "Stop.", told: true }], followed: ["Stop."] })
  })

  /** What's logged of its own voice and the cap, which is how often that happens on his speakers is counted, and what's logged of his words. */
  const logged = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => {
    const lines: Array<string> = []
    const logger = Logger.make(({ message }) => {
      lines.push((Array.isArray(message) ? message : [message]).join(" "))
    })
    return overHelperScoped(test.pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger)))).then(() => ({
      counted: lines.filter((line) => /own voice|Ducked|Picked up again/.test(line)),
      all: lines,
    }))
  }

  test("logs one plain line each time its own voice stops a line, and each sound the cap kept from stopping it, with none of his words", async () => {
    const result = await logged(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."]], { live: true, reply: () => ({ intent: "resume", spoken: "", message: "" }) })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, defaults.wary)
        yield* helper.quiet
        yield* helper.talk(0.8, defaults.capped)
        yield* helper.quiet
        yield* helper.talk(0.8, defaults.wary - 1)
        yield* helper.talk(0, defaults.abandon)
        yield* helper.talk(0.8, defaults.wary)
        yield* helper.quiet
        yield* helper.wait(1)
      }),
    )
    expect(result.counted).toEqual([
      "Stopped for its own voice over its first seconds, as its words tell, so it picks up again, and takes more speech to stop till they're over",
      "Stopped for its own voice again over its first seconds, as its words tell, though it took more speech to stop, so it picks up again",
      "Ducked for a sound over its first seconds too short to stop for, as its own voice stopped this line before, so it turns back up",
      "Ducked for a sound over its first seconds too short to stop for, as its own voice stopped this line before, so it turns back up while it hears whose it was",
      "Heard only its own voice in a sound over its first seconds too short to stop for, so it played on",
    ])
    expect(result.all.filter((line) => line.includes("yapd") && !line.startsWith("Heard:"))).toEqual([])
  })

  test("counts talk that went on past where it stopped, which the model took as not meant for it, as nobody's own voice, and leaves the cap off", async () => {
    const result = await logged(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Can you pass me the salt?"], [0.8, "Over in yapd, the tests pass."]], {
          live: true,
          reply: () => ({ intent: "resume", spoken: "", message: "" }),
        })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 40)
        yield* helper.quiet
        const before = helper.timeline.length
        yield* helper.talk(0.8, defaults.wary)
        const after = read(helper.timeline.slice(before))
        yield* helper.quiet
        yield* helper.wait(1)
        return after
      }).pipe(Effect.tap((after) => Effect.sync(() => expect(after).toEqual(["volume 0.25", "stop"])))),
    )
    expect(result.counted).toEqual([
      "Picked up again over its first seconds after talk not meant for it",
      "Stopped for its own voice over its first seconds, as its words tell, so it picks up again, and takes more speech to stop till they're over",
    ])
    expect(result.all.some((line) => line.includes("salt") && !line.startsWith("Heard:"))).toBe(false)
  })

  test("stops for him past its first seconds as ever, though its own voice stopped the line before", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Hold on."]], {
          live: true,
          reply: () => ({ intent: "dismiss", spoken: "", message: "" }),
        })
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, defaults.wary)
        yield* helper.quiet
        yield* helper.wait(3)
        const before = helper.timeline.length
        yield* helper.talk(0.9, defaults.confirm)
        const stopped = read(helper.timeline.slice(before))
        yield* helper.talk(0.9, 6)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })) }
      }),
    )
    expect(result).toEqual({ stopped: ["volume 0.25", "stop"], responded: [{ heard: "Hold on.", told: false }] })
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

  test("tells the model he began over yapd's own voice, with what it was saying around then, to have him say again a message that may be cut off", () => {
    const interruption: Responder.Interruption = {
      project: "yapd",
      turn: { prompt: Option.none(), message: "The tests pass and the PR is ready." },
      needsYou: false,
      lines: [{ speaker: "yapd", text: "Over in yapd,…" }],
      heard: "revert it.",
    }
    const told = Responder.prompt({ ...interruption, echo: "Over in yapd, the tests pass now" }, Option.none())
    expect(told).toContain(
      `They began while your own voice could still get into their microphone, so what was heard may start with your own words, from around "Over in yapd, the tests pass now", misheard or not, and their first word may be lost under yours. Words that sound like yours there are yours, however they came out, like "Code up." for "Claude on": take them all out, and never put them in the message or turn them into words of theirs. If nothing surely theirs is left, it's "resume", never "dismiss".`,
    )
    expect(told).toContain(`If a message for the agent sounds cut off, or hangs on a word that may be yours, don't send it: make it "answer", asking them in a few words to say it again. A question or a dismissal goes as usual.`)
    // Just before what he said, which still ends it.
    expect(told.endsWith(`say it again. A question or a dismissal goes as usual.\n\nWhat the user just said:\nrevert it.`)).toBe(true)
    // Begun once its own voice could no longer get in, nothing's said of it.
    expect(Responder.prompt(interruption, Option.none())).not.toContain("your own voice")
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

  test("leaves a yes begun while yapd's own voice could still get into the microphone to the model, which may be its own \"sir?\", but still ends it at a stop", () => {
    const said = "Codex asks whether to deploy to staging, sir?"
    const over = (heard: string) =>
      Effect.runSync(
        Responder.quick(
          { project: "yapd", turn: { prompt: Option.none(), message: said }, needsYou: true, lines: [{ speaker: "yapd", text: said }], heard, echo: said },
          Effect.succeed("On it, sir."),
        ),
      )
    expect(over("Sure.")).toBeUndefined()
    expect(over("Stop.")).toEqual({ intent: "dismiss", spoken: "", message: "" })
    expect(reply("Sure.", said, true, said)?.intent).toBe("send")
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
