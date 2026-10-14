import type { Socket } from "bun"
import { describe, expect, test } from "bun:test"
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  type Duration,
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
import { between, cut, together, unfinished, unsaid } from "./Conversation.ts"
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
 * taking what's said to Sam for talk with someone else, the relay `sending` seconds to send, and follow-ups going out
 * as `result` says: sent, queued, or held back as the session has moved on. `render` renders what's said back, and
 * with `unplayable`, nothing but the update can be played, as when the audio helper goes down after it. With `afplay`,
 * what's said back plays like afplay, which can't say it's playing, and either plays to the end or can't play at all.
 * With `model`, replies are worked out by the provider's responder with that model instead, and the persona's
 * lines are `lines`, or the plain ones. With `persona`, it's that one that picks and is told the lines. With `routines`,
 * those are the names of his routines. With `over`, it's that update that's read, with what the journal `kept` before it,
 * and with `present`, while he's at hand.
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
    readonly routines?: ReadonlyArray<string>
    readonly over?: Conversation.Update
    readonly kept?: ReadonlyArray<Journal.Entry>
    readonly present?: boolean
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
        tick: Effect.void,
      }),
      // Each frame holds the probability that it's speech.
      Layer.succeed(Vad, { make: Effect.succeed((frame: Float32Array) => Effect.succeed(frame[0]!)) }),
      Layer.succeed(Transcriber, {
        transcribe: (_, terms) =>
          Effect.sync(() => {
            glossaries.push(terms ?? [])
            return transcripts.shift() ?? ""
          }),
        ready: Effect.succeed(true),
      }),
      given.model === undefined
        ? Layer.succeed(Responder.Responder, {
            respond: ({ heard: text }) =>
              Effect.sync(() => heard.push(text)).pipe(
                Effect.zipRight(Effect.sleep("5 seconds")),
                Effect.as({
                  reply: text.startsWith("Sam,")
                    ? { intent: "resume" as const, spoken: "", message: "" }
                    : { intent: "send" as const, spoken: text.startsWith("Just") ? "" : "Okay.", message: text },
                  source: "model" as const,
                }),
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
      ...(given.routines === undefined ? {} : { routines: Effect.succeed(given.routines) }),
    }).pipe(Effect.provide(context))
    for (const entry of given.kept ?? []) yield* Context.get(context, Journal.Journal).write(entry)
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
      /** All the journal kept. */
      journal: Effect.flatMap(Journal.Journal, (journal) => journal.since(0)).pipe(Effect.provide(context)),
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

  test("a reply row keeps how it was decided, how long that took and what he hadn't heard, and never reads as noise or catching up", async () => {
    // A model that takes two seconds to answer.
    const model = Layer.succeed(Model, {
      ask: (schema) =>
        Effect.sleep("2 seconds").pipe(
          Effect.zipRight(Schema.decodeUnknown(schema)({ intent: "answer", spoken: "The auth one, sir.", message: "" })),
          Effect.mapError((cause) => new ModelError({ cause })),
        ),
    })
    /** What's kept of what he said, and what's logged of how long it took, talking `late` seconds after the update has played to the end, or over it. */
    const replied = (said: string, late?: number) => {
      const logged: Array<string> = []
      const logger = Logger.make(({ message }) => {
        logged.push((Array.isArray(message) ? message : [message]).join(" "))
      })
      return scoped(
        Effect.gen(function* () {
          const { fiber, frames, wait, journal } = yield* conversation([said], 0, [], "sent", { model })
          if (late !== undefined) yield* wait(10 + late)
          // Over a second of speech, as the endpointer keeps it.
          yield* frames(0.9, 47)
          yield* frames(0, defaults.silence)
          yield* wait(20)
          yield* Fiber.join(fiber)
          return { kept: (yield* journal).map(({ kind, detail }) => ({ kind, detail })), timing: logged.filter((line) => line.startsWith("Timing:")) }
        }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
      )
    }
    // Over the line, which stops at two seconds of its ten: worked out by the model, with what yapd hadn't said yet.
    const over = await replied("Which PR?")
    expect(over.kept).toEqual([
      {
        kind: "reply",
        detail: { intent: "answer", source: "model", ms: 2000, modelMs: 2000, left: "PR is ready.", after: false, lateBy: 0, needsYou: false, voiced: 1.18 },
      },
    ])
    expect(over.timing).toEqual(["Timing: 2.0 s to work out a reply, 2.0 s of it the model's"])
    // A second and a half after it ended: taken in at once, with nothing it hadn't said.
    const after = await replied("Thanks.", 1.5)
    expect(after.kept).toEqual([
      { kind: "reply", detail: { intent: "dismiss", source: "quick", ms: 0, after: true, lateBy: 1.5, needsYou: false, voiced: 1.18 } },
    ])
    expect(after.timing).toEqual(["Timing: 0.0 s to work out a reply, without the model"])
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

  test("tells the answer what of the question yapd hadn't said yet when the user spoke over it, and nothing once all of it was said", async () => {
    const told = (over: boolean) =>
      scoped(
        Effect.gen(function* () {
          const told: Array<string | undefined> = []
          const { question, speak, wait } = yield* conversation(["Yes."])
          const asking = yield* question((_heard, _voiced, _echo, _afterPause, unsaid) => Effect.sync(() => void told.push(unsaid)).pipe(Effect.as(Option.some(Effect.void))))
          // Over it, three seconds in, it stops at two of its ten; or once it's played to the end.
          yield* wait(over ? 3 : 10)
          yield* speak
          yield* Fiber.join(asking)
          return told
        }),
      )
    // Only its first word was said by a moment before he began.
    expect(await told(true)).toEqual(["project is it for?"])
    expect(await told(false)).toEqual([undefined])
  })

  /** A line of twenty words, read out over ten seconds: one every half second. */
  const counting = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"

  test("tells the answer what of the question yapd hadn't said yet a moment before the user began, never from where it stopped once what they said was clearly speech", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Yes."]], { spoken: counting, ask: true, live: true })
        yield* helper.wait(6)
        // A halting start, clearly speech only most of a second after he began.
        yield* helper.talk(0.9, 1)
        for (let sound = 1; sound < defaults.confirm; sound++) {
          yield* helper.talk(0, defaults.abandon - 2)
          yield* helper.talk(0.9, 1)
        }
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { stopped: helper.timeline.find(({ type }) => type === "stop")?.at ?? 0, unheard: helper.unheard }
      }),
    )
    // Begun six seconds in, after its twelfth word, of which he's taken to have heard eleven; it stopped near seven, after its thirteenth.
    expect(result.stopped).toBeGreaterThan(6.6)
    expect(result.unheard).toEqual(["twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"])
  })

  test("tells the answer what of the question yapd hadn't said yet by where it had got to in all of it, once it picked up again after its own voice stopped it over its first seconds", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Yes."]], { spoken: counting, ask: true, live: true })
        // Only its own voice, which Whisper hears nothing in, two and a half seconds in.
        yield* helper.wait(2.5)
        yield* helper.talk(0.8, defaults.wary)
        yield* helper.quiet
        // Him, three seconds after it picked up again.
        yield* helper.wait(3)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { plays: helper.plays.map(seconds), unheard: helper.unheard }
      }),
    )
    // Begun five seconds into the line, after its tenth word, of which he's taken to have heard nine: not three seconds in, from where it picked up.
    expect(result).toEqual({ plays: [0, 1.892], unheard: ["ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"] })
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

  test("the microphone stays open 3 s after an update, 6 s after an answer, 8 s after a question or an update that asks one while he's at hand", async () => {
    const asking: Conversation.Update = { ...update, needsYou: true, spoken: "The PR is up. Should I merge it?" }
    /** Whether it's still listening once it's been quiet for `seconds` after the line was said. */
    const quiet = (line: "update" | "asking" | "away" | "answer" | "question", seconds: number) =>
      scoped(
        Effect.gen(function* () {
          const { fiber, say, ask, wait } = yield* conversation([], 0, [], "sent", line === "asking" || line === "away" ? { over: asking, present: line === "asking" } : {})
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
 * what yapd was saying around then when it's told that, in `offered`, and
 * what it hadn't said yet then, when it's told that, in `unheard`. Its
 * fiber ends with whether the update was heard, or the answer followed up.
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
    /** How long working out what to do about what's said takes, in seconds, as a model call does, for an update, an answer or a question alike: at once unless said. */
    readonly responding?: number
    readonly answer?: boolean
    /** With `ask`, it asks a question in the same words instead, like an agent's or its own, which takes what's said as `follow` says. */
    readonly ask?: boolean
    /** Whether the answer, or the question, takes what's said for a follow-up, or an answer, as the model would. */
    readonly follow?: (heard: string, echo?: string, afterPause?: string) => boolean
    /** Whether Whisper fails on all it's given. */
    readonly failing?: boolean
    /** Whether "Mute." turns yapd off, counted in `offs`, which here leaves it on. */
    readonly off?: boolean
    /** How long Whisper takes on each thing it's given, in seconds: at once unless said. */
    readonly transcribing?: number
    /** Whether Whisper can't hear yet, its model still loading, though it hears what it's given as ever. */
    readonly unready?: boolean
    /** With `tell`, it says a notice in the same words instead, like a failure, which nothing else said over it is for. */
    readonly tell?: boolean
    /** Whether something always waits to be said next. */
    readonly queued?: boolean
    /** With `answer`, whether it's followed up only from its end, and how long it's listened to after: as after an answer unless said. */
    readonly after?: boolean
    readonly wait?: Duration.DurationInput
    /** With `answer`, what's run once it's been said to the end. */
    readonly through?: Effect.Effect<void>
    /** Whether an answer he asked for always waits to be said next. */
    readonly asked?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    let offs = 0
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
    const offered: Array<{ readonly heard: string; readonly echo?: string; readonly afterPause?: string }> = []
    const unheard: Array<string | undefined> = []
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
          options.failing === true ? Effect.fail(new TranscribeError({ cause: "Whisper broke" })) : Effect.sync(() => {
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
          }).pipe((heard) => (options.transcribing === undefined ? heard : Effect.delay(heard, `${options.transcribing} seconds`))),
        ready: Effect.succeed(options.unready !== true),
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
      // In the timeline too, so what's done before it is known.
      ...(options.off === true
        ? {
            off: Effect.sync(() => {
              offs++
              timeline.push({ type: "off", at: (now() - (first ?? now())) / 1000 })
            }),
          }
        : {}),
      ...(options.queued === true ? { queued: Effect.void } : {}),
      ...(options.asked === true ? { asked: Effect.void } : {}),
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
    const respond = (heard: string, _: number, echo?: string, afterPause?: string, unsaid?: string) =>
      Effect.sync(() => {
        offered.push({ heard, ...(echo === undefined ? {} : { echo }), ...(afterPause === undefined ? {} : { afterPause }) })
        unheard.push(unsaid)
      }).pipe(
        Effect.zipRight(Effect.sleep(`${options.responding ?? 0} seconds`)),
        Effect.as((options.follow?.(heard, echo, afterPause) ?? true) ? Option.some(Effect.sync(() => void followed.push(heard))) : Option.none()),
      )
    const fiber = yield* Effect.fork(
      options.ask === true
        ? made.ask({ audio: "/tmp/question.wav", spoken, answer: respond })
        : options.answer === true
          ? made.answer({
              audio: "/tmp/answer.wav",
              spoken,
              followUp: respond,
              ...(options.after === true ? { after: true } : {}),
              ...(options.wait === undefined ? {} : { wait: options.wait }),
              ...(options.through === undefined ? {} : { through: options.through }),
            })
          : options.tell === true
            ? Effect.as(made.tell({ audio: "/tmp/notice.wav", spoken }), false)
            : made.converse({ ...long, spoken }),
    )
    yield* flush
    yield* flush
    return {
      fiber,
      offs: () => offs,
      commands,
      timeline,
      plays,
      transcribed,
      sent,
      responded,
      rendered,
      followed,
      offered,
      unheard,
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
      /** All the journal kept. */
      journal: Effect.flatMap(Journal.Journal, (journal) => journal.since(0)).pipe(Effect.provide(context)),
      /** What the journal kept of what may have been its own voice in each reply, as the model asked later reads it back. */
      overheard: Effect.map(Effect.flatMap(Journal.Journal, (journal) => journal.since(0)), (entries) =>
        entries.map(({ detail }) => {
          const { echo, afterPause } = (detail ?? {}) as { readonly echo?: string; readonly afterPause?: string }
          return { echo, afterPause }
        }),
      ).pipe(Effect.provide(context)),
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
          unsaid: long.spoken.slice("Over in yapd, ".length),
          voiced: 0.16,
          lateBy: 0,
        },
      ],
      rendered: [answered],
      sent: [],
      replies: ["Which PR was that?"],
    })
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
          return { responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })), journal: yield* helper.journal }
        }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
      )
      return { ...result, lines }
    }
    const plain = await answered("Ask me that with your shortcut, sir.")
    // Over its first second, with what may have been its own voice, which isn't kept with it either.
    expect(plain.responded).toEqual([{ heard: secret, told: true }])
    // Nor what the model answered to it, which may give it away in words nothing takes for a secret, nor what yapd hadn't said yet.
    const worked = { source: "model", ms: 0, after: false, lateBy: 0, needsYou: false, voiced: 0.16 }
    expect(plain.journal.map(({ kind, text, said, detail }) => ({ kind, text, said, detail }))).toEqual([
      { kind: "reply", text: undefined, said: undefined, detail: { intent: "answer", withheld: true, ...worked } },
    ])
    expect(plain.lines.filter((line) => line.includes("sk-live"))).toEqual([])
    expect(plain.lines).toContain("Heard something that could give a secret away, so it's held back")
    expect(plain.lines).toContain("Reply: answer")
    // The model's answer saying it back is said, but neither logged nor kept.
    const echoed = await answered("I won't keep sk-live-4f9a8b7c6d5e, sir. Ask me that with your shortcut.")
    expect(echoed.journal.map(({ kind, text, said, detail }) => ({ kind, text, said, detail }))).toEqual([
      { kind: "reply", text: undefined, said: undefined, detail: { intent: "answer", withheld: true, ...worked } },
    ])
    expect(JSON.stringify(echoed.journal)).not.toContain("4f9a8b7c6d5e")
    expect(echoed.lines.filter((line) => line.includes("4f9a8b7c6d5e"))).toEqual([])
    expect(echoed.lines).toContain("Reply: answer")
    // Nor what he hadn't heard of that answer when he talks over it, which a few words of may not show to be one, like the last
    // digits of a code.
    const talkedOver = await answered("I won't keep the key ending four eight one five nine two, sir. Ask me that with your shortcut.", "What?")
    expect(talkedOver.journal.map(({ kind, text, said, detail }) => ({ kind, text, said, detail }))).toEqual([
      { kind: "reply", text: undefined, said: undefined, detail: { intent: "answer", withheld: true, ...worked } },
      { kind: "reply", text: "What?", said: "", detail: { intent: "dismiss", ...worked, voiced: 1.18 } },
    ])
    expect(JSON.stringify(talkedOver.journal)).not.toContain("nine two")
  })

  test.each([
    ["an answer", { answer: true }],
    ["a question", { ask: true }],
  ] as const)("logs none of a secret said over %s, whatever comes of it, only that it was heard", async (_, over) => {
    const lines: Array<string> = []
    const logger = Logger.make(({ message }) => {
      lines.push((Array.isArray(message) ? message : [message]).join(" "))
    })
    const offered = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Remember that the staging key is sk-live-4f9a8b7c6d5e."]], over)
        yield* helper.wait(4)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return helper.offered.map(({ heard }) => heard)
      }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
    )
    expect(offered).toEqual(["Remember that the staging key is sk-live-4f9a8b7c6d5e."])
    expect(lines.filter((line) => line.includes("4f9a8b7c6d5e"))).toEqual([])
    expect(lines).toContain("Heard something that could give a secret away, so it isn't logged")
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
        return { asked, responded: helper.responded, rendered: helper.rendered, sent: helper.sent, replies: yield* helper.replies, overheard: yield* helper.overheard }
      }),
    )
    expect(result.asked).toEqual({ commands: ["play", "volume", "stop", "play"], rendered: [again], sent: [] })
    // Kept with what may have been its own voice, so the brain reading it back later is told so too; what he said once it had stopped, as ever.
    expect(result.overheard).toEqual([{ echo: first, afterPause: undefined }, { echo: undefined, afterPause: undefined }])
    expect(result.responded.map(({ heard, echo, lines }) => ({ heard, echo, lines }))).toEqual([
      { heard: "the pull request merge it", echo: first, lines: [{ speaker: "yapd", text: "Over in yapd,…" }] },
      {
        heard: "Merge the pull request.",
        echo: undefined,
        lines: [
          { speaker: "yapd", text: "Over in yapd,…" },
          // Still marked as maybe its own voice, so the model asked next doesn't take it for more he asked.
          { speaker: "user", text: "the pull request merge it", echo: first },
          { speaker: "yapd", text: again },
        ],
      },
    ])
    expect(result).toMatchObject({ sent: ["Merge the pull request."], replies: ["the pull request merge it", "Merge the pull request."] })
    // Its usual line that it's in hand, as for any message passed on.
    expect(result.rendered).toEqual([again, Persona.plain.onIt])
  })

  test.each([
    ["nothing Whisper can make out, without asking the model", ""],
    ["what gives itself away as made up, once the model takes it for its own voice", "Thanks for watching!"],
    ["yapd's own words around then, once the model takes them for its own voice", "Over in yapd, the tests pass."],
    ["yapd's own words with its name misheard, once the model takes them for its own voice", "Of Erin yapped. The tests pass now."],
  ])("picks up again from just before where it stopped, saying nothing, when what stopped it is heard as %s", async (_, heard) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper(heard === "" ? [] : [[0.8, heard]], { reply: () => ({ intent: "resume", spoken: "", message: "" }) })
        yield* helper.wait(2.5)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          commands: helper.commands,
          plays: helper.plays,
          transcribed: helper.transcribed,
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
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
      // Anything heard, the model judges, told it may be yapd's own voice.
      responded: heard === "" ? [] : [{ heard, told: true }],
      rendered: [],
      sent: [],
      replies: [],
    })
  })

  test("logs one plain line each time it picks up again after its own voice, apart from his talk not meant for it, with none of his words", async () => {
    const lines: Array<string> = []
    const logger = Logger.make(({ message }) => {
      lines.push((Array.isArray(message) ? message : [message]).join(" "))
    })
    await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper(
          [
            [0.8, "Over in yapd, the tests pass."],
            [0.7, "Cup day of"],
            [0.9, "Can you pass me the salt?"],
          ],
          { reply: () => ({ intent: "resume", spoken: "", message: "" }) },
        )
        yield* helper.wait(0.5)
        // Its own words, which the model takes for its own voice.
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        // What the model takes for its own voice.
        yield* helper.talk(0.7, 10)
        yield* helper.quiet
        // His, going on past where it stopped, which the model takes as not meant for it.
        yield* helper.talk(0.9, 40)
        yield* helper.quiet
        // Past its first seconds, its own words are talk not meant for it, as ever, and not logged as either.
        yield* helper.wait(4)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        expect(helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined }))).toEqual([
          { heard: "Over in yapd, the tests pass.", told: true },
          { heard: "Cup day of", told: true },
          { heard: "Can you pass me the salt?", told: true },
          { heard: "Over in yapd, the tests pass.", told: false },
        ])
      }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
    )
    expect(lines.filter((line) => line === Conversation.ownVoice || line === Conversation.notMeant)).toEqual([
      Conversation.ownVoice,
      Conversation.ownVoice,
      Conversation.notMeant,
    ])
    expect(lines.filter((line) => /yapd, the tests|Cup day|salt/.test(line) && !line.startsWith("Heard:"))).toEqual([])
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

  test("picks an answer of yapd's up again when the model takes what stopped it over its first seconds for its own voice, taking none of that for a follow-up, and takes his whole", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // As the model would take yapd's own words, told they may be that.
        const helper = yield* overHelper([[0.8, "Over in yapped, the tests pass."], [0.9, "Tell it to open a PR."]], {
          answer: true,
          follow: (heard, echo) => echo === undefined || !heard.startsWith("Over"),
        })
        yield* helper.wait(2)
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        const picked = {
          commands: [...helper.commands],
          plays: [...helper.plays],
          offered: helper.offered.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          followed: [...helper.followed],
        }
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 15)
        yield* helper.quiet
        return { picked, commands: helper.commands, followed: yield* Fiber.join(helper.fiber), followUps: helper.followed }
      }),
    )
    expect(result).toEqual({
      picked: { commands: ["play", "volume", "stop", "play"], plays: [0, 1.2], offered: [{ heard: "Over in yapped, the tests pass.", told: true }], followed: [] },
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

  test("past three times talk that wasn't meant for it, the rest plays through whatever's said, but 'Mute.' still turns yapd off", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.95, "Mute."]], { off: true })
        yield* helper.wait(4)
        for (let time = 0; time < 3; time++) {
          yield* helper.talk(0.8, 10)
          yield* helper.quiet
          yield* helper.wait(0.5)
        }
        // The TV again, and then him.
        yield* helper.talk(0.8, 10)
        yield* helper.quiet
        const before = helper.offs()
        yield* helper.talk(0.95, 10)
        yield* helper.quiet
        yield* helper.wait(0.5)
        return { commands: helper.commands, transcribed: helper.transcribed, responded: helper.responded, offs: [before, helper.offs()] }
      }),
    )
    expect(result).toEqual({
      // Only "Mute." stops it, at once.
      commands: ["play", "volume", "stop", "play", "volume", "stop", "play", "volume", "stop", "play", "stop"],
      transcribed: ["", "", "", "", "Mute."],
      responded: [],
      offs: [0, 1],
    })
  })

  test.each([
    ["an update", {}],
    ["a question", { ask: true }],
    ["an answer", { answer: true }],
  ] as const)("'Mute.' said on its own after a pause, while what someone else said over %s is still being worked out, turns yapd off", async (_, given) => {
    const over = (before: string) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, before], [0.95, "Mute."]], { responding: 5, off: true, ...given })
          yield* helper.wait(4)
          yield* helper.talk(0.9, 20)
          yield* helper.quiet
          // He says it while that's still being worked out.
          yield* helper.wait(1)
          yield* helper.talk(0.95, 10)
          yield* helper.quiet
          yield* helper.wait(0.1)
          return { offs: helper.offs(), worked: [...helper.responded, ...helper.offered].map(({ heard }) => heard) }
        }),
      )
    expect(await over("Are you coming to the standup?")).toEqual({ offs: 1, worked: ["Are you coming to the standup?"] })
    // Trailed off into it, it's the rest of what he was saying, like a thread to mute, for the model to work out once he's done.
    expect(await over("Can you…")).toEqual({ offs: 0, worked: ["Can you Mute."] })
  })

  test.each([
    ["an update", {}],
    ["a question", { ask: true }],
    ["an answer", { answer: true }],
  ] as const)("'Mute.' said on its own over %s turns yapd off, even with talk after it begun while Whisper is still on it", async (_, given) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.95, "Mute."], [0.9, "Hello?"]], { off: true, transcribing: 0.4, ...given })
        yield* helper.wait(4)
        yield* helper.talk(0.95, 10)
        yield* helper.quiet
        // His phone rings, and he answers it while "Mute." is still being transcribed.
        yield* helper.talk(0.9, 20)
        yield* helper.wait(0.4)
        yield* helper.quiet
        yield* helper.wait(0.4)
        return { offs: helper.offs(), worked: [...helper.responded, ...helper.offered].map(({ heard }) => heard) }
      }),
    )
    expect(result).toEqual({ offs: 1, worked: [] })
  })

  test.each([
    ["once its own voice is learnt", 4],
    ["over its first seconds, while its own voice can still get into the microphone", 1],
  ] as const)("over a notice, %s, nothing he says turns it down, so talk in the room can't keep it low, and 'Mute.' stops it before yapd is turned off", async (_, at) => {
    const over = (said: string) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.95, said]], { off: true, tell: true })
          yield* helper.wait(at)
          yield* helper.talk(0.95, 10)
          yield* helper.quiet
          yield* helper.wait(0.5)
          return { timeline: helper.timeline.map(({ type, value }) => (value === undefined ? type : `${type} ${value}`)), offs: helper.offs() }
        }),
      )
    expect(await over("Mute.")).toEqual({ timeline: ["play", "stop", "off"], offs: 1 })
    expect(await over("What time is it?")).toEqual({ timeline: ["play"], offs: 0 })
  })

  test("over a notice, talk longer than 'Mute.' could be, like a TV's, is never even transcribed", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        // What Whisper would hear as "Mute." were it asked, so asking it would show.
        const helper = yield* overHelper([[0.95, "Mute."]], { off: true, tell: true })
        yield* helper.wait(4)
        yield* helper.talk(0.95, 100)
        yield* helper.quiet
        yield* helper.wait(0.5)
        return { transcribed: helper.transcribed, offs: helper.offs(), commands: helper.commands }
      }),
    )
    expect(result).toEqual({ transcribed: [], offs: 0, commands: ["play"] })
  })

  test.each([
    ["a notice", { tell: true }],
    ["the rest of an update played through after talk that wasn't meant for it", {}],
    ["the rest of an answer played through so", { answer: true }],
    ["the rest of a question played through so", { ask: true }],
  ] as const)("with something waiting to be said next, the moment after %s is over after the pause between lines, and a 'Mute.' begun in it is heard out", async (_, given) => {
    const after = (mute: boolean) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.95, "Mute."]], { off: true, queued: true, ...given })
          yield* helper.wait(4)
          // Talk Whisper makes nothing of, three times, as from a TV, unless it's a notice, which plays through all that's said anyway.
          if (!("tell" in given)) {
            for (let time = 0; time < 3; time++) {
              yield* helper.talk(0.8, 10)
              yield* helper.quiet
              yield* helper.wait(0.5)
            }
          }
          yield* helper.finish
          yield* helper.wait(0.2)
          if (mute) yield* helper.talk(0.95, 10)
          yield* helper.wait(0.2)
          const early = Option.isSome(yield* Fiber.poll(helper.fiber))
          // Past the pause between lines.
          yield* helper.wait(0.3)
          const late = Option.isSome(yield* Fiber.poll(helper.fiber))
          if (mute) yield* helper.quiet
          return { early, late, done: Option.isSome(yield* Fiber.poll(helper.fiber)), offs: helper.offs() }
        }),
      )
    expect(await after(false)).toEqual({ early: false, late: true, done: true, offs: 0 })
    expect(await after(true)).toEqual({ early: false, late: false, done: true, offs: 1 })
  })

  test("once the moment after a notice is over, 'Mute.' begun while other talk is still being transcribed is heard out too", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Is that the news?"], [0.95, "Mute."]], { off: true, tell: true, queued: true, transcribing: 0.4 })
        yield* helper.finish
        // Someone else begins just as it ends, and goes on past the pause between lines.
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 10)
        yield* helper.wait(0.4)
        yield* helper.quiet
        // He says it while that's being transcribed.
        yield* helper.talk(0.95, 10)
        yield* helper.quiet
        yield* helper.wait(0.4)
        yield* helper.wait(0.4)
        return { transcribed: helper.transcribed, offs: helper.offs() }
      }),
    )
    expect(result).toEqual({ transcribed: ["Is that the news?", "Mute."], offs: 1 })
  })

  test.each([
    [
      "talk begun a while before the notice ended, like a TV's, and still going",
      (helper: Effect.Effect.Success<ReturnType<typeof overHelper>>) =>
        Effect.gen(function* () {
          yield* helper.wait(4)
          yield* helper.talk(0.8, 30)
          yield* helper.wait(1)
          yield* helper.finish
          // The pause between lines.
          yield* helper.wait(0.5)
        }),
    ],
    [
      "talk begun a while after other talk ended, while that's still being made out",
      (helper: Effect.Effect.Success<ReturnType<typeof overHelper>>) =>
        Effect.gen(function* () {
          yield* helper.finish
          yield* helper.wait(0.3)
          yield* helper.talk(0.8, 10)
          yield* helper.wait(0.4)
          yield* helper.quiet
          // A TV, begun most of a second after, as Whisper is still on what came before.
          yield* helper.wait(0.8)
          yield* helper.talk(0.85, 30)
          yield* helper.wait(0.2)
        }),
    ],
  ] as const)("once the moment after a notice is over with something waiting, %s, holds what's next up no longer", async (_, said) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Is that the news?"], [0.85, "Back to you."]], { off: true, tell: true, queued: true, transcribing: 1 })
        yield* said(helper)
        return { done: Option.isSome(yield* Fiber.poll(helper.fiber)), offs: helper.offs() }
      }),
    )
    expect(result).toEqual({ done: true, offs: 0 })
  })

  test("once the moment after a notice is over, talk that keeps starting again right after it stops is listened to for 'Mute.' four seconds at most", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Is that the news?"]], { off: true, tell: true, queued: true })
        yield* helper.finish
        for (let time = 0; time < 8; time++) {
          yield* helper.wait(0.3)
          yield* helper.talk(0.8, 10)
          yield* helper.wait(0.2)
          yield* helper.quiet
        }
        yield* helper.wait(0.3)
        yield* helper.talk(0.8, 10)
        yield* helper.wait(0.1)
        const listening = Option.isNone(yield* Fiber.poll(helper.fiber))
        // Four seconds after the pause between lines.
        yield* helper.wait(0.1)
        return { listening, done: Option.isSome(yield* Fiber.poll(helper.fiber)), offs: helper.offs() }
      }),
    )
    expect(result).toEqual({ listening: true, done: true, offs: 0 })
  })

  test("a 'Mute.' begun a beat after the pause between lines that follows a notice is still heard, rather than cut in two", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.95, "Mute."]], { off: true, tell: true, queued: true })
        yield* helper.finish
        yield* helper.wait(0.5)
        yield* helper.wait(0.05)
        yield* helper.talk(0.95, 10)
        yield* helper.quiet
        return helper.offs()
      }),
    )
    expect(result).toBe(1)
  })

  test("with nothing waiting to be said next, a 'Mute, mute' begun in the moment after a notice and still going as it's over is heard out", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.95, "Mute, mute."]], { off: true, tell: true })
        yield* helper.finish
        yield* helper.wait(1.5)
        yield* helper.talk(0.95, 10)
        // Just past the usual moment after it.
        yield* helper.wait(1.7)
        yield* helper.quiet
        return helper.offs()
      }),
    )
    expect(result).toBe(1)
  })

  test("once the moment after a notice is over, Whisper is waited on no longer than what's next is held up for 'Mute.'", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.95, "Mute."]], { off: true, tell: true, queued: true, transcribing: 10 })
        yield* helper.finish
        yield* helper.wait(0.3)
        yield* helper.talk(0.95, 10)
        // Heard out three seconds into the four what's next can be held up for.
        yield* helper.wait(3.2)
        yield* helper.quiet
        // Four seconds after the pause between lines.
        yield* helper.wait(1)
        return { done: Option.isSome(yield* Fiber.poll(helper.fiber)), offs: helper.offs() }
      }),
    )
    expect(result).toEqual({ done: true, offs: 0 })
  })

  test("once the moment after a notice is over, short talk like a TV's left waiting while Whisper lags holds what's next up no longer than 'Mute.' could", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Is that the news?"]], { off: true, tell: true, queued: true, transcribing: 3.9 })
        yield* helper.finish
        yield* helper.wait(0.3)
        // Three short bursts in the moment after it, the last two waiting while Whisper is on the first until 0.3 seconds before what's
        // next can be held up no longer.
        for (let time = 0; time < 3; time++) {
          yield* helper.talk(0.8, 10)
          yield* helper.quiet
          yield* helper.wait(0.05)
        }
        yield* helper.wait(3.75)
        // Just past four seconds after the pause between lines.
        yield* helper.wait(0.4)
        return { done: Option.isSome(yield* Fiber.poll(helper.fiber)), offs: helper.offs() }
      }),
    )
    expect(result).toEqual({ done: true, offs: 0 })
  })

  test.each([
    ["while Whisper can't hear yet, its model still loading, it isn't asked", { unready: true, transcribing: 30 }, 0.6],
    ["Whisper taking longer than 'Mute.' could be heard out in, it's taken for other talk", { transcribing: 10 }, 4],
  ] as const)("over a notice, %s, so what's next is held up no longer", async (_, given, after) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.95, "Mute."]], { off: true, tell: true, queued: true, ...given })
        yield* helper.wait(4)
        yield* helper.talk(0.95, 10)
        yield* helper.quiet
        yield* helper.finish
        yield* helper.wait(after)
        return { done: Option.isSome(yield* Fiber.poll(helper.fiber)), offs: helper.offs() }
      }),
    )
    expect(result).toEqual({ done: true, offs: 0 })
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

  test("listens on for his reply, taking nothing of its own, when the model takes its own last words for that as a line ended within its first seconds", async () => {
    const after = (reply: boolean, answer: boolean) =>
      overHelperScoped(
        Effect.gen(function* () {
          // As the model would take yapd's own "ready", told it may be that, and his reply.
          const helper = yield* overHelper([[0.8, "Ready."], [0.9, "Merge it."]], {
            spoken: "The PR is ready.",
            duration: 2,
            answer,
            reply: ({ echo, heard }) => (echo === undefined ? { intent: "send", spoken: "Okay.", message: heard } : { intent: "resume", spoken: "", message: "" }),
            follow: (_, echo) => echo === undefined,
          })
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
    const own = { heard: "Ready.", told: true }
    expect(await after(true, false)).toMatchObject({ commands: ["play", "volume", "play"], responded: [own, { heard: "Merge it.", told: false }], sent: ["Merge it."] })
    expect(await after(true, true)).toMatchObject({ commands: ["play", "volume"], offered: [own, { heard: "Merge it.", told: false }], done: true })
    // With none, it falls quiet once the usual moment for a reply is up.
    expect(await after(false, false)).toEqual({ commands: ["play", "volume"], responded: [own], sent: [], offered: [], before: false, done: true })
  })

  test.each([
    ["an update", { spoken: "The PR is ready.", words: ["Ready.", "Merge it."] }],
    ["an answer", { spoken: "The PR is ready.", words: ["Ready.", "Merge it."], answer: true }],
    ["an agent's question", { spoken: "The PR is ready, sir. Shall I merge it?", words: ["Merge it?", "Merge it."], ask: true }],
    ["yapd's own question", { spoken: "Which one, sir: yapd or the docs site?", words: ["Site.", "Yapd."], ask: true }],
  ] as const)(
    "gives what he says a second after %s ends within its first seconds, over its own last word that the model is still working out, as surely his",
    async (_, given) => {
      const [own, his] = given.words
      const result = await overHelperScoped(
        Effect.gen(function* () {
          // As the model would: its own last word alone is that, but what he said after the pause is his, even in yapd's words.
          const helper = yield* overHelper([[0.8, own], [0.9, his]], {
            spoken: given.spoken,
            duration: 2,
            responding: 2.6,
            answer: "answer" in given,
            ask: "ask" in given,
            reply: ({ echo, heard, afterPause }) =>
              echo !== undefined && afterPause === undefined ? { intent: "resume", spoken: "", message: "" } : { intent: "send", spoken: "Okay.", message: afterPause ?? heard },
            follow: (_, echo, afterPause) => echo === undefined || afterPause !== undefined,
          })
          yield* helper.wait(1.95)
          yield* helper.talk(0, defaults.lead)
          // Its own last word, which plays to its end before it's clearly speech.
          yield* helper.talk(0.8, 1)
          yield* helper.finish
          yield* helper.talk(0.8, defaults.wary - 1)
          yield* helper.quiet
          // His reply, a second on, while what to make of its own word is still being worked out.
          yield* helper.wait(1)
          yield* helper.talk(0.9, 16)
          yield* helper.quiet
          yield* helper.wait(3)
          return {
            given: [...helper.responded, ...helper.offered].map(({ heard, echo, afterPause }) => ({ heard, told: echo !== undefined, afterPause })),
            taken: [...helper.sent, ...helper.followed],
          }
        }),
      )
      expect(result).toEqual({
        given: [
          { heard: own, told: true, afterPause: undefined },
          { heard: `${own} ${his}`, told: true, afterPause: his },
        ],
        taken: ["answer" in given || "ask" in given ? `${own} ${his}` : his],
      })
    },
  )

  test.each([
    ["an update", false],
    ["a question", true],
  ] as const)("gives what he said after a pause over %s apart only when yapd's own voice may be in what came before", async (_, ask) => {
    const after = (at: number) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "Hmm, hold on."], [0.91, "Merge it."], [0.92, "And deploy."]], { responding: 2, ask })
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
          return (ask ? helper.offered : helper.responded).map(({ heard, echo, afterPause }) => ({ heard, told: echo !== undefined, afterPause }))
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

  test("still gives what he said after a pause apart when all of it trails off and is given a moment more", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hmm, hold on."], [0.91, "Merge it, and…"]], { responding: 2 })
        yield* helper.wait(1)
        yield* helper.talk(0, defaults.lead)
        yield* helper.talk(0.9, 20)
        yield* helper.quiet
        // He goes on before the reply to it is ready, and trails off.
        yield* helper.wait(0.5)
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(6)
        return helper.responded.map(({ heard, echo, afterPause }) => ({ heard, told: echo !== undefined, afterPause }))
      }),
    )
    expect(result).toEqual([
      { heard: "Hmm, hold on.", told: true, afterPause: undefined },
      { heard: "Hmm, hold on. Merge it, and…", told: true, afterPause: "Merge it, and…" },
    ])
  })

  test.each(["Stop.", "Thank you.", "Of course.", "That's it.", "I don't know.", "Thank you so much."])("takes \"%s\" over its first seconds for his to judge, however short, though yapd was saying \"stopped\" and Whisper makes up \"Thank you.\"", async (heard) => {
    const over = (frames: number, live = false) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, heard]], {
            spoken: "Over in yapd, the agent stopped at the next step and is waiting on you, sir.",
            duration: 5,
            live,
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
    // Sixteen frames of speech, half a second past where it stopped, or less once the time it takes to stop has gone by.
    expect(await over(16)).toEqual({ commands: ["play", "volume", "stop"], plays: [0], responded: [{ heard, told: true }], done: true })
    expect(await over(16, true)).toEqual({ commands: ["play", "volume", "stop"], plays: [0], responded: [{ heard, told: true }], done: true })
    // Twelve, no longer than its own voice can go on after: still his to judge, told it may be its own voice.
    expect(await over(12)).toEqual({ commands: ["play", "volume", "stop"], plays: [0], responded: [{ heard, told: true }], done: true })
  })

  /** Each way yapd talks that he can talk over, in words with "stopped" in them: an update, an answer, an agent's question and one of its own. */
  const talkedOver = [
    ["an update", { spoken: "Over in yapd, the agent stopped at the next step and is waiting on you, sir." }],
    ["an answer", { spoken: "Over in yapd, the agent stopped at the next step and is waiting on you, sir.", answer: true }],
    ["an agent's question", { spoken: "Over in yapd, the agent stopped and asks whether to carry on with the migration. Shall it?", ask: true }],
    ["yapd's own question", { spoken: "The agent stopped, sir. Which project is the new work for: yapd or the docs site?", ask: true }],
  ] as const

  /** Short things he may say, or Whisper may make of yapd's own voice, none of which code can tell apart. */
  const short = ["4.", "C.", "Stop, thanks.", "Okay, stop.", "That's it.", "The agent stopped."]

  /** Each line logged while `test` runs, as one string. */
  const logging = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => {
    const lines: Array<string> = []
    const logger = Logger.make(({ message }) => {
      lines.push((Array.isArray(message) ? message : [message]).join(" "))
    })
    return overHelperScoped(test.pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger)))).then((result) => ({ result, lines }))
  }

  /** The log lines for picking up again over its first seconds. */
  const pickups = (lines: ReadonlyArray<string>) => lines.filter((line) => line === Conversation.ownVoice || line === Conversation.notMeant)

  test.each(talkedOver.flatMap(([kind, given]) => short.map((heard) => [heard, kind, given] as const)))(
    "gives the model %p said over its first seconds of %s with what yapd was saying around then, however short, and does what it decides",
    async (heard, _, given) => {
      const asked = "answer" in given || "ask" in given
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, heard]], { ...given, duration: 5, live: true, reply: () => ({ intent: "answer", spoken: answered, message: "" }) })
          yield* helper.wait(0.3)
          yield* helper.talk(0, defaults.lead)
          // No longer than its own voice can go on after it stops, so it may all have been that.
          yield* helper.talk(0.9, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          return {
            told: [...helper.responded, ...helper.offered].map(({ heard, echo }) => ({ heard, stopped: echo?.includes("stopped") })),
            done: asked ? helper.followed : helper.rendered,
          }
        }),
      )
      expect(result).toEqual({ told: [{ heard, stopped: true }], done: [asked ? heard : answered] })
    },
    30_000,
  )

  test.each(talkedOver)(
    "picks %s up again from 0.8 s before where it stopped, saying nothing and logging it, when the model takes what's said over its first seconds for yapd's own voice",
    async (_, given) => {
      const { result, lines } = await logging(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "4."]], {
            ...given,
            duration: 5,
            live: true,
            reply: ({ echo }) => ({ intent: echo === undefined ? "dismiss" : "resume", spoken: "", message: "" }),
            follow: (_, echo) => echo === undefined,
          })
          yield* helper.wait(1.5)
          yield* helper.talk(0, defaults.lead)
          yield* helper.talk(0.9, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          return {
            stopped: helper.timeline.find(({ type }) => type === "stop")?.at ?? 0,
            plays: helper.plays.map(seconds),
            told: [...helper.responded, ...helper.offered].map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
            rendered: helper.rendered,
            followed: helper.followed,
            replies: yield* helper.replies,
          }
        }),
      )
      expect(result.stopped).toBeGreaterThan(1.5)
      const { stopped, ...rest } = result
      expect(rest).toEqual({ plays: [0, seconds(stopped - 0.8)], told: [{ heard: "4.", told: true }], rendered: [], followed: [], replies: [] })
      expect(pickups(lines)).toEqual([Conversation.ownVoice])
    },
    30_000,
  )

  test.each(talkedOver)(
    "keeps listening to %s however often the model takes something short said over its first seconds for yapd's own voice, as that's no talk not meant for it",
    async (_, given) => {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, "C."], [0.9, "Which PR was that?"]], {
            ...given,
            duration: 5,
            reply: ({ echo }) => (echo === undefined ? { intent: "answer", spoken: answered, message: "" } : { intent: "resume", spoken: "", message: "" }),
            follow: (_, echo) => echo === undefined,
          })
          // More times than talk not meant for it is let go before it stops listening.
          for (let time = 0; time < 4; time++) {
            yield* helper.wait(0.5)
            yield* helper.talk(0.8, 10)
            yield* helper.quiet
          }
          // Past its first seconds since.
          yield* helper.wait(2)
          yield* helper.talk(0.9, 10)
          yield* helper.quiet
          yield* helper.wait(1)
          return {
            told: [...helper.responded, ...helper.offered].map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
            commands: helper.commands.slice(-2),
          }
        }),
      )
      expect(result.told).toEqual([...Array.from({ length: 4 }, () => ({ heard: "C.", told: true })), { heard: "Which PR was that?", told: false }])
      // Stopped for him once more, as it was still listening.
      expect(result.commands).toContain("stop")
    },
    30_000,
  )

  test.each(talkedOver.flatMap(([kind, given]) => [
    ["nothing", kind, given, false],
    ["Whisper failing", kind, given, true],
  ] as const))(
    "picks up again from 0.8 s before where it stopped over its first seconds, asking nobody and logging it, on %s for %s",
    async (_, __, given, failing) => {
      const { result, lines } = await logging(
        Effect.gen(function* () {
          const helper = yield* overHelper([], { ...given, duration: 5, live: true, failing })
          yield* helper.wait(1.5)
          yield* helper.talk(0, defaults.lead)
          yield* helper.talk(0.9, 12)
          yield* helper.quiet
          yield* helper.wait(1)
          return {
            stopped: helper.timeline.find(({ type }) => type === "stop")?.at ?? 0,
            plays: helper.plays.map(seconds),
            told: [...helper.responded, ...helper.offered],
          }
        }),
      )
      expect(result.stopped).toBeGreaterThan(1.5)
      expect(result).toEqual({ stopped: result.stopped, plays: [0, seconds(result.stopped - 0.8)], told: [] })
      expect(pickups(lines)).toEqual([Conversation.ownVoice])
    },
    30_000,
  )

  test.each(["Thanks for watching!", "The agent stopped."])("gives \"%s\" over its first seconds, no longer than its own voice can go on after, to the model, picking up again once it takes it for yapd's own voice", async (heard) => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, heard]], {
          spoken: "Over in yapd, the agent stopped at the next step and is waiting on you, sir.",
          duration: 5,
          reply: ({ echo }) => ({ intent: echo === undefined ? "dismiss" : "resume", spoken: "", message: "" }),
        })
        yield* helper.wait(0.3)
        yield* helper.talk(0, defaults.lead)
        yield* helper.talk(0.9, 12)
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
    expect(result).toEqual({ commands: ["play", "volume", "stop", "play"], plays: [0, 0], responded: [{ heard, told: true }], done: false })
  })
  test("keeps listening however often the model carries on after a nod, like an \"Okay.\" or a \"Yeah.\" before the agent's question, unlike for talk that wasn't meant for it", async () => {
    for (const nod of ["Okay.", "Yeah."]) {
      const result = await overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, nod]], { reply: () => ({ intent: "resume", spoken: "", message: "" }) })
          yield* helper.wait(4)
          for (let time = 0; time < 4; time++) {
            yield* helper.talk(0.9, 10)
            yield* helper.quiet
            yield* helper.wait(0.5)
          }
          return { commands: helper.commands, plays: helper.plays.map(seconds), responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })) }
        }),
      )
      expect([nod, result]).toEqual([
        nod,
        {
          commands: ["play", ...Array.from({ length: 4 }, () => ["volume", "stop", "play"]).flat()],
          // Each time from a moment back, as after any talk it carries on after, never further back than the time before, so he hears the question.
          plays: [0, 2.5, 2.5, 2.5, 2.5],
          responded: Array.from({ length: 4 }, () => ({ heard: nod, echo: undefined })),
        },
      ])
    }
  })

  test("tells the model nothing of its own voice for what he begins past its first seconds, though a sound before was let go as what may have been its own voice", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Which PR was that?"]], { reply: () => ({ intent: "answer", spoken: answered, message: "" }) })
        yield* helper.wait(2.5)
        // A sound over its first seconds that never becomes speech.
        yield* helper.talk(0.8, 2)
        yield* helper.talk(0, defaults.abandon)
        yield* helper.wait(1.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(1)
        return { commands: helper.commands, responded: helper.responded.map(({ heard, echo }) => ({ heard, echo })) }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "volume", "volume", "volume", "stop", "play"],
      responded: [{ heard: "Which PR was that?", echo: undefined }],
    })
  })

  test("falls quiet at once when the model carries on after what he said once a line has ended, as it's no reply, without listening on", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Sam, can you pass the salt?"], [0.91, "Merge it."]], {
          duration: 2,
          reply: () => ({ intent: "resume", spoken: "", message: "" }),
        })
        yield* helper.wait(2)
        yield* helper.finish
        yield* helper.wait(0.5)
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        const done = Option.isSome(yield* Fiber.poll(helper.fiber))
        // Within the moment it would have listened on for.
        yield* helper.talk(0.91, 10)
        yield* helper.quiet
        yield* helper.wait(5)
        return { done, heard: yield* Fiber.join(helper.fiber), commands: helper.commands, responded: helper.responded, sent: helper.sent }
      }),
    )
    expect(result).toEqual({
      done: true,
      heard: true,
      commands: ["play"],
      // Said to the end, there was nothing it hadn't said yet.
      responded: [{ project: "yapd", turn: long.turn, needsYou: false, lines: [{ speaker: "yapd", text: long.spoken }], heard: "Sam, can you pass the salt?", voiced: 0, lateBy: 0.5 }],
      sent: [],
    })
  })

  test("tells the model its own voice going on a third of a second past where it stopped may be that, when it took a fifth of a second to stop", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "Over in yapd, the tests pass."]], {
          reply: ({ echo }) => ({ intent: echo === undefined ? "dismiss" : "resume", spoken: "", message: "" }),
        })
        yield* helper.wait(1)
        yield* helper.talk(0, defaults.lead)
        yield* helper.talk(0.8, 1)
        // Stopped a fifth of a second after its first sound, at 1.2 seconds, its voice going on to about 1.5.
        yield* helper.wait(0.2)
        yield* helper.talk(0.8, 15)
        yield* helper.quiet
        yield* helper.wait(1)
        return {
          commands: helper.commands,
          plays: helper.plays.map(seconds),
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          done: Option.isSome(yield* Fiber.poll(helper.fiber)),
        }
      }),
    )
    expect(result).toEqual({
      commands: ["play", "volume", "stop", "play"],
      plays: [0, 0.4],
      responded: [{ heard: "Over in yapd, the tests pass.", told: true }],
      done: false,
    })
  })

  test("journals a dismissal said over its first seconds that he went on with after a pause, and counts the update heard", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Hmm, hold on."], [0.91, "No, that's fine, leave it."]], {
          responding: 2,
          reply: () => ({ intent: "dismiss", spoken: "", message: "" }),
        })
        yield* helper.wait(1)
        yield* helper.talk(0, defaults.lead)
        // No longer than its own voice can go on after it stops, so it may all have been that.
        yield* helper.talk(0.9, 12)
        yield* helper.quiet
        // He goes on before the reply to it is ready.
        yield* helper.wait(0.5)
        yield* helper.talk(0.91, 20)
        yield* helper.quiet
        yield* helper.wait(3)
        return {
          responded: helper.responded.map(({ heard, echo }) => ({ heard, told: echo !== undefined })),
          replies: yield* helper.replies,
          overheard: yield* helper.overheard,
          heard: yield* Fiber.join(helper.fiber),
        }
      }),
    )
    expect(result).toEqual({
      responded: [
        { heard: "Hmm, hold on.", told: true },
        { heard: "Hmm, hold on. No, that's fine, leave it.", told: true },
      ],
      replies: ["Hmm, hold on. No, that's fine, leave it."],
      // Kept with what may have been its own voice, and what he said after a pause, for the brain reading it back later.
      overheard: [{ echo: first, afterPause: "No, that's fine, leave it." }],
      heard: true,
    })
  })
})

