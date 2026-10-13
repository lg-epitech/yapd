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
  /** What yapd left out of its update to say only its headline, which asking for more gets. */
  readonly more?: string
  /** The names of their routines, whose steps yapd sends an agent only when they say one with their shortcut. */
  readonly routines?: ReadonlyArray<string>
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
- Muting or unmuting this thread or any other, like "mute this", "silence it for now" or "unmute the Tezos one", or asking what's muted, is for you, never the agent: never "send". It's "answer", telling them in a few words to ask you that with their shortcut. Taking back a mute or unmute you just told them of, like "scratch that" or "undo that" right after you said you muted it, is never "send" either: it's "answer", asking them in a few words to say it again.
- How you talk to them is for you, never the agent: focus, quiet, goodnight, being back, shorter updates or everything in full, like "let me focus till three", "I'm off to bed" or "stop giving me the short version". Never "send". It's "answer", telling them in a few words to ask you that with their shortcut.
- Catching up is for you, never the agent: hearing what they missed or haven't heard, or what came in while they were away or had you off, however they put it, like "what did I miss?", "catch me up" or "anything else from rig?". Never "send". It's "answer", telling them in a few words to ask you that with their shortcut.
- What they want you to keep in mind, or forget, is for you, never the agent: a fact, like "remember that rig's T3 Code runs the nightly", or steps for when they say a name, like "when I say review it, have Sol review it until it's clean". Never "send". It's "answer", telling them in a few words to ask you that with their shortcut. A bare "forget it" or "never mind" isn't that: it's "dismiss".

"spoken": what you say back. They're listening, not reading.
${aloud}
- For "answer", the answer in at most 50 words.
- For "send", empty: you say your usual line that it's in hand. Only when there's more they must know than that, say just that, in a few words, like "I took that to mean the staging branch." Don't repeat back what they asked for: they've just said it.
- Empty for "dismiss" and "resume".

"message": for "send", the message for the agent, written as the user would type it: first person, keeping their intent and wording, with anything they referred to spelled out so it stands on its own. Keep every request they made, in their order, including what to do once something's done, like "when that's merged, update the deployment". Empty otherwise.

What they said was transcribed from speech and can have mistakes, so go with what they most likely meant. Write "message" in the language they spoke.`

/** What's known of your own voice in what they said earlier on, as they said it: what came first may be yours, and what followed a pause is theirs. */
const earlier = ({ echo, afterPause }: Line) =>
  echo === undefined
    ? ""
    : ` (they began that while your own voice could still get into their microphone, so what came first may be your own words, from around "${echo}"${
        afterPause === undefined || afterPause.trim() === "" ? "" : `; what they said after a pause, "${afterPause}", is surely theirs`
      })`

export const prompt = ({ project, turn, needsYou, lines, heard, echo, afterPause, unsaid, more, routines = [] }: Interruption, style: Option.Option<string>) =>
  [
    instructions,
    ...Option.toArray(Option.map(style, styled)),
    ...(routines.length === 0
      ? []
      : [
          `Their routines, by name: ${routines.map((name) => `"${name}"`).join(", ")}. Each stands for steps you send an agent only when they say its name with their shortcut, never here. A routine's name said as a request is never "send", even when it reads as an instruction for this agent: it's "answer", telling them in a few words to say it with their shortcut. Words that change what it asks, like "for typos" or "but only the tests", make it a message of their own, as ever.`,
        ]),
    `Project: ${project}`,
    ...Option.match(turn.prompt, { onNone: () => [], onSome: (prompt) => [`User's prompt to the agent:\n${prompt}`] }),
    `Agent's message:\n${turn.message}`,
    needsYou
      ? "The agent is waiting on the user: it asked something, needs a decision or permission, or failed."
      : "The agent isn't waiting on the user.",
    ...(more === undefined || more.trim() === ""
      ? []
      : [`What you left out of your update, to say only if they ask for more or for the details, as "answer" with these words as they are:\n${more}`]),
    `Conversation so far, where "…" marks where you were cut off:\n${lines
      .map((line) => `${line.speaker === "yapd" ? "You" : "User"}: ${line.text}${earlier(line)}`)
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

/** Calling it off, said on its own to an update: hearing enough of it, never something for yapd to forget, which is asked with the shortcut. */
const callingOff: ReadonlySet<string> = new Set(["forget it", "forget about it"])

/** What Whisper writes for near-silence, which nobody said. */
export const hallucinated: ReadonlySet<string> = new Set(["you", "thank you", "bye", "see you again", "kid", "thanks for watching"])

/** Taking an update in. Said to one that asked something, they could be the answer, so the model judges those. */
export const noted: ReadonlySet<string> = new Set([
  "thanks", "thank you", "thanks a lot", "cheers", "got it", "ok", "okay", "ok thanks", "okay thanks", "cool", "great", "good",
  "very good", "perfect", "nice", "sounds good", "alright", "all right", "noted", "understood", "awesome", "fine", "good job",
  "well done", "excellent", "brilliant", "lovely", "good to know", "ok cool", "okay cool", "great thanks", "perfect thanks",
])

/** Asking for the rest of an update yapd said only the headline of. */
export const morePlease: ReadonlySet<string> = new Set(["more", "tell me more", "more please", "details", "more details", "what else", "the details"])

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
  if (enough.has(said) || callingOff.has(said)) return Effect.succeed({ intent: "dismiss", spoken: "", message: "" })
  // The rest of an update said in its headline. Begun while yapd's own voice could still get into the microphone, "more" may be its own word: the model weighs that.
  const more = interruption.more?.trim() ?? ""
  if (more !== "" && interruption.echo === undefined && morePlease.has(said)) return Effect.succeed({ intent: "answer", spoken: more, message: "" })
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
