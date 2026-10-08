import { Context, Effect, Layer, Option, Schema, SubscriptionRef } from "effect"
import * as Config from "./Config.ts"
import { Model } from "./Model.ts"
import * as Settings from "./Settings.ts"
import { Warmth } from "./Voice.ts"

// The few things yapd says without asking a model each time, like "On it."
// once it has passed something on. Written once in the user's style, kept for
// as long as the style stays the same, and rendered ahead, so they play the
// moment they're needed.

export const Lines = Schema.Struct({
  /** Something the user said is on its way to the work. */
  onIt: Schema.String,
  /** It will be, once the work in hand is done. */
  queued: Schema.String,
  /** What they said couldn't be made out. */
  misheard: Schema.String,
  /** Something is being looked into before it can be answered. */
  checking: Schema.String,
})
export type Lines = typeof Lines.Type

export const plain: Lines = {
  onIt: "On it.",
  queued: "Noted. I'll get to it once the current task is done.",
  misheard: "Sorry, I didn't catch that.",
  checking: "One moment.",
}

export class Persona extends Context.Tag("yapd/Persona")<
  Persona,
  {
    /** The lines as they are now: plain until the user's style has been written in. */
    readonly lines: Effect.Effect<Lines>
  }
>() {}

export const prompt = (style: string) =>
  [
    `You're the voice of a developer's assistant, the one getting their coding work done. Write the few short lines you say most, in the way they want you to talk, each a few words and readable aloud, in English. Talk about the work as yours, never about agents or sessions.`,
    `How they want you to talk:\n${style}`,
    `Reply with only a JSON object with these keys:`,
    `- "onIt": what you say once you've taken an instruction in hand, like "${plain.onIt}" Don't repeat back what was asked.`,
    `- "queued": that you'll do it as soon as the current task is done, like "${plain.queued}"`,
    `- "misheard": that you didn't catch what they said, like "${plain.misheard}"`,
    `- "checking": that you're looking into something before answering, like "${plain.checking}"`,
  ].join("\n\n")

const stored = Schema.parseJson(Schema.Struct({ style: Schema.String, lines: Lines }))

/** Lines in the user's style, kept in the database until the style changes, and rendered ahead. */
export const layer = Layer.scoped(
  Persona,
  Effect.gen(function* () {
    const style = yield* Config.style
    const warmth = yield* Warmth
    const ref = yield* SubscriptionRef.make(plain)
    if (Option.isNone(style)) {
      yield* Effect.forkScoped(warmth.warm(Object.values(plain)))
      return { lines: SubscriptionRef.get(ref) }
    }
    const settings = yield* Settings.Settings
    const model = yield* Model
    const kept = yield* settings.read("persona").pipe(
      Effect.map(Option.flatMap(Schema.decodeUnknownOption(stored))),
      Effect.map(Option.filter((kept) => kept.style === style.value)),
      Effect.orElseSucceed(() => Option.none()),
    )
    const written = Option.match(kept, {
      onSome: ({ lines }) => Effect.succeed(lines),
      onNone: () =>
        model.ask(Lines, prompt(style.value)).pipe(
          Effect.tap((lines) =>
            settings.write("persona", JSON.stringify({ style: style.value, lines })).pipe(Effect.ignore),
          ),
          Effect.tap((lines) => Effect.logInfo(`Wrote my usual lines in your style: ${Object.values(lines).join(" | ")}`)),
        ),
    })
    // In the background, so nothing waits on it, and the plain lines stand in meanwhile.
    yield* written.pipe(
      Effect.tap((lines) => SubscriptionRef.set(ref, lines)),
      Effect.flatMap((lines) => warmth.warm(Object.values(lines))),
      Effect.catchAll((error) => Effect.logWarning("Could not write my usual lines in your style, so they stay plain", error)),
      Effect.forkScoped,
    )
    return { lines: SubscriptionRef.get(ref) }
  }),
)

/** The plain lines, for tests and for wherever there's no style. */
export const Plain = Layer.succeed(Persona, { lines: Effect.succeed(plain) })
