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
  /** A question yapd asked is left unanswered for good. */
  leaving: Schema.String,
  /** What the user meant could be any of several threads, and asking wouldn't help. */
  cantTell: Schema.String,
  /** The work they asked to stop has stopped. */
  stopped: Schema.String,
  /** Whether to send something once more that may not have got there, after saying why. */
  again: Schema.String,
  /** The work they stopped is going again. */
  carrying: Schema.String,
  /** How the user is addressed, like "sir", or nothing. Lines made up on the spot use it too. */
  address: Schema.String,
})
export type Lines = typeof Lines.Type

export const plain: Lines = {
  onIt: "On it.",
  queued: "Noted. I'll get to it once the current task is done.",
  misheard: "Sorry, I didn't catch that.",
  checking: "One moment.",
  leaving: "I'll leave that one.",
  cantTell: "I couldn't tell which one you meant.",
  stopped: "Stopped.",
  again: "Send it again?",
  carrying: "Carrying on.",
  address: "",
}

/** The lines that are said on their own, to render ahead. */
export const sayable = (lines: Lines) => [
  lines.onIt,
  lines.queued,
  lines.misheard,
  lines.checking,
  lines.leaving,
  lines.cantTell,
  lines.stopped,
  lines.carrying,
]

/** ", sir" before a line's last mark, when the user is addressed at all. */
export const addressed = (lines: Pick<Lines, "address">) => (lines.address.trim() === "" ? "" : `, ${lines.address.trim()}`)

/**
 * The lines that tell rather than ask: worded as a question, he'd answer one
 * yapd isn't waiting on. Not "misheard", which may well ask him to say it
 * again, nor "again", which asks whether to send something once more.
 */
const telling = ["onIt", "queued", "checking", "leaving", "cantTell", "stopped", "carrying"] as const

/** Whether none of the lines that tell asks something, nor how he's addressed, which goes into lines of every kind. */
const tells = (lines: Lines) => !lines.address.includes("?") && telling.every((key) => !lines[key].includes("?"))

/**
 * The lines, addressing him without marks of their own, which would land in
 * the middle of a sentence, and with the plain line, addressing him as the
 * rest do, in place of any that should tell but asks.
 */
const told = (written: Lines): Lines => {
  const lines = { ...written, address: written.address.replace(/[^\p{L}\p{N}' -]/gu, "").trim() }
  return Object.assign(
    lines,
    ...telling.filter((key) => lines[key].includes("?")).map((key) => ({ [key]: plain[key].replace(/\.$/, `${addressed(lines)}.`) })),
  )
}

/** A line with the address taken out, for saying after a sentence that used it already, since he's addressed once a line. */
export const unaddressed = (line: string, lines: Pick<Lines, "address">) => {
  const address = lines.address.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (address === "") return line
  const without = line
    .replace(new RegExp(`^${address}\\s*,\\s*`, "i"), "")
    .replace(new RegExp(`\\s*,\\s*${address}\\b`, "gi"), "")
    .trim()
  return `${without.charAt(0).toUpperCase()}${without.slice(1)}`
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
    `Reply with only a JSON object with these keys, each a statement, never a question unless it says so:`,
    `- "onIt": what you say once you've taken an instruction in hand, like "${plain.onIt}" Don't repeat back what was asked.`,
    `- "queued": that you'll do it as soon as the current task is done, like "${plain.queued}"`,
    `- "misheard": that you didn't catch what they said, like "${plain.misheard}"`,
    `- "checking": that you're looking into something before answering, like "${plain.checking}"`,
    `- "leaving": that you'll let a question you asked go, since it wasn't answered, like "${plain.leaving}"`,
    `- "cantTell": that you couldn't tell which of their threads they meant, like "${plain.cantTell}" It's said instead of asking, so don't ask.`,
    `- "stopped": that the work they asked you to stop has stopped, like "${plain.stopped}"`,
    `- "again": asking whether to send something once more, like "${plain.again}" A question. It comes right after a sentence that addressed them already and said it may not have got there, so it has no address of its own.`,
    `- "carrying": that the work they had stopped is going again, like "${plain.carrying}"`,
    `- "address": how you address them, in a word or two, like "sir", as their style says. Empty if it doesn't say.`,
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
      yield* Effect.forkScoped(warmth.warm(sayable(plain)))
      return { lines: SubscriptionRef.get(ref) }
    }
    const settings = yield* Settings.Settings
    const model = yield* Model
    const kept = yield* settings.read("persona").pipe(
      Effect.map(Option.flatMap(Schema.decodeUnknownOption(stored))),
      // Kept from before they all had to tell, they're written again.
      Effect.map(Option.filter((kept) => kept.style === style.value && tells(kept.lines))),
      Effect.orElseSucceed(() => Option.none()),
    )
    const written = Option.match(kept, {
      onSome: ({ lines }) => Effect.succeed(lines),
      onNone: () =>
        model.ask(Lines, prompt(style.value)).pipe(
          Effect.map(told),
          Effect.tap((lines) =>
            settings.write("persona", JSON.stringify({ style: style.value, lines })).pipe(Effect.ignore),
          ),
          Effect.tap((lines) => Effect.logInfo(`Wrote my usual lines in your style: ${sayable(lines).join(" | ")}`)),
        ),
    })
    // In the background, so nothing waits on it, and the plain lines stand in meanwhile.
    yield* written.pipe(
      Effect.tap((lines) => SubscriptionRef.set(ref, lines)),
      Effect.flatMap((lines) => warmth.warm(sayable(lines))),
      Effect.catchAll((error) => Effect.logWarning("Could not write my usual lines in your style, so they stay plain", error)),
      Effect.forkScoped,
    )
    return { lines: SubscriptionRef.get(ref) }
  }),
)

/** The plain lines, for tests and for wherever there's no style. */
export const Plain = Layer.succeed(Persona, { lines: Effect.succeed(plain) })
