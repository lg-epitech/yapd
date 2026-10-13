import { Effect, Option, Ref } from "effect"
import { join } from "node:path"
import * as Config from "./Config.ts"
import { home } from "./Home.ts"

// The user's rules for new work, in their own words, since a model reads them:
// "Fable on high for design and hard bugs, a worktree for features and fixes,
// none for questions". Apart from .env, which holds settings rather than prose.

/** Next to .env, in yapd's home, unless `YAPD_PREFERENCES` says elsewhere. */
export const path = Effect.map(Config.preferences, Option.getOrElse(() => join(home, "preferences.md")))

/** More than this is cut, since every prompt waits on the model reading it. */
const longest = 6000

/** What's kept of the file, and whether that's all of it. */
export const fit = (text: string) => {
  const rules = text.trim()
  return { rules: rules.slice(0, longest), whole: rules.length <= longest }
}

/** A routine he wrote in the file: what he says, and the steps sent to a thread for it, as he typed them. */
export interface Routine {
  readonly name: string
  readonly steps: string
}

/** Quotes or backticks around a name, which aren't part of it. */
const quoted = /^["'`\u201c\u2018]+|["'`\u201d\u2019]+$/g

/**
 * His routines: the lines under a "## Routines" heading, up to the next
 * heading, written "- name: steps", from the whole file, however long, so
 * none is lost to the cut. Anything else there, and the rest of the file, is
 * free-form. The first of two called the same, in any case, is the one.
 */
export const routines = (text: string): ReadonlyArray<Routine> => {
  const found: Array<Routine> = []
  let under = false
  for (const line of text.split(/\r?\n/)) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)[\s#]*$/.exec(line)
    if (heading !== null) {
      under = /^routines:?$/i.test(heading[1]!.trim())
      continue
    }
    const routine = under ? /^\s*[-*+]\s+([^:]+?)\s*:\s*(\S.*?)\s*$/.exec(line) : null
    if (routine === null) continue
    const name = routine[1]!.replace(quoted, "").trim()
    if (name !== "" && !found.some((other) => other.name.toLowerCase() === name.toLowerCase())) found.push({ name, steps: routine[2]! })
  }
  return found
}

/**
 * What reads his routines, each time from the whole file, so a change
 * applies to the next thing he says. None without a file. One called as yapd
 * `answers` to already, like "ship it", which with a question open would be
 * a yes to it, never the routine, is left out, as it's refused said by
 * voice, and the log says so once, until which are left out changes.
 */
export const written = (path: string, answers: (name: string) => boolean) =>
  Effect.map(Ref.make(""), (warned) =>
    Effect.gen(function* () {
      const file = Bun.file(path)
      const all = (yield* Effect.tryPromise(() => file.exists())) ? routines(yield* Effect.tryPromise(() => file.text())) : []
      const taken = all.filter(({ name }) => answers(name))
      const names = taken.map(({ name }) => `"${name}"`).join(", ")
      if ((yield* Ref.getAndSet(warned, names)) !== names && taken.length > 0) {
        const [them, it] = taken.length === 1 ? ["routine", "it"] : ["routines", "them"]
        yield* Effect.logWarning(`I already answer to ${names}, so I'm going without your ${them} called that in ${path}: call ${it} something else`)
      }
      return all.filter((routine) => !taken.includes(routine))
    }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`Could not read ${path}, so I'm going without your routines`, error).pipe(Effect.as<ReadonlyArray<Routine>>([])),
      ),
    ),
  )

/** Read each time, so a change applies to the next dictation. None when there's no file, or nothing in it. */
export const load = (path: string) =>
  Effect.gen(function* () {
    const file = Bun.file(path)
    if (!(yield* Effect.tryPromise(() => file.exists()))) return Option.none<string>()
    const { rules, whole } = fit(yield* Effect.tryPromise(() => file.text()))
    if (!whole) yield* Effect.logWarning(`${path} is longer than ${longest} characters, so I only read the start of it`)
    return rules === "" ? Option.none<string>() : Option.some(rules)
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning(`Could not read ${path}, so I'm going without your rules`, error).pipe(Effect.as(Option.none<string>())),
    ),
  )
