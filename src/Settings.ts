import { Database } from "bun:sqlite"
import { Context, Data, Effect, Layer } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { home } from "./Home.ts"

// What the user chose that yapd keeps across restarts, in its database: so
// far, only whether it's on.

export const file = join(home, "yapd.sqlite")

export class SettingsError extends Data.TaggedError("SettingsError")<{ readonly message: string; readonly cause?: unknown }> {}

export class Settings extends Context.Tag("yapd/Settings")<
  Settings,
  {
    /** Whether yapd is on. It is until the user turns it off. */
    readonly on: Effect.Effect<boolean, SettingsError>
    readonly remember: (on: boolean) => Effect.Effect<void, SettingsError>
  }
>() {}

/** Opens the database at `path`, or in memory for ":memory:", and closes it with the scope. */
export const make = (path: string) =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          if (path !== ":memory:") {
            await mkdir(dirname(path), { recursive: true })
            // Private from the start.
            await writeFile(path, "", { flag: "a", mode: 0o600 })
          }
          const database = new Database(path, { strict: true })
          database.exec("create table if not exists settings (name text primary key, value text not null)")
          return database
        },
        catch: (cause) => new SettingsError({ message: `Could not open ${path}.`, cause }),
      }),
      (database) => Effect.sync(() => database.close()),
    )
    const query = <A>(run: () => A) =>
      Effect.try({ try: run, catch: (cause) => new SettingsError({ message: "Could not read or change yapd's settings.", cause }) })
    return {
      on: query(
        () => database.query<{ value: string }, [string]>("select value from settings where name = ?").get("on")?.value !== "false",
      ),
      remember: (on: boolean) =>
        query(() => {
          database
            .query("insert into settings (name, value) values ('on', ?) on conflict (name) do update set value = excluded.value")
            .run(String(on))
        }),
    } satisfies Settings["Type"]
  })

export const layer = Layer.scoped(Settings, make(file))
