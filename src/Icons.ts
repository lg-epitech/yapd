import { Clock, Effect, Option, PubSub, Schema, Stream } from "effect"
import * as T3Actions from "./T3Actions.ts"
import type * as T3Live from "./T3Live.ts"

// Each project's icon as T3 Code draws it, for a menu to show beside its
// threads: the emoji or monogram he chose for it, its own image, fetched from
// its machine's T3 Code and served by yapd, or else a monogram made from its
// name. Nothing outside yapd ever sees T3 Code's address, nor the signed path
// that's a key to the image while it lasts.

/** T3 Code's colours, in its order, which is what a name's monogram is coloured by. */
export const colors = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const
export type Color = (typeof colors)[number]

/** A name as T3 Code compares it. */
const normalized = (name: string) => name.normalize("NFKC").trim()

/**
 * The monogram T3 Code makes from a project's name: its first letter, and the
 * first number after it in the first word, else the first letter of the last
 * word, else the first word's last letter; and a colour from the name.
 */
export const monogram = (name: string): { readonly text: string; readonly color: Color } => {
  const words = normalized(name).match(/[\p{L}\p{N}]+/gu) ?? []
  const first = words[0]
  let text = "PR"
  if (first !== undefined) {
    const letters = Array.from(first)
    const lead = letters[0] ?? "P"
    const next = letters.slice(1).find((letter) => /\p{N}/u.test(letter)) ?? (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : letters.at(-1)) ?? lead
    text = Array.from(`${lead}${next}`.toUpperCase()).slice(0, 2).join("")
  }
  let hash = 0
  for (const letter of normalized(name).toLocaleLowerCase("en-US") || "project") hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % colors.length
  return { text, color: colors[hash] ?? "blue" }
}

/** How a project's icon is drawn: its image, at a path on yapd's API, an emoji, or a monogram. Each with the monogram to draw instead. */
export type Icon =
  | { readonly kind: "image"; readonly url: string; readonly revision: string; readonly text: string; readonly color: Color }
  | { readonly kind: "emoji"; readonly emoji: string; readonly text: string; readonly color: Color }
  | { readonly kind: "monogram"; readonly text: string; readonly color: Color }

const Shade = Schema.Literal(...colors)

/** The icon he chose for a project, as T3 Code sends it: a Lucide glyph used to carry a monogram, which T3 Code still reads as one. */
const Chosen = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("monogram"), text: Schema.NonEmptyString, color: Shade }),
  Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("lucide"), name: Schema.String, color: Shade, monogramText: Schema.optional(Schema.NonEmptyString), monogram: Schema.optional(Schema.NonEmptyString) }),
)
const chosen = Schema.decodeUnknownOption(Chosen)

/**
 * The icon he chose for a project, if it's one yapd can draw: a monogram, an
 * emoji, or a Lucide glyph, which the menu can't draw, as a monogram of the
 * name in its colour. A kind T3 Code adds is none, as T3 Code's own app takes it.
 */
export const override = (project: Pick<T3Live.Project, "title" | "projectIcon">): Option.Option<Icon> =>
  Option.map(chosen(project.projectIcon), (icon): Icon => {
    const named = monogram(project.title)
    switch (icon.kind) {
      case "monogram":
        return { kind: "monogram", text: icon.text, color: icon.color }
      case "emoji":
        return { kind: "emoji", emoji: icon.emoji, ...named }
      case "lucide":
        return { kind: "monogram", text: icon.monogramText ?? icon.monogram ?? named.text, color: icon.color }
    }
  })

/** A project's image, as yapd serves it. */
export interface Image {
  readonly bytes: Uint8Array
  readonly type: string
  /** Changes only with the image. */
  readonly revision: string
}

/** How long a project with no image of its own goes before T3 Code is asked again, and one with an image. */
const again = { missing: 10 * 60_000, found: 30 * 60_000 }

/** Where yapd serves a project's image. */
export const path = (machine: string, project: string) => `/projects/${encodeURIComponent(machine)}/${encodeURIComponent(project)}/icon`

/** What's known of a project's image. */
interface Known {
  /** The folder T3 Code was asked by, which moving the project changes. */
  readonly root: string
  /** The name T3 Code gave its image, which has its hash in it, so the same name is the same image. */
  readonly file?: string
  readonly image?: Image
  /** When T3 Code was last asked. */
  readonly asked: number
  readonly asking: boolean
}

