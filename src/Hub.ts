import { env } from "@huggingface/transformers"
import { Data, Effect, Schedule } from "effect"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

export class LoadError extends Data.TaggedError("LoadError")<{ readonly repo: string; readonly cause: unknown }> {}

/**
 * In a cache where nothing is part of a file. It's named for what it said at
 * first, that the model loaded once, which was the only way to tell while
 * transformers.js did the downloading: it writes straight into its cache, so a
 * restart mid-download leaves a partial model that every later start fails to
 * load. What's downloaded here only appears once whole, so a cache that only
 * holds that is marked before anything is in it, and what has downloaded is
 * still there after a restart, whether or not the model ever loaded. That's
 * only so when all of a model is downloaded here, so whoever loads one that is
 * keeps transformers.js from downloading any of it.
 */
const marker = (repo: string) => join(env.cacheDir, repo, ".yapd-loaded")

/** Caches being cleared, by folder, so that one isn't cleared again with what has downloaded into it since. */
const clearing = new Map<string, Promise<void>>()

/** Empties a cache that isn't marked. `whole` when all that will be in it is downloaded here. */
const clear = (repo: string, whole: boolean) => {
  const cache = join(env.cacheDir, repo)
  const started =
    clearing.get(cache) ??
    Bun.file(marker(repo))
      .exists()
      .then(async (marked) => {
        if (marked) return
        await rm(cache, { recursive: true, force: true })
        if (whole) await Bun.write(marker(repo), "")
      })
      .finally(() => clearing.delete(cache))
  clearing.set(cache, started)
  return started
}

/** Downloads under way, by where they end up, so that asking again waits for the one there is rather than write over it. */
const downloads = new Map<string, Promise<string>>()

/** Next to a file the repo hasn't got, so that it isn't asked for at every start, which couldn't be answered offline. */
const absent = (path: string) => `${path}.absent`

/**
 * What transformers.js sends with what it downloads that matters: the user's
 * token, for a repo that's theirs alone. To Hugging Face and nowhere else, as
 * it has it, whatever host the models are set to come from.
 */
export const headers = (url: string): Record<string, string> => {
  const token = process.env.HF_TOKEN ?? process.env.HF_ACCESS_TOKEN
  const { protocol, hostname } = new URL(url)
  const theirs = protocol === "https:" && ["huggingface.co", "hf.co"].includes(hostname)
  return theirs && token !== undefined && token !== "" ? { Authorization: `Bearer ${token}` } : {}
}

/** Written next to where it goes and moved into place once whole, so that a file in the cache is never part of one. */
const fetched = async (url: string, path: string, optional: boolean) => {
  const response = await fetch(url, { headers: headers(url) })
  if (response.status === 404 && optional) {
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(absent(path), "")
    return path
  }
  if (!response.ok || response.body === null) throw new Error(`Downloading ${url} failed with ${response.status}`)
  const part = `${path}.part`
  try {
    await mkdir(dirname(path), { recursive: true })
    // What a download that was stopped left, which would otherwise be written over from its start and no further.
    await rm(part, { force: true })
    // Chunk by chunk, since a model can be larger than the memory there is to spare, and Bun 1.3 can wait forever
    // writing out a response whose connection drops when it's handed the response itself.
    const writer = Bun.file(part).writer()
    const reader = response.body.getReader()
    let length = 0
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        await writer.write(next.value)
        length += next.value.length
      }
    } finally {
      // When it failed too, or the file stays open, and takes its room on the disk after it's removed.
      await writer.end()
    }
    // A compressed response is as long as what it holds once it's read, not as it says.
    const expected = response.headers.get("content-encoding") === null ? response.headers.get("content-length") : null
    const written = (await stat(part)).size
    if (written !== length || (expected !== null && Number(expected) !== length)) {
      throw new Error(`Downloading ${url} stopped at ${written} of ${expected ?? length} bytes`)
    }
    await rename(part, path)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
  return path
}

/**
 * One of the repo's files in transformers.js's cache, downloaded unless it's
 * there. `optional` when the model loads without: there's nothing where it
 * would be, then, if the repo hasn't got it.
 */
export const download = async (repo: string, file: string, optional = false) => {
  const path = join(env.cacheDir, repo, file)
  if ((await Bun.file(path).exists()) || (optional && (await Bun.file(absent(path)).exists()))) return path
  const running = downloads.get(path)
  if (running !== undefined) return running
  const started = fetched(`${env.remoteHost}${repo}/resolve/main/${file}`, path, optional).finally(() => downloads.delete(path))
  downloads.set(path, started)
  return started
}

/**
 * Downloads all that loading a model reads, with what it's given to download
 * each file. Which files those are can depend on what's in the first of them.
 */
export type Files = (get: (file: string, optional?: boolean) => Promise<string>) => Promise<unknown>

const all = (repo: string, files: Files) => files((file, optional) => download(repo, file, optional))

/**
 * The repo's files in the cache, without loading anything. transformers.js
 * can't be left to download what it loads: it asks for some files twice, and
 * takes one that's still being written for one in the cache, as it does again
 * when it's asked to load after it failed, while what it started is still
 * downloading.
 */
export const cache = (repo: string, files: Files) =>
  Effect.tryPromise({
    try: () => clear(repo, true).then(() => all(repo, files)),
    catch: (cause) => new LoadError({ repo, cause }),
  })

/**
 * `files` are all that `from` reads, which are downloaded first, and `from`
 * mustn't download any more. Without, `from` does the downloading. A cache
 * whose model doesn't load is no longer trusted, whatever is wrong with it, so
 * the next load starts from an empty one rather than fail the same way.
 */
export const load = <A>(repo: string, from: () => Promise<A>, files?: Files) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => clear(repo, files !== undefined), catch: (cause) => new LoadError({ repo, cause }) })
    let there = false
    const model = yield* Effect.tryPromise({
      try: async () => {
        if (files !== undefined) await all(repo, files)
        there = true
        return await from()
      },
      catch: (cause) => new LoadError({ repo, cause }),
    }).pipe(
      Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }),
      // Not when it's the download that failed, which leaves what did download for the next one.
      Effect.tapError(() => (there ? Effect.promise(() => rm(marker(repo), { force: true })) : Effect.void)),
    )
    yield* Effect.promise(() => Bun.write(marker(repo), ""))
    return model
  })
