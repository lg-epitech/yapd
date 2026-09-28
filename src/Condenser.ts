import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import * as Config from "./Config.ts"
import { Model } from "./Model.ts"

export const Priority = Schema.Literal("needs-you", "done", "trivial")
export type Priority = typeof Priority.Type

export const Summary = Schema.Struct({
  priority: Priority,
  spoken: Schema.String,
})
export type Summary = typeof Summary.Type

export interface Turn {
  readonly prompt: Option.Option<string>
  readonly message: string
}

export class CondenseError extends Data.TaggedError("CondenseError")<{ readonly cause: unknown }> {}

export class Condenser extends Context.Tag("yapd/Condenser")<
  Condenser,
  { readonly condense: (project: string, turn: Turn) => Effect.Effect<Summary, CondenseError> }
>() {}

const instructions = `You turn a coding agent's final message into a short spoken update. The user is listening, not reading.

Reply with only a JSON object with the keys "spoken" and "priority".

"spoken":
- At most 50 words, one to three sentences. Lead with the outcome, then anything the user must decide or do.
- If the user's prompt is given, answer what they asked rather than recounting everything the agent did.
- Natural speech: contractions, connected sentences. No lists, markdown, code, file paths or URLs. Say "the config loader", not "src/config/loader.ts". Round numbers that are hard to say, like 1,847 or 0.3127, but keep simple ones like 81.
- Mention the project once, in the first sentence, as part of it: its subject, a possessive, or "in" the project, like "yapd's tests pass now" or "Over in yapd, the fix is in". Never as a label before the sentence. Say its name the way a person would, like "cryptio sources" for cryptio-sources.
- No filler like "I have successfully". Don't name the agent.
- Use the language the agent's message is written in.

"priority":
- "needs-you" if the agent asks a question, needs a decision or permission, or failed.
- "trivial" if there's nothing new to hear: a bare acknowledgement, or a reply that only confirms what the user just said or restates work they already know about, like "Understood, the checks are still running". Something the agent did or found since isn't trivial.
- "done" otherwise.`

/** The user's YAPD_STYLE, which summaries and replies both follow. */
export const styled = (style: string) =>
  `How the user wants you to talk, for "spoken" only. Follow it for tone, wording and how you address them, but keep to the rules above:\n${style}`

export const prompt = (project: string, turn: Turn, style: Option.Option<string>) =>
  [
    instructions,
    ...Option.toArray(Option.map(style, styled)),
    `Project: ${project}`,
    ...Option.match(turn.prompt, { onNone: () => [], onSome: (prompt) => [`User's prompt:\n${prompt}`] }),
    `Agent's message:\n${turn.message}`,
  ].join("\n\n")

const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `

/** The update as it's read out, naming the project up front if the summary left it out. */
export const introduce = (project: string, spoken: string) =>
  words(spoken).includes(words(project)) ? spoken : `${project}. ${spoken}`

export const ProviderCondenser = Layer.effect(
  Condenser,
  Effect.gen(function* () {
    const model = yield* Model
    const style = yield* Config.style
    return {
      condense: (project, turn) =>
        model.ask(Summary, prompt(project, turn, style)).pipe(Effect.mapError((cause) => new CondenseError({ cause }))),
    }
  }),
)
