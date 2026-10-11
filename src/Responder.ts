import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { aloud, inEnglish, styled, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import { Model } from "./Model.ts"
import { afterOnIt, Persona, withOnIt } from "./Persona.ts"

export const Intent = Schema.Literal("dismiss", "answer", "send", "resume")
export type Intent = typeof Intent.Type

/** A flat object rather than a union, since some CLIs only take an object schema. */
export const Reply = Schema.Struct({
  intent: Intent,
  spoken: Schema.String,
  message: Schema.String,
})
export type Reply = typeof Reply.Type

export interface Line {
  readonly speaker: "yapd" | "user"
  readonly text: string
  /** For the user, what yapd was saying around when they began, when its own voice could still get into their microphone. */
  readonly echo?: string
  /** With `echo`, what they said once they carried on after a pause, which is surely theirs. */
  readonly afterPause?: string
}

/** The user said something while yapd was reading an update, or right after. */
export interface Interruption {
  readonly project: string
  readonly turn: Turn
  /** Whether the agent is waiting on the user. */
  readonly needsYou: boolean
  /** What's been said about the update so far, oldest first, ending with yapd's line they spoke over. */
  readonly lines: ReadonlyArray<Line>
  readonly heard: string
  /**
   * What yapd was saying around when they began, when that was while its own
   * voice could still get into the microphone: the first words heard may be
   * some of it, or their first word lost under it.
   */
  readonly echo?: string
  /** With `echo`, what they said once they carried on after a pause, which is surely theirs, as yapd had stopped by then. */
  readonly afterPause?: string
  /** When yapd was cut off, the words of its line they spoke over that it hadn't said yet. */
  readonly unsaid?: string
}

export class RespondError extends Data.TaggedError("RespondError")<{ readonly cause: unknown }> {}

export class Responder extends Context.Tag("yapd/Responder")<
  Responder,
  { readonly respond: (interruption: Interruption) => Effect.Effect<Reply, RespondError> }
>() {}

const instructions = `You're yapd, the voice that tells a developer how the work they gave their coding agents went. They interrupted you while you read them an update, or spoke right after you finished. Work out what they want from what they said.

Reply with only a JSON object with the keys "intent", "spoken" and "message".

"intent":
- "dismiss" if they've heard enough or want you to be quiet, however they put it. That includes acknowledging, like "sounds good", "okay" or "thanks", unless the agent is waiting on them and those words answer what it asked.
- "answer" if they asked something the agent's message or the conversation answers, including asking you to repeat.
- "send" if it's meant for the agent and would change what it does: an instruction, a correction, a decision it asked for, or a question its message doesn't answer. Agreeing with what the agent already said it would do changes nothing, so that's "dismiss". So is telling it to do nothing, leave something as it is, or not go ahead, like "keep the ticket as it is" or "no, leave it", even when the agent asked: it has already stopped, and sending that only wakes it to say it understood.
- "resume" if it wasn't meant for you, like talking to someone else or background noise.

"spoken": what you say back. They're listening, not reading.
${aloud}
- For "answer", the answer in at most 50 words.
- For "send", empty: you say your usual line that it's in hand. Only when there's more they must know than that, say just that, in a few words, like "I took that to mean the staging branch." Don't repeat back what they asked for: they've just said it.
- Empty for "dismiss" and "resume".

"message": for "send", the message for the agent, written as the user would type it: first person, keeping their intent and wording, with anything they referred to spelled out so it stands on its own. Keep every request they made, in their order, including what to do once something's done, like "when that's merged, update the deployment". Empty otherwise.

What they said was transcribed from speech and can have mistakes, so go with what they most likely meant. Write "message" in the language they spoke.`

export const prompt = ({ project, turn, needsYou, lines, heard, echo, afterPause, unsaid }: Interruption, style: Option.Option<string>) =>
  [
    instructions,
    ...Option.toArray(Option.map(style, styled)),
    `Project: ${project}`,
    ...Option.match(turn.prompt, { onNone: () => [], onSome: (prompt) => [`User's prompt to the agent:\n${prompt}`] }),
    `Agent's message:\n${turn.message}`,
    needsYou
      ? "The agent is waiting on the user: it asked something, needs a decision or permission, or failed."
      : "The agent isn't waiting on the user.",
    `Conversation so far, where "…" marks where you were cut off:\n${lines
      .map(({ speaker, text }) => `${speaker === "yapd" ? "You" : "User"}: ${text}`)
      .join("\n")}`,
    ...(unsaid === undefined || unsaid === ""
      ? []
      : [
          `What you hadn't said yet when they cut you off:\n${unsaid}`,
          `An "okay" or "thanks" can't answer a question they haven't heard yet: if the agent's question is only in what you hadn't said yet, it's "resume", so they hear it. Otherwise go by the rules above.`,
        ]),
    ...(echo === undefined
      ? []
      : [
          `They began while your own voice could still get into their microphone, so what was heard may start with your own words, from around "${echo}", misheard or not, and their first word may be lost under yours. Words that sound like yours there are yours, however they came out, like "Code up." for "Claude on": take them all out, and never put them in the message or turn them into words of theirs. If nothing surely theirs is left, it's "resume", never "dismiss". If a message for the agent sounds cut off, or hangs on a word that may be yours, don't send it: make it "answer", asking them in a few words to say it again. A question or a dismissal goes as usual.${
            afterPause === undefined || afterPause.trim() === ""
              ? ""
              : ` What they said after a pause, "${afterPause}", is surely theirs, even where it repeats your words, like naming one of your options; only what came before it may be yours.`
          }`,
        ]),
    `What the user just said:\n${heard}`,
  ].join("\n\n")

/** What only fills a pause or asks nicely, which is never what was said. */
const padding = ["uh", "um", "erm", "oh", "ah", "hmm", "sir", "please"]

/** What he calls yapd, which is only how he addresses it, unless it's all he said. */
const names = ["jarvis", "yapd"]

/**
 * What's said, as it's compared: lowercase words, without the "um", "sir" and
 * "Jarvis" around them. A name said on its own is kept, since "Yapd." can be
 * the answer to which project, and is never silence.
 */
export const gist = (heard: string) => {
  const words = heard
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !padding.includes(word))
  const said = words.filter((word) => !names.includes(word))
  return (said.length > 0 ? said : words).join(" ")
}

