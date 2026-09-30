import { Database } from "bun:sqlite"
import { Context, Data, Effect, Layer } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { home } from "./Home.ts"

// What yapd knows that nothing else does, like which updates the user has
// heard, in one SQLite database on the machine that talks to them. What
// agents and T3 Code keep is asked of them when needed, never copied here,
// since a copy would drift. A row about a thread names its machine too, since
// another machine's threads are only known there.

export const file = join(home, "yapd.sqlite")

export class StoreError extends Data.TaggedError("StoreError")<{ readonly message: string; readonly cause?: unknown }> {}

/**
 * How the schema came to be, one step at a time. The database counts the
 * steps it has had in its `user_version`, so each runs once. A feature adds
 * the tables it needs as a new step at the end, and a step that has shipped
 * never changes.
 */
export const migrations: ReadonlyArray<string> = []

export class Store extends Context.Tag("yapd/Store")<
  Store,
  {
    /** Runs `work` as one transaction: all of it is kept, or none of it if it throws. */
    readonly transaction: <A>(work: (database: Database) => A) => Effect.Effect<A, StoreError>
  }
>() {}

const version = (database: Database) => database.query<{ user_version: number }, []>("pragma user_version").get()?.user_version ?? 0

/**
 * Takes the database through the steps it hasn't had. Each step goes with its
 * count, so a failed one leaves nothing behind, and each reads the count with
 * the database locked, so a second yapd starting at once can't take one twice.
 */
const migrate = (database: Database, steps: ReadonlyArray<string>) => {
  const next = database.transaction(() => {
    const had = version(database)
    if (had > steps.length) {
      throw new StoreError({ message: `The database is from a newer yapd, at version ${had} where this one knows ${steps.length}.` })
    }
    const step = steps[had]
    if (step === undefined) return false
    database.exec(step)
    database.exec(`pragma user_version = ${had + 1}`)
    return true
  })
  while (next.immediate()) {}
}

/** Opens the database at `path`, or in memory for ":memory:", up to date, and closes it with the scope. */
export const open = (path: string, steps: ReadonlyArray<string> = migrations) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (path !== ":memory:") {
          await mkdir(dirname(path), { recursive: true })
          // Private from the start. SQLite gives its journal files the same permissions.
          await writeFile(path, "", { flag: "a", mode: 0o600 })
        }
        const database = new Database(path, { strict: true })
        try {
          // Readers don't wait for a writer, and a writer waits its turn instead of failing.
          database.exec("pragma journal_mode = wal")
          database.exec("pragma busy_timeout = 5000")
          database.exec("pragma foreign_keys = on")
          migrate(database, steps)
          return database
        } catch (error) {
          database.close()
          throw error
        }
      },
      catch: (cause) => cause instanceof StoreError ? cause : new StoreError({ message: `Could not open ${path}.`, cause }),
    }),
    (database) => Effect.sync(() => database.close()),
  )

export const make = (path: string, steps: ReadonlyArray<string> = migrations) =>
  Effect.map(open(path, steps), (database): Store["Type"] => ({
    transaction: (work) =>
      Effect.try({
        try: () => database.transaction(() => work(database))(),
        catch: (cause) => new StoreError({ message: "yapd's database couldn't be read or changed.", cause }),
      }),
  }))

export const layer = Layer.scoped(Store, make(file))
