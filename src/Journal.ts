import type { Database } from "bun:sqlite"
import { Context, Effect, Layer, Option } from "effect"
import * as Store from "./Store.ts"

// Everything yapd heard, said and did, kept in its database so it outlives a
// restart: what each update said, what the user answered or asked for, and
// what came of it. It's what yapd builds on when the user says "follow up on
// what the std agent just finished", or asks what they missed.

export type Kind =
  /** An agent finished a turn, and yapd summed it up. */
  | "update"
  /** The user said something back to an update or a question, and yapd answered. */
  | "reply"
  /** A message went to an agent on the user's behalf, or failed to. */
  | "sent"
  /** The user dictated something. */
  | "dictation"
  /** yapd started work. */
  | "started"
  /** yapd did something else for the user, like stopping a thread. */
  | "action"
  /** yapd brought something up itself, like a thread waiting on the user. */
  | "notice"

export interface Entry {
  readonly at: number
  readonly kind: Kind
  /** The machine it happened on, by the hostname its hooks report. */
  readonly machine?: string | undefined
  readonly project?: string | undefined
  /** The thread or session it's about. */
  readonly thread?: string | undefined
  readonly directory?: string | undefined
  /** What yapd said about it. */
  readonly said?: string | undefined
  /** The words it's about: the agent's message, the user's, or a prompt. */
  readonly text?: string | undefined
  /** The request of the user's it belongs to. */
  readonly utterance?: string | undefined
  /** Set on what must only ever be said once, like a thread's question. */
  readonly key?: string | undefined
  /** When the user heard it through, answered it or was briefed on it. */
  readonly heardAt?: number | undefined
  /** Anything else worth keeping, as JSON. */
  readonly detail?: unknown
}

export interface Kept extends Entry {
  readonly id: number
}

export class Journal extends Context.Tag("yapd/Journal")<
  Journal,
  {
    /** Keeps an entry. Never fails: what can't be kept is only logged. */
    readonly write: (entry: Entry) => Effect.Effect<void>
    /** Entries since `at`, oldest first, the latest `most` of them when there are more. */
    readonly since: (at: number, options?: { readonly most?: number; readonly kinds?: ReadonlyArray<Kind> }) => Effect.Effect<ReadonlyArray<Kept>>
  }
>() {}

interface Row {
  readonly id: number
  readonly at: number
  readonly kind: Kind
  readonly machine: string | null
  readonly project: string | null
  readonly thread: string | null
  readonly directory: string | null
  readonly said: string | null
  readonly text: string | null
  readonly utterance: string | null
  readonly key: string | null
  readonly heard_at: number | null
  readonly detail: string | null
}

const parse = (detail: string | null) => {
  if (detail === null) return undefined
  try {
    return JSON.parse(detail) as unknown
  } catch {
    return undefined
  }
}

const kept = (row: Row): Kept => ({
  id: row.id,
  at: row.at,
  kind: row.kind,
  ...(row.machine === null ? {} : { machine: row.machine }),
  ...(row.project === null ? {} : { project: row.project }),
  ...(row.thread === null ? {} : { thread: row.thread }),
  ...(row.directory === null ? {} : { directory: row.directory }),
  ...(row.said === null ? {} : { said: row.said }),
  ...(row.text === null ? {} : { text: row.text }),
  ...(row.utterance === null ? {} : { utterance: row.utterance }),
  ...(row.key === null ? {} : { key: row.key }),
  ...(row.heard_at === null ? {} : { heardAt: row.heard_at }),
  ...Option.match(Option.fromNullable(parse(row.detail)), { onNone: () => ({}), onSome: (detail) => ({ detail }) }),
})

/** How much of any one text is kept: an agent's message can run to pages, and only its gist is ever read back. */
const longest = 4000

const clip = (text: string | undefined) => (text === undefined ? null : text.length <= longest ? text : `${text.slice(0, longest - 1)}…`)

export const fromStore = (store: Store.Store["Type"]): Journal["Type"] => ({
  write: (entry) =>
    store
      .transaction((database: Database) => {
        database
          .query(
            "insert into journal (at, kind, machine, project, thread, directory, said, text, utterance, key, heard_at, detail) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            entry.at,
            entry.kind,
            entry.machine ?? null,
            entry.project ?? null,
            entry.thread ?? null,
            entry.directory ?? null,
            clip(entry.said),
            clip(entry.text),
            entry.utterance ?? null,
            entry.key ?? null,
            entry.heardAt ?? null,
            entry.detail === undefined ? null : JSON.stringify(entry.detail),
          )
      })
      .pipe(Effect.catchAll((error) => Effect.logWarning("Could not keep this in my journal", error))),
  since: (at, options = {}) =>
    store
      .transaction((database: Database) => {
        const kinds = options.kinds ?? []
        const filter = kinds.length === 0 ? "" : ` and kind in (${kinds.map(() => "?").join(", ")})`
        const rows = database
          .query<Row, Array<string | number>>(`select * from journal where at >= ?${filter} order by at desc, id desc limit ?`)
          .all(at, ...kinds, options.most ?? 200)
        return rows.reverse().map(kept)
      })
      .pipe(
        Effect.catchAll((error) => Effect.logWarning("Could not read my journal", error).pipe(Effect.as<ReadonlyArray<Kept>>([]))),
      ),
})

export const layer = Layer.effect(Journal, Effect.map(Store.Store, fromStore))

/** A journal of its own in memory, for tests. */
export const memory = Layer.scoped(Journal, Effect.map(Store.make(":memory:"), fromStore)).pipe(Layer.orDie)
