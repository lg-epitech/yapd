import { env } from "@huggingface/transformers"
import { Data, Effect, Schedule } from "effect"
import { rename, rm } from "node:fs/promises"
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

/** One of the repo's files in transformers.js's cache, downloaded unless it's there, for what transformers.js doesn't load itself. */
export const download = async (repo: string, file: string) => {
  const path = join(env.cacheDir, repo, file)
  if (await Bun.file(path).exists()) return path
  const response = await fetch(`${env.remoteHost}${repo}/resolve/main/${file}`)
  if (!response.ok) throw new Error(`Downloading ${repo}/${file} failed with ${response.status}`)
  // Read whole, since Bun 1.3 can wait forever writing out a response whose connection drops, and moved into place once complete.
  const part = `${path}.part`
  await Bun.write(part, await response.arrayBuffer())
  await rename(part, path)
  return path
}