export interface Icons {
  /** A project's icon, from what's known at once: asking its machine's T3 Code for its image, when that's due, comes after. */
  readonly icon: (machine: string, project: T3Live.Project) => Effect.Effect<Icon>
  /** A project's image, once it's been fetched. */
  readonly image: (machine: string, project: string) => Effect.Effect<Option.Option<Image>>
  /** Each time an image is found, changes or goes. */
  readonly changes: Stream.Stream<void>
}

/** The icons of projects, each image asked of its machine's T3 Code through `actions`: this one's, or another's through its tunnel. */
export const make = (options: { readonly actions: (machine: string) => Option.Option<T3Actions.Actions> }) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const known = new Map<string, Known>()
    const changed = yield* PubSub.unbounded<void>()
    const keyOf = (machine: string, project: string) => `${machine}\n${project}`

    /** Asks T3 Code for a project's image, by its own folder, and fetches it unless it's the one already here. */
    const fetching = (machine: string, project: T3Live.Project, key: string, before: Known | undefined) =>
      Effect.gen(function* () {
        const actions = options.actions(machine)
        if (Option.isNone(actions)) {
          known.set(key, { root: project.workspaceRoot, asked: yield* Clock.currentTimeMillis, asking: false })
          return
        }
        const { relativeUrl } = yield* actions.value.favicon(project.workspaceRoot)
        const file = decodeURIComponent(relativeUrl.split("/").at(-1) ?? "")
        const now = yield* Clock.currentTimeMillis
        if (file === T3Actions.noIcon) {
          known.set(key, { root: project.workspaceRoot, asked: now, asking: false })
          if (before?.image !== undefined) yield* PubSub.publish(changed, undefined)
          return
        }
        // Named by its hash, it's the image already here.
        if (before?.image !== undefined && before.file === file && before.root === project.workspaceRoot) {
          known.set(key, { ...before, asked: now, asking: false })
          return
        }
        const { bytes, type } = yield* actions.value.asset(relativeUrl)
        if (!type.toLowerCase().startsWith("image/")) {
          known.set(key, { root: project.workspaceRoot, asked: now, asking: false })
          return yield* Effect.logWarning(`T3 Code sent ${project.title}'s icon as something other than an image`)
        }
        const revision = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16)
        known.set(key, { root: project.workspaceRoot, file, image: { bytes, type, revision }, asked: now, asking: false })
        if (before?.image?.revision !== revision) yield* PubSub.publish(changed, undefined)
      }).pipe(
        // Never with what went wrong in full, which could hold the path that's a key to the image.
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const at = known.get(key)
            known.set(key, { root: project.workspaceRoot, ...(at?.file === undefined ? {} : { file: at.file }), ...(at?.image === undefined ? {} : { image: at.image }), asked: yield* Clock.currentTimeMillis, asking: false })
            yield* Effect.logWarning(`Could not fetch ${project.title}'s icon: ${T3Actions.reason(error)}`)
          }),
        ),
      )

    return {
      icon: (machine, project) =>
        Effect.gen(function* () {
          const chosen = override(project)
          if (Option.isSome(chosen)) return chosen.value
          const key = keyOf(machine, project.id)
          const at = known.get(key)
          const now = yield* Clock.currentTimeMillis
          const due =
            at === undefined ||
            (!at.asking && (at.root !== project.workspaceRoot || now - at.asked >= (at.image === undefined ? again.missing : again.found)))
          if (due) {
            known.set(key, { ...(at ?? { root: project.workspaceRoot }), asked: at?.asked ?? now, asking: true })
            yield* Effect.forkIn(fetching(machine, project, key, at), scope)
          }
          const named = monogram(project.title)
          return at?.image === undefined
            ? { kind: "monogram", ...named }
            : { kind: "image", url: path(machine, project.id), revision: at.image.revision, ...named }
        }),
      image: (machine, project) => Effect.sync(() => Option.fromNullable(known.get(keyOf(machine, project))?.image)),
      changes: Stream.fromPubSub(changed),
    } satisfies Icons
  })
