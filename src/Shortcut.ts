import { Context, Effect, Either, Option, PubSub, Stream } from "effect"

// A global shortcut to start new work by voice: pressed once to start dictating,
// again to send, or Escape to cancel. The audio helper registers the keys with
// macOS, which needs no permission, and reports presses; what they mean is
// worked out here.

export type Modifier = "ctrl" | "option" | "cmd" | "shift"

/** In the order they're written back. */
const modifiers: ReadonlyArray<Modifier> = ["ctrl", "option", "cmd", "shift"]

const modifierNames: Readonly<Record<string, Modifier>> = {
  ctrl: "ctrl",
  control: "ctrl",
  option: "option",
  opt: "option",
  alt: "option",
  cmd: "cmd",
  command: "cmd",
  shift: "shift",
}

/** Keys that type nothing, by the name the helper knows them by. Anything else is one character. */
const keyNames: Readonly<Record<string, string>> = {
  space: "space",
  return: "return",
  enter: "return",
  tab: "tab",
  ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index + 1}`, `f${index + 1}`])),
}

export interface Keys {
  /** A name from `keyNames`, or the character the key types, which the helper finds on the current layout. */
  readonly key: string
  readonly modifiers: ReadonlyArray<Modifier>
}

export const format = (keys: Keys) => [...keys.modifiers, keys.key].join("+")

/**
 * Parses `YAPD_SHORTCUT`, like `ctrl+option+cmd+space`: modifiers, then one key.
 * Empty or `none` is no shortcut.
 */
export const parse = (value: string): Either.Either<Option.Option<Keys>, string> => {
  const text = value.trim().toLowerCase()
  if (text === "" || text === "none") return Either.right(Option.none())
  const invalid = (why: string) =>
    Either.left(`YAPD_SHORTCUT is "${value}", which I can't read: ${why}. Use something like ctrl+option+cmd+space, or none.`)

  const parts = text.split("+").map((part) => part.trim())
  const last = parts.pop() ?? ""
  const held = new Set<Modifier>()
  for (const part of parts) {
    const modifier = modifierNames[part]
    if (modifier === undefined) return invalid(`"${part}" isn't ctrl, option, cmd or shift`)
    held.add(modifier)
  }
  if (last === "" || last in modifierNames) return invalid("it doesn't end with a key")
  if (last === "escape" || last === "esc") return invalid("Escape is how a dictation is cancelled")
  const key = keyNames[last] ?? ([...last].length === 1 ? last : undefined)
  if (key === undefined) return invalid(`"${last}" isn't a key I know`)
  // Function keys type nothing, but anything else would be taken from typing in every app.
  if (!/^f\d+$/.test(key) && !held.has("ctrl") && !held.has("option") && !held.has("cmd")) {
    return invalid("it needs ctrl, option or cmd, or it would take the key from typing")
  }
  return Either.right(Option.some({ key, modifiers: modifiers.filter((modifier) => held.has(modifier)) }))
}

/** A registered key the helper saw pressed. */
export type Key = "shortcut" | "escape"

export type Event =
  /** The user pressed the shortcut to dictate new work. */
  | { readonly _tag: "Started" }
  /** They pressed it again, to send it. */
  | { readonly _tag: "Sent" }
  /** They pressed Escape instead. */
  | { readonly _tag: "Cancelled" }

const started: Event = { _tag: "Started" }
const sent: Event = { _tag: "Sent" }
const cancelled: Event = { _tag: "Cancelled" }

/** Whether the user is dictating after a press, and what the press meant. */
export const press = (dictating: boolean, key: Key): { readonly dictating: boolean; readonly event?: Event } => {
  if (key === "shortcut") return { dictating: !dictating, event: dictating ? sent : started }
  // Escape can still arrive just after it was let go.
  return dictating ? { dictating: false, event: cancelled } : { dictating }
}

export class Shortcut extends Context.Tag("yapd/Shortcut")<
  Shortcut,
  {
    /** What the user does with the shortcut, from when the stream starts. */
    readonly events: Stream.Stream<Event>
    /** Ends a dictation from this side, like when it runs too long, as if the user pressed Escape. */
    readonly cancel: Effect.Effect<void>
    /** Takes the keys, or lets them go and ends any dictation, so they work in other apps while yapd is off. */
    readonly toggle: (on: boolean) => Effect.Effect<void>
  }
>() {}

/** When no shortcut is set, or nothing can take it. */
export const none: Shortcut["Type"] = { events: Stream.never, cancel: Effect.void, toggle: () => Effect.void }

/**
 * Keeps whether the user is dictating on this side, and has the helper take
 * Escape only while they are, since a registered key is kept from every other
 * app. The helper holds no keys when it starts, so each one is told the shortcut.
 */
export const make = (keys: Keys, send: (message: object) => void) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<Event>()
    let dictating = false
    let registered: boolean | undefined
    let on = true
    /** The shortcut, or no keys at all. */
    const hold = () => send(on ? { type: "shortcut", key: keys.key, modifiers: keys.modifiers } : { type: "shortcut" })
    const pressed = (key: Key) =>
      Effect.suspend(() => {
        const next = press(dictating, key)
        if (next.dictating !== dictating) send({ type: "escape", on: next.dictating })
        dictating = next.dictating
        return next.event === undefined ? Effect.void : Effect.asVoid(PubSub.publish(events, next.event))
      })

    const toggle = (next: boolean) =>
      Effect.suspend(() => {
        if (next === on) return Effect.void
        on = next
        hold()
        return on ? Effect.void : pressed("escape")
      })

    return {
      service: { events: Stream.fromPubSub(events), cancel: pressed("escape"), toggle } satisfies Shortcut["Type"],
      /** A helper has just started. */
      greeted: Effect.sync(hold),
      /** How registering went, logged when it changes, so a restarted helper doesn't say it again. */
      registered: (ok: boolean, message = "macOS turned it down") =>
        Effect.suspend(() => {
          if (ok === registered) return Effect.void
          registered = ok
          return ok
            ? Effect.logInfo(`Press ${format(keys)} to dictate new work`)
            : Effect.logWarning(`Can't use ${format(keys)} to dictate new work: ${message}. Pick another with YAPD_SHORTCUT.`)
        }),
      pressed,
      /** The helper quit, letting go of Escape and whatever was being dictated. */
      quit: Effect.suspend(() => {
        if (!dictating) return Effect.void
        dictating = false
        return Effect.asVoid(PubSub.publish(events, cancelled))
      }),
    }
  })
