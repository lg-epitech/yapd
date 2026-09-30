import { Effect } from "effect"
import * as Store from "./Store.ts"
import type { Known } from "./Threads.ts"

// What yapd keeps about threads themselves: what the work is, in full, so it
// knows a thread by what the user says about it. It only ever grows, and what
// was learnt first stands: the message a thread started from never changes,
// and the dictation and description are only known when it starts. So a
// record fills in what's missing and never replaces anything.

export interface Records {
  /**
   * Keeps `known`, filling in what's stored: a field already stored keeps its
   * first value, a thread yapd started stays one it started, and the first
   * time it was known stands.
   */
  readonly remember: (known: Known) => Effect.Effect<void, Store.StoreError>
  /** What's kept about the threads with these ids on `machine`, by id. */
  readonly recall: (machine: string, ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, Known>, Store.StoreError>
}

interface Row {
  readonly machine: string
  readonly id: string
  readonly prompt: string | null
  readonly dictated: string | null
  readonly description: string | null
  readonly started: number
  readonly at: string
}

const known = (row: Row): Known => ({
  machine: row.machine,
  id: row.id,
  prompt: row.prompt,
  dictated: row.dictated,
  description: row.description,
  started: row.started === 1,
  at: row.at,
})

export const make: Effect.Effect<Records, never, Store.Store> = Effect.map(
  Store.Store,
  (store): Records => ({
    remember: (thread) =>
      store.transaction((database) => {
        // On the right of SET, a plain column is the stored row and `excluded` is the new one: what's stored comes first.
        database
          .query<void, [string, string, string | null, string | null, string | null, number, string]>(
            `insert into threads (machine, id, prompt, dictated, description, started, at) values (?, ?, ?, ?, ?, ?, ?)
            on conflict (machine, id) do update set
              prompt = coalesce(prompt, excluded.prompt),
              dictated = coalesce(dictated, excluded.dictated),
              description = coalesce(description, excluded.description),
              started = max(started, excluded.started)`,
          )
          .run(thread.machine, thread.id, thread.prompt, thread.dictated, thread.description, thread.started ? 1 : 0, thread.at)
      }),
    recall: (machine, ids) =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : store.transaction((database) => {
            const rows = database
              .query<Row, string[]>(
                `select machine, id, prompt, dictated, description, started, at from threads
                where machine = ? and id in (${ids.map(() => "?").join(", ")})`,
              )
              .all(machine, ...ids)
            return new Map(rows.map((row) => [row.id, known(row)]))
          }),
  }),
)