describe("A line listened to from its end", () => {
  /** A failure, as it's said. */
  const failed = "The Tezos migration failed, sir: the fee tests broke."

  test("plays through talk over it, never turned down or stopped, takes none of that for a reply, even talk going on past its end when it wasn't yapd's own voice, and takes what he says after it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.8, "And now the weather."], [0.9, "Tell it to fix them and run them again."]], { answer: true, after: true, spoken: failed })
        // A TV over it once its own voice is learnt, then again, going on past its end.
        yield* helper.wait(4)
        yield* helper.talk(0.8, 20)
        yield* helper.quiet
        yield* helper.wait(4)
        yield* helper.talk(0.8, 20)
        yield* helper.wait(1.5)
        yield* helper.finish
        yield* helper.talk(0.8, 20)
        yield* helper.quiet
        // Then him.
        yield* helper.wait(1)
        yield* helper.talk(0.9, 20)
        yield* helper.quiet
        return { commands: helper.commands, offered: helper.offered, followed: helper.followed, done: yield* Fiber.join(helper.fiber) }
      }),
    )
    expect(result).toEqual({
      commands: ["play"],
      offered: [{ heard: "Tell it to fix them and run them again." }],
      followed: ["Tell it to fix them and run them again."],
      done: true,
    })
  })

  test("yapd's own last words alone are dropped with no model call; 'No.' merged into them goes to the model with the line's words as the echo note, and what's after them as surely his", async () => {
    const spoken = "On it, sir: the Tezos migration."
    const after = (own: string, no: boolean, line = spoken) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, own], [0.95, "No."]], { answer: true, after: true, wait: Conversation.linger, spoken: line, duration: 2.5 })
          // Its own voice gets into the microphone over the line, as over a new voice processor's first seconds, until it ends.
          yield* helper.wait(0.3)
          yield* helper.talk(0.9, 40)
          yield* helper.wait(2.2)
          yield* helper.finish
          // He says no right after, before the silence that tells its own voice has stopped.
          if (no) {
            yield* helper.wait(0.3)
            yield* helper.talk(0.95, 10)
          }
          yield* helper.quiet
          yield* helper.wait(4)
          return { transcribed: helper.transcribed, offered: helper.offered, done: Option.isSome(yield* Fiber.poll(helper.fiber)) }
        }),
      )
    expect(await after("the Tezos migration.", false)).toEqual({ transcribed: ["the Tezos migration."], offered: [], done: true })
    expect(await after("the Tezos migration.", true)).toEqual({
      transcribed: ["the Tezos migration. No."],
      offered: [{ heard: "the Tezos migration. No.", echo: spoken, afterPause: "No." }],
      done: true,
    })
    // Misheard, with its last word said earlier in the line too, none of it is told as his: it may all be its own.
    const runsOn = "On it, sir: fixing what Rosie runs on."
    expect(await after("On it, sir. Fixing what Rosy runs on.", false, runsOn)).toEqual({
      transcribed: ["On it, sir. Fixing what Rosy runs on."],
      offered: [{ heard: "On it, sir. Fixing what Rosy runs on.", echo: runsOn }],
      done: true,
    })
  })

  test("'Mute.' run into by yapd's own last words turns yapd off with nothing worked out, however early its own voice began, even after a line about muting", async () => {
    const muted = (from: number, spoken = "On it, sir: the Tezos migration.", last = "the Tezos migration.") =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, last], [0.95, "Mute."]], { answer: true, after: true, off: true, wait: Conversation.linger, spoken, duration: 2.5 })
          // Its own voice gets into the microphone from `from` into the line until it ends, and he says it right after.
          yield* helper.wait(from)
          yield* helper.talk(0.9, 10)
          yield* helper.wait(2.5 - from)
          yield* helper.finish
          yield* helper.wait(0.2)
          yield* helper.talk(0.95, 10)
          yield* helper.quiet
          yield* helper.wait(0.1)
          return { offs: helper.offs(), transcribed: helper.transcribed, offered: helper.offered, done: Option.isSome(yield* Fiber.poll(helper.fiber)) }
        }),
      )
    const off = (last = "the Tezos migration.") => ({ offs: 1, transcribed: [`${last} Mute.`], offered: [], done: true })
    expect(await muted(0.3)).toEqual(off())
    // Begun over its last moment, it's acted on as soon as it's made out, as over any line.
    expect(await muted(2.1)).toEqual(off())
    // Said after its last words, it's never the line's own "mute", whatever the line was about.
    expect(await muted(0.3, "Muted, sir: the Tezos importer.", "the Tezos importer.")).toEqual(off("the Tezos importer."))
    expect(await muted(2.1, "Muted, sir: the Tezos importer.", "the Tezos importer.")).toEqual(off("the Tezos importer."))
  })

  test("'Mute.' begun over its last second, before its last moment, and still going as it ends, turns yapd off with nothing worked out", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.95, "Mute."]], { answer: true, after: true, off: true, spoken: failed })
        // Once its own voice is learnt, 0.9 s before it ends.
        yield* helper.wait(9.1)
        yield* helper.talk(0.95, 14)
        yield* helper.wait(0.9)
        yield* helper.finish
        yield* helper.quiet
        yield* helper.wait(0.1)
        return { offs: helper.offs(), offered: helper.offered, done: Option.isSome(yield* Fiber.poll(helper.fiber)) }
      }),
    )
    expect(result).toEqual({ offs: 1, offered: [], done: true })
  })

  test("what he begins as it ends, while what's run once it's said to the end is still running, is his reply, not talk over it", async () => {
    const result = await overHelperScoped(
      Effect.gen(function* () {
        const helper = yield* overHelper([[0.9, "Scratch that."]], { answer: true, after: true, through: Effect.sleep("200 millis") })
        yield* helper.wait(4)
        yield* helper.finish
        yield* helper.talk(0.9, 10)
        yield* helper.quiet
        yield* helper.wait(0.2)
        return { followed: helper.followed, done: yield* Fiber.join(helper.fiber) }
      }),
    )
    expect(result).toEqual({ followed: ["Scratch that."], done: true })
  })

  test.each([
    ["an answer", false],
    ["a line listened to from its end", true],
  ] as const)("the wait after %s is over early for an answer he asked for, no sooner than 2 s after it ended, and talk begun before then holds it open", async (_, after) => {
    const waited = (talk: boolean) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.9, "And the Mina one?"]], { answer: true, after, asked: true })
          yield* helper.wait(4)
          yield* helper.finish
          yield* helper.wait(1.5)
          if (talk) yield* helper.talk(0.9, 10)
          yield* helper.wait(0.4)
          const early = Option.isSome(yield* Fiber.poll(helper.fiber))
          // Past two seconds after it ended, and a beat.
          yield* helper.wait(0.3)
          const late = Option.isSome(yield* Fiber.poll(helper.fiber))
          if (talk) yield* helper.quiet
          return { early, late, followed: helper.followed }
        }),
      )
    expect(await waited(false)).toEqual({ early: false, late: true, followed: [] })
    expect(await waited(true)).toEqual({ early: false, late: false, followed: ["And the Mina one?"] })
  })

  test("talk longer than 'Mute.' could be, ending 'and…', then 'Mute.' a second later, in a failure's wait, turns yapd off; 'Can you…' then 'mute.' doesn't", async () => {
    const over = (before: string, frames: number) =>
      overHelperScoped(
        Effect.gen(function* () {
          const helper = yield* overHelper([[0.8, before], [0.95, "Mute."]], { answer: true, after: true, off: true, responding: 5, spoken: failed })
          yield* helper.wait(4)
          yield* helper.finish
          yield* helper.wait(0.5)
          yield* helper.talk(0.8, frames)
          yield* helper.quiet
          // He says it while that's still being worked out.
          yield* helper.wait(1)
          yield* helper.talk(0.95, 10)
          yield* helper.quiet
          yield* helper.wait(0.1)
          return { offs: helper.offs(), worked: helper.offered.map(({ heard }) => heard) }
        }),
      )
    // A TV's talk, cut off mid-sentence: nothing is worked out of it.
    expect(await over("So the plan for the rollout is to ship the loader and…", 100)).toEqual({ offs: 1, worked: [] })
    // Trailed off into it, it's the rest of what he was saying, like a thread to mute, for the model to work out.
    expect(await over("Can you…", 10)).toEqual({ offs: 0, worked: ["Can you Mute."] })
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

  test("keeps which subagents are read aloud for yapd, never the agent, while asking the agent to use one is still its", () => {
    const prompt = Responder.prompt(
      { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Could you start reading me the subagents from now on?" },
      Option.none(),
    )
    expect(prompt).toContain(
      `Which threads you read aloud to them, a thread's subagents included, like "read me its subagents", "start reading the subagents" or "keep its subagents to yourself", is for you, never the agent: never "send".`,
    )
    expect(prompt).toContain(`Asking the agent to use subagents, like "have a subagent review it", is the agent's as usual.`)
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
      voiced: 1,
      lateBy: 0,
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

  test("tells the model what of what he said earlier on may have been yapd's own voice, and what after a pause was his, only for what he began over it", () => {
    const told = (line: Partial<Words.Line>) =>
      Responder.prompt(
        {
          project: "yapd",
          turn: { prompt: Option.none(), message: "The tests pass and the PR is ready." },
          needsYou: false,
          lines: [
            { speaker: "yapd", text: "Over in yapd,…" },
            { speaker: "user", text: "the pull request merge it", ...line },
            { speaker: "yapd", text: "Once more, sir?" },
          ],
          heard: "Fix the tests.",
        },
        Option.none(),
      )
    expect(told({ echo: "Over in yapd, the tests pass now and the pull request" })).toContain(
      `User: the pull request merge it (they began that while your own voice could still get into their microphone, so what came first may be your own words, from around "Over in yapd, the tests pass now and the pull request")\nYou: Once more, sir?`,
    )
    expect(told({ echo: "Over in yapd, the tests pass now and the pull request", afterPause: "merge it" })).toContain(
      `from around "Over in yapd, the tests pass now and the pull request"; what they said after a pause, "merge it", is surely theirs)`,
    )
    // Begun once its own voice could no longer get in, his words alone, as ever.
    expect(told({})).toContain("User: the pull request merge it\nYou: Once more, sir?")
  })

  test("tells the model what he said after a pause is surely his, even in its own words, only with what it was saying around when he began", () => {
    const interruption: Responder.Interruption = {
      project: "yapd",
      turn: { prompt: Option.none(), message: "The PR is ready." },
      needsYou: true,
      lines: [{ speaker: "yapd", text: "The PR is ready." }],
      heard: "Ready. Merge it.",
      voiced: 1,
      lateBy: 0,
    }
    const sentence = `What they said after a pause, "Merge it.", is surely theirs, even where it repeats your words, like naming one of your options; only what came before it may be yours.`
    const told = Responder.prompt({ ...interruption, echo: "The PR is ready.", afterPause: "Merge it." }, Option.none())
    expect(told).toContain(sentence)
    // In the note on its own voice, just before what he said, which still ends it, all of it.
    expect(told.endsWith(`A question or a dismissal goes as usual. ${sentence}\n\nWhat the user just said:\nReady. Merge it.`)).toBe(true)
    // Without a pause, or without the note, nothing's said of it.
    expect(Responder.prompt({ ...interruption, echo: "The PR is ready." }, Option.none())).not.toContain("after a pause")
    expect(Responder.prompt({ ...interruption, echo: "The PR is ready.", afterPause: "" }, Option.none())).not.toContain("after a pause")
    expect(Responder.prompt({ ...interruption, afterPause: "Merge it." }, Option.none())).toBe(Responder.prompt(interruption, Option.none()))
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
      { priority: "done", headline: "In right price, I've added the table before “Données traitées,” sir.", more: "" },
      { spoken: "In right price, I've added the table before the processed data section, sir." },
    ])
    const summary = await Effect.runPromise(
      Effect.flatMap(Condenser.Condenser, ({ condense }) =>
        condense("right-price", { prompt: Option.none(), message: "J'ai ajouté le tableau avant « Données traitées »." }),
      ).pipe(Effect.provide(Condenser.ProviderCondenser.pipe(Layer.provide(layer)))),
    )
    expect(summary).toEqual({ priority: "done", spoken: "In right price, I've added the table before the processed data section, sir.", more: "" })
    expect(asked[1]).toContain("What's about to be said:\nIn right price, I've added the table before “Données traitées,” sir.")
  })

  test("asks nothing more when it's all in English", async () => {
    const { asked, layer } = scripted([{ priority: "done", headline: "yapd's tests pass now.", more: "" }])
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
    // "Go on" stays a yes, never the rest.
    expect(Words.agreed.has("go on")).toBe(true)
  })

  test("the model is given the rest to say if he asks for more, and told how yapd talks is never for the agent", () => {
    const prompt = Responder.prompt(over("Can you tell me the rest?", "Retries back off now."), Option.none())
    expect(prompt).toContain(`What you left out of your update, to say only if they ask for more or for the details, as "answer" with these words as they are:\nRetries back off now.`)
    expect(prompt).toContain(`How you talk to them is for you, never the agent: focus, quiet, goodnight, being back, shorter updates or everything in full`)
    expect(prompt).toContain(`Never "send". It's "answer", telling them in a few words to ask you that with their shortcut.`)
    expect(Responder.prompt(over("Thanks."), Option.none())).not.toContain("What you left out")
  })

  test("catching up said over an update is never for the agent: the model is told to have him ask with the shortcut, and nothing takes it without the model", () => {
    const prompt = Responder.prompt(over("What did I miss?"), Option.none())
    expect(prompt).toContain(`Catching up is for you, never the agent: hearing what they missed or haven't heard, or what came in while they were away or had you off, however they put it`)
    expect(prompt).toContain(`Never "send". It's "answer", telling them in a few words to ask you that with their shortcut.`)
    for (const heard of ["What did I miss?", "Catch me up.", "Anything else from rig?"]) expect(quickly(over(heard, "Retries back off now."))).toBeUndefined()
  })

  test("a bare forget it or never mind over an update is hearing enough, without the model, even when the agent asked something: never asked to use the shortcut", () => {
    const dismissed: Responder.Reply = { intent: "dismiss", spoken: "", message: "" }
    for (const heard of ["Forget it.", "Forget about it.", "Never mind."]) {
      expect(quickly(over(heard))).toEqual(dismissed)
      expect(quickly({ ...over(heard), needsYou: true, turn: { prompt: Option.none(), message: "The PR is up. Should I merge it?" } })).toEqual(dismissed)
    }
    // Forgetting something in particular is for yapd, which the model is told to have him ask with the shortcut.
    expect(quickly(over("Forget that one about rig."))).toBeUndefined()
    expect(Responder.prompt(over("Forget that one about rig."), Option.none())).toContain(
      `telling them in a few words to ask you that with their shortcut. A bare "forget it" or "never mind" isn't that: it's "dismiss".`,
    )
  })

  test("a routine's name said over an update is never for its agent as the bare words: the model is told his routines, and to have him say one with the shortcut", async () => {
    const result = await scoped(
      Effect.gen(function* () {
        const { asked, layer } = scripted([{ intent: "answer", spoken: "Say that with your shortcut, sir.", message: "" }])
        const { fiber, sent, speak, wait } = yield* conversation(["Land it."], 0, [], "sent", { model: layer, routines: ["land it", "review it"] })
        yield* speak
        yield* wait(20)
        yield* Fiber.join(fiber)
        return { asked, sent }
      }),
    )
    expect(result.asked[0]).toContain(`Their routines, by name: "land it", "review it".`)
    expect(result.asked[0]).toContain(
      `A routine's name said as a request is never "send", even when it reads as an instruction for this agent: it's "answer", telling them in a few words to say it with their shortcut.`,
    )
    expect(result.sent).toEqual([])
    expect(Responder.prompt(over("Land it."), Option.none())).not.toContain("Their routines")
  })

  test("what the thread was asked, when it's one of his routines' steps yapd sent it, the model is told of by the routine's name alone", async () => {
    // Words of his own, never an example the model is shown.
    const steps = "have Codex audit the fee code twice"
    const result = await scoped(
      Effect.gen(function* () {
        const { asked, layer } = scripted([{ intent: "dismiss", spoken: "", message: "" }])
        const { fiber, speak, wait } = yield* conversation(["Do that again, and merge it."], 0, [], "sent", {
          model: layer,
          over: { ...update, turn: { prompt: Option.some(steps), message: "Both audits came back clean." }, about: { machine: "Rosie", id: "t-mina" } },
          kept: [{ at: 0, kind: "sent", machine: "Rosie", thread: "t-mina", text: steps, said: "On it, sir.", detail: { routines: ["review it"] } }],
        })
        yield* speak
        yield* wait(20)
        yield* Fiber.join(fiber)
        return asked
      }),
    )
    expect(result[0]).not.toContain(steps)
    expect(result[0]).toContain(`User's prompt to the agent:\nhis routine "review it"`)
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

  test("goes ahead at once when the agent asked", () => {
    const heard = "The PR is up. Should I merge it?"
    expect(reply("Yeah, go ahead.", heard, true, heard)).toEqual({ intent: "send", spoken: "On it, sir.", message: "Yeah, go ahead." })
    expect(reply("yes please", heard, true, heard)).toEqual({ intent: "send", spoken: "On it, sir.", message: "Yes please." })
    // As yapd said it, when the agent buried its question.
    expect(reply("Yes.", "Done. Shall I merge? The docs are updated too.", true, "Over in yapd, it's done. Shall I merge it?")?.intent).toBe("send")
  })

  test("a plain yes to an update that asked goes to its agent at once only when begun within 3 s of its end and said clearly; later or fainter, the model works it out", () => {
    const asked = "The PR is up. Should I merge it?"
    const yes = (lateBy: number, voiced: number) =>
      Effect.runSync(
        Responder.quick(
          { project: "yapd", turn: { prompt: Option.none(), message: asked }, needsYou: true, lines: [{ speaker: "yapd", text: asked }], heard: "Yes.", voiced, lateBy },
          Effect.succeed("On it, sir."),
        ),
      )?.intent
    expect(yes(0, 0.5)).toBe("send")
    expect(yes(3, 0.5)).toBe("send")
    // Begun a while after, or faint, it may be a TV's or someone else's.
    expect(yes(3.2, 0.5)).toBeUndefined()
    expect(yes(0.5, 0.2)).toBeUndefined()
    // A stop is still one, however late or faint.
    expect(
      Effect.runSync(
        Responder.quick(
          { project: "yapd", turn: { prompt: Option.none(), message: asked }, needsYou: true, lines: [{ speaker: "yapd", text: asked }], heard: "Stop.", voiced: 0.2, lateBy: 5 },
          Effect.succeed("On it, sir."),
        ),
      ),
    ).toEqual({ intent: "dismiss", spoken: "", message: "" })
  })

  test("leaves a nod to an update cut off to the model, shown what yapd hadn't said yet, and that a nod only answers what was heard", () => {
    const message = "The PR is ready. Should I merge it?"
    expect(reply("Okay.", message, true, "The PR is…")).toBeUndefined()
    const told = (unsaid?: string, echo?: string) =>
      Responder.prompt(
        {
          project: "yapd",
          turn: { prompt: Option.none(), message },
          needsYou: true,
          lines: [{ speaker: "yapd", text: unsaid === undefined ? message : "The PR is…" }],
          heard: "Okay.",
          ...(unsaid === undefined ? {} : { unsaid }),
          ...(echo === undefined ? {} : { echo }),
        },
        Option.none(),
      )
    const note = `An "okay" or "thanks" can't answer a question they haven't heard yet: if the agent's question is only in what you hadn't said yet, it's "resume", so they hear it. Otherwise go by the rules above.`
    // Right after the conversation, before the note on its own voice and what he said.
    expect(told("ready. Should I merge it?", "The PR is ready.")).toContain(
      `You: The PR is…\n\nWhat you hadn't said yet when they cut you off:\nready. Should I merge it?\n\n${note}\n\nThey began while your own voice`,
    )
    expect(told("ready. Should I merge it?").endsWith(`${note}\n\nWhat the user just said:\nOkay.`)).toBe(true)
    // Said to the end, there's nothing it hadn't said, so neither.
    expect(told()).not.toContain("hadn't said yet")
    expect(told()).not.toContain(`can't answer a question they haven't heard yet`)
    expect(told("")).not.toContain("hadn't said yet")
    // Nor the guess this replaces, that a nod answers nothing whenever its first line was cut off.
    expect(told("ready. Should I merge it?")).not.toContain("answers nothing")
  })

  test("leaves a yes begun while yapd's own voice could still get into the microphone to the model, which may be its own \"sir?\", but still ends it at a stop", () => {
    const said = "Codex asks whether to deploy to staging, sir?"
    const over = (heard: string) =>
      Effect.runSync(
        Responder.quick(
          { project: "yapd", turn: { prompt: Option.none(), message: said }, needsYou: true, lines: [{ speaker: "yapd", text: said }], heard, echo: said, voiced: 1, lateBy: 0 },
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
          { project: "yapd", turn: { prompt: Option.none(), message }, needsYou: message === heard, lines: [{ speaker: "yapd", text: message }], heard: said, voiced: 1, lateBy: 0 },
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
