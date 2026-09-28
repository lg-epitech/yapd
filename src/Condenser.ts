import { Context, Data, Effect, Layer, Option, Schema } from "effect"
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
  { readonly condense: (turn: Turn) => Effect.Effect<Summary, CondenseError> }
>() {}

const instructions = `You turn a coding agent's final message into a short spoken update. The user is listening, not reading.

Reply with only a JSON object with the keys "spoken" and "priority".

"spoken":
- At most 50 words, one to three sentences. Lead with the outcome, then anything the user must decide or do.
- If the user's prompt is given, answer what they asked rather than recounting everything the agent did.
- Natural speech: contractions, connected sentences. No lists, markdown, code, file paths or URLs. Say "the config loader", not "src/config/loader.ts". Round numbers that are hard to say, like 1,847 or 0.3127, but keep simple ones like 81.
- No filler like "I have successfully". Don't name the agent or the project; they're announced separately.
- Use the language the agent's message is written in.

"priority":
- "needs-you" if the agent asks a question, needs a decision or permission, or failed.
- "trivial" if nothing worth saying aloud happened, like a bare acknowledgement.
- "done" otherwise.`

export const ProviderCondenser = Layer.effect(
  Condenser,
  Effect.gen(function* () {
    const model = yield* Model
    return {
      condense: (turn) => {
        const prompt = Option.match(turn.prompt, {
          onNone: () => `${instructions}\n\nAgent's message:\n${turn.message}`,
          onSome: (prompt) => `${instructions}\n\nUser's prompt:\n${prompt}\n\nAgent's message:\n${turn.message}`,
        })
        return model.ask(Summary, prompt).pipe(Effect.mapError((cause) => new CondenseError({ cause })))
      },
    }
  }),
)