/** Hearing enough, however it's put. Said to any update, it never goes to the agent. */
export const enough: ReadonlySet<string> = new Set([
  "stop", "quiet", "be quiet", "shut up", "silence", "mute", "skip", "skip it", "next", "enough", "that's enough", "never mind",
])

/** What Whisper writes for near-silence, which nobody said. */
export const hallucinated: ReadonlySet<string> = new Set(["you", "thank you", "bye", "see you again", "kid", "thanks for watching"])

/** Taking an update in. Said to one that asked something, they could be the answer, so the model judges those. */
export const noted: ReadonlySet<string> = new Set([
  "thanks", "thank you", "thanks a lot", "cheers", "got it", "ok", "okay", "ok thanks", "okay thanks", "cool", "great", "good",
  "very good", "perfect", "nice", "sounds good", "alright", "all right", "noted", "understood", "awesome", "fine", "good job",
  "well done", "excellent", "brilliant", "lovely", "good to know", "ok cool", "okay cool", "great thanks", "perfect thanks",
])

/** Going ahead with what was asked. Only ever taken as that after a question. */
export const agreed: ReadonlySet<string> = new Set([
  "yes", "yeah", "yep", "yup", "sure", "go ahead", "do it", "yes do it", "yes go ahead", "go for it", "yes go for it",
  "absolutely", "of course", "yes of course", "yeah do it", "yeah go ahead", "sure go ahead", "ok do it", "okay do it",
  "ok go ahead", "okay go ahead", "yes yes", "yeah yeah", "sounds good do it", "sounds good go ahead", "yes that's fine",
  "yes it's fine", "yes ship it", "ship it", "merge it", "yes merge it", "go on", "proceed", "yes proceed", "do both",
  "yes do both", "yes both", "both",
])

const question = /\?\s*["')\]]*\s*$/

/**
 * Whether what they're answering is a question they heard in full: the first
 * thing said back to an update that asked something, as the agent wrote it or
 * as yapd said it. Once there's been an exchange, or yapd was cut off before
 * the end, "yes" could mean anything, so it's left to the model.
 */
const asked = ({ needsYou, turn, lines }: Interruption) => {
  if (!needsYou || lines.some(({ speaker }) => speaker === "user")) return false
  const said = lines.findLast(({ speaker }) => speaker === "yapd")?.text.trim() ?? ""
  return said !== "" && !said.endsWith("…") && (question.test(said) || question.test(turn.message.trim()))
}

/** What they said, as they'd have typed it. */
const typed = (heard: string) => {
  const trimmed = heard.trim().replace(/[\s.!,]+$/, "")
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`
}

/**
 * The replies that need no model to work out: hearing enough, taking an update
 * in, and going ahead when the agent asked. They're the most common by far,
 * and answering them at once is what makes yapd feel quick. Anything else, or
 * anything said to an update that asked something that isn't a plain yes, is
 * left to the model.
 */
export const quick = (interruption: Interruption, onIt: Effect.Effect<string>): Effect.Effect<Reply | undefined> => {
  const said = gist(interruption.heard)
  if (said === "") return Effect.succeed(undefined)
  if (enough.has(said)) return Effect.succeed({ intent: "dismiss", spoken: "", message: "" })
  // Begun while yapd's own voice could still get into the microphone, a yes may be its own words, like its "sir?" heard as "Sure.": the model weighs that.
  if (asked(interruption) && interruption.echo === undefined) {
    // Only picked: it's noted as said once it's passed on, since he may yet carry on talking and this reply be dropped.
    return agreed.has(said)
      ? Effect.map(onIt, (spoken) => ({ intent: "send", spoken, message: typed(interruption.heard) }))
      : Effect.succeed(undefined)
  }
  if (noted.has(said) && !interruption.needsYou) return Effect.succeed({ intent: "dismiss", spoken: "", message: "" })
  return Effect.succeed(undefined)
}

export const ProviderResponder = Layer.effect(
  Responder,
  Effect.gen(function* () {
    const model = yield* Model
    const style = yield* Config.style
    const persona = yield* Persona
    return {
      respond: (interruption) =>
        Effect.gen(function* () {
          const fast = yield* quick(interruption, persona.onIt())
          if (fast !== undefined) return fast
          const reply = yield* model.ask(Reply, prompt(interruption, style)).pipe(Effect.mapError((cause) => new RespondError({ cause })))
          // Going ahead, an "On it" the model wrote anyway gives way to a line of yapd's own: picked as it's passed on
          // when that was all of it, or put in its place now, with the rest after it.
          const said = reply.spoken.trim()
          const rest = reply.intent === "send" ? afterOnIt(said, yield* persona.lines) : said
          const spoken = yield* inEnglish(model, rest)
          return { ...reply, spoken: rest === said || spoken === "" ? spoken : withOnIt(yield* persona.onIt(), spoken) }
        }),
    }
  }),
)
