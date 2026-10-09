import { Context, Effect, Layer, Option, Random, Ref, Schema, SubscriptionRef } from "effect"
import * as Config from "./Config.ts"
import { Model } from "./Model.ts"
import * as Settings from "./Settings.ts"
import { Warmth } from "./Voice.ts"

// The few things yapd says without asking a model each time, like "On it."
// once it has passed something on. Written once in the user's style, kept for
// as long as the style stays the same, and rendered ahead, so they play the
// moment they're needed. For "On it." he can give lines of his own instead,
// a different one each time, since one line every time grows stale.

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
  address: "",
}

/** The lines that are said on their own, to render ahead. */
export const sayable = (lines: Lines) => [lines.onIt, lines.queued, lines.misheard, lines.checking, lines.leaving, lines.cantTell]

/** ", sir" before a line's last mark, when the user is addressed at all. */
export const addressed = (lines: Pick<Lines, "address">) => (lines.address.trim() === "" ? "" : `, ${lines.address.trim()}`)

/**
 * What's said past an "On it" it starts with, addressing him or not, which a
 * model may still write where yapd says a line of its own for going ahead:
 * "On it, sir, in yapd." is "In yapd.", and "On it, sir." is nothing.
 */
export const afterOnIt = (spoken: string, lines: Pick<Lines, "address">) => {
  const address = lines.address.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const onIt = new RegExp(`^on it${address === "" ? "" : `(?:,?\\s*${address})?`}(?![\\p{L}\\p{N}])[\\s\\p{P}]*`, "iu")
  const said = spoken.trim()
  const rest = said.replace(onIt, "")
  return rest === said ? said : `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
}

/** A line for going ahead with more said after it, as a sentence of its own. */
export const withOnIt = (onIt: string, rest: string) => {
  const line = onIt.trim()
  return [line === "" || /[.!?…]$/.test(line) ? line : `${line}.`, rest.trim()].filter((part) => part !== "").join(" ")
}

/**
 * The lines that tell rather than ask: worded as a question, he'd answer one
 * yapd isn't waiting on. Not "misheard", which may well ask him to say it again.
 */
const telling = ["onIt", "queued", "checking", "leaving", "cantTell"] as const

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

export class Persona extends Context.Tag("yapd/Persona")<
  Persona,
  {
    /** The lines as they are now: plain until the user's style has been written in. */
    readonly lines: Effect.Effect<Lines>
    /**
     * The line to say once he's asked for something: one of his own, never
     * the one he heard last, nor `besides`, one said in the same breath, or
     * the written one. Picking it changes nothing, since a reply that has one
     * may yet be dropped or say something else.
     */
    readonly onIt: (besides?: string) => Effect.Effect<string>
    /**
     * Notes what's being said, so the next line for going ahead is a
     * different one from his own it starts with, said on its own or with more
     * after it. Only his own count.
     */
    readonly said: (spoken: string) => Effect.Effect<void>
  }
>() {}

/**
 * His own lines for once he's asked for something, from YAPD_ON_IT, without
 * any that ask, since he'd answer one yapd isn't waiting on.
 */
const ownLines = Effect.gen(function* () {
  const lines = [...new Set(yield* Config.onIt)]
  const asking = lines.filter((line) => line.includes("?"))
  if (asking.length > 0) {
    yield* Effect.logWarning(`Leaving out the lines in YAPD_ON_IT that ask something, since they'd be answered: ${asking.join(" | ")}`)
  }
  return lines.filter((line) => !line.includes("?"))
})

/**
 * The lines with his own in place of the written "on it". Read for anything
 * but saying it, like rendering ahead, his first one stands for them all.
 */
const owning = (own: ReadonlyArray<string>) => (lines: Lines): Lines => (own.length === 0 ? lines : { ...lines, onIt: own[0]! })

/**
 * One of his own lines, never the one said last, nor one said alongside, so
 * they vary, and how to note one as said. Only noting changes which comes
 * next: a line picked for a reply that's then dropped, or queued, or that
 * fails, was never heard. Without his own, it's the line as it is now, even
 * twice in one breath.
 */
const alternating = (own: ReadonlyArray<string>, lines: Effect.Effect<Lines>) =>
  Effect.gen(function* () {
    const last = yield* Ref.make<string | undefined>(undefined)
    return {
      onIt: (besides?: string) =>
        own.length === 0
          ? Effect.map(lines, ({ onIt }) => onIt)
          : Effect.flatMap(Ref.get(last), (said) => {
              // The same line twice in one breath stands out more than one heard a while ago, so with too few to avoid both, it's `besides` that's avoided.
              const others = [own.filter((line) => line !== said && line !== besides), own.filter((line) => line !== besides), own].find((lines) => lines.length > 0)!
              return Effect.map(Random.nextIntBetween(0, others.length), (index) => others[index]!)
            }),
      said: (spoken: string) => {
        const said = spoken.trim()
        // The longest that fits, in case one of his lines starts another.
        const [heard] = own
          .filter((line) => said.startsWith(line) && !/^[\p{L}\p{N}]/u.test(said.slice(line.length)))
          .toSorted((one, other) => other.length - one.length)
        return heard === undefined ? Effect.void : Ref.set(last, heard)
      },
    }
  })

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
    `- "address": how you address them, in a word or two, like "sir", as their style says. Empty if it doesn't say.`,
  ].join("\n\n")

const stored = Schema.parseJson(Schema.Struct({ style: Schema.String, lines: Lines }))

/** Lines in the user's style, kept in the database until the style changes, and rendered ahead. */
export const layer = Layer.scoped(
  Persona,
  Effect.gen(function* () {
    const style = yield* Config.style
    const warmth = yield* Warmth
    const own = yield* ownLines
    const ref = yield* SubscriptionRef.make(plain)
    const lines = Effect.map(SubscriptionRef.get(ref), owning(own))
    const persona = { lines, ...(yield* alternating(own, lines)) }
    // All of his own, so whichever comes up plays at once. Straight away, since they need no model, even if the rest can't be written.
    yield* Effect.forkScoped(warmth.warm(own))
    const warm = (lines: Lines) => warmth.warm(sayable(owning(own)(lines)).filter((line) => !own.includes(line)))
    if (Option.isNone(style)) {
      yield* Effect.forkScoped(warm(plain))
      return persona
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
      Effect.flatMap(warm),
      Effect.catchAll((error) => Effect.logWarning("Could not write my usual lines in your style, so they stay plain", error)),
      Effect.forkScoped,
    )
    return persona
  }),
)

/** The plain lines, for tests and for wherever there's no style. */
export const Plain = Layer.succeed(Persona, { lines: Effect.succeed(plain), onIt: () => Effect.succeed(plain.onIt), said: () => Effect.void })
