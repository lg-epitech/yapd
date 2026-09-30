import { Data, Effect, Option, Schema } from "effect"
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { home } from "./Home.ts"
import { Agent } from "./Payload.ts"

// The sessions yapd started from the command line, one file each, next to
// their output. Whoever starts one and what minds it are different processes,
// and this is where they meet. A follow-up needs it too, to pick the session
// up with what it was started with.

export const Session = Schema.Struct({
  /** Names its files. Not the session's id, which Codex only says once it runs. */
  launch: Schema.String,
  agent: Agent,
  session: Schema.optional(Schema.String),
  project: Schema.String,
  directory: Schema.String,
  repository: Schema.Boolean,
  model: Schema.String,
  effort: Schema.optional(Schema.String),
  permissions: Schema.optional(Schema.String),
  /** What the turn that's starting, or the last one, was asked. */
  prompt: Schema.String,
  /** Whether that turn picks up a session rather than starts one. */
  resume: Schema.Boolean,
  /**
   * Starting until the command line names the session, and unstarted if it
   * never does. Then running, until the turn ends one way or the other.
   */
  state: Schema.Literal("starting", "unstarted", "running", "idle", "failed"),
  /** Why it failed, to be read out. */
  error: Schema.optional(Schema.String),
  at: Schema.String,
})
export type Session = typeof Session.Type

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly path: string
  readonly cause: unknown
}> {}

export const folder = join(home, "sessions")

export const record = (launch: string, root: string = folder) => join(root, `${launch}.json`)

/** Everything the command line printed, as it printed it. */
export const log = (launch: string, root: string = folder) => join(root, `${launch}.log`)

/** Records go after a month, by when the session last did anything. */
const kept = 30 * 24 * 60 * 60_000

export const write = (session: Session, root: string = folder) =>
  Effect.suspend(() => {
    const path = record(session.launch, root)
    const aside = `${path}.${crypto.randomUUID()}`
    let writing = false
    return Effect.tryPromise({
      try: async () => {
        await mkdir(root, { recursive: true })
        writing = true
        // Private from creation, including while the record is being written.
        await writeFile(aside, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: "wx" })
        await rename(aside, path)
      },
      catch: (cause) => new StorageError({ path, cause }),
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => writing ? Effect.tryPromise(() => rm(aside, { force: true })).pipe(
          Effect.catchAll((error) => Effect.logWarning(`Could not remove temporary session record ${aside}`, error)),
        ) : Effect.void),
      ),
      // Filesystem promises cannot be aborted; finish the atomic write before releasing its temporary file.
      Effect.uninterruptible,
    )
  })

export const read = (launch: string, root: string = folder) =>
  Effect.tryPromise(() => Bun.file(record(launch, root)).text()).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Session))),
    Effect.option,
  )

/** The session an agent's hooks report under that id, if yapd started it. */
export const find = (agent: Agent, session: string, root: string = folder) =>
  Effect.gen(function* () {
    const names = yield* Effect.promise(() => readdir(root).catch(() => []))
    const launches = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length))
    const sessions = yield* Effect.forEach(launches, (launch) => read(launch, root), { concurrency: 16 })
    return Option.fromNullable(
      sessions.flatMap(Option.toArray).find((found) => found.agent === agent && found.session === session),
    )
  })

/** Lets go of what's older than a month. */
export const prune = (now: number, root: string = folder) =>
  Effect.tryPromise({
    try: async () => {
      for (const name of await readdir(root).catch(() => [])) {
        const path = join(root, name)
        const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: now }))
        if (now - mtimeMs > kept) await rm(path, { force: true })
      }
    },
    catch: (cause) => new StorageError({ path: root, cause }),
  })
