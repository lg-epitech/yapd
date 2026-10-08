import { Clock, type Duration, Effect, Fiber, Option, Queue, Scope, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, type AudioError, type Playback } from "./Audio.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, RelayError, type Thread } from "./Relay.ts"
import { Journal } from "./Journal.ts"
import { Persona } from "./Persona.ts"
import { type Line, type Reply, Responder } from "./Responder.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { extension, Voice } from "./Voice.ts"

/** An update, rendered and ready to be read out. */
export interface Update {
  readonly session: string
  readonly project: string
  readonly turn: Turn
  /** Whether the agent asked something, needs a decision or permission, or failed. */
  readonly needsYou: boolean
  readonly spoken: string
  readonly audio: string
  readonly thread: Thread
  /** When its turn stopped. */
  readonly at: number
}

type Signal =
  | Endpointer.Event
  /** The microphone stopped, like when the helper quits. */
  | { readonly _tag: "Deaf" }
  /** The rest carry the id of what sent them, so one that's no longer waited on is let go. */
  | { readonly _tag: "Finished"; readonly id: number }
  /** The playback broke off, like when the audio helper quits: what it played wasn't heard to the end. */
  | { readonly _tag: "Broke"; readonly id: number; readonly error: AudioError }
  | { readonly _tag: "Lingered"; readonly id: number }
  /** The reply is whatever the one who asked for it works out: what to do about an update, or an answer to a question. */
  | { readonly _tag: "Replied"; readonly id: number; readonly reply: unknown }

/**
 * The microphone for a whole update, so nothing the user says is missed
 * between lines, like while yapd works out what to say back.
 */
interface Ear {
  readonly signals: Queue.Queue<Signal>
  deaf: boolean
}

/** How a line went: played out, or talked over, with what the user said. */
type Outcome =
  | { readonly _tag: "Finished" }
  | {
      readonly _tag: "Interrupted"
      /** How far it got, in seconds. */
      readonly at: number
      readonly duration: number
      readonly audio: Float32Array
      readonly ear: Ear
    }

/** How long the microphone stays open after yapd stops, for a reply to what it just said. */
const linger: Duration.DurationInput = "3 seconds"
/** Longer after a question, which takes a moment's thought to answer. */
const pondering: Duration.DurationInput = "8 seconds"
/** Longer than the longest utterance, so only a microphone that went quiet trips it. */
const patience = "40 seconds"
/** Volume while it's still unclear whether the user is talking. */
const ducked = 0.25
/** How far back to pick up after talk that wasn't meant for yapd. */
const rewind = 1.5
/** Talk that wasn't meant for yapd, after which the rest of an update plays without listening, say for a TV. */
const misses = 3
/** How long to wait for the rest when the user trails off, before working out a reply. */
const hesitation = "3 seconds"
/** How long the user can keep adding to what they said, since talk that goes on longer is more likely a TV. */
const rambling = 60_000

/** Words a sentence hardly ever ends on. */
const dangling = /\b(and|or|but|to|the|a|an|of|for|with|my|your|if|when|because)[.,]?$/i

/** Whether the user seems to have stopped mid-thought: Whisper marks trailing off with an ellipsis. */
export const unfinished = (heard: string) => /(\.\.\.|…|,)$/.test(heard) || dangling.test(heard)

/** What the user said before and after a pause, as one. */
export const together = (before: string, after: string) =>
  after === "" ? before : `${before.replace(/\s*(\.\.\.|…)$/, "")} ${after}`

/** What's said of a reply held back because the work it answers has been given something else since. */
export const movedOn = "You've moved on from that since, so I held it back."

/** Seconds of speech in what the user said, less the quiet the endpointer keeps either side of it. */
export const voiced = (audio: Float32Array) =>
  Math.max(0, (audio.length - (Endpointer.defaults.lead + Endpointer.defaults.tail) * frame) / rate)

/** Samples a second from the microphone, and in each frame of it. */
const rate = 16000
const frame = 512

