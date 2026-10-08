import type { Database } from "bun:sqlite"
import { Context, Data, Effect, Layer, Option } from "effect"
import * as Store from "./Store.ts"

// What yapd keeps across restarts, in its database: whether it's on, and the
// odd thing it works out once, like its usual lines in the user's style.

export class SettingsError extends Data.TaggedError("SettingsError")<{ readonly message: string; readonly cause?: unknown }> {}

export class Settings extends Context.Tag("yapd/Settings")<
  Settings,
  {
    /** Whether yapd is on. It is until the user turns it off. */
    readonly on: Effect.Effect<boolean, SettingsError>
    readonly remember: (on: boolean) => Effect.Effect<void, SettingsError>
    /** Anything else yapd keeps, by name. */
    readonly read: (name: string) => Effect.Effect<Option.Option<string>, SettingsError>
    readonly write: (name: string, value: string) => Effect.Effect<void, SettingsError>
  }
>() {}

/** Reads and writes the `settings` table of yapd's database. */
export const fromStore = (store: Store.Store["Type"]): Settings["Type"] => {
  const query = <A>(run: (database: Database) => A) =>
    store
      .transaction(run)
      .pipe(Effect.mapError((cause) => new SettingsError({ message: "Could not read or change yapd's settings.", cause })))
  const read = (name: string) =>
    query((database) =>
      Option.fromNullable(database.query<{ value: string }, [string]>("select value from settings where name = ?").get(name)?.value),
    )
  const write = (name: string, value: string) =>
    query((database) => {
      database
        .query("insert into settings (name, value) values (?, ?) on conflict (name) do update set value = excluded.value")
        .run(name, value)
    })
  return {
    on: Effect.map(read("on"), (value) => Option.getOrUndefined(value) !== "false"),
    remember: (on) => write("on", String(on)),
    read,
    write,
  }
}

/** Opens the database at `path`, or in memory for ":memory:", and closes it with the scope. */
export const make = (path: string) =>
  Store.make(path).pipe(
    Effect.map(fromStore),
    Effect.mapError((cause) => new SettingsError({ message: `Could not open ${path}.`, cause })),
  )

export const layer = Layer.effect(Settings, Effect.map(Store.Store, fromStore))
