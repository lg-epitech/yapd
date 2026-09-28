import { Effect, Fiber, Option, Queue, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, type Playback } from "./Audio.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, Relays, RelayError, type Thread } from "./Relay.ts"
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

/** How a line went: played out, or talked over, with what the user said. */
type Outcome =
  | { readonly _tag: "Finished" }
  | {
      readonly _tag: "Interrupted"
      /** How far it got, in seconds. */
      readonly at: number
      readonly duration: number
      readonly audio: Float32Array
    }

type Signal =
  | Endpointer.Event
  | { readonly _tag: "Finished" }
  | { readonly _tag: "Lingered" }
  /** The microphone stopped, like when the helper quits. */
  | { readonly _tag: "Deaf" }

/** How long the microphone stays open after yapd stops, for a reply to what it just said. */
const linger = "3 seconds"
/** Longer than the longest utterance, so only a microphone that went quiet trips it. */
const patience = "40 seconds"
/** Volume while it's still unclear whether the user is talking. */
const ducked = 0.25
/** How far back to pick up after talk that wasn't meant for yapd. */
const rewind = 1.5
/** Talk that wasn't meant for yapd, after which the rest of an update plays without listening, say for a TV. */
const misses = 3

/** The part of `text` heard in `fraction` of its audio, marked when it's cut short. */
export const cut = (text: string, fraction: number) => {
  if (fraction >= 1) return text
  const words = text.split(/\s+/)
  return `${words.slice(0, Math.max(1, Math.round(words.length * fraction))).join(" ")}…`
}

const misheard: Reply = { intent: "answer", spoken: "Sorry, I didn't catch that.", message: "" }

/**
 * Reads updates out while listening. Talking over yapd ducks it at once and
 * stops it once it's clearly speech; what the user said then decides whether it
 * stops there, answers, sends the agent a follow-up, or carries on.
 */