/** The part of `text` heard in `fraction` of its audio, marked when it's cut short. */
export const cut = (text: string, fraction: number) => {
  if (fraction >= 1) return text
  const words = text.split(/\s+/)
  return `${words.slice(0, Math.max(1, Math.round(words.length * fraction))).join(" ")}…`
}


/** Something yapd asks the user for itself, like which project new work is for, rendered and ready to be asked. */
export interface Question {
  readonly audio: string
  /**
   * Works out what the user meant by what they said, and how many seconds of
   * it were speech, which may be called again with all of it if they carry
   * on. What it returns is run once they've stopped, and none means it
   * wasn't an answer.
   */
  readonly answer: (heard: string, voiced: number) => Effect.Effect<Option.Option<Effect.Effect<void>>>
}

/**
 * Reads updates out while listening. Talking over yapd ducks it at once and
 * stops it once it's clearly speech; what the user said then decides whether it
 * stops there, answers, sends the agent a follow-up, or carries on.
 */
export const make = (options: {
  readonly dir: string
  /** Whether unrelated activity has made the update stale. */
  readonly moved: (update: Update) => Effect.Effect<boolean>
  /** Delivers the follow-up, or queues it until the session can receive it, using its latest thread. */
  readonly send: (update: Update, message: string) => Effect.Effect<"sent" | "queued", RelayError>
  /** Says how a follow-up went when the update it answers was cut off before yapd could. */
  readonly late: (update: Update, spoken: string, failed: boolean) => Effect.Effect<void>
  /** Something was said over an update and taken in, which takes the place of whatever yapd asked before. */
  readonly replied: Effect.Effect<void>
  /** yapd starts saying something back over an update, like an answer or word of a follow-up, which is then what the user heard last. */
  readonly saying: (update: Update, line: string) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const lifetime = yield* Effect.scope
    const audio = yield* Audio
    const vad = yield* Vad
    const transcriber = yield* Transcriber
    const responder = yield* Responder
    const voice = yield* Voice
    const persona = yield* Persona
    const journal = yield* Journal

    let ids = 0
    const fresh = () => ++ids

    /** Starts listening, if there's a microphone. That's only known once something plays. */
    const open = (scope: Scope.Scope) =>
      Effect.gen(function* () {
        const detect = yield* vad.make.pipe(Effect.option)
        if (Option.isNone(detect)) return undefined
        const microphone = yield* audio.microphone.pipe(Scope.extend(scope))
        if (Option.isNone(microphone)) return undefined
        const ear: Ear = { signals: yield* Queue.unbounded<Signal>(), deaf: false }
        const endpointer = new Endpointer.Endpointer()
        yield* Stream.fromQueue(microphone.value).pipe(
          Stream.mapEffect((frame) =>
            detect.value(frame).pipe(Effect.map((probability) => endpointer.push(frame, probability))),
          ),
          Stream.runForEach((event) => (event === undefined ? Effect.void : Queue.offer(ear.signals, event))),
          Effect.ignore,
          Effect.zipRight(
            Effect.suspend(() => {
              ear.deaf = true
              return Queue.offer(ear.signals, { _tag: "Deaf" })
            }),
          ),
          Effect.forkIn(scope),
        )
        return ear
      })

    /** The microphone for whatever is said in the scope, opened when it's first needed. */
    const hearing = (scope: Scope.Scope) => {
      let opened: Ear | undefined
      return Effect.suspend(() =>
        opened === undefined
          ? open(scope).pipe(
              Effect.tap((ear) => {
                opened = ear
              }),
            )
          : Effect.succeed(opened),
      )
    }

    /**
     * Plays a line from `from` seconds, listening if there's an ear, then
     * `wait` longer for a reply. `through` runs once it has played to the end,
     * before that wait: the user has heard it, whatever they say after.
     */
    const speak = (
      path: string,
      from: number,
      ear: Effect.Effect<Ear | undefined>,
      given: { readonly wait?: Duration.DurationInput; readonly through?: Effect.Effect<void> } = {},
    ) =>
      Effect.gen(function* () {
        const { wait = linger, through = Effect.void } = given
        const playback = yield* audio.play(path, from)
        const listening = yield* ear
        if (listening === undefined || listening.deaf) {
          yield* playback.finished
          yield* through
          return { _tag: "Finished" } satisfies Outcome
        }
        return yield* listen(playback, listening, wait, through)
      }).pipe(Effect.scoped)

    const listen = (playback: Playback, ear: Ear, wait: Duration.DurationInput, through: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const { signals } = ear
        const id = fresh()
        // Failing ends it too, or this could wait for a signal that never comes.
        yield* playback.finished.pipe(
          Effect.match({
            onFailure: (error): Signal => ({ _tag: "Broke", id, error }),
            onSuccess: (): Signal => ({ _tag: "Finished", id }),
          }),
          Effect.flatMap((signal) => Queue.offer(signals, signal)),
          Effect.forkScoped,
        )

        let playing = true
        /** Between an onset and the end of what the user said. */
        let speaking = false
        let deaf = false
        let stoppedAt: number | undefined
        let lingering: { readonly id: number; readonly fiber: Fiber.RuntimeFiber<void> } | undefined
        const stopLingering = Effect.suspend(() => {
          const fiber = lingering?.fiber
          lingering = undefined
          return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
        })
        const startLingering = Effect.gen(function* () {
          yield* stopLingering
          const id = fresh()
          const fiber = yield* Effect.sleep(wait).pipe(
            Effect.zipRight(Queue.offer(signals, { _tag: "Lingered", id })),
            Effect.asVoid,
            Effect.forkScoped,
          )
          lingering = { id, fiber }
        })
        const next = Effect.suspend(() =>
          speaking && !playing
            ? Queue.take(signals).pipe(
                Effect.timeout(patience),
                Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
              )
            : Queue.take(signals),
        )

        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              speaking = true
              yield* stopLingering
              if (playing) yield* playback.volume(ducked)
              break
            case "Speech":
              yield* stopLingering
              if (playing) {
                playing = false
                stoppedAt = yield* playback.stop
              }
              break
            case "Abandoned":
              speaking = false
              if (playing) yield* playback.volume(1)
              else yield* startLingering
              break
            case "Utterance":
              return {
                _tag: "Interrupted",
                at: stoppedAt ?? playback.duration,
                duration: playback.duration,
                audio: signal.audio,
                ear,
              } satisfies Outcome
            case "Finished":
              // Also arrives for a playback the user stopped, which is already dealt with.
              if (signal.id !== id || !playing) break
              playing = false
              yield* through
              if (deaf) return { _tag: "Finished" } satisfies Outcome
              if (!speaking) yield* startLingering
              break
            case "Broke":
              // As without a microphone: cut short, it wasn't heard, and there's nothing to wait for a reply to.
              if (signal.id !== id || !playing) break
              return yield* Effect.fail(signal.error)
            case "Lingered":
              if (signal.id !== lingering?.id) break
              return { _tag: "Finished" } satisfies Outcome
            case "Deaf":
              deaf = true
              if (!playing) return { _tag: "Finished" } satisfies Outcome
              yield* playback.volume(1)
              break
            case "Replied":
              break
          }
        }
      })

    /**
     * Works out a reply while still listening, so pausing mid-thought doesn't cut
     * the user off: if they carry on before it's ready, it starts again with all
     * they said, and how many seconds of all of it were speech. Nothing's done
     * with a reply while they might still be talking.
     */
    const settle = <R>(
      ear: Ear,
      first: string,
      audio: Float32Array,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      respond: (heard: string, voiced: number) => Effect.Effect<R>,
    ) =>
      Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + rambling
        let heard = first
        let speech = voiced(audio)
        while (true) {
          const replying = unfinished(heard) ? Effect.zipRight(Effect.sleep(hesitation), respond(heard, speech)) : respond(heard, speech)
          if (ear.deaf || (yield* Clock.currentTimeMillis) > until) return { heard, reply: yield* replying }
          const id = fresh()
          const fiber = yield* replying.pipe(
            Effect.flatMap((reply) => Queue.offer(ear.signals, { _tag: "Replied", id, reply })),
            Effect.fork,
          )

          let speaking = false
          let carryingOn = false
          let held: R | undefined
          let more: Float32Array | undefined
          waiting: while (true) {
            const signal = yield* (speaking || carryingOn)
              ? Queue.take(ear.signals).pipe(
                  Effect.timeout(patience),
                  Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
                )
              : Queue.take(ear.signals)
            switch (signal._tag) {
              case "Replied":
                // Once they carry on, even one that got in before it was stopped is out of date.
                if (signal.id !== id || carryingOn) break
                // Only this call's replies carry its id.
                if (!speaking) return { heard, reply: signal.reply as R }
                held = signal.reply as R
                break
              case "Onset":
                speaking = true
                break
              case "Abandoned":
                speaking = false
                if (held !== undefined) return { heard, reply: held }
                break
              case "Speech":
                carryingOn = true
                held = undefined
                yield* Fiber.interrupt(fiber)
                break
              case "Utterance":
                more = signal.audio
                break waiting
              case "Deaf":
                speaking = false
                if (carryingOn) break waiting
                if (held !== undefined) return { heard, reply: held }
                break
              case "Finished":
              case "Broke":
              case "Lingered":
                break
            }
          }
          yield* Fiber.interrupt(fiber)
          if (more === undefined) continue
          const after = yield* transcribe(more)
          heard = together(heard, after)
          // Only what added words, since speech Whisper made nothing of isn't in what was heard.
          if (after !== "") speech += voiced(more)
        }
      })

    /** Follow-ups on their way, each attached to the update it answers, with its own mark, so one ending doesn't clear a later one. */
    const sending = new Map<Update, object>()

    /**
     * Sends a follow-up and returns what to say about it. Once the user has said
     * it, it's sent whatever happens to the conversation, like a dictation
     * cutting it off: what's then left unsaid is said later.
     */
    const pass = (update: Update, reply: Reply) =>
      Effect.gen(function* () {
        let failed = false
        const mark = {}
        sending.set(update, mark)
        const lines = yield* persona.lines
        const fiber = yield* follow(update, reply.message).pipe(
          Effect.map((result) => (result === "queued" ? lines.queued : reply.spoken || lines.onIt)),
          Effect.catchAll((error) =>
            Effect.logWarning("Could not send the follow-up", { reason: error.reason, error }).pipe(
              Effect.tap(() => {
                failed = true
              }),
              Effect.as(error.reason),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (sending.get(update) === mark) sending.delete(update)
            }),
          ),
          Effect.annotateLogs({ project: update.project }),
          Effect.forkIn(lifetime),
        )
        return yield* Fiber.join(fiber).pipe(
          Effect.onInterrupt(() =>
            Fiber.join(fiber).pipe(
              Effect.flatMap((spoken) => options.late(update, spoken, failed)),
              Effect.forkIn(lifetime),
            ),
          ),
        )
      })

    const follow = (update: Update, message: string) =>
      Effect.gen(function* () {
        // Typing into a session that started something else would steer it, or answer one of its prompts.
        if (yield* options.moved(update)) return yield* new RelayError({ reason: movedOn })
        const text = plain(message)
        const result = yield* options.send(update, text)
        yield* Effect.logInfo(`${result === "queued" ? "Queued" : "Sent"}: ${text}`)
        return result
      })

    const transcribe = (audio: Float32Array) =>
      transcriber.transcribe(audio).pipe(
        Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))),
        Effect.tap((heard) => (heard === "" ? Effect.void : Effect.logInfo(`Heard: ${heard}`))),
      )

    /**
     * Reads an update out and talks it over. `through` runs as soon as the
     * update itself has been read to the end, even with the microphone still
     * open for a reply, since the user has heard it by then.
     */
    const converse = (update: Update, through: Effect.Effect<void> = Effect.void) =>
      Effect.suspend(() => {
        const rendered: Array<string> = []
        return Effect.gen(function* () {
          const ear = hearing(yield* Effect.scope)
          const lines: Array<Line> = []
          let text = update.spoken
          let path = update.audio
          let from = 0
          let missed = 0

          while (true) {
            const outcome: Outcome = yield* speak(path, from, missed < misses ? ear : Effect.succeed(undefined), {
              through: path === update.audio ? through : Effect.void,
            })
            if (outcome._tag === "Finished") return
            // Replying to something yapd had finished saying: there's nothing to go back to.
            const after = outcome.at >= outcome.duration
            // Always forward, so talk that keeps coming can't hold an update back forever.
            const carryOn = () => {
              missed++
              from = Math.max(from, outcome.at - rewind)
            }

            const first = yield* transcribe(outcome.audio)
            if (first === "") {
              if (after) return
              carryOn()
              continue
            }

            const said = cut(text, outcome.duration > 0 ? outcome.at / outcome.duration : 1)
            const { heard, reply } = yield* settle(outcome.ear, first, outcome.audio, transcribe, (heard) =>
              responder
                .respond({
                  project: update.project,
                  turn: update.turn,
                  needsYou: update.needsYou,
                  lines: [...lines, { speaker: "yapd", text: said }],
                  heard,
                })
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.logWarning("Could not reply", error).pipe(
                      Effect.zipRight(persona.lines),
                      Effect.map((lines): Reply => ({ intent: "answer", spoken: lines.misheard, message: "" })),
                    ),
                  ),
                ),
            )
            yield* Effect.logInfo(`Reply: ${reply.intent}${reply.spoken === "" ? "" : `, saying: ${reply.spoken}`}`)
            if (reply.intent !== "resume") {
              yield* journal.write({
                at: yield* Clock.currentTimeMillis,
                kind: "reply",
                host: update.thread.origin.host,
                project: update.project,
                thread: update.session,
                directory: update.thread.cwd,
                said: reply.spoken,
                text: heard,
                detail: { intent: reply.intent, ...(reply.message === "" ? {} : { message: reply.message }) },
              })
              yield* options.replied
            }

            if (reply.intent === "dismiss") return
            if (reply.intent === "resume") {
              if (after) return
              carryOn()
              continue
            }

            lines.push({ speaker: "yapd", text: said }, { speaker: "user", text: heard })
            text =
              reply.intent === "send"
                ? yield* pass(update, reply)
                : reply.spoken
            if (text === "") return
            path = join(options.dir, `${crypto.randomUUID()}${extension}`)
            rendered.push(path)
            yield* voice.render(text, path)
            yield* options.saying(update, text)
            from = 0
            missed = 0
          }
        }).pipe(
          Effect.scoped,
          Effect.ensuring(Effect.promise(() => Promise.all(rendered.map((path) => rm(path, { force: true }))))),
          Effect.annotateLogs({ project: update.project }),
        )
      })

    /**
     * Asks the user something and listens for what they say over it or right
     * after, like with an update. Returns whether they answered.
     */
    const ask = (question: Question) =>
      Effect.gen(function* () {
        const ear = hearing(yield* Effect.scope)
        let from = 0
        let missed = 0
        while (true) {
          const outcome: Outcome = yield* speak(question.audio, from, missed < misses ? ear : Effect.succeed(undefined), { wait: pondering })
          if (outcome._tag === "Finished") return false
          const first = yield* transcribe(outcome.audio)
          const answer = first === "" ? Option.none() : (yield* settle(outcome.ear, first, outcome.audio, transcribe, question.answer)).reply
          if (Option.isSome(answer)) {
            // They've answered, so it's taken in even if a dictation starts right now.
            yield* Effect.uninterruptible(answer.value)
            return true
          }
          // Talk that wasn't an answer, after the question was asked in full, leaves it unanswered.
          if (outcome.at >= outcome.duration) return false
          missed++
          from = Math.max(from, outcome.at - rewind)
        }
      }).pipe(Effect.scoped)

    return {
      converse,
      ask,
      /** Whether a follow-up to the session, or this particular update, is on its way. */
      sending: (session: string, update?: Update) => Effect.sync(() =>
        update === undefined ? [...sending.keys()].some((update) => update.session === session) : sending.has(update),
      ),
    }
  })
