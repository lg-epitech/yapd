import { env } from "@huggingface/transformers"
import { Data, Effect, Schedule } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"

export class LoadError extends Data.TaggedError("LoadError")<{ readonly repo: string; readonly cause: unknown }> {}

/**
 * transformers.js downloads straight into its cache, so a restart mid-download
 * leaves a partial model that every later start fails to load. Only a model
 * that loaded before is trusted; anything else downloads again.
 */
export const load = <A>(repo: string, from: () => Promise<A>) =>
  Effect.gen(function* () {
    const cache = join(env.cacheDir, repo)
    const loaded = join(cache, ".yapd-loaded")
    if (!(yield* Effect.promise(() => Bun.file(loaded).exists()))) {
      yield* Effect.promise(() => rm(cache, { recursive: true, force: true }))
    }
    const model = yield* Effect.tryPromise({ try: from, catch: (cause) => new LoadError({ repo, cause }) }).pipe(
      Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }),
    )
    yield* Effect.promise(() => Bun.write(loaded, ""))
    return model
  })
