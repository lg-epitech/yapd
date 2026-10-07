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

/**
 * How everything yapd says reads, whichever call writes it: as the assistant
 * doing the work, in English, and only what can be said aloud.
 */
export const aloud = [
  `- As their assistant, the one getting things done: the coding agents are how you work, not someone you hand things to. Talk about the work as yours, like "I've fixed the loader", "we're nearly there" or "On it", never about an agent or a session, or what you asked one to do.`,
  `- Every word in English, whatever language they or the agent used, since the voice can't speak anything else. Translate titles, headings and quotes too, rather than keeping them as written. Only the names of people and places stay as they are.`,
  `- Natural speech: no lists, markdown, code, file paths or URLs. Nothing that's only meant to be read or copied, like an ID, a hash, a key, or a wallet, email or street address: say what it is instead, like "the vault's wallet address" or "its source ID".`,
  `- Names the way a person would say them, like "cryptio sources" for cryptio-sources or "Fable" for claude-fable-5-1. One that was generated rather than chosen, like a date, a few words and a hash, goes by what the work is about, like "the picture transcription".`,
].join("\n")

const instructions = `You're yapd, the voice that tells a developer how the work they gave their coding agents went. One just finished, and you turn its final message into a short spoken update. The user is listening, not reading.

Reply with only a JSON object with the keys "spoken" and "priority".

"spoken":
- At most 50 words, one to three sentences. Lead with the outcome, then anything the user must decide or do.
- If the user's prompt is given, answer what they asked rather than recounting everything the agent did.
- Contractions, connected sentences. Say "the config loader", not "src/config/loader.ts". Round numbers that are hard to say, like 1,847 or 0.3127, but keep simple ones like 81.
- Mention the project once, in the first sentence, as part of it: its subject, a possessive, or "in" the project, like "yapd's tests pass now" or "Over in yapd, the fix is in". Never as a label before the sentence.
- No filler like "I have successfully".
${aloud}

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

/** Words as they're compared: lowercase, without accents, and letters apart from digits, so Équipe9 is "equipe 9". */
const words = (text: string) =>
  ` ${text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/(\p{L})(?=\p{N})|(\p{N})(?=\p{L})/gu, "$1$2 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `

/** Part of a name that's a hash, like 5c529e6b. */
const hash = /^(?=.*\d)(?=.*[a-f])[\da-f]{6,}$/i

/**
 * Whether a project's name can be read out as it is, rather than one generated
 * from a date, a request's first words and a hash, like T3 Code's scratch folders.
 */
export const speakable = (project: string) =>
  !/\d{4}-\d{2}-\d{2}/.test(project) && !project.split(/[^\p{L}\p{N}]+/u).some((part) => hash.test(part))

/** The update as it's read out, naming the project up front if the summary left it out and its name can be said. */
export const introduce = (project: string, spoken: string) =>
  !speakable(project) || words(spoken).includes(words(project)) ? spoken : `${project}. ${spoken}`

/** A letter English doesn't use, like é or ß, or one from another script. */
const foreign = /(?![A-Za-z])\p{L}/u

/** A capitalized word in the Latin alphabet, which with a letter like that is mostly a name, like Hélène or Trois-Rivières. */
const name = /^\P{L}*\p{Lu}[\p{Script=Latin}\P{L}]*$/u

/**
 * Whether the voice, which reads everything as English, can say it: no word
 * in it gives another language away, except names.
 */
export const english = (text: string) => text.split(/\s+/).every((word) => !foreign.test(word) || name.test(word))

const Translation = Schema.Struct({ spoken: Schema.String })

const translating = (spoken: string) =>
  [
    `This is about to be read aloud by a voice that only speaks English, but some of it isn't in English, which the voice would mangle. Rewrite it with every word in English: translate what isn't, titles and quotes included, and keep the rest word for word. Only the names of people and places stay as they are.`,
    `Reply with only a JSON object with the key "spoken".`,
    `What's about to be said:\n${spoken}`,
  ].join("\n\n")

/**
 * What's said, checked for another language, which the model is asked to
 * translate when some slipped through. Kept as it was when that fails.
 */
export const inEnglish = (model: Model["Type"], spoken: string) =>
  english(spoken)
    ? Effect.succeed(spoken)
    : model.ask(Translation, translating(spoken)).pipe(
        Effect.map((translation) => translation.spoken.trim() || spoken),
        Effect.tap(() => Effect.logInfo(`Translated what wasn't in English: ${spoken}`)),
        Effect.catchAll((error) => Effect.logWarning("Could not translate", error).pipe(Effect.as(spoken))),
      )

export const ProviderCondenser = Layer.effect(
  Condenser,
  Effect.gen(function* () {
    const model = yield* Model
    const style = yield* Config.style
    return {
      condense: (project, turn) =>
        model.ask(Summary, prompt(project, turn, style)).pipe(
          Effect.mapError((cause) => new CondenseError({ cause })),
          Effect.flatMap((summary) => Effect.map(inEnglish(model, summary.spoken), (spoken) => ({ ...summary, spoken }))),
        ),
    }
  }),
)
