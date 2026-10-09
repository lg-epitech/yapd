import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Deferred, Effect, Fiber, Layer, Option, Queue, Random, Schema, type Scope, TestClock, TestContext } from "effect"
import { Audio, AudioError } from "./Audio.ts"
import * as Condenser from "./Condenser.ts"
import * as Conversation from "./Conversation.ts"
import { cut, together, unfinished } from "./Conversation.ts"
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
      Fiber.interrupt(fiber).pipe(Effect.zipRight(Effect.fork(made.ask({ audio: "/tmp/question.wav", answer, ...(terms === undefined ? {} : { terms }) }))))
    /** One that takes what's said after "yes" for an answer. */
    const ask = (answers: Array<string>) =>
      question((heard) =>
        Effect.succeed(heard.startsWith("Yes") ? Option.some(Effect.sync(() => void answers.push(heard))) : Option.none()),
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
