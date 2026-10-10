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
import { readFileSync } from "node:fs"
import { Audio, AudioError, native } from "./Audio.ts"
import * as Condenser from "./Condenser.ts"
import * as Conversation from "./Conversation.ts"
import { between, cut, stopIn, together, unfinished, whose } from "./Conversation.ts"
import { wav } from "./Dictation.ts"
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
        echo: () => Effect.succeed(undefined),
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

  test("takes nothing, or what Whisper makes up, for unclear", () => {
    for (const heard of [
      "", "Thank you.", "- Verse.", "End of song.", "Thank you. Thank you.", "Okay.", "Thanks.", "So,", "Hello?", "Mm-hmm.", "Uh-huh.",
      "Please subscribe.", "Thank you, bye.", "Thank you so much for watching.", "I'll see you next time.", "you you you",
      "Subtitles by the Amara.org community", "Okay, thanks.", "Of course.", "Excuse me.", "Good morning.", "What the hell?", "Jesus Christ.",
    ]) {
      expect([heard, whose(heard, saying)]).toEqual([heard, "unclear"])
    }
  })

  test("takes its own voice for unclear when Whisper writes its name as a word it knows, like \"yapped\" for \"yapd\"", () => {
    for (const heard of ["Over in yapped.", "Over in Japan.", "Over in Yappy.", "Overin Yapti.", "Over in yapped, the tests pass.", "In yapped.", "Over in your app."]) {
      expect([heard, whose(heard, saying)]).toEqual([heard, "unclear"])
    }
    const question = "Which one, sir: yapd or the docs site?"
    for (const heard of ["Which one, sir? Yapped.", "Which one? Yapped.", "Which one, sir? Yap, or the dock site?", "One, sir? Yapped."]) {
      expect([heard, whose(heard, question)]).toEqual([heard, "unclear"])
    }
    // His own words still are his, said over it.
    expect(whose("Hold on, which PR was that?", saying)).toBe("his")
    expect(whose("Neither, start a new project.", question)).toBe("his")
  })

  test("takes the words it says around its name for unclear, with its name misheard as another word, or two of its words as two others", () => {
    for (const heard of ["In Japan.", "In yacht.", "Japan, the."]) {
      expect([heard, whose(heard, "In yapd, the tests pass now")]).toEqual([heard, "unclear"])
    }
    for (const heard of ["Of Erin yapped.", "Of her in yapped.", "Over in Rennie app tests.", "In Rennie app tests."]) {
      expect([heard, whose(heard, saying)]).toEqual([heard, "unclear"])
    }
  })

  test("takes a word beside its words for its name misheard only when it sounds like it, never a word of his like \"Deploy\" in \"Deploy it.\"", () => {
    for (const heard of ["Deploy it.", "Retry it.", "Fix it.", "Kill it.", "Is it done?"]) {
      expect([heard, whose(heard, "the build is green. It wants to know whether to")]).toEqual([heard, "his"])
    }
    expect(whose("The other one.", "Over in rig, the migration is still running")).toBe("his")
    // But its own "Over in" goes before whatever its name is heard as, like "Over in rate." for "Over in rig".
    expect(whose("Over in production.", saying)).toBe("unclear")
    // As Whisper writes its name, said as it is.
    expect(whose("Rick, it.", "the migration on rig, it wants")).toBe("unclear")
  })

  test("takes its own voice for unclear with its name written as two words or misheard, or a word of its put another way", () => {
    for (const [heard, line] of [
      ["Over in your app, the tests pass now.", "Over in yapd, the tests pass now and the"],
      ["Over in your app, the tests", "Over in yapd, the tests pass now and the"],
      ["Over in your", "Over in yapd, the tests pass now and the"],
      ["Over in Rennie app, the tests pass.", "Over in yapd, the tests pass now and the"],
      ["Codex failed on your app, the build broke.", "Codex failed on yapd, the build broke on the main branch"],
      ["Over in home lab, Claude finished the migration.", "Over in homelab, Claude finished the migration and the tests"],
      ["Over in back end, the tests pass.", "Over in backend, the tests pass now and the pull request"],
      ["Over in note book, the tests pass.", "Over in notebook, the tests pass now and the pull request"],
      ["Over in tea three code, Codex fixed the flaky login test.", "Over in t3code, Codex fixed the flaky login test and pushed"],
      ["Over in T3 Code", "Over in t3code, Codex fixed the flaky login test and pushed"],
      ["Over in my NAS", "Over in minas-sv2, Codex fixed the flaky login test and pushed"],
      ["Rick, the migration finished.", "Over in rig, the migration finished and the build is green"],
      ["Kodak's fixed the failing login test.", "Codex fixed the failing login test and pushed the branch, sir"],
      ["So the test is passed now.", "Over in yapd, the tests pass now and the"],
      ["The tests are passing now.", "Over in yapd, the tests pass now and the"],
    ] as const) {
      expect([heard, whose(heard, line)]).toEqual([heard, "unclear"])
    }
    expect(whose("Over in production, merge it.", "Over in yapd, the tests pass now and the")).toBe("unclear")
  })

  test("takes what yapd was saying for unclear, misheard or not, even with a word misheard as its voice stops getting in", () => {
    expect(whose("Over in yapd, the tests pass.", saying)).toBe("unclear")
    expect(whose("Over in yap D, the test pass.", saying)).toBe("unclear")
    expect(whose("Codecs finished the migrations.", "Codex finished the migration and")).toBe("unclear")
    expect(whose("Over and yeah the test past.", `${saying} and the pull request`)).toBe("unclear")
    expect(whose("Codecs. Yap.", "Codex on yapd")).toBe("unclear")
    expect(whose("Over in yapd, the tests pass. Now in the pool.", `${saying} and the pull request is ready`)).toBe("unclear")
    // Whisper says a word again on noise.
    expect(whose("Over in yapd yapd, the tests pass.", saying)).toBe("unclear")
    // Nothing but words nearly anything has, in its order.
    expect(whose("And the", `${saying} and the pull request`)).toBe("unclear")
  })

  test("takes two words it says one after another for its voice, however common, with its name heard as anything after them", () => {
    // As Whisper heard its voice getting in, with only it playing.
    const u1 = "Over in yapd, the tests pass now and the PR is ready for review, sir."
    const u2 = "Over in rig, Claude finished the migration and the build is green, sir."
    const u4 = "Over in home lab, the agent stopped at the next step and is waiting on you, sir."
    const q2 = "Which project is this for, sir? yapd or home lab?"
    for (const [heard, line] of [
      ["over and yet.", u1], ["over in the app.", u1], ["over and yeah.", u1], ["Over and her laugh", u4], ["Star Trek is this for sure.", q2],
      // With words of his, it's as unclear, so none of its voice goes with them.
      ["Merge it is this for sir. Yeah, don't have love", q2], ["over in rate. Tell it to open a PR.", u2],
    ] as const) {
      expect([heard, whose(heard, line)]).toEqual([heard, "unclear"])
    }
    // His stop among them is still his, on its own.
    for (const [heard, line, stop] of [
      ["Wait. Jack is this for sir.", q2, "Wait."], ["over and out. Never mind.", u1, "Never mind."], ["over and yeah. Hold on.", u1, "Hold on."],
      ["over and out. Skip.", u1, "Skip."], ["Which project is this? Nevermind.", q2, "Never mind."],
    ] as const) {
      expect([heard, whose(heard, line), stopIn(heard, line)]).toEqual([heard, "stop", stop])
    }
  })

  test("takes a stop yapd was saying for unclear, even cut off partway through a longer word, or run into the next", () => {
    expect(whose("Stop.", "I'll stop the tests now")).toBe("unclear")
    expect(whose("Next.", "The tests pass. Next, I'll open")).toBe("unclear")
    expect(whose("Stop.", "Codex on yapd stopped after the tests failed, sir.")).toBe("unclear")
    expect(whose("Codex on yapd stop.", "Codex on yapd stopped after the tests failed, sir.")).toBe("unclear")
    expect(whose("It's still wait", "The pull request is open and it's still waiting on CI.")).toBe("unclear")
    expect(whose("The agent skip", "The agent skipped the flaky test and pushed.")).toBe("unclear")
    expect(whose("Codex is stop", "Codex is stopping the server.")).toBe("unclear")
    expect(whose("Codex is resizing the stop rage volume.", "Codex is resizing the storage volume for the database now")).toBe("unclear")
    // His stop, all of it in line with its words, as its "skipped", or "stopped" as Whisper may write it.
    expect(whose("Skip the tests.", "Codex skipped the tests and pushed")).toBe("unclear")
    expect(whose("Stop it.", "Codex stopped the server")).toBe("unclear")
    expect(whose("Wait, merge it.", "Codex is waiting on your approval")).toBe("unclear")
  })

  test("takes words of the user's own for his, however common, and a word on its own, like \"Yes.\"", () => {
    const line = "Codex finished the migration on yapd and all the tests pass now. Do you want me to open the pull request?"
    for (const heard of ["Not now.", "What did you do?", "Do it.", "Merge it.", "Yes.", "Yeah.", "No.", "Docs."]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
    }
    // His, though a common word of it is one of yapd's too, even its first.
    expect(whose("So, tell it to run the migration again.", `${saying} and the pull request is ready for review, so I can merge it`)).toBe("his")
    expect(whose("In production, merge it.", saying)).toBe("his")
    expect(whose("Yes.", "Send it again?")).toBe("his")
    expect(whose("Yes, please.", "Send it again?")).toBe("his")
    expect(whose("Which PR was that?", `${saying} and the pull request is ready`)).toBe("his")
    // Once yapd has stopped talking, none of it can be its voice, but what Whisper makes up still is nobody's.
    expect(whose("Docs.", "")).toBe("his")
    expect(whose("Thank you.", "")).toBe("unclear")
  })

  test("takes everyday words of his for his, unless they're what yapd is saying, or two of them one after another as it says them", () => {
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
    // Its words, in its order or not.
    expect(whose("Can you do it?", "Can the agent do it now")).toBe("unclear")
    expect(whose("Is it", "it is ready for review")).toBe("unclear")
    expect(whose("And all the", line)).toBe("unclear")
    expect(whose("Over in yapd and the tests pass.", saying)).toBe("unclear")
  })

  test("takes a sentence of his for his, though it has a word or a phrase of what Whisper makes up in it", () => {
    const line = "Codex finished the migration on yapd and all the tests pass now. Do you want me to open the pull request?"
    for (const heard of ["Post it in the release channel.", "Pause the video.", "Is it watching the files?", "Turn the music down.", "Excuse me, what did it do?"]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
    }
    for (const heard of ["Merge it, then post in the channel.", "I'm sorry, don't merge it."]) {
      expect([heard, whose(heard, `${saying} and the pull request is ready for review`)]).toEqual([heard, "his"])
    }
  })

  test("takes words of his beside a word of its that not just anything has, or like one, for unclear, as they may be its voice", () => {
    const long = `${saying} and the pull request is ready for review, so I can merge it`
    for (const heard of [
      "Over in yapd. Don't merge it until the review is done.", "Over in yapd, the tests pass now open a PR", "Over in yapd, the tests pass now which PR",
      "Over in Japan, tell it to open a PR.", "Over in your app. Don't merge it.", "Tests pass, flaky build.", "The tests are flaky.",
      "Merge it, then post in the channel.", "The tests failed.", "Is the pull request merged?", "Fix the tests.", "The tests are not passing now.",
    ]) {
      expect([heard, whose(heard, long)]).toEqual([heard, "unclear"])
    }
    expect(whose("Close the pull request.", "Codex opened the pull request, sir.")).toBe("unclear")
    expect(whose("Send it again? Yes.", "Send it again?")).toBe("unclear")
    expect(whose("Don't merge it.", "Shall I merge the pull request, sir?")).toBe("unclear")
    expect(whose("Over in t3code, what failed?", "Over in t3code, Codex fixed the flaky login test and pushed the branch, sir.")).toBe("unclear")
    // A word of his only like one of its: the start of it, or a letter away.
    expect(whose("Open it.", "Claude opened a pull request on the docs site")).toBe("unclear")
    expect(whose("Approve.", "Codex is waiting on your approval to delete the branch")).toBe("unclear")
  })

  test("takes a stop or a wait of his yapd isn't saying for a stop, though its own voice runs into it, and takes only that", () => {
    const long = `${saying} and the pull request is ready`
    for (const [heard, stop] of [
      ["Over in yapd, the tests. Stop.", "Stop."], ["Over in yapd. Not now.", "Not now."], ["Over in yapped. Not now.", "Not now."],
      ["Over in yapd. No, wait.", "Wait."], ["Over in yapd, the tests skip this one.", "Skip."], ["Over in yapd, the tests pass. Hold on, which PR was that?", "Hold on."],
      ["Tell it to wait. in yapd, the tests", "Wait."], ["Stop. in yapd, the tests", "Stop."], ["Wait, which pull request?", "Wait."],
      ["Over in yapd. Never mind.", "Never mind."], ["Over in yapd. That's enough.", "That's enough."], ["Over in yapd, hold on a second.", "Hold on."],
    ] as const) {
      expect([heard, whose(heard, long), stopIn(heard, long)]).toEqual([heard, "stop", stop])
    }
    expect(whose("Over in t3code, wait a second.", "Over in t3code, Codex fixed the flaky login test and pushed the branch, sir.")).toBe("stop")
    expect(stopIn("Over in t3code, wait a second.", "Over in t3code, Codex fixed the flaky login test and pushed the branch, sir.")).toBe("Wait a second.")
    expect(whose("yapd's tests, hold on.", "yapd's tests are failing on the main branch")).toBe("stop")
    // Beside a word of its that ends as a "wait" would sound, run together with it, but only beside it.
    for (const [heard, line] of [
      ["Over in yapd. Wait.", long], ["Over in yapd, wait.", long], ["Codex finished. Wait.", "Codex finished the migration and the tests pass"],
      ["The build. Wait.", "The build is green and the tests pass"],
    ] as const) {
      expect([heard, whose(heard, line), stopIn(heard, line)]).toEqual([heard, "stop", "Wait."])
    }
    // All of the longest he said.
    expect(stopIn("Over in yapd. Wait a second.", long)).toBe("Wait a second.")
    // Never one he turns around.
    for (const heard of ["Don't wait for CI, merge it.", "No need to wait, merge it.", "Don't stop the deploy, the tests are fine."]) {
      expect([heard, stopIn(heard, `${long} for review, so I can merge it`), whose(heard, `${long} for review, so I can merge it`)]).toEqual([heard, undefined, "unclear"])
    }
    // But one said after a sentence that ends turning something around is his.
    for (const heard of ["Over in yapd. No, don't. Stop.", "Over in yapd. Don't. Stop.", "Over in yapd. Don't! Wait."]) {
      expect([heard, whose(heard, long)]).toEqual([heard, "stop"])
    }
    // His stop, with a word of its like it, but not the same, nor the start of one.
    expect([whose("Wait.", "Codex wants your approval to delete the old branch."), stopIn("Wait.", "Codex wants your approval")]).toEqual(["stop", "Wait."])
    expect(whose("Stop.", "Claude finished the first two steps of the plan.")).toBe("stop")
    expect(stopIn("Not now.", "it wants to know which page you meant")).toBe("Not now.")
    // Clearly his, it's all taken, stop and all.
    expect(whose("Hold on, which PR was that?", long)).toBe("his")
    expect(whose("Stop now.", "Codex stopped the server")).toBe("unclear")
    expect(stopIn("Over in yapd, the tests pass.", long)).toBeUndefined()
  })

  test("takes what Whisper makes up of everyday words over yapd's for unclear, unless it's said just so", () => {
    const line = "Codex on yapd finished the migration, and all the tests pass"
    for (const heard of [
      "I'm going to go.", "Let's go.", "I'm sorry.", "I don't know.", "That's it.", "That's all.", "Come on.", "Here we go.",
      "I'll see you in the next one.", "See you guys.", "Thank you for your attention.", "I'll be right back.", "Have a nice day.",
      "Take care.", "Good luck.", "Welcome back.",
    ]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "unclear"])
    }
    for (const heard of ["Not now.", "Do it.", "What did you do?", "Which one?", "Go on."]) {
      expect([heard, whose(heard, line)]).toEqual([heard, "his"])
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
 * unless it says otherwise, what's worked out from is kept in `responded`,
 * and what yapd says back in `rendered`.
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
    /** How long rendering what yapd says back takes, in seconds, as Kokoro does: at once unless said. */
    readonly rendering?: number
    /** Frames of a value the voice detector takes so many milliseconds over each, so it runs behind what's heard after them. */
    readonly lagging?: readonly [number, number]
    /** Samples, at 24 kHz, of a file rendered for "Sir?", which then plays for as long as the file lasts and finishes by itself. */
    readonly sir?: Float32Array
    /** Whether "Sir?" can't be rendered. */
    readonly speechless?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    /** Files rendered for "Sir?", which play for as long as they last. */
    const files = new Set<string>()
    /** Lines finishing by themselves as they play. */
    const finishing: Array<Fiber.RuntimeFiber<void>> = []
    /** When each line started playing, by the clock. */
    const starts: Array<number> = []
    const commands: Array<string> = []
    /** Where each line was played from, in seconds. */
    const plays: Array<number> = []
    const transcribed: Array<string> = []
    const sent: Array<string> = []
    /** What a reply was worked out from, in order. */
    const responded: Array<string> = []
    /** What yapd says back, in order. */
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
    yield* Effect.addFinalizer(() => Effect.sync(() => connection?.terminate()).pipe(Effect.zipRight(Fiber.interruptAll(finishing))))
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
                  }
                  commands.push(command.type)
                  if (command.type === "play") {
                    if (!running) send({ type: "active", listening: true })
                    running = true
                    playing = { id: command.id ?? "", since: now(), from: command.from ?? 0 }
                    plays.push(playing.from)
                    starts.push(playing.since)
                    // As long as its samples last, as the WAV file says.
                    const file = command.path !== undefined && files.has(command.path) ? readFileSync(command.path) : undefined
                    const lasting = file === undefined ? undefined : new DataView(file.buffer, file.byteOffset).getUint32(40, true) / 2 / 24000
                    send({ type: "playing", id: command.id, duration: lasting ?? options.duration ?? 10 })
                    if (lasting !== undefined) {
                      const id = playing.id
                      finishing.push(
                        Runtime.runFork(runtime)(
                          Effect.sleep(`${Math.round(lasting * 1000)} millis`).pipe(
                            Effect.zipRight(
                              Effect.sync(() => {
                                if (playing?.id !== id) return
                                send({ type: "finished", id })
                                playing = undefined
                              }),
                            ),
                          ),
                        ),
                      )
                    }
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
      Layer.succeed(Vad, {
        make: Effect.succeed((frame: Float32Array) =>
          options.lagging !== undefined && frame[0] === Math.fround(options.lagging[0])
            ? Effect.promise(() => new Promise((resolve) => setTimeout(resolve, options.lagging![1]))).pipe(Effect.as(frame[0]!))
            : Effect.succeed(frame[0]!),
        ),
      }),
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
          return Effect.sync(() => void responded.push(heard)).pipe(
            Effect.zipRight(Effect.sleep(`${options.responding ?? 0} seconds`)),
            Effect.as({ intent, spoken: intent === "send" ? "Okay." : "", message: intent === "send" ? heard : "" }),
          )
        },
      }),
      Layer.succeed(Voice, {
        render: (text, path) =>
          options.speechless === true && text === Conversation.cue
            ? Effect.fail(new ProcessError({ command: "kokoro", code: 1, stderr: "It couldn't render." }))
            : Effect.sync(() => void rendered.push(text)).pipe(
                Effect.zipRight(options.rendering === undefined ? Effect.void : Effect.sleep(`${options.rendering} seconds`)),
                Effect.zipRight(
                  options.sir === undefined || text !== Conversation.cue
                    ? Effect.void
                    : Effect.promise(() => Bun.write(path, wav(options.sir!, 24000))).pipe(Effect.zipRight(Effect.sync(() => void files.add(path)))),
                ),
              ),
      }),
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
      responded,
      rendered,
      interrupted: () => interrupted,
      /** Seconds since the last line started playing, by the clock. */
      since: Effect.sync(() => (now() - (starts.at(-1) ?? 0)) / 1000),
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

  test("falls quiet for the user once Whisper has made out it's clearly him, says \"Sir?\", and takes none of what he said over them", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to deploy."]])
        yield* helper.talk(0.9, 10)
        // Still talking: it could be its own voice until it's made out.
        const talking = [...helper.commands]
        yield* helper.quiet
        const stopped = [...helper.commands]
        // Only once the last of its voice has stopped coming in too.
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          talking,
          stopped,
          commands: helper.commands,
          rendered: helper.rendered,
          transcribed: helper.transcribed,
          responded: helper.responded,
          sent: helper.sent,
          replies: yield* helper.replies,
        }
      }),
    )
    expect(result).toEqual({
      talking: ["play"],
      stopped: ["play", "stop"],
      commands: ["play", "stop", "play"],
      rendered: ["Sir?"],
      transcribed: ["Tell it to deploy."],
      responded: [],
      sent: [],
      replies: [],
    })
  })

  test("takes only his stop once it's made out, never what he goes on with after them while it is, which is all one with it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes five seconds over the first.
        const helper = yield* overHelper([[0.91, "Hold on."], [0.92, "Merge it."]], { delays: [5], intent: "dismiss" })
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.wait(3.5)
        yield* helper.talk(0.92, defaults.confirm)
        const going = [...helper.commands]
        yield* helper.talk(0.92, 6)
        yield* helper.quiet
        yield* helper.wait(2)
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        return { going, commands: helper.commands, transcribed: helper.transcribed, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    // Carried on over what he went on with, as over all he says until he and yapd have both been quiet a moment.
    expect(result.going).toEqual(["play"])
    expect(result).toMatchObject({ commands: ["play", "stop"], transcribed: ["Hold on.", "Merge it."], responded: ["Hold on."], sent: [], replies: ["Hold on."] })
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

  test("carries on over the user talking on past them until he's finished, then falls quiet and says \"Sir?\", taking none of it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.93, "Listen, Jarvis,"], [0.94, "I need to tell you something."]])
        yield* helper.wait(2.5)
        yield* helper.talk(0.93, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.94, 35)
        // Looked at as he goes on, only for a stop of his.
        const talking = [...helper.commands]
        yield* helper.talk(0.94, 30)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.wait(1)
        return { talking, commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ talking: ["play"], commands: ["play", "stop", "play"], rendered: ["Sir?"], sent: [], replies: [] })
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
          intent: "dismiss",
        })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], responded: ["Hold on."], sent: [], replies: ["Hold on."] })
  })

  test("goes back to before the user began when he wasn't talking to it, since it only stopped once it made out it was him", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]], { intent: "resume" })
        yield* helper.wait(2)
        yield* helper.talk(0.9, 10)
        yield* helper.wait(1.5)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, plays: helper.plays }
      }),
    )
    expect(result.commands.slice(0, 3)).toEqual(["play", "stop", "play"])
    // A second and a half before he began, two seconds in, rather than before where it stopped, three and a half seconds in.
    expect(result.plays).toEqual([0, 0.5])
  })

  test("lets what it's making out decide how a line ends that finishes meanwhile, however long that takes, and falls quiet for him only then", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // A line short enough to be over before Whisper is done, which takes longer than yapd waits for a reply.
        const helper = yield* overHelper([[0.9, "Tell it to deploy."]], { delays: [10], duration: 2, spoken: "Codex is done, sir." })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.finish
        for (let second = 0; second < 10; second++) yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered] }
        // Nothing said back once it has.
        yield* helper.finish
        for (let second = 0; second < 4; second++) yield* helper.wait(1)
        const exit = yield* Fiber.poll(helper.fiber)
        return { asked, done: Option.isSome(exit), sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ asked: { commands: ["play", "play"], rendered: ["Sir?"] }, done: true, sent: [], replies: [] })
  })

  test("still replies to a stop of his it was making out when the helper quits meanwhile", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on, merge it."]], { delays: [5], intent: "dismiss" })
        yield* helper.wait(1)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.quit
        yield* helper.wait(5)
        return { responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ responded: ["Hold on."], sent: [], replies: ["Hold on."] })
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

  test("takes his stop, and lets go of its voice heard after it while that's made out, rather than add it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes three seconds over what he said, while its voice gets in again.
        const helper = yield* overHelper([[0.9, "Hold on."], [0.8, "the tests pass now and the pull request"]], { delays: [3], intent: "dismiss" })
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
        return { stopped, responded: helper.responded, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], responded: ["Hold on."], rendered: [], sent: [], replies: ["Hold on."] })
  })

  test("takes its voice still coming in just after it falls quiet for him for part of what he said over them, and says \"Sir?\" only once that's over", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to open a PR."], [0.8, "the tests pass now"]])
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        const stopped = [...helper.commands]
        // The last of its voice, still coming in once it has stopped.
        yield* helper.talk(0.8, 6)
        const before = [...helper.commands]
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          stopped,
          before,
          commands: helper.commands,
          rendered: helper.rendered,
          transcribed: helper.transcribed,
          responded: helper.responded,
          sent: helper.sent,
          replies: yield* helper.replies,
        }
      }),
    )
    expect(result).toEqual({
      stopped: ["play", "stop"],
      before: ["play", "stop"],
      commands: ["play", "stop", "play"],
      rendered: ["Sir?"],
      transcribed: ["Tell it to open a PR.", "the tests pass now"],
      responded: [],
      sent: [],
      replies: [],
    })
  })

  test("adds nothing the user goes on with as the last of its voice comes in, just after it falls quiet for him, and takes all he says again after \"Sir?\" whole", async () => {
    const again = "Tell it to open a PR and merge it."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to open a PR."], [0.91, "and merge it"], [0.92, again]], { responding: 2 })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        // What he carries on with straight after, as the last of its voice comes in.
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], responded: [...helper.responded] }
        yield* helper.finish
        yield* helper.talk(0.92, 20)
        yield* helper.quiet
        yield* helper.wait(3)
        return { asked, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      asked: { commands: ["play", "stop", "play"], rendered: ["Sir?"], responded: [] },
      responded: [again],
      sent: [again],
      replies: [again],
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
  test("takes only the \"hold on\" of his in what the user says across the end of them, made out whole, when some of the rest is yapd's words", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.93, "Hold on, tell it to"], [0.94, "merge the pull request."]], { intent: "dismiss" })
        yield* helper.wait(2.3)
        yield* helper.talk(0.93, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.94, 30)
        yield* helper.quiet
        yield* helper.wait(4)
        return { commands: helper.commands.slice(0, 2), responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], responded: ["Hold on."], sent: [], replies: ["Hold on."] })
  })

  test("falls quiet for what the user says across the end of them, though Whisper takes a while to make it out, taking none of it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes three seconds over a look at what he's said so far.
        const helper = yield* overHelper([[0.93, "Tell it to"], [0.94, "deploy to staging."]], { delays: [3] })
        yield* helper.wait(2.3)
        yield* helper.talk(0.93, 10)
        yield* helper.wait(1)
        yield* helper.talk(0.94, 30)
        yield* helper.quiet
        yield* helper.wait(4)
        yield* helper.wait(1)
        return { commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop", "play"], rendered: ["Sir?"], sent: [], replies: [] })
  })

  test("makes out a stop the user says across the end of them whole, as Whisper hears it, and takes only that", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.93, "Not"], [0.94, "now."]], { intent: "dismiss" })
        yield* helper.wait(2.7)
        yield* helper.talk(0.93, 8)
        yield* helper.wait(0.5)
        yield* helper.talk(0.94, 8)
        yield* helper.quiet
        yield* helper.wait(4)
        return { commands: helper.commands, transcribed: helper.transcribed, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], transcribed: ["Not now."], responded: ["Not now."], sent: [], replies: ["Not now."] })
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

  test("doesn't add its own voice, paused as what the user said before is made out to be his stop, to it, but takes that on its own", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hold on."], [0.8, "the tests pass now and the pull request"]], { delays: [3], intent: "dismiss" })
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.talk(0.8, 10)
        yield* helper.talk(0, 5)
        yield* helper.wait(2)
        const stopped = [...helper.commands]
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], responded: ["Hold on."], sent: [], replies: ["Hold on."] })
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

  test("stops for a stop of the user's run straight on from its own voice, and takes only that, never its words", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Hold on, which PR was that?"]], { intent: "dismiss" })
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        const exit = yield* Fiber.poll(helper.fiber)
        return { commands: helper.commands, done: Option.isSome(exit), responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], done: true, responded: ["Hold on."], sent: [], replies: ["Hold on."] })
  })

  test("doesn't stop for words the user talks straight on from its own voice with, or its own voice runs on after, taking none of them", async () => {
    for (const [first, then] of [
      [[0.8, "Over in yapd, the tests pass now"], [0.9, "open a PR"]],
      [[0.8, "Over in yapd, the tests pass now"], [0.9, "which PR"]],
      [[0.9, "Which PR was that?"], [0.8, "in yapd, the tests pass now"]],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          // Whisper runs what he says on from its voice, or its voice on from his, without a full stop between.
          const helper = yield* overHelper([first, then], { live: true })
          yield* helper.wait(0.3)
          yield* helper.talk(first[0], 20)
          yield* helper.talk(then[0], 30)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([first[1], result]).toEqual([first[1], { commands: ["play"], rendered: [], sent: [], replies: [] }])
    }
  }, 30_000)

  test("stops for the stop or wait in the user's question about what it just said, taking only that, as the rest is its words", async () => {
    // Made out once he's done, and, talking on, partway through and again once he's done.
    for (const [at, said, frames, stop] of [
      [1, "Wait, which pull request?", 20, "Wait."], [0.8, "Hold on, what about the tests?", 20, "Hold on."], [0.5, "Hold on a second, what about the tests?", 45, "Hold on."],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said]], { live: true, intent: "dismiss" })
          yield* helper.wait(at)
          yield* helper.talk(0.9, frames)
          yield* helper.quiet
          // The microphone goes on hearing quiet, as the last of its voice stops coming in.
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands.slice(0, 2), responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { commands: ["play", "stop"], responded: [stop], sent: [], replies: [stop] }])
    }
  }, 30_000)

  test("stops for a stop of the user's that its own voice runs on into, and takes only that, never its words", async () => {
    for (const [said, stop] of [["Stop.", "Stop."], ["Tell it to wait.", "Wait."]] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said], [0.8, "in yapd, the tests"]], { intent: "dismiss" })
          yield* helper.wait(0.3)
          yield* helper.talk(0.9, 12)
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, 12)
          yield* helper.quiet
          // The microphone goes on hearing quiet, as the last of its voice stops coming in.
          yield* helper.quiet
          yield* helper.wait(1)
          const exit = yield* Fiber.poll(helper.fiber)
          return { commands: helper.commands, done: Option.isSome(exit), responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { commands: ["play", "stop"], done: true, responded: [stop], sent: [], replies: [stop] }])
    }
  })

  test("stops about a second in for a stop of the user's heard in full though its own voice runs on after him, and takes only that", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Skip this one."], [0.8, "in yapd, the tests pass now"]], { intent: "dismiss" })
        yield* helper.wait(0.3)
        yield* helper.talk(0.9, 15)
        yield* helper.wait(0.5)
        yield* helper.talk(0.8, 25)
        const early = [...helper.commands]
        yield* helper.talk(0.8, 15)
        yield* helper.wait(1)
        yield* helper.quiet
        yield* helper.wait(1)
        return { early, responded: helper.responded, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ early: ["play", "stop"], responded: ["Skip."], rendered: [], sent: [], replies: ["Skip."] })
  })

  test("falls quiet for what the user says across the end of them, begun with a word that only fills a pause, taking none of it", async () => {
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
        return { commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop", "play"], rendered: ["Sir?"], sent: [], replies: [] })
  })

  test("lets go of the user's answer when it runs on from the last of its question's voice, and takes it when he says it again", async () => {
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
        const before = [...answers]
        yield* helper.talk(0.91, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ before: [], rendered: [], answered: true, answers: ["Yapd."] })
  })

  test("takes nothing of a quick yes to a short question said over its voice, says \"Sir?\" once he's finished, and takes his yes then for the answer", async () => {
    for (const said of ["Yes.", "Yeah.", "Yes, please."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const answers: Array<string> = []
          const helper = yield* overHelper([[0.9, said], [0.91, said]], { duration: 1.2 })
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
          const asked = { rendered: [...helper.rendered], answers: [...answers] }
          yield* helper.finish
          yield* helper.talk(0.91, 10)
          yield* helper.quiet
          yield* helper.wait(1)
          return { asked, answered: yield* Fiber.join(asking), answers }
        }),
      )
      expect([said, result]).toEqual([said, { asked: { rendered: ["Sir?"], answers: [] }, answered: true, answers: [said] }])
    }
  }, 30_000)

  test("lets go of the user's yes when it runs on from the last of a short question's voice, and takes it when he says it again", async () => {
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
        const before = [...answers]
        yield* helper.talk(0.91, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ before: [], rendered: [], answered: true, answers: ["Yes."] })
  })

  test("lets go of the user's reply when it runs on from the last of a short line's voice, and passes it on when he says it again", async () => {
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
        const before = [...helper.sent]
        yield* helper.talk(0.92, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { before, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ before: [], rendered: ["Okay."], sent: ["Merge it."], replies: ["Merge it."] })
  })

  test("lets go of the user's answer when it's one of the question's last words, begun over them and gone on past its voice, and takes it when he says it again", async () => {
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
          const before = [...answers]
          yield* helper.talk(0.91, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          return { before, rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
        }),
      )
      expect([said, result]).toEqual([said, { before: [], rendered: [], answered: true, answers: [said] }])
    }
  }, 30_000)

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

  test("stops for a stop of his a look about a second in heard only as the last word, once all of it bears that out, though Whisper hears only yapd's voice in all of it", async () => {
    for (const [spoken, looked, whole, stop] of [
      [long.spoken, "Wait.", "and the PR.", "Wait."],
      [
        "Two threads need you, sir. The Tezos importer asks which fee table to use, and the pull request on yapd is ready for review.",
        "Two threads need to skip.",
        "Two threads need a T-ZO's importer.",
        "Skip.",
      ],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, looked], [0.81, ""]], { spoken, whole: [[0.8, 0.81], whole], live: true, intent: "dismiss" })
          yield* helper.wait(0.3)
          // A look about a second in, which hears his stop as the last word, then its own voice going on.
          yield* helper.talk(0.8, 36)
          const looking = [...helper.commands]
          yield* helper.talk(0.81, 10)
          yield* helper.quiet
          // The microphone goes on hearing quiet, as the last of its voice stops coming in.
          yield* helper.quiet
          yield* helper.wait(1)
          return { looking, commands: helper.commands, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([stop, result]).toEqual([stop, { looking: ["play"], commands: ["play", "stop"], responded: [stop], sent: [], replies: [stop] }])
    }
  })

  test("lets go of the user's words run on from its own voice, carrying on, and passes them on whole when he says them again after them", async () => {
    const said = "Don't merge it until the review is done."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd."], [0.9, said], [0.91, said]], { live: true })
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 12)
        yield* helper.talk(0.9, 40)
        yield* helper.quiet
        yield* helper.wait(1)
        const ignored = { commands: [...helper.commands], responded: [...helper.responded], sent: [...helper.sent], replies: [...(yield* helper.replies)] }
        // Past its first three seconds, as he says it again.
        yield* helper.talk(0.91, 40)
        yield* helper.quiet
        yield* helper.wait(1)
        return { ignored, transcribed: helper.transcribed, commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    // Looked at for a stop of his while he talked, then made out whole once he'd finished, and let go.
    expect(result.ignored).toEqual({ commands: ["play"], responded: [], sent: [], replies: [] })
    expect(result.transcribed.slice(0, 2)).toEqual([`Over in yapd. ${said}`, `Over in yapd. ${said}`])
    expect(result.transcribed.at(-1)).toBe(said)
    expect(result.commands).toEqual(["play", "volume", "stop", "play"])
    expect(result.sent).toEqual([said])
    expect(result.replies).toEqual([said])
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
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        return { plays: helper.plays, sent: helper.sent }
      }),
    )
    // A second and a half before he began, two seconds in.
    expect(result).toEqual({ plays: [0, 0.5], sent: [] })
  })

  test("keeps to a stop of his it stopped for a second in, though Whisper leaves it out of all of it, rather than carry on as if he hadn't said it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // A look partway hears a skip of his, which Whisper, hearing all of it, leaves out for its voice.
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.81, "Skip the"], [0.82, "and the"]], {
          whole: [[0.8, 0.81, 0.82], "Over in yapd, the tests pass now and the pull request."],
          live: true,
          intent: "dismiss",
        })
        yield* helper.wait(1)
        yield* helper.talk(0.8, 30)
        yield* helper.talk(0.81, 10)
        const stopped = [...helper.commands]
        yield* helper.talk(0.82, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, commands: helper.commands, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "stop"], commands: ["play", "stop"], responded: ["Skip."], sent: [], replies: ["Skip."] })
  })

  test("keeps to a stop of his it stopped for a second in, though all Whisper hears of it is a word nearly anything has, like the \"on\" of \"working on\"", async () => {
    for (const [spoken, before, whole, stop] of [
      [
        "Over in homelab, the agent is working on the migration and the tests pass now, sir. Shall I open the pull request?",
        "Over in homelab, the agent is",
        "Over in homelab, the agent is working on the migration.",
        "Hold on.",
      ],
      [long.spoken, "Over in yapd, the tests pass.", "Over in yapd, the tests pass now and the pull request.", "Not now."],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          // A look partway hears a stop of his, which Whisper, hearing all of it, leaves out for its voice, with a word of it among its own.
          const helper = yield* overHelper([[0.8, before], [0.81, `${stop.slice(0, -1)} the`], [0.82, "and the"]], {
            spoken,
            whole: [[0.8, 0.81, 0.82], whole],
            live: true,
            intent: "dismiss",
          })
          yield* helper.wait(1)
          yield* helper.talk(0.8, 30)
          yield* helper.talk(0.81, 10)
          yield* helper.talk(0.82, 10)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands, plays: helper.plays, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([stop, result]).toEqual([stop, { commands: ["play", "stop"], plays: [0], responded: [stop], sent: [], replies: [stop] }])
    }
  })

  test("picks up from before where the user began when what it stopped for a second in turns out to be its own word once it's made out whole", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // A look partway hears its "step" as a stop, which Whisper hears right once it has all of it.
        const helper = yield* overHelper([[0.8, "Over in homelab, the agent is on the last"], [0.81, "stop of"], [0.82, "the plan."]], {
          spoken: "Over in homelab, the agent is on the last step of the plan and the tests pass now, sir. Shall I open the pull request?",
          whole: [[0.8, 0.81, 0.82], "Over in homelab, the agent is on the last step of the plan."],
          live: true,
        })
        yield* helper.wait(1)
        yield* helper.talk(0.8, 30)
        yield* helper.talk(0.81, 10)
        const stopped = [...helper.commands]
        yield* helper.talk(0.82, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, commands: helper.commands, plays: helper.plays, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.stopped).toEqual(["play", "stop"])
    // Again from a second and a half before he began, with nothing taken in.
    expect(result).toMatchObject({ commands: ["play", "stop", "play"], plays: [0, 0], responded: [], sent: [], replies: [] })
  })

  test("stops for a stop of the user's as he pauses after it, while its own voice getting in goes on, without waiting for the end", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass now"], [0.9, "Skip."], [0.81, "and the pull request"]], {
          live: true,
          intent: "dismiss",
        })
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 20)
        yield* helper.talk(0.9, 8)
        // A moment's pause, then its own voice again, with no look about a second in yet.
        yield* helper.talk(0, 8)
        yield* helper.talk(0.81, 4)
        const early = [...helper.commands]
        yield* helper.quiet
        yield* helper.wait(1)
        return { early, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ early: ["play", "stop"], responded: ["Skip."], sent: [], replies: ["Skip."] })
  })

  test("takes only the stop of his in what the user starts saying as it stops, when the rest is in its words, like \"Tell it to stop the migration.\"", async () => {
    const said = "Tell it to stop the migration."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.91, "Tell it to"], [0.92, "stop the migration."]], {
          live: true,
          duration: 2.5,
          spoken: "Claude is still running the migration, sir.",
          whole: [[0.91, 0.92], said],
          intent: "dismiss",
        })
        yield* helper.wait(2)
        yield* helper.talk(0.91, 16)
        yield* helper.finish
        yield* helper.talk(0.92, 30)
        yield* helper.quiet
        yield* helper.wait(1)
        return { responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ responded: ["Stop."], sent: [], replies: ["Stop."] })
  })

  test("stops for a stop or a wait from its first word, and has the update dismissed on just what was said", async () => {
    for (const said of ["Stop.", "Hold on."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said]], { intent: "dismiss", live: true })
          yield* helper.talk(0.9, 10)
          // Still talking: it could be its own voice until he's finished and it's made out.
          const talking = [...helper.commands]
          yield* helper.quiet
          // The microphone goes on hearing quiet, as the last of its voice stops coming in.
          yield* helper.quiet
          yield* helper.wait(1)
          const exit = yield* Fiber.poll(helper.fiber)
          return {
            talking,
            commands: helper.commands,
            done: Option.isSome(exit),
            responded: helper.responded,
            sent: helper.sent,
            replies: yield* helper.replies,
          }
        }),
      )
      expect([said, result]).toEqual([
        said,
        { talking: ["play"], commands: ["play", "stop"], done: true, responded: [said], sent: [], replies: [said] },
      ])
    }
  }, 30_000)

  test("stops for a stop of the user's that its own voice runs into from its first word, acting on that alone", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests."], [0.9, "Stop."]], { intent: "dismiss", live: true })
        yield* helper.wait(0.1)
        yield* helper.talk(0.8, 20)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        const exit = yield* Fiber.poll(helper.fiber)
        return {
          transcribed: helper.transcribed,
          commands: helper.commands,
          done: Option.isSome(exit),
          responded: helper.responded,
          sent: helper.sent,
          replies: yield* helper.replies,
        }
      }),
    )
    expect(result).toEqual({
      transcribed: ["Over in yapd, the tests. Stop."],
      commands: ["play", "stop"],
      done: true,
      responded: ["Stop."],
      sent: [],
      replies: ["Stop."],
    })
  })

  test("stops for a wait of the user's straight after its name, which ends as a \"wait\" would sound, acting on that alone", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd."], [0.9, "Wait."]], { intent: "dismiss", live: true })
        yield* helper.wait(0.1)
        yield* helper.talk(0.8, 20)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], responded: ["Wait."], sent: [], replies: ["Wait."] })
  })

  test("falls quiet for what's clearly the user over its first second once he's finished, says \"Sir?\", and takes what he says again then whole, never what he said over it", async () => {
    const said = "Which PR was that?"
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, said], [0.91, said]], { live: true })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 20)
        const talking = [...helper.commands]
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent] }
        yield* helper.finish
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { talking, asked, commands: helper.commands, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.talking).toEqual(["play"])
    // Stopped once it made out it was him, and asked once he and yapd had both been quiet a moment, with nothing taken.
    expect(result.asked).toEqual({ commands: ["play", "stop", "play"], rendered: ["Sir?"], responded: [], sent: [] })
    // What he said again, after it, is taken like any reply: "Sir?" wasn't stopped for it, as it had played to the end.
    expect(result).toMatchObject({ commands: ["play", "stop", "play", "play"], responded: [said], sent: [said], replies: [said] })
  })

  test("lets go of words over them that yapd says a few seconds after, as where each word falls in a line is only guessed", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Its "ready for review" comes about four seconds after he begins.
        const helper = yield* overHelper([[0.9, "Is it ready for review?"]], { live: true })
        yield* helper.wait(0.3)
        yield* helper.talk(0.9, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play"], sent: [], replies: [] })
  })

  test("falls quiet for everyday words of his over them, though they're only words nearly anything has, and takes none of them", async () => {
    for (const said of ["Why did it do that?", "Don't do it."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, said]], { live: true })
          yield* helper.wait(1)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          // The microphone goes on hearing quiet, as the last of its voice stops coming in.
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([said, result]).toEqual([said, { commands: ["play", "stop", "play"], rendered: ["Sir?"], sent: [], replies: [] }])
    }
  }, 30_000)

  test("falls quiet for a word of his beside its words over them, rather than take it for its name misheard, and takes none of it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Deploy it."]], { live: true, spoken: "The build is green. It wants to know whether to deploy, sir." })
        yield* helper.wait(1.8)
        yield* helper.talk(0.9, 12)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop", "play"], rendered: ["Sir?"], sent: [], replies: [] })
  })

  test("doesn't stop for its own voice with its name misheard or written in two, as a look at it about a second in sees it, nor once it's made out whole", async () => {
    const t3code = "Over in t3code, Codex fixed the flaky login test and pushed the branch, sir. It wants to know whether to deploy."
    for (const [spoken, soFar, rest] of [
      [long.spoken, "Over in yapped,", "the tests pass now."],
      [long.spoken, "Over in your app", "the tests"],
      [long.spoken, "Over in your app, the tests", "pass now."],
      [t3code, "Over in T3 Code", "Codex fixed the"],
      [t3code.replace("t3code", "minas-sv2"), "Over in my NAS", "Codex fixed the"],
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
          return { commands: helper.commands, transcribed: helper.transcribed, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([soFar, result]).toEqual([
        soFar,
        { commands: ["play"], transcribed: [soFar, `${soFar} ${rest}`], rendered: [], sent: [], replies: [] },
      ])
    }
  }, 60_000)

  test("takes nothing of what the user says over them on either side of a pause, like \"Don't... merge it yet.\", and all of it when he says it again after \"Sir?\"", async () => {
    const said = "Don't merge it yet."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Don't..."], [0.91, "merge it yet."], [0.92, said]], {
          live: true,
          spoken: "Over in yapd, Codex opened the pull request and the checks are all green now, sir. Shall I merge it?",
        })
        yield* helper.wait(0.3)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.talk(0, 3)
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], responded: [...helper.responded] }
        yield* helper.finish
        yield* helper.talk(0.92, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { asked, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      asked: { commands: ["play", "stop", "play"], rendered: ["Sir?"], responded: [] },
      responded: [said],
      sent: [said],
      replies: [said],
    })
  })

  test("takes nothing of a short answer of everyday words over the end of a short question it asked over them, and takes it when he says it again after \"Sir?\"", async () => {
    for (const said of ["Go for it.", "Don't."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const answers: Array<string> = []
          const helper = yield* overHelper([[0.9, said], [0.91, said]], { duration: 2.2 })
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
          const before = [...answers]
          yield* helper.finish
          yield* helper.talk(0.91, 10)
          yield* helper.quiet
          yield* helper.wait(1)
          return { before, rendered: helper.rendered, answered: yield* Fiber.join(asking), answers }
        }),
      )
      expect([said, result]).toEqual([said, { before: [], rendered: ["Sir?"], answered: true, answers: [said] }])
    }
  }, 30_000)

  test("takes nothing of what the user says a moment after its own voice got in right up to the end of them, falls quiet for it, and takes it when he says it again after \"Sir?\"", async () => {
    const said = "Tell it to open a PR."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass now and the"], [0.9, said], [0.91, said]], { live: true })
        yield* helper.wait(0.3)
        // Its own voice until a little past its first three seconds, then a moment's quiet, shorter than ends what he says, and him.
        yield* helper.talk(0.8, 88)
        yield* helper.talk(0, 12)
        yield* helper.talk(0.9, 6)
        const going = [...helper.commands]
        yield* helper.talk(0.9, 14)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], responded: [...helper.responded] }
        yield* helper.finish
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        return { going, asked, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    // Neither ducked nor stopped at once, as it would be once what was said over them is over, since he went on within a moment of it.
    expect(result.going).toEqual(["play"])
    expect(result).toEqual({
      going: ["play"],
      asked: { commands: ["play", "stop", "play"], rendered: ["Sir?"], responded: [] },
      responded: [said],
      sent: [said],
      replies: [said],
    })
  })

  test("stops at once for what the user says once what was said over them is over, its own voice up to their end and all, and takes it whole, as ever", async () => {
    const said = "Tell it to open a PR."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass now and the"], [0.9, said]], { live: true })
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 88)
        // Over a second's quiet, longer than ends what was said over them.
        yield* helper.talk(0, 35)
        yield* helper.talk(0.9, 6)
        const stopped = [...helper.commands]
        yield* helper.talk(0.9, 14)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, rendered: helper.rendered, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "volume", "stop"], rendered: ["Okay."], responded: [said], sent: [said], replies: [said] })
  })

  test("stops at once for the user talking past its first three seconds, and takes what he says whole, as ever", async () => {
    const said = "Which PR was that?"
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, said]], { live: true })
        yield* helper.wait(3.5)
        yield* helper.talk(0.9, 6)
        const stopped = [...helper.commands]
        yield* helper.talk(0.9, 14)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped, transcribed: helper.transcribed, rendered: helper.rendered, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ stopped: ["play", "volume", "stop"], transcribed: [said], rendered: ["Okay."], responded: [said], sent: [said], replies: [said] })
  })

  test("takes nothing of a quick answer said a moment after a short question whose own voice got in right up to its end, and takes it when he says it again after \"Sir?\"", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper([[0.8, "Send it again?"], [0.9, "Yes."], [0.91, "Yes."]], { duration: 1.8, live: true })
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Send it again?",
            answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(0.1)
        yield* helper.talk(0.8, 52)
        yield* helper.finish
        // A moment's quiet, shorter than ends what he says, then him.
        yield* helper.talk(0, 10)
        yield* helper.talk(0.9, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { rendered: [...helper.rendered], answers: [...answers] }
        yield* helper.finish
        yield* helper.talk(0.91, 12)
        yield* helper.quiet
        yield* helper.wait(1)
        return { asked, answered: yield* Fiber.join(asking), answers }
      }),
    )
    expect(result).toEqual({ asked: { rendered: ["Sir?"], answers: [] }, answered: true, answers: ["Yes."] })
  })

  test("takes nothing of what the user goes on with just after its first seconds, within a moment of what he said over them, which was let go, but falls quiet for it rather than act on the rest alone", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to fix the tests,"], [0.91, "and then deploy it."]], { live: true })
        yield* helper.wait(1.6)
        yield* helper.talk(0.9, 28)
        // A pause of 0.6 s, over the end of its first three seconds.
        yield* helper.talk(0, 19)
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, rendered: helper.rendered, transcribed: helper.transcribed, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "stop", "play"],
      rendered: ["Sir?"],
      transcribed: ["Tell it to fix the tests,", "and then deploy it."],
      responded: [],
      sent: [],
      replies: [],
    })
  })

  test("takes only the stop of what the user said over them, never adding what he goes on with straight after, which is the rest of it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes half a second, and working out what to do two.
        const helper = yield* overHelper([[0.9, "Wait for the tests to pass,"], [0.91, "then merge it."]], {
          live: true,
          delays: [0.5],
          responding: 2,
          intent: "dismiss",
        })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 25)
        yield* helper.quiet
        yield* helper.talk(0, 4)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(3)
        return { commands: helper.commands.slice(0, 2), responded: [...new Set(helper.responded)], sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], responded: ["Wait."], sent: [], replies: ["Wait."] })
  })

  test("takes only the stop of his it ran into, never what he goes on with straight after, but says \"Sir?\" for that rather than drop it, and takes it whole then", async () => {
    const said = "Tell it to open a PR."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd."], [0.9, "Stop."], [0.91, said], [0.92, said]], { live: true, responding: 2, intent: "dismiss" })
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 8)
        yield* helper.quiet
        // Just after what he said over them is over, while it works out what to do about his stop.
        yield* helper.talk(0, 4)
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], responded: [...helper.responded], rendered: [...helper.rendered], sent: [...helper.sent], replies: [...(yield* helper.replies)] }
        yield* helper.finish
        yield* helper.talk(0.92, 20)
        yield* helper.quiet
        yield* helper.wait(3)
        return { asked, responded: helper.responded, replies: yield* helper.replies }
      }),
    )
    // Neither his stop, which what he went on with takes the place of, nor that is noted, until he says it again.
    expect(result).toEqual({
      asked: { commands: ["play", "stop", "play"], responded: ["Stop."], rendered: ["Sir?"], sent: [], replies: [] },
      responded: ["Stop.", said],
      replies: [said],
    })
  })

  test("lets go of what the user says straight on from its own voice heard as words of their own, when he says a word of its too, carrying on, and takes it when he says it again", async () => {
    const said = "Tell it to open a PR."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "There are three open form requests, the Acrofit."], [0.9, said], [0.91, said]], {
          live: true,
          spoken: "There are three open pull requests: the echo fix, the menu bar icon and the README.",
        })
        // Its own voice until a little short of its first three seconds, then a moment's quiet, and him, saying its "open".
        yield* helper.talk(0.8, 90)
        yield* helper.talk(0, 12)
        yield* helper.talk(0.9, 30)
        yield* helper.quiet
        yield* helper.wait(1)
        const ignored = { commands: [...helper.commands], responded: [...helper.responded] }
        yield* helper.talk(0.91, 6)
        const stopped = [...helper.commands]
        yield* helper.talk(0.91, 24)
        yield* helper.quiet
        yield* helper.wait(1)
        return { ignored, stopped, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      ignored: { commands: ["play"], responded: [] },
      stopped: ["play", "volume", "stop"],
      responded: [said],
      sent: [said],
      replies: [said],
    })
  })

  test("takes nothing of what the user goes on with just after its first seconds, after its own voice ran on into a word of his, like the \"if\" of \"and if\"", async () => {
    for (const [spoken, heard, at, frames] of [
      [long.spoken, "Over in yapd, the tests pass now and if", 0.3, 88],
      // Without its voice, but a word it says too.
      ["Over in rig, the agent asks if it should merge the pull request now, sir. It says the tests pass and the build is green.", "If.", 2.6, 8],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, heard], [0.9, "the tests fail, revert it."]], { live: true, spoken })
          yield* helper.wait(at)
          yield* helper.talk(0.8, frames)
          // A moment's pause, which ends what he said once its first seconds are over.
          yield* helper.talk(0, 12)
          yield* helper.talk(0.9, 20)
          yield* helper.quiet
          yield* helper.wait(1)
          return { commands: helper.commands, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      // All of it has words of yapd's, so it's let go, as it carries on.
      expect([heard, result]).toEqual([heard, { commands: ["play"], responded: [], sent: [], replies: [] }])
    }
  })

  test("never adds what the user goes on with to the stop of what he said over them before it has worked out what to do, however long he pauses first, but says \"Sir?\" for all of it", async () => {
    const again = "Wait for the tests to pass, then merge it."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes half a second, and working out what to do two.
        const helper = yield* overHelper([[0.9, "Wait for the tests to pass,"], [0.91, "then merge it."], [0.92, again]], {
          live: true,
          delays: [0.5],
          responding: 2,
          intent: "dismiss",
        })
        yield* helper.wait(0.5)
        // A look as he pauses after "Wait" stops it while he goes on.
        yield* helper.talk(0.9, 12)
        yield* helper.talk(0, 6)
        yield* helper.talk(0.9, 13)
        yield* helper.quiet
        // Over a second after what he said ends.
        yield* helper.talk(0, 34)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], sent: [...helper.sent], replies: [...(yield* helper.replies)] }
        yield* helper.finish
        yield* helper.talk(0.92, 40)
        yield* helper.quiet
        yield* helper.wait(3)
        return { asked, responded: helper.responded, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      asked: { commands: ["play", "stop", "play"], rendered: ["Sir?"], sent: [], replies: [] },
      responded: ["Wait.", again],
      replies: [again],
    })
  })

  test("takes only the stop of what the user said over them, never adding what he says after the rest of it, before it has worked out what to do", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes two seconds over the first part, and working out what to do three.
        const helper = yield* overHelper([[0.9, "Wait for the tests to pass,"], [0.91, "then merge it."], [0.92, "and deploy it."]], {
          live: true,
          delays: [2],
          responding: 3,
          intent: "dismiss",
        })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 25)
        yield* helper.quiet
        yield* helper.talk(0, 4)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.talk(0, 10)
        yield* helper.talk(0.92, 15)
        yield* helper.quiet
        yield* helper.wait(4)
        return { sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ sent: [], replies: ["Wait."] })
  })

  test("takes nothing of what the user said over them, nor of what he goes on with as the last of its voice comes in, falling quiet and saying \"Sir?\" once he's finished", async () => {
    for (const pause of [15, 20]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          // Whisper takes a third of a second.
          const helper = yield* overHelper([[0.9, "Hold off for now,"], [0.91, "I want to review the pull request first."]], {
            live: true,
            delays: [0.3, 0.3, 0.3],
          })
          yield* helper.wait(2.4)
          yield* helper.talk(0.9, 25)
          yield* helper.talk(0, pause)
          yield* helper.talk(0.91, 40)
          yield* helper.quiet
          yield* helper.wait(2)
          return { commands: helper.commands, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([pause, result]).toEqual([pause, { commands: ["play", "stop", "play"], rendered: ["Sir?"], sent: [], replies: [] }])
    }
  }, 30_000)

  test("takes only the stop of his it stopped for over them, never what he goes on with as the last of its voice comes in", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Stop."], [0.91, "I want to review the pull request first."]], {
          live: true,
          delays: [0.3, 0.3, 0.3],
          responding: 2,
          intent: "dismiss",
        })
        yield* helper.wait(2.4)
        yield* helper.talk(0.9, 15)
        yield* helper.talk(0, 15)
        yield* helper.talk(0.91, 40)
        yield* helper.quiet
        yield* helper.wait(4)
        return { commands: helper.commands, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], replies: ["Stop."] })
  })

  test("takes nothing of a sentence he begins over them and finishes after them, like \"If the tests fail,\" then \"revert it.\", and all of it when he says it again after \"Sir?\"", async () => {
    const again = "If the tests fail, revert it."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "If the tests fail,"], [0.91, "revert it."], [0.92, again]], { live: true })
        yield* helper.wait(2.2)
        yield* helper.talk(0.9, 20)
        // A pause of 0.6 s, over the end of its first three seconds.
        yield* helper.talk(0, 19)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = {
          commands: [...helper.commands],
          rendered: [...helper.rendered],
          transcribed: [...helper.transcribed],
          responded: [...helper.responded],
          sent: [...helper.sent],
          replies: [...(yield* helper.replies)],
        }
        yield* helper.finish
        yield* helper.talk(0.92, 40)
        yield* helper.quiet
        yield* helper.wait(1)
        return { asked, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    // Made out a part at a time: the first let go, as it has words of yapd's, the second clearly him, and neither taken.
    expect(result.asked).toEqual({
      commands: ["play", "stop", "play"],
      rendered: ["Sir?"],
      transcribed: ["If the tests fail,", "revert it."],
      responded: [],
      sent: [],
      replies: [],
    })
    expect(result).toMatchObject({ responded: [again], sent: [again], replies: [again] })
  })

  test("takes only the stop of \"Wait, hold off for now,\" over them, never \"then merge it.\" said within a moment, while what he says over them goes on", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Working out what to do takes two seconds, as a model call does.
        const helper = yield* overHelper([[0.9, "Wait, hold off for now,"], [0.91, "then merge it."]], { live: true, responding: 2, intent: "dismiss" })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 40)
        const stopped = [...helper.commands]
        yield* helper.talk(0, 16)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(3)
        return { stopped, commands: helper.commands, responded: helper.responded, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    // Stopped at once for the "Wait", heard about a second in, which is all that's worked out from, or noted.
    expect(result).toEqual({ stopped: ["play", "stop"], commands: ["play", "stop"], responded: ["Wait."], rendered: [], sent: [], replies: ["Wait."] })
  })

  test("never adds \"then merge it.\", said once what the user said over them is over, to the stop of \"Wait, hold off for now,\" before it has worked out what to do, but says \"Sir?\" for all of it", async () => {
    const again = "Wait, hold off for now, then merge it."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Working out what to do takes two seconds, as a model call does.
        const helper = yield* overHelper([[0.9, "Wait, hold off for now,"], [0.91, "then merge it."], [0.92, again]], { live: true, responding: 2, intent: "dismiss" })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 40)
        yield* helper.talk(0, 38)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], responded: [...helper.responded], rendered: [...helper.rendered], sent: [...helper.sent], replies: [...(yield* helper.replies)] }
        yield* helper.finish
        yield* helper.talk(0.92, 40)
        yield* helper.quiet
        yield* helper.wait(3)
        return { asked, responded: helper.responded, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({
      asked: { commands: ["play", "stop", "play"], responded: ["Wait."], rendered: ["Sir?"], sent: [], replies: [] },
      responded: ["Wait.", again],
      replies: [again],
    })
  })

  test("says \"Sir?\" rather than drop an answer the user gives once his wait over a question's first seconds is over, before it has worked out what to do about that, and takes the answer whole then", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const heard: Array<string> = []
        const helper = yield* overHelper([[0.9, "Hold on."], [0.91, "The docs site."], [0.92, "The docs site."]], { live: true, duration: 3.5 })
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Which one, sir: yapd or the docs site?",
            // Working out what's meant takes two seconds, as a model call does, and only naming an option answers it.
            answer: (said) =>
              Effect.sync(() => void heard.push(said)).pipe(
                Effect.zipRight(Effect.sleep("2 seconds")),
                Effect.as(said.includes("docs") ? Option.some(Effect.sync(() => void answers.push(said))) : Option.none()),
              ),
          }),
        )
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 12)
        yield* helper.quiet
        // Once what he said over them is over.
        yield* helper.talk(0, 10)
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { rendered: [...helper.rendered], heard: [...heard], answers: [...answers] }
        yield* helper.finish
        yield* helper.talk(0.92, 20)
        yield* helper.quiet
        yield* helper.wait(3)
        return { asked, answered: yield* Fiber.join(asking), heard, answers }
      }),
    )
    expect(result).toEqual({
      asked: { rendered: ["Sir?"], heard: ["Hold on."], answers: [] },
      answered: true,
      heard: ["Hold on.", "The docs site."],
      answers: ["The docs site."],
    })
  })

  test("takes nothing of \"Tell it to fix the tests,\", \"and wait for CI.\" and \"Then merge it.\", begun over them with pauses between, but the stop in them", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to fix the tests,"], [0.91, "and wait for CI."], [0.92, "Then merge it."]], { live: true, intent: "dismiss" })
        yield* helper.wait(2)
        yield* helper.talk(0.9, 28)
        yield* helper.talk(0, 18)
        yield* helper.talk(0.91, 20)
        yield* helper.talk(0, 18)
        yield* helper.talk(0.92, 15)
        yield* helper.quiet
        yield* helper.wait(2)
        return { commands: helper.commands, responded: helper.responded, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], responded: ["Wait."], rendered: [], sent: [], replies: ["Wait."] })
  })

  test("never takes its own voice over them, heard as its words, or as words of their own, like \"is important.\" for its \"importer\", at worst falling quiet for it", async () => {
    const importer = "Two threads need you: the Tezos importer and the menu bar app."
    for (const [spoken, heard, commands] of [
      [long.spoken, "Over in yapd, the tests", ["play"]],
      [importer, "Two threads need you. The Tezos is important.", ["play"]],
      // As if his: it falls quiet and asks, which is all it can do.
      [importer, "is important.", ["play", "stop", "play"]],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, heard]], { live: true, spoken })
          yield* helper.wait(0.3)
          yield* helper.talk(0.8, 30)
          yield* helper.quiet
          // The microphone goes on hearing quiet, as the last of its voice stops coming in.
          yield* helper.quiet
          yield* helper.wait(1)
          const during = [...helper.commands]
          // Played to the end, or "Sir?" is, with nothing said back.
          yield* helper.finish
          yield* helper.wait(4)
          const exit = yield* Fiber.poll(helper.fiber)
          return { during, done: Option.isSome(exit), responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([heard, result]).toEqual([heard, { during: [...commands], done: true, responded: [], sent: [], replies: [] }])
    }
  }, 30_000)

  test("takes nothing said over \"Sir?\" either, saying it once more, then only listening, and takes what he says after that whole, once he's paused a while", async () => {
    const said = "Which PR was that?"
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, said], [0.91, said], [0.92, said], [0.93, said]])
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        // Over "Sir?", which is said over its first seconds too.
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.talk(0.92, 15)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { commands: [...helper.commands], rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent] }
        // Not asked a third time, and heard as after any line, once he's been quiet longer than he pauses going on with something.
        yield* helper.talk(0, 20)
        yield* helper.talk(0.93, 15)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        return { asked, commands: helper.commands, rendered: helper.rendered, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result.asked).toEqual({ commands: ["play", "stop", "play", "stop", "play", "stop"], rendered: ["Sir?", "Sir?"], responded: [], sent: [] })
    expect(result).toEqual({
      asked: result.asked,
      commands: ["play", "stop", "play", "stop", "play", "stop", "play"],
      rendered: ["Sir?", "Sir?", "Okay."],
      responded: [said],
      sent: [said],
      replies: [said],
    })
  })

  test("takes nothing he goes on with after a pause once \"Sir?\" has been talked over twice, or can't be said, and all of it once he's paused a while", async () => {
    const again = "If the build breaks, revert it."
    for (const speechless of [false, true]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper(
            [[0.9, "Which PR was that?"], [0.91, "Which PR was that?"], [0.92, "If the build breaks,"], [0.93, "revert it."], [0.94, again]],
            { speechless },
          )
          yield* helper.wait(0.5)
          if (!speechless) {
            yield* helper.talk(0.9, 15)
            yield* helper.quiet
            yield* helper.quiet
            yield* helper.wait(1)
            // Over "Sir?", which is said over its first seconds too.
            yield* helper.talk(0.91, 15)
            yield* helper.quiet
            yield* helper.quiet
            yield* helper.wait(1)
          }
          // Over "Sir?" once more, or over its first seconds when it can't be said.
          yield* helper.talk(0.92, 20)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          // On with it after a pause of a second and a half.
          yield* helper.talk(0, 6)
          yield* helper.talk(0.93, 15)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          const asked = { rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent], replies: [...(yield* helper.replies)] }
          // All of it again, after a pause longer than he makes going on with something.
          yield* helper.talk(0, 20)
          yield* helper.talk(0.94, 30)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          return { asked, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([speechless, result]).toEqual([
        speechless,
        {
          asked: { rendered: speechless ? [] : ["Sir?", "Sir?"], responded: [], sent: [], replies: [] },
          responded: [again],
          sent: [again],
          replies: [again],
        },
      ])
    }
  }, 30_000)

  test("takes nothing of what the user begins as \"Sir?\" ends, though that's only made out once it has", async () => {
    const again = "Which PR was that? The one for the docs site."
    // "Sir?" said after its first three seconds, or over them.
    for (const at of [2.2, 0.5]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          // The voice detector takes a tenth of a second over each frame of what he begins over the end of "Sir?".
          const helper = yield* overHelper([[0.9, "Which PR was that?"], [0.95, "The one for the docs site."], [0.96, again]], { lagging: [0.95, 100] })
          yield* helper.wait(at)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          yield* helper.talk(0.95, 10)
          yield* helper.finish
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1200)))
          yield* helper.quiet
          yield* helper.wait(1)
          yield* helper.quiet
          yield* helper.wait(1)
          const asked = { rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent] }
          yield* helper.finish
          yield* helper.talk(0.96, 30)
          yield* helper.quiet
          yield* helper.wait(1)
          return { asked, responded: helper.responded, sent: helper.sent }
        }),
      )
      expect([at, result]).toEqual([at, { asked: { rendered: ["Sir?", "Sir?"], responded: [], sent: [] }, responded: [again], sent: [again] }])
    }
  }, 30_000)

  test("says \"Sir?\" no more than twice for what the user said over them, though he stops the first and goes on", async () => {
    const said = "Which PR was that?"
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Working out what to do takes two seconds, as a model call does.
        const helper = yield* overHelper([[0.9, said], [0.91, "Wait."], [0.92, said], [0.93, said], [0.94, said]], { responding: 2 })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        // Over "Sir?", which stops it, then on from that before it has worked out what to do.
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.talk(0.92, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        // Over it once more.
        yield* helper.talk(0.93, 15)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent] }
        yield* helper.talk(0, 20)
        yield* helper.talk(0.94, 15)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(3)
        return { asked, rendered: helper.rendered, responded: helper.responded, sent: helper.sent }
      }),
    )
    expect(result).toEqual({
      asked: { rendered: ["Sir?", "Sir?"], responded: ["Wait."], sent: [] },
      rendered: ["Sir?", "Sir?", "Okay."],
      responded: ["Wait.", said],
      sent: [said],
    })
  })

  test("picks up from before where the user began over them when what he says after \"Sir?\" wasn't meant for it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Tell it to deploy."], [0.91, "Sam, are you coming?"]], { intent: "resume" })
        yield* helper.wait(2)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.finish
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return { plays: helper.plays, rendered: helper.rendered, responded: helper.responded, sent: helper.sent }
      }),
    )
    // The update, "Sir?", then the update again from a second and a half before where he began, two seconds in.
    expect(result).toEqual({ plays: [0, 0, 0.5], rendered: ["Sir?"], responded: ["Sam, are you coming?"], sent: [] })
  })

  test("asks a question again when what the user says after \"Sir?\" isn't an answer, rather than leave it unanswered", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const answers: Array<string> = []
        const helper = yield* overHelper(
          [[0.9, "Neither, start a new project."], [0.91, "Sam, one moment."], [0.92, "Neither, start a new project."]],
          { duration: 3.5 },
        )
        yield* Fiber.interrupt(helper.fiber)
        const asking = yield* Effect.fork(
          helper.ask({
            audio: "/tmp/question.wav",
            spoken: "Which one, sir: yapd or the docs site?",
            answer: (heard) => Effect.succeed(heard.startsWith("Sam,") ? Option.none() : Option.some(Effect.sync(() => void answers.push(heard)))),
          }),
        )
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.finish
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        const asked = { plays: helper.plays.length, rendered: [...helper.rendered], answers: [...answers] }
        yield* helper.finish
        yield* helper.talk(0.92, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return { asked, answered: yield* Fiber.join(asking), answers }
      }),
    )
    // The update, given up on, the question, "Sir?", and the question again.
    expect(result).toEqual({ asked: { plays: 4, rendered: ["Sir?"], answers: [] }, answered: true, answers: ["Neither, start a new project."] })
  })

  test("makes out all the user said over them again once he's said more since a look as he paused, so a stop he says after that is heard", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes five seconds over the look as he paused.
        const helper = yield* overHelper([[0.9, "Tell it to deploy."], [0.91, "Stop."]], { delays: [5], intent: "dismiss" })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        // Long enough for a look at all he's said so far.
        yield* helper.talk(0, 7)
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.wait(5)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, rendered: helper.rendered, responded: helper.responded, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ commands: ["play", "stop"], rendered: [], responded: ["Stop."], replies: ["Stop."] })
  })

  test("lets go of its own \"Sir?\" getting into the microphone, heard as a word like it, like \"Sure.\", rather than say it again", async () => {
    for (const echo of ["Sure.", "Sir.", "Sorry?", "Siri?", "Stir.", "Serve."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "Which PR was that?"], [0.85, echo]])
          yield* helper.wait(0.5)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          // "Sir?", said over its first seconds too, getting into the microphone.
          yield* helper.talk(0.85, 10)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          yield* helper.finish
          yield* helper.wait(4)
          const exit = yield* Fiber.poll(helper.fiber)
          return { rendered: helper.rendered, done: Option.isSome(exit), responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([echo, result]).toEqual([echo, { rendered: ["Sir?"], done: true, responded: [], sent: [], replies: [] }])
    }
  }, 30_000)

  test("takes the user's reply straight after \"Sir?\" whole, though its own voice got into the microphone over it, and is still being made out once he's begun", async () => {
    const said = "Merge it."
    // Whisper makes out its own voice at once, or only once he has finished.
    for (const delay of [0, 1]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "Which PR was that?"], [0.85, "Sir."], [0.91, said]], { delays: [0, delay] })
          yield* helper.wait(0.5)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          // "Sir?", said over its first seconds too, getting into the microphone, and him a third of a second after it ends.
          yield* helper.talk(0.85, 10)
          yield* helper.finish
          yield* helper.talk(0, 10)
          yield* helper.talk(0.91, 15)
          yield* helper.quiet
          yield* helper.wait(1)
          return { rendered: helper.rendered, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([delay, result]).toEqual([delay, { rendered: ["Sir?", "Okay."], responded: [said], sent: [said], replies: [said] }])
    }
  }, 30_000)

  test("takes a quick reply begun just after the voice of \"Sir?\" whole, though its file goes on a moment in quiet, to a question as to an update, but nothing begun over its voice", async () => {
    // "Sir?" as it's rendered: its voice, then a sixth of a second of quiet.
    const sir = new Float32Array(24000).fill(0.3, 0, 20160)
    // Whether it's a question, and how far into "Sir?" he answers, as the microphone hears him: a twentieth of a second after
    // its voice ends, or a tenth before.
    for (const [asking, at] of [[false, 0.86], [true, 0.86], [false, 0.7], [true, 0.7]] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const answers: Array<string> = []
          const helper = yield* overHelper([[0.9, "Yes."], [0.91, "Yes."]], { live: true, sir })
          if (asking) {
            yield* Fiber.interrupt(helper.fiber)
            yield* Effect.fork(
              helper.ask({
                audio: "/tmp/question.wav",
                spoken: "Send it again?",
                answer: (heard) => Effect.succeed(Option.some(Effect.sync(() => void answers.push(heard)))),
              }),
            )
          }
          yield* helper.wait(0.5)
          yield* helper.talk(0.9, 12)
          yield* helper.quiet
          yield* helper.quiet
          while (helper.rendered.length === 0 || helper.plays.length < (asking ? 3 : 2)) yield* helper.talk(0, 1)
          // A frame at a time, so he begins just where he does.
          while ((yield* helper.since) < at) yield* helper.talk(0, 1)
          for (let frame = 0; frame < 12; frame++) yield* helper.talk(0.91, 1)
          yield* helper.quiet
          yield* helper.wait(1)
          return { rendered: helper.rendered, responded: helper.responded, sent: helper.sent, answers }
        }),
      )
      const taken = at > 0.84
      expect([asking, at, result]).toEqual([
        asking,
        at,
        !taken
          ? { rendered: ["Sir?", "Sir?"], responded: [], sent: [], answers: [] }
          : asking
            ? { rendered: ["Sir?"], responded: [], sent: [], answers: ["Yes."] }
            : { rendered: ["Sir?", "Okay."], responded: ["Yes."], sent: ["Yes."], answers: [] },
      ])
    }
  }, 30_000)

  test("takes nothing of what the user goes on with straight after \"Sir?\", having begun over it, though that's still being made out, and all of it when he says it again", async () => {
    const again = "If the tests fail, revert it."
    for (const delay of [0, 1]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "Which PR was that?"], [0.92, "If the tests fail,"], [0.93, "revert it."], [0.94, again]], {
            delays: [0, delay],
          })
          yield* helper.wait(0.5)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          // Over the end of "Sir?", and on a third of a second after it.
          yield* helper.talk(0.92, 10)
          yield* helper.finish
          yield* helper.talk(0.92, 10)
          yield* helper.talk(0, 10)
          yield* helper.talk(0.93, 15)
          yield* helper.quiet
          yield* helper.wait(1)
          yield* helper.quiet
          yield* helper.wait(1)
          const asked = { rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent] }
          yield* helper.finish
          yield* helper.talk(0.94, 30)
          yield* helper.quiet
          yield* helper.wait(1)
          return { asked, responded: helper.responded, sent: helper.sent }
        }),
      )
      expect([delay, result]).toEqual([delay, { asked: { rendered: ["Sir?", "Sir?"], responded: [], sent: [] }, responded: [again], sent: [again] }])
    }
  }, 30_000)

  test("takes nothing of what the user goes on with straight after \"Sir?\" when Whisper heard nothing in what was said over it, which may have been him", async () => {
    const again = "If the tests fail, revert it."
    for (const delay of [0, 1]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "Which PR was that?"], [0.92, ""], [0.93, "revert it."], [0.94, again]], { delays: [0, delay] })
          yield* helper.wait(0.5)
          yield* helper.talk(0.9, 15)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          // Over the end of "Sir?", and on a third of a second after it.
          yield* helper.talk(0.92, 10)
          yield* helper.finish
          yield* helper.talk(0.92, 10)
          yield* helper.talk(0, 10)
          yield* helper.talk(0.93, 15)
          yield* helper.quiet
          yield* helper.wait(1)
          yield* helper.quiet
          yield* helper.wait(1)
          const asked = { rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent] }
          yield* helper.finish
          yield* helper.talk(0.94, 30)
          yield* helper.quiet
          yield* helper.wait(1)
          return { asked, responded: helper.responded, sent: helper.sent }
        }),
      )
      expect([delay, result]).toEqual([delay, { asked: { rendered: ["Sir?", "Sir?"], responded: [], sent: [] }, responded: [again], sent: [again] }])
    }
  }, 30_000)

  test("takes nothing of what the user goes on with over \"Sir?\", or while it's still being rendered, though it's said after its first seconds, and all of it when he says it again", async () => {
    const again = "If the build breaks, revert it."
    // Begun late in its first seconds, so "Sir?" is said after them, at once or a moment later, once it's rendered, or early, so
    // it's said over them, but takes a moment to render: how far in he begins, for how many frames, and how long he pauses.
    for (const [at, frames, pause, rendering] of [
      [2.2, 20, 26, undefined],
      [1.5, 30, 44, undefined],
      [2.2, 20, 26, 0.3],
      [0.5, 20, 42, 0.4],
      [0.5, 20, 46, 0.4],
    ] as const) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "If the build breaks,"], [0.91, "revert it."], [0.92, again]], {
            live: true,
            ...(rendering === undefined ? {} : { rendering }),
          })
          yield* helper.wait(at)
          yield* helper.talk(0.9, frames)
          // Long enough that what he said over them is over before he goes on.
          yield* helper.talk(0, pause)
          yield* helper.talk(0.91, 15)
          yield* helper.quiet
          yield* helper.quiet
          yield* helper.wait(1)
          const asked = { rendered: [...helper.rendered], responded: [...helper.responded], sent: [...helper.sent], replies: [...(yield* helper.replies)] }
          yield* helper.finish
          yield* helper.talk(0.92, 40)
          yield* helper.quiet
          yield* helper.wait(1)
          return { asked, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
        }),
      )
      expect([at, frames, pause, rendering, result]).toEqual([
        at,
        frames,
        pause,
        rendering,
        { asked: { rendered: ["Sir?", "Sir?"], responded: [], sent: [], replies: [] }, responded: [again], sent: [again], replies: [again] },
      ])
    }
  }, 30_000)

  test("lets go of what it's making out of what's said over \"Sir?\" when the update is cut off then, like by a dictation or yapd turned off", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // Whisper takes five seconds over what's said over "Sir?".
        const helper = yield* overHelper([[0.9, "Tell it to deploy."], [0.91, "Tell it to deploy."]], { delays: [0, 5] })
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        const asked = [...helper.commands]
        yield* Fiber.interrupt(helper.fiber)
        yield* helper.wait(5)
        yield* helper.wait(5)
        return { asked, interrupted: helper.interrupted(), rendered: helper.rendered, responded: helper.responded, sent: helper.sent, replies: yield* helper.replies }
      }),
    )
    expect(result).toEqual({ asked: ["play", "stop", "play"], interrupted: 1, rendered: ["Sir?"], responded: [], sent: [], replies: [] })
  })

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

  test("lets go of a follow-up run on from its own voice over them, carrying on, and takes it when he says it again after them, leaving the answer unheard", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."], [0.9, "Tell it to open a PR."], [0.91, "Tell it to open a PR."]], { live: true })
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const answering = yield* Effect.fork(helper.answer(answer(followUps, through)))
        yield* helper.wait(0.3)
        // His words run straight on from its own voice getting through.
        yield* helper.talk(0.8, 15)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        const ignored = { commands: helper.commands.slice(asked), followUps: [...followUps] }
        // Past its first three seconds, as he says it again.
        yield* helper.wait(1)
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        const followed = yield* Fiber.join(answering)
        // Long past where it would have been said to the end.
        yield* helper.wait(20)
        return { ignored, commands: helper.commands.slice(asked), followed, followUps, through }
      }),
    )
    // Never stopped for what ran on from its voice, then cut off by what he said again, so never heard to the end.
    expect(result).toEqual({
      ignored: { commands: ["play"], followUps: [] },
      commands: ["play", "volume", "stop"],
      followed: true,
      followUps: ["Tell it to open a PR."],
      through: [],
    })
  })

  test("falls quiet for a follow-up over them once Whisper has made out it's clearly him, says \"Sir?\", takes what he says again then for the follow-up, and leaves the answer unheard", async () => {
    const said = "Tell it to open a PR."
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        const helper = yield* overHelper([[0.9, said], [0.91, said]])
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const answering = yield* Effect.fork(helper.answer(answer(followUps, through)))
        yield* helper.wait(0.3)
        yield* helper.talk(0.9, 15)
        const talking = helper.commands.slice(asked)
        yield* helper.quiet
        // The microphone goes on hearing quiet, as the last of its voice stops coming in.
        yield* helper.quiet
        yield* helper.wait(1)
        const before = [...followUps]
        yield* helper.finish
        yield* helper.talk(0.91, 15)
        yield* helper.quiet
        const followed = yield* Fiber.join(answering)
        yield* helper.wait(20)
        return { talking, before, commands: helper.commands.slice(asked), rendered: helper.rendered, followed, followUps, through }
      }),
    )
    expect(result).toEqual({
      talking: ["play"],
      before: [],
      commands: ["play", "stop", "play"],
      rendered: ["Sir?"],
      followed: true,
      followUps: [said],
      through: [],
    })
  })

  test("has an answer heard when it's said to the end while a follow-up over them is still being made out, then says \"Sir?\" once that's him, and takes what he says again", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const followUps: Array<string> = []
        const through: Array<string> = []
        // Whisper takes three seconds over it, by when the answer has been said to the end.
        const helper = yield* overHelper([[0.9, "Tell it to deploy."], [0.91, "Tell it to deploy."]], { duration: 2, delays: [3] })
        yield* Fiber.interrupt(helper.fiber)
        const asked = helper.commands.length
        const answering = yield* Effect.fork(helper.answer(answer(followUps, through, "Codex opened the pull request, sir.")))
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1.5)
        yield* helper.finish
        const heard = [...through]
        yield* helper.wait(1.5)
        yield* helper.wait(1)
        const before = { commands: helper.commands.slice(asked), rendered: [...helper.rendered], followUps: [...followUps] }
        yield* helper.finish
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        return { heard, before, followed: yield* Fiber.join(answering), followUps, through }
      }),
    )
    expect(result).toEqual({
      heard: ["through"],
      before: { commands: ["play", "play"], rendered: ["Sir?"], followUps: [] },
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
