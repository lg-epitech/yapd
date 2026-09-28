import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { styled, type Turn } from "./Condenser.ts"
import * as Config from "./Config.ts"
import { Model } from "./Model.ts"

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
}

export class RespondError extends Data.TaggedError("RespondError")<{ readonly cause: unknown }> {}

export class Responder extends Context.Tag("yapd/Responder")<
  Responder,
  { readonly respond: (interruption: Interruption) => Effect.Effect<Reply, RespondError> }
>() {}

const instructions = `You're the voice that reads a coding agent's updates aloud. The user interrupted you, or spoke right after you finished. Work out what they want from what they said.

Reply with only a JSON object with the keys "intent", "spoken" and "message".

"intent":
- "dismiss" if they've heard enough or want you to be quiet, however they put it. That includes acknowledging, like "sounds good", "okay" or "thanks", unless the agent is waiting on them and those words answer what it asked.
- "answer" if they asked something the agent's message or the conversation answers, including asking you to repeat.
- "send" if it's meant for the agent and would change what it does: an instruction, a correction, a decision it asked for, or a question its message doesn't answer. Agreeing with what the agent already said it would do changes nothing, so that's "dismiss".
- "resume" if it wasn't meant for you, like talking to someone else or background noise.

"spoken": what you say back. They're listening, not reading: natural speech, no lists, markdown, code, file paths or URLs.
- For "answer", the answer in at most 50 words.
- For "send", a few words on what you passed on, like "Okay, I've asked it to take another look."
- Empty for "dismiss" and "resume".

"message": for "send", the message for the agent, written as the user would type it: first person, keeping their intent and wording, with anything they referred to spelled out so it stands on its own. Empty otherwise.

What they said was transcribed from speech and can have mistakes, so go with what they most likely meant. Reply in the language they spoke.`

export const prompt = ({ project, turn, needsYou, lines, heard }: Interruption, style: Option.Option<string>) =>
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
    `What the user just said:\n${heard}`,
  ].join("\n\n")

export const ProviderResponder = Layer.effect(
  Responder,
  Effect.gen(function* () {
    const model = yield* Model
    const style = yield* Config.style
    return {
      respond: (interruption) =>
        model.ask(Reply, prompt(interruption, style)).pipe(Effect.mapError((cause) => new RespondError({ cause }))),
    }
  }),
)
