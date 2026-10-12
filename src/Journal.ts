import type { Database } from "bun:sqlite"
import { Clock, Context, Effect, Layer, Option, PubSub, Stream } from "effect"
import { hostname } from "node:os"
import * as Config from "./Config.ts"
import * as Store from "./Store.ts"

// Everything yapd heard, said and did, kept in its database so it outlives a
// restart: what each update said, what the user answered or asked for, and
// what came of it. It's what yapd builds on when the user says "follow up on
// what the std agent just finished", or asks what they missed.

export type Kind =
  /** An agent finished a turn, and yapd summed it up. */
  | "update"
  /** The user said something back to an update, a question or an answer, and yapd answered. */
  | "reply"
  /** A message went to an agent on the user's behalf, or failed to. */
  | "sent"
  /** The user dictated something, or typed it to yapd. */
  | "dictation"
  /** yapd started work. */
  | "started"
  /** yapd did something else for the user, like stopping a thread or dropping a question. */
  | "action"
  /** yapd brought something up itself, like a thread waiting on the user. */
  | "notice"
  /** yapd answered something the user asked it. */
  | "answer"
  /** yapd briefed him on what it held for later, in a digest of its own accord. */
  | "brief"

/** Every kind of entry, as the API takes them. */
export const kinds = ["update", "reply", "sent", "dictation", "started", "action", "notice", "answer", "brief"] as const satisfies ReadonlyArray<Kind>

/**
 * Why an update was held for later rather than said: focus or quiet was on,
 * it only said how work that carries on was going, or it finished while yapd
 * was offline.
 */
export type Held = "focus" | "quiet" | "progress" | "offline"

