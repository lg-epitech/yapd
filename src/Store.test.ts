import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Store from "./Store.ts"

const first = "create table heard (thread text primary key)"
const second = "create table focus (until text not null)"

const tables = (path: string) => {
  const database = new Database(path, { readonly: true })
  try {
    const names = database.query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name").all()
    const version = database.query<{ user_version: number }, []>("pragma user_version").get()?.user_version
    return { names: names.map(({ name }) => name), version }
  } finally {
    database.close()
  }
}

const within = async (test: (path: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "yapd-store-"))
  try {
    await test(join(root, "nested", "yapd.sqlite"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const opened = (path: string, steps: ReadonlyArray<string>) => Effect.runPromiseExit(Effect.scoped(Store.open(path, steps)))

describe("Store", () => {
  test("creates a private database and runs each step once, even across restarts", () =>
    within(async (path) => {
      expect(Exit.isSuccess(await opened(path, [first]))).toBe(true)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(tables(path)).toEqual({ names: ["heard"], version: 1 })

      expect(Exit.isSuccess(await opened(path, [first, second]))).toBe(true)
      expect(tables(path)).toEqual({ names: ["focus", "heard"], version: 2 })
    }))

  test("keeps the steps before one that fails, and nothing of the one that failed", () =>
    within(async (path) => {
      const exit = await opened(path, [first, `${second}; create table heard (again text)`])
      expect(exit).toMatchObject({ _tag: "Failure", cause: { error: { _tag: "StoreError" } } })
      expect(tables(path)).toEqual({ names: ["heard"], version: 1 })
    }))

  test("refuses a database from a newer yapd rather than guess at its tables", () =>
    within(async (path) => {
      await opened(path, [first, second])
      const exit = await opened(path, [first])
      expect(exit).toMatchObject({ _tag: "Failure", cause: { error: { _tag: "StoreError", message: expect.stringContaining("newer yapd") } } })
      expect(tables(path)).toEqual({ names: ["focus", "heard"], version: 2 })
    }))

  test("keeps none of a transaction that fails partway", async () => {
    const counts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store.make(":memory:", [first])
          const failed = yield* Effect.exit(
            store.transaction((database) => {
              database.run("insert into heard values ('rosie:one')")
              database.run("insert into heard values ('rosie:one')")
            }),
          )
          const count = yield* store.transaction((database) =>
            database.query<{ count: number }, []>("select count(*) as count from heard").get()?.count,
          )
          return { failed, count }
        }),
      ),
    )
    expect(counts.failed).toMatchObject({ _tag: "Failure", cause: { error: { _tag: "StoreError" } } })
    expect(counts.count).toBe(0)
  })
})


test("Store upgrades existing outgoing messages without losing them", () => within(async path => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* Store.make(path, Store.migrations.slice(0, 1))
    yield* store.transaction(database => database.run("insert into messages (command_id, message_id, machine, thread, title, project, directory, text, state, created_at) values ('old', 'message', 'rig', 't1', 'Fix', 'yapd', '/repo', 'Keep API', 'held', '2026-09-30T00:00:00.000Z')"))
  })))
  const row = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* Store.make(path)
    return yield* store.transaction(database => database.query<{ text: string; state: string; reference: string | null }, []>("select text, state, reference from messages where command_id = 'old'").get())
  })))
  expect(row).toEqual({ text: "Keep API", state: "held", reference: null })
}))

test("a database at version 2 with settings and 42 threads moves to version 3 and keeps them all", () => within(async path => {
  // As Rosie's was: settings from before the steps, 40 threads learned and 2 that yapd started.
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* Store.make(path, Store.migrations.slice(0, 2))
    yield* store.transaction(database => {
      database.run("create table settings (name text primary key, value text not null)")
      database.run("insert into settings values ('on', 'false')")
      database.run(`insert into settings values ('persona', '{"style":"Jarvis"}')`)
      for (let index = 0; index < 42; index++) {
        database.run(
          "insert into threads (machine, id, prompt, description, started, at) values ('Rosie', ?, ?, ?, ?, '2026-09-30T23:17:00.000Z')",
          [`t${index}`, index < 2 ? "Migrate Tezos." : null, index < 2 ? "the Tezos migration" : null, index < 2 ? 1 : 0],
        )
      }
    })
  })))
  expect(tables(path).version).toBe(2)
  const found = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* Store.make(path, Store.migrations.slice(0, 3))
    return yield* store.transaction(database => ({
      settings: database.query<{ name: string; value: string }, []>("select name, value from settings order by name").all(),
      threads: database.query<{ count: number }, []>("select count(*) as count from threads").get()?.count,
      started: database.query<{ description: string }, []>("select description from threads where started = 1 order by id").all(),
      journal: database.query<{ count: number }, []>("select count(*) as count from journal").get()?.count,
    }))
  })))
  expect(found).toEqual({
    settings: [{ name: "on", value: "false" }, { name: "persona", value: '{"style":"Jarvis"}' }],
    threads: 42,
    started: [{ description: "the Tezos migration" }, { description: "the Tezos migration" }],
    journal: 0,
  })
  expect(tables(path).version).toBe(3)
}))
