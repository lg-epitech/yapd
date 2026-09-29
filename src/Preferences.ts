import { Effect, Option } from "effect"
import { dirname, join } from "node:path"
import * as Config from "./Config.ts"

// The user's rules for new work, in their own words, since a model reads them:
// "Fable on high for design and hard bugs, a worktree for features and fixes,
// none for questions". Apart from .env, which holds settings rather than prose.

/** Next to .env, in the yapd folder, unless `YAPD_PREFERENCES` says elsewhere. */
export const path = Effect.map(Config.preferences, Option.getOrElse(() => join(dirname(import.meta.dir), "preferences.md")))

/** More than this is cut, since every prompt waits on the model reading it. */
const longest = 6000

/** What's kept of the file, and whether that's all of it. */
export const fit = (text: string) => {
  const rules = text.trim()
  return { rules: rules.slice(0, longest), whole: rules.length <= longest }
}

/** Read each time, so a change applies to the next dictation. None when there's no file, or nothing in it. */
export const load = (path: string) =>
  Effect.gen(function* () {
    const file = Bun.file(path)
    if (!(yield* Effect.promise(() => file.exists()))) return Option.none<string>()
    const { rules, whole } = fit(yield* Effect.promise(() => file.text()))
    if (!whole) yield* Effect.logWarning(`${path} is longer than ${longest} characters, so I only read the start of it`)
    return rules === "" ? Option.none<string>() : Option.some(rules)
  }).pipe(
    Effect.catchAllDefect((defect) =>
      Effect.logWarning(`Could not read ${path}, so I'm going without your rules`, defect).pipe(Effect.as(Option.none<string>())),
    ),
  )