export const make = (options: {
  readonly dir: string
  /** Whether the session has done anything since the update's turn stopped. */
  readonly moved: (update: Update) => Effect.Effect<boolean>
  readonly sent: (session: string, message: string) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const audio = yield* Audio
    const vad = yield* Vad
    const transcriber = yield* Transcriber
    const responder = yield* Responder
    const relays = yield* Relays
    const voice = yield* Voice

    const speak = (path: string, from: number, listening: boolean) =>
      Effect.gen(function* () {
        const playback = yield* audio.play(path, from)
        // Only known once playing: the helper opens the microphone as it starts.
        const microphone = listening ? yield* audio.microphone : Option.none()
        const detect = Option.isSome(microphone) ? yield* vad.make.pipe(Effect.option) : Option.none()
        if (Option.isNone(microphone) || Option.isNone(detect)) {
          yield* playback.finished
          return { _tag: "Finished" } satisfies Outcome
        }
        return yield* listen(playback, microphone.value, detect.value)
      }).pipe(Effect.scoped)

    const listen = (
      playback: Playback,
      microphone: Queue.Dequeue<Float32Array>,
      detect: (frame: Float32Array) => Effect.Effect<number, unknown>,
    ) =>
      Effect.gen(function* () {
        const signals = yield* Queue.unbounded<Signal>()
        const endpointer = new Endpointer.Endpointer()
        yield* Stream.fromQueue(microphone).pipe(
          Stream.mapEffect((frame) => detect(frame).pipe(Effect.map((probability) => endpointer.push(frame, probability)))),
          Stream.runForEach((event) => (event === undefined ? Effect.void : Queue.offer(signals, event))),
          Effect.ignore,
          Effect.zipRight(Queue.offer(signals, { _tag: "Deaf" })),
          Effect.forkScoped,
        )
        // Failing counts too, or this could wait for a signal that never comes.
        yield* playback.finished.pipe(
          Effect.ignore,
          Effect.zipRight(Queue.offer(signals, { _tag: "Finished" })),
          Effect.forkScoped,
        )

        let playing = true
        /** Between an onset and the end of what the user said. */
        let speaking = false
        let deaf = false
        let stoppedAt: number | undefined
        let lingering: Fiber.RuntimeFiber<void> | undefined
        const stopLingering = Effect.suspend(() => (lingering === undefined ? Effect.void : Fiber.interrupt(lingering)))
        const startLingering = Effect.gen(function* () {
          yield* stopLingering
          lingering = yield* Effect.sleep(linger).pipe(
            Effect.zipRight(Queue.offer(signals, { _tag: "Lingered" })),
            Effect.asVoid,
            Effect.forkScoped,
          )
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
              } satisfies Outcome
            case "Finished":
              // Also arrives for a playback the user stopped, which is already dealt with.
              if (!playing) break
              playing = false
              if (deaf) return { _tag: "Finished" } satisfies Outcome
              if (!speaking) yield* startLingering
              break
            case "Lingered":
              return { _tag: "Finished" } satisfies Outcome
            case "Deaf":
              deaf = true
              if (!playing) return { _tag: "Finished" } satisfies Outcome
              yield* playback.volume(1)
              break
          }
        }
      })

    const follow = (update: Update, message: string, again: boolean) =>
      Effect.gen(function* () {
        if (again) return yield* new RelayError({ reason: "It's still on what I sent it, so I didn't send that." })
        // Typing into a session that started something else would steer it, or answer one of its prompts.
        if (yield* options.moved(update)) {
          return yield* new RelayError({ reason: "That session has moved on since, so I didn't send it." })
        }
        const text = plain(message)
        yield* relays.send(update.thread, text)
        yield* options.sent(update.session, text)
        yield* Effect.logInfo(`Sent: ${text}`)
      })

    const converse = (update: Update) =>
      Effect.suspend(() => {
        const rendered: Array<string> = []
        return Effect.gen(function* () {
          const lines: Array<Line> = []
          // The project is spoken first, so it's part of what was heard.
          let text = `${update.project}. ${update.spoken}`
          let path = update.audio
          let from = 0
          let missed = 0
          let sent = false

          while (true) {
            const outcome: Outcome = yield* speak(path, from, missed < misses)
            if (outcome._tag === "Finished") return
            // Replying to something yapd had finished saying: there's nothing to go back to.
            const after = outcome.at >= outcome.duration
            // Always forward, so talk that keeps coming can't hold an update back forever.
            const carryOn = () => {
              missed++
              from = Math.max(from, outcome.at - rewind)
            }

            const heard = yield* transcriber.transcribe(outcome.audio).pipe(
              Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))),
            )
            if (heard === "") {
              if (after) return
              carryOn()
              continue
            }
            yield* Effect.logInfo(`Heard: ${heard}`)

            const said = cut(text, outcome.duration > 0 ? outcome.at / outcome.duration : 1)
            const reply = yield* responder
              .respond({
                project: update.project,
                turn: update.turn,
                needsYou: update.needsYou,
                lines: [...lines, { speaker: "yapd", text: said }],
                heard,
              })
              .pipe(Effect.catchAll((error) => Effect.logWarning("Could not reply", error).pipe(Effect.as(misheard))))
            yield* Effect.logInfo(`Reply: ${reply.intent}`)

            if (reply.intent === "dismiss") return
            if (reply.intent === "resume") {
              if (after) return
              carryOn()
              continue
            }

            lines.push({ speaker: "yapd", text: said }, { speaker: "user", text: heard })
            text =
              reply.intent === "send"
                ? yield* follow(update, reply.message, sent).pipe(
                    Effect.tap(() => {
                      sent = true
                    }),
                    Effect.as(reply.spoken || "Sent."),
                    Effect.catchAll((error) =>
                      Effect.logWarning("Could not send the follow-up", error).pipe(Effect.as(error.reason)),
                    ),
                  )
                : reply.spoken
            if (text === "") return
            path = join(options.dir, `${crypto.randomUUID()}${extension}`)
            rendered.push(path)
            yield* voice.render(text, path)
            from = 0
            missed = 0
          }
        }).pipe(
          Effect.ensuring(Effect.promise(() => Promise.all(rendered.map((path) => rm(path, { force: true }))))),
          Effect.annotateLogs({ project: update.project }),
        )
      })

    return { converse }
  })
