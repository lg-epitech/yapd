import { Effect, Schema } from "effect"
import { mkdir, realpath, rename } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { home } from "./Home.ts"
import { Agent } from "./Payload.ts"
import { run } from "./Process.ts"

// The projects agents have run in on this machine, and what each last ran
// with, so new work can start in one without the user listing it, and follow
// what they used there. Kept where the sessions run, since a path means
// nothing on another machine.

export const Entry = Schema.Struct({
  agent: Agent,
  /** Hooks don't always say, so it can be missing. */
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  at: Schema.String,
})
export type Entry = typeof Entry.Type

/** By the path of the project's checkout. */
const Seen = Schema.Record({ key: Schema.String, value: Entry })
export type Seen = typeof Seen.Type

export const file = join(home, "projects.json")

export interface Session {
  /** Where it runs: the project's checkout, a folder inside it, or one of its worktrees. */
  readonly directory: string
  readonly agent: Agent
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

/** The checkout a directory belongs to, from git's shared directory, which a worktree points back to. */
export const checkout = (commonDir: string, directory: string) => {
  const dir = commonDir.replace(/\/+$/, "")
  return basename(dir) === ".git" ? dirname(dir) : directory
}

/** A session that doesn't say its model keeps the one the project last used with that agent. */
export const merge = (seen: Seen, project: string, session: Session, at: string): Seen => {
  const before = seen[project]
  const kept = session.model === undefined && before?.agent === session.agent ? before : undefined
  const model = session.model ?? kept?.model
  const effort = session.effort ?? kept?.effort
  return {
    ...seen,
    [project]: { agent: session.agent, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), at },
  }
}

/** What's been seen so far. Nothing, when the record is missing or can't be read. */
export const read = (path: string = file) =>
  Effect.tryPromise(() => Bun.file(path).text()).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Seen))),
    Effect.orElseSucceed((): Seen => ({})),
  )

const project = (directory: string) =>
  run(["git", "-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.map((stdout) => checkout(stdout.trim(), directory)),
    Effect.orElseSucceed(() => directory),
    Effect.flatMap((path) => Effect.promise(() => realpath(path).catch(() => path))),
  )

/**
 * Notes that an agent ran in a directory. It never fails, so what calls it,
 * like a hook, can't be broken by it. Two sessions noting at once can lose one
 * of the notes, which the next turn makes up for.
 */
export const note = (session: Session, path: string = file) =>
  Effect.gen(function* () {
    const checkout = yield* project(session.directory)
    const seen = merge(yield* read(path), checkout, session, new Date().toISOString())
    // Written aside and moved into place, so a reader never finds half of it.
    const aside = `${path}.${crypto.randomUUID()}`
    yield* Effect.promise(async () => {
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(aside, `${JSON.stringify(seen, null, 2)}\n`)
      await rename(aside, path)
    })
  }).pipe(Effect.catchAllCause(() => Effect.void))