export interface Entry {
  readonly at: number
  readonly kind: Kind
  /** What the user calls the machine it happened on, like "Rosie" or "rig". */
  readonly machine?: string | undefined
  /** The hostname its hooks report, when that's all there is: it's kept in `detail`, and the machine named from it. */
  readonly host?: string | undefined
  readonly project?: string | undefined
  /** The thread or session it's about: T3 Code's id when known. */
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

export interface Kept extends Omit<Entry, "host"> {
  readonly id: number
}

export class Journal extends Context.Tag("yapd/Journal")<
  Journal,
  {
    /** Keeps an entry and gives back its id. Never fails: what can't be kept is only logged, and has none. */
    readonly write: (entry: Entry) => Effect.Effect<Option.Option<number>>
    /**
     * Keeps an entry under its key unless one was ever kept under it, so what's
     * said once is said once across restarts: none when one was, otherwise the
     * new entry's id, when the journal could keep it, to note when it's heard.
     */
    readonly claim: (entry: Entry & { readonly key: string }) => Effect.Effect<Option.Option<Option.Option<number>>>
    /** Notes that the user heard these through, answered them or was briefed on them, unless they had already. */
    readonly markHeard: (ids: ReadonlyArray<number>, at: number) => Effect.Effect<void>
    /** Notes that the user is still to hear these, like a question put by to be asked again, whatever they heard of them before. */
    readonly markUnheard: (ids: ReadonlyArray<number>) => Effect.Effect<void>
    /** Notes that what was said for an entry was these words in the end, like a line played without "it's on your screen". */
    readonly reword: (id: number, said: string) => Effect.Effect<void>
    /**
     * Entries since `at`, oldest first, the latest `most` of them when there
     * are more: with `muted`, only those kept quiet because he muted their
     * thread, or only the others.
     */
    readonly since: (
      at: number,
      options?: { readonly most?: number; readonly kinds?: ReadonlyArray<Kind>; readonly muted?: boolean; readonly held?: boolean },
    ) => Effect.Effect<ReadonlyArray<Kept>>
    /** A page of entries, newest written first: `most` of them, only older than the entry `before` and of `kinds` when given. */
    readonly page: (options: { readonly most: number; readonly before?: number; readonly kinds?: ReadonlyArray<Kind> }) => Effect.Effect<ReadonlyArray<Kept>>
    /** The latest entries about a thread, newest first. */
    readonly byThread: (machine: string, thread: string, most: number) => Effect.Effect<ReadonlyArray<Kept>>
    /**
     * Updates and notices since `at` the user hasn't heard, oldest first, the
     * latest `most` of them: with `muted`, only those kept quiet because he
     * muted their thread, or only the others; with `held`, only those held
     * for later, or only the others.
     */
    readonly unheard: (at: number, most: number, muted?: boolean, held?: boolean) => Effect.Effect<ReadonlyArray<Kept>>
    /** Each thread's newest update or notice since `at`, newest first, `most` threads at most. */
    readonly latest: (at: number, most: number) => Effect.Effect<ReadonlyArray<Kept>>
    /** Notes that these were kept quiet because he muted their thread, like updates dropped as he did. */
    readonly mute: (ids: ReadonlyArray<number>) => Effect.Effect<void>
    /** Notes that these were held for later, and why, like updates dropped as focus began, and when they were. */
    readonly hold: (ids: ReadonlyArray<number>, why: Held) => Effect.Effect<void>
    /**
     * The updates held for later since `at` that he hasn't heard, and that
     * aren't muted, oldest first, the latest `most` of them. One that came
     * before `at`, but was only held since, like one waiting to be said as
     * focus began, counts as held since.
     */
    readonly held: (at: number, most?: number) => Effect.Effect<ReadonlyArray<Kept>>
    /**
     * What yapd last said, or held, about the same work since `at`: the newest
     * update kept under the session, tied to it, or kept under the thread.
     */
    readonly previous: (at: number, session: string, ref?: { readonly machine: string; readonly id: string }) => Effect.Effect<Option.Option<Kept>>
    /**
     * Something newer about the same work was kept as said, the entry
     * `newer`: what was held as progress of it before, by the same match as
     * `previous`, is out of date, so it's noted as dealt with at `at`, never
     * to come up in a digest after he heard how the work went.
     */
    readonly outdated: (newer: number, session: string, ref: { readonly machine: string; readonly id: string } | undefined, at: number) => Effect.Effect<void>
    /**
     * The updates he heard, newest kept first, `most` of them: never one kept
     * quiet or held for later, which he never heard said, however many of
     * those came since.
     */
    readonly heard: (most: number) => Effect.Effect<ReadonlyArray<Kept>>
    /** Each update and notice as it's kept. */
    readonly kept: Stream.Stream<Kept>
    /** The latest thing the user heard. */
    readonly lastHeard: Effect.Effect<Option.Option<Kept>>
    /** Forgets what's older than `before`. */
    readonly prune: (before: number) => Effect.Effect<void>
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

/** A machine reported only by its hostname, named the way the user calls it. */
export type Naming = (host: string) => string

/** What the user calls each machine: this one by `YAPD_NAME`, others as `YAPD_REMOTES` names them, else the hostname without its domain. */
export const naming = Effect.gen(function* () {
  const own = Option.getOrUndefined(yield* Config.name)
  const remotes = yield* Config.remotes
  return (host: string): string => {
    const short = host.split(".")[0] ?? host
    // Read each time, since a Mac's hostname changes with the network.
    if (host.toLowerCase() === hostname().toLowerCase()) return own ?? short
    return remotes.has(host.toLowerCase()) ? host.toLowerCase() : short
  }
})

const values = (entry: Entry, called: Naming) => {
  const machine = entry.machine ?? (entry.host === undefined ? undefined : called(entry.host))
  const detail =
    entry.host === undefined
      ? entry.detail
      : { ...(typeof entry.detail === "object" && entry.detail !== null ? entry.detail : {}), host: entry.host }
  return [
    entry.at,
    entry.kind,
    machine ?? null,
    entry.project ?? null,
    entry.thread ?? null,
    entry.directory ?? null,
    clip(entry.said),
    clip(entry.text),
    entry.utterance ?? null,
    entry.key ?? null,
    entry.heardAt ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  ] as const
}

const columns = "(at, kind, machine, project, thread, directory, said, text, utterance, key, heard_at, detail) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

/** What's read back, as an empty list when it can't be, since nothing that reads it should stop for that. */
const reading = <A>(effect: Effect.Effect<ReadonlyArray<A>, Store.StoreError>) =>
  effect.pipe(Effect.catchAll((error) => Effect.logWarning("Could not read my journal", error).pipe(Effect.as<ReadonlyArray<A>>([]))))

/** What's told of as it's kept: updates and notices, which are what a thread's latest is. */
const told: ReadonlySet<Kind> = new Set<Kind>(["update", "notice"])

/** Whether a row was kept quiet because he muted its thread, as SQLite reads its detail. */
const quiet = "coalesce(json_extract(detail, '$.muted'), 0)"

/** Whether a row was held for later, as SQLite reads its detail. */
const heldBack = "(json_extract(detail, '$.held') is not null)"

/**
 * The journal in `store`, naming machines by `called`, and telling `written`
 * of each update and notice as it's kept, when there's one to tell.
 */
export const fromStore = (
  store: Store.Store["Type"],
  called: Naming = (host) => host.split(".")[0] ?? host,
  written?: PubSub.PubSub<Kept>,
): Journal["Type"] => {
  /** The row just kept, as it reads back, for whoever follows what's kept. */
  const reread = (database: Database, id: number, entry: Entry) => {
    if (written === undefined || !told.has(entry.kind)) return undefined
    const row = database.query<Row, [number]>("select * from journal where id = ?").get(id)
    return row === null ? undefined : kept(row)
  }
  const tell = (row: Kept | undefined) => (row === undefined || written === undefined ? Effect.void : PubSub.publish(written, row))
  return {
    write: (entry) =>
      store
        .transaction((database: Database) => {
          const id = Number(database.query(`insert into journal ${columns}`).run(...values(entry, called)).lastInsertRowid)
          return { id, row: reread(database, id, entry) }
        })
        .pipe(
          Effect.tap(({ row }) => tell(row)),
          Effect.map(({ id }) => Option.some(id)),
          Effect.catchAll((error) => Effect.logWarning("Could not keep this in my journal", error).pipe(Effect.as(Option.none<number>()))),
        ),
    claim: (entry) =>
      store
        .transaction((database: Database) => {
          const inserted = database.query(`insert or ignore into journal ${columns}`).run(...values(entry, called))
          if (inserted.changes === 0) return { claimed: Option.none<Option.Option<number>>(), row: undefined }
          const id = Number(inserted.lastInsertRowid)
          return { claimed: Option.some(Option.some(id)), row: reread(database, id, entry) }
        })
        .pipe(
          Effect.tap(({ row }) => tell(row)),
          Effect.map(({ claimed }) => claimed),
          // Said twice is better than never said, when the journal can't tell.
          Effect.catchAll((error) =>
            Effect.logWarning("Could not check my journal for what I've said", error).pipe(Effect.as(Option.some(Option.none<number>()))),
          ),
        ),
    markHeard: (ids, at) =>
      ids.length === 0
        ? Effect.void
        : store
            .transaction((database: Database) => {
              database
                .query<never, Array<number>>(`update journal set heard_at = ? where heard_at is null and id in (${ids.map(() => "?").join(", ")})`)
                .run(at, ...ids)
            })
            .pipe(Effect.catchAll((error) => Effect.logWarning("Could not note what you heard in my journal", error))),
    markUnheard: (ids) =>
      ids.length === 0
        ? Effect.void
        : store
            .transaction((database: Database) => {
              database.query<never, Array<number>>(`update journal set heard_at = null where id in (${ids.map(() => "?").join(", ")})`).run(...ids)
            })
            .pipe(Effect.catchAll((error) => Effect.logWarning("Could not note what you've still to hear in my journal", error))),
    reword: (id, said) =>
      store
        .transaction((database: Database) => {
          database.query<never, [string, number]>("update journal set said = ? where id = ?").run(said, id)
        })
        .pipe(Effect.catchAll((error) => Effect.logWarning("Could not note what I said in my journal", error))),
    since: (at, options = {}) =>
      reading(
        store.transaction((database: Database) => {
          const kinds = options.kinds ?? []
          const { muted, held } = options
          const filter = `${kinds.length === 0 ? "" : ` and kind in (${kinds.map(() => "?").join(", ")})`}${muted === undefined ? "" : ` and ${quiet} = ?`}${
            held === undefined ? "" : ` and ${heldBack} = ${held ? 1 : 0}`
          }`
          const rows = database
            .query<Row, Array<string | number>>(`select * from journal where at >= ?${filter} order by at desc, id desc limit ?`)
            .all(at, ...kinds, ...(muted === undefined ? [] : [muted ? 1 : 0]), options.most ?? 200)
          return rows.reverse().map(kept)
        }),
      ),
    page: ({ most, before = Number.MAX_SAFE_INTEGER, kinds = [] }) =>
      reading(
        store.transaction((database: Database) => {
          const filter = kinds.length === 0 ? "" : ` and kind in (${kinds.map(() => "?").join(", ")})`
          // By id, which only grows, so a page picks up where the last one left off whenever what it's about happened.
          return database
            .query<Row, Array<string | number>>(`select * from journal where id < ?${filter} order by id desc limit ?`)
            .all(before, ...kinds, most)
            .map(kept)
        }),
      ),
    byThread: (machine, thread, most) =>
      reading(
        store.transaction((database: Database) =>
          database
            .query<Row, [string, string, number]>("select * from journal where machine = ? and thread = ? order by at desc, id desc limit ?")
            .all(machine, thread, most)
            .map(kept),
        ),
      ),
    unheard: (at, most, muted, held) =>
      reading(
        store.transaction((database: Database) =>
          database
            .query<Row, Array<number>>(
              `select * from journal where heard_at is null and kind in ('update', 'notice') and at >= ?${muted === undefined ? "" : ` and ${quiet} = ?`}${
                held === undefined ? "" : ` and ${heldBack} = ${held ? 1 : 0}`
              } order by at desc, id desc limit ?`,
            )
            .all(at, ...(muted === undefined ? [] : [muted ? 1 : 0]), most)
            .reverse()
            .map(kept),
        ),
      ),
    latest: (at, most) =>
      reading(
        store.transaction((database: Database) =>
          database
            // By when each happened, not when it was kept: an update summed up slowly can be kept after a newer notice.
            .query<Row, [number, number]>(
              `select * from (
                 select *, row_number() over (partition by machine, thread order by at desc, id desc) as rank
                 from journal where kind in ('update', 'notice') and thread is not null and at >= ?
               ) where rank = 1 order by at desc, id desc limit ?`,
            )
            .all(at, most)
            .map(kept),
        ),
      ),
    mute: (ids) =>
      ids.length === 0
        ? Effect.void
        : store
            .transaction((database: Database) => {
              database
                .query<never, Array<number>>(
                  `update journal set detail = json_set(coalesce(detail, '{}'), '$.muted', json('true')) where id in (${ids.map(() => "?").join(", ")})`,
                )
                .run(...ids)
            })
            .pipe(Effect.catchAll((error) => Effect.logWarning("Could not note what I kept quiet in my journal", error))),
    hold: (ids, why) =>
      ids.length === 0
        ? Effect.void
        : Effect.flatMap(Clock.currentTimeMillis, (now) =>
            store.transaction((database: Database) => {
              database
                .query<never, Array<string | number>>(
                  `update journal set detail = json_set(coalesce(detail, '{}'), '$.held', ?, '$.heldAt', ?) where id in (${ids.map(() => "?").join(", ")})`,
                )
                .run(why, now, ...ids)
            }),
          ).pipe(Effect.catchAll((error) => Effect.logWarning("Could not note what I held for later in my journal", error))),
    held: (at, most = 200) =>
      reading(
        store.transaction((database: Database) =>
          database
            .query<Row, [number, number]>(
              `select * from journal where kind = 'update' and heard_at is null and ${heldBack} and ${quiet} = 0 and max(at, coalesce(json_extract(detail, '$.heldAt'), at)) >= ?
               order by at desc, id desc limit ?`,
            )
            .all(at, most)
            .reverse()
            .map(kept),
        ),
      ),
    previous: (at, session, ref) =>
      store
        .transaction((database: Database) =>
          Option.map(
            Option.fromNullable(
              database
                .query<Row, [number, string, string, string | null, string | null]>(
                  `select * from journal where kind = 'update' and at >= ? and (thread = ? or json_extract(detail, '$.session') = ? or (machine = ? and thread = ?))
                   order by at desc, id desc limit 1`,
                )
                .get(at, session, session, ref?.machine ?? null, ref?.id ?? null),
            ),
            kept,
          ),
        )
        .pipe(Effect.catchAll((error) => Effect.logWarning("Could not read my journal", error).pipe(Effect.as(Option.none<Kept>())))),
    outdated: (newer, session, ref, at) =>
      store
        .transaction((database: Database) => {
          database
            .query<never, [number, number, string, string, string | null, string | null]>(
              `update journal set heard_at = ? where kind = 'update' and heard_at is null and id < ? and json_extract(detail, '$.held') = 'progress'
               and (thread = ? or json_extract(detail, '$.session') = ? or (machine = ? and thread = ?))`,
            )
            .run(at, newer, session, session, ref?.machine ?? null, ref?.id ?? null)
        })
        .pipe(Effect.catchAll((error) => Effect.logWarning("Could not note what's out of date in my journal", error))),
    heard: (most) =>
      reading(
        store.transaction((database: Database) =>
          database
            .query<Row, [number]>(`select * from journal where kind = 'update' and heard_at is not null and ${quiet} = 0 and not ${heldBack} order by id desc limit ?`)
            .all(most)
            .map(kept),
        ),
      ),
    kept: written === undefined ? Stream.never : Stream.fromPubSub(written),
    lastHeard: store
      .transaction((database: Database) =>
        Option.map(
          Option.fromNullable(
            database.query<Row, []>("select * from journal where heard_at is not null order by heard_at desc, id desc limit 1").get(),
          ),
          kept,
        ),
      )
      .pipe(Effect.catchAll((error) => Effect.logWarning("Could not read my journal", error).pipe(Effect.as(Option.none<Kept>())))),
    prune: (before) =>
      store
        .transaction((database: Database) => {
          database.query("delete from journal where at < ?").run(before)
        })
        .pipe(Effect.catchAll((error) => Effect.logWarning("Could not prune my journal", error))),
  }
}

export const layer = Layer.effect(
  Journal,
  Effect.gen(function* () {
    return fromStore(yield* Store.Store, yield* naming, yield* PubSub.unbounded<Kept>())
  }),
)

/** A journal of its own in memory, for tests. */
export const memory = Layer.scoped(
  Journal,
  Effect.gen(function* () {
    return fromStore(yield* Store.make(":memory:"), undefined, yield* PubSub.unbounded<Kept>())
  }),
).pipe(Layer.orDie)
