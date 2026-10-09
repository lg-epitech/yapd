import type { Database } from "bun:sqlite"
import { Clock, Context, Duration, Effect, Layer, Option } from "effect"
import * as Store from "./Store.ts"

// What yapd did to threads for the user, one row for each step it committed
// to, written before the step goes out. Each step's ids come from the request
// it belongs to and where it falls in it, so working it out again, acting on
// it again or restarting can't give it a second id, and T3 Code, which does a
// command once however often it's sent under the same id, does it once. It's
// a ledger, not an outbox: nothing in it is ever sent again on its own, and
// nothing waits in it to be sent.

/** What a step did. */
export type Kind = "message" | "stop" | "undo" | "decide" | "reply" | "start" | "tidy" | "relay"

/** Where a step got to: prepared before it goes out, then what came of it. */
export type State = "prepared" | "sent" | "refused" | "failed" | "unknown" | "abandoned"

/** How a message went in, as T3 Code said: at once, into the turn under way, or after it. */
export type How = "now" | "steered" | "queued"

/** A step, as the ledger keeps it. */
export interface Row {
  readonly commandId: string
  /** For messages and new work: the message's own id, which is how it's found in the thread. */
  readonly messageId: string | null
  readonly utterance: string
  readonly step: number
  readonly kind: Kind
  /** What the user calls the machine. */
  readonly machine: string
  /** The thread it's for, or the new one's id for new work. */
  readonly thread: string
  /** The command as it went out. */
  readonly body: unknown
  /** A message's words as compared for "I sent that a minute ago". */
  readonly digest: string | null
  readonly state: State
  readonly how: How | null
  readonly reason: string | null
  readonly at: number
}

/** A row as `prepare` gives it back, and whether this was the call that wrote it. */
export interface Prepared extends Row {
  /** Written just now, so this step has never gone out: nothing else may send it. */
  readonly fresh: boolean
}

/** The ids a step goes under, the same however often it's worked out: `yapd:<utterance>:<step>`, and its message's with `:m`. */
export const ids = (utterance: string, step: number, message: boolean) => ({
  commandId: `yapd:${utterance}:${step}`,
  messageId: message ? `yapd:${utterance}:${step}:m` : null,
})

/** A message's words as they're compared: case, punctuation and spacing aside. */
export const digest = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/** How the reason of a step that's never to be offered again on its own starts. */
const unoffered = "Not to be offered again"

/** The reason of a step that's never to be offered again on its own, for why, as `leave` notes it. */
export const leftBe = (why: string) => `${unoffered}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`

/** The reason of a message he took back while it was still in the queue, which never reached the thread. */
export const withdrawn = "Withdrawn."

/** Whether a step may still be offered to go again: it didn't get through, or may not have, and he hasn't been offered it, or taken it back, already. */
export const offerable = (row: Row) => (row.state === "failed" || row.state === "unknown") && !(row.reason ?? "").startsWith(unoffered)

/**
 * What came of noting what came of a step: noted; left as it is, since it's
 * no longer where `from` says, or as it was read; or not written, as yapd's
 * database couldn't be, which says nothing of where the step is.
 */
export type Noted = "noted" | "stale" | "unwritten"

/** Which rows `latest` looks at. */
export interface Filter {
  readonly kinds?: ReadonlyArray<Kind>
  readonly states?: ReadonlyArray<State>
  readonly machine?: string
  readonly thread?: string
}

/** The steps yapd committed to, each written before it goes out. */
export class Ledger extends Context.Tag("yapd/Ledger")<
  Ledger,
  {
    /** Writes the step's row before it goes out, or gives back the one already there for this step of this request (I1). */
    readonly prepare: (step: {
      readonly utterance: string
      readonly step: number
      readonly kind: Kind
      readonly machine: string
      readonly thread: string
      /** The command, given the step's ids. */
      readonly body: (ids: { readonly commandId: string; readonly messageId: string | null }) => unknown
      readonly message: boolean
      readonly digest?: string
    }) => Effect.Effect<Prepared, Store.StoreError>
    /**
     * Notes what came of a step, only while it's in one of `from` when that's
     * given, and only while it's still as `as` was read, in the same state for
     * the same reason, when that's given: what came of it since, like his no
     * to sending it again, which only changes its reason, stands. Whether it
     * was noted, left as it is for that, or not written, which is never taken
     * for that. Never fails: what can't be written is logged, and given back
     * as such.
     */
    readonly settle: (
      commandId: string,
      state: Exclude<State, "prepared">,
      details?: {
        readonly reason?: string
        readonly how?: How
        readonly from?: ReadonlyArray<State>
        readonly as?: Pick<Row, "state" | "reason">
      },
    ) => Effect.Effect<Noted>
    /**
     * Leaves a step that didn't get through, may not have, or never said what
     * came of it, as it is, but never to be offered again on its own, noting
     * why: the same words said again still find it, and it may still go once
     * more on his yes.
     */
    readonly leave: (commandId: string, why: string) => Effect.Effect<void>
    /**
     * Takes a step that didn't get through, or may not have, to send once
     * more on the user's yes, as it was before it was taken: none if it isn't
     * waiting for that, or was sent again already. It's given up on as it's
     * taken, so it's never taken twice, even if yapd stops before it's settled.
     */
    readonly resending: (commandId: string) => Effect.Effect<Option.Option<Row>>
    /**
     * Changes what a step goes out as, only while it never left yapd: T3 Code
     * never saw its ids, so nothing it holds under them can differ. Whether it
     * did: one that may have got there only ever goes as it first went.
     */
    readonly amend: (commandId: string, body: unknown) => Effect.Effect<boolean>
    /**
     * The latest message with these words to this thread since `at`, unless
     * it was turned down or withdrawn, neither of which reached it: one given
     * up on otherwise may still have got there.
     */
    readonly twin: (machine: string, thread: string, digest: string, since: number) => Effect.Effect<Option.Option<Row>>
    /** The latest step within this long, of those the filter lets through. */
    readonly latest: (within: Duration.DurationInput, filter?: Filter) => Effect.Effect<Option.Option<Row>>
    /** The steps since `at`, of those the filter lets through, oldest first. */
    readonly steps: (since: number, filter?: Filter) => Effect.Effect<ReadonlyArray<Row>>
    /** Steps since `at` that never said what came of them, or may not have got through, and haven't been left be, oldest first: what a restart checks. */
    readonly open: (since: number) => Effect.Effect<ReadonlyArray<Row>>
    readonly get: (commandId: string) => Effect.Effect<Option.Option<Row>>
    /** Forgets what's older than `before`. */
    readonly prune: (before: number) => Effect.Effect<void>
  }
>() {}

interface Stored {
  readonly command_id: string
  readonly message_id: string | null
  readonly utterance: string
  readonly step: number
  readonly kind: Kind
  readonly machine: string
  readonly thread: string
  readonly body: string
  readonly digest: string | null
  readonly state: State
  readonly how: How | null
  readonly reason: string | null
  readonly at: number
}

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

const row = (stored: Stored): Row => ({
  commandId: stored.command_id,
  messageId: stored.message_id,
  utterance: stored.utterance,
  step: stored.step,
  kind: stored.kind,
  machine: stored.machine,
  thread: stored.thread,
  body: parse(stored.body),
  digest: stored.digest,
  state: stored.state,
  how: stored.how,
  reason: stored.reason,
  at: stored.at,
})

const one = (database: Database, commandId: string) =>
  Option.map(Option.fromNullable(database.query<Stored, [string]>("select * from actions where command_id = ?").get(commandId)), row)

/** Where a step falls among those since `at` that the filter lets through, and what to ask that with. */
const among = (at: number, filter: Filter): readonly [string, Array<string | number>] => {
  const kinds = filter.kinds ?? []
  const states = filter.states ?? []
  const where = [
    "at >= ?",
    ...(kinds.length === 0 ? [] : [`kind in (${kinds.map(() => "?").join(", ")})`]),
    ...(states.length === 0 ? [] : [`state in (${states.map(() => "?").join(", ")})`]),
    ...(filter.machine === undefined ? [] : ["machine = ?"]),
    ...(filter.thread === undefined ? [] : ["thread = ?"]),
  ].join(" and ")
  return [
    where,
    [at, ...kinds, ...states, ...(filter.machine === undefined ? [] : [filter.machine]), ...(filter.thread === undefined ? [] : [filter.thread])],
  ]
}

/** What's read back, as nothing when it can't be: what reads it goes on as if there were none. */
const reading = <A>(effect: Effect.Effect<Option.Option<A>, Store.StoreError>) =>
  effect.pipe(Effect.catchAll((error) => Effect.logWarning("Could not read what I did to your threads", error).pipe(Effect.as(Option.none<A>()))))

/** The ledger, kept in yapd's database. */
export const fromStore = (store: Store.Store["Type"]): Ledger["Type"] => ({
  prepare: (step) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const { commandId, messageId } = ids(step.utterance, step.step, step.message)
      const body = JSON.stringify(step.body({ commandId, messageId }) ?? null)
      return yield* store.transaction((database: Database): Prepared => {
        const written = database
          .query(
            `insert into actions (command_id, message_id, utterance, step, kind, machine, thread, body, digest, state, at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?) on conflict (command_id) do nothing`,
          )
          .run(commandId, messageId, step.utterance, step.step, step.kind, step.machine, step.thread, body, step.digest ?? null, at).changes
        const kept = Option.getOrThrow(one(database, commandId))
        return { ...kept, fresh: written > 0 }
      })
    }),
  settle: (commandId, state, details = {}) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      store.transaction((database: Database): Noted => {
        const from = details.from ?? []
        const as = details.as === undefined ? [] : [details.as.state, details.as.reason]
        const { changes } = database
          .query(
            `update actions set state = ?, how = coalesce(?, how), reason = ?, settled_at = ? where command_id = ?${
              from.length === 0 ? "" : ` and state in (${from.map(() => "?").join(", ")})`
            }${as.length === 0 ? "" : " and state = ? and reason is ?"}`,
          )
          .run(state, details.how ?? null, details.reason ?? null, at, commandId, ...from, ...as)
        return changes > 0 ? "noted" : "stale"
      }),
    ).pipe(Effect.catchAll((error) => Effect.logWarning(`Could not note what came of ${commandId}`, error).pipe(Effect.as<Noted>("unwritten")))),
  leave: (commandId, why) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      store.transaction((database: Database) => {
        database
          .query("update actions set reason = ?, settled_at = ? where command_id = ? and state in ('prepared', 'failed', 'unknown')")
          .run(leftBe(why), at, commandId)
      }),
    ).pipe(Effect.catchAll((error) => Effect.logWarning(`Could not note that ${commandId} is left be`, error))),
  resending: (commandId) =>
    reading(
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        store.transaction((database: Database) => {
          // As it was, so it goes out again exactly as it did, and can be put back if it never leaves.
          const was = one(database, commandId)
          const taken = database
            .query(
              `update actions set state = 'abandoned', reason = 'Sending it again.', settled_at = ?
               where command_id = ? and state in ('prepared', 'failed', 'unknown')`,
            )
            .run(at, commandId).changes
          return taken === 0 ? Option.none<Row>() : was
        }),
      ),
    ),
  amend: (commandId, body) =>
    store
      .transaction(
        (database: Database) =>
          database.query("update actions set body = ? where command_id = ? and state = 'failed'").run(JSON.stringify(body ?? null), commandId).changes > 0,
      )
      .pipe(Effect.catchAll((error) => Effect.logWarning(`Could not change what ${commandId} goes as`, error).pipe(Effect.as(false)))),
  twin: (machine, thread, digest, since) =>
    reading(
      store.transaction((database: Database) =>
        Option.map(
          Option.fromNullable(
            database
              .query<Stored, [string, string, string, number, string]>(
                `select * from actions where kind = 'message' and machine = ? and thread = ? and digest = ? and at >= ?
                 and state != 'refused' and not (state = 'abandoned' and coalesce(reason, '') = ?) order by at desc limit 1`,
              )
              .get(machine, thread, digest, since, withdrawn),
          ),
          row,
        ),
      ),
    ),
  latest: (within, filter = {}) =>
    reading(
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.transaction((database: Database) => {
          const [where, values] = among(now - Duration.toMillis(Duration.decode(within)), filter)
          const found = database.query<Stored, Array<string | number>>(`select * from actions where ${where} order by at desc, step desc, rowid desc limit 1`).get(...values)
          return Option.map(Option.fromNullable(found), row)
        }),
      ),
    ),
  steps: (since, filter = {}) =>
    store
      .transaction((database: Database) => {
        const [where, values] = among(since, filter)
        return database.query<Stored, Array<string | number>>(`select * from actions where ${where} order by at, step, rowid`).all(...values).map(row)
      })
      .pipe(Effect.catchAll((error) => Effect.logWarning("Could not read what I did to your threads", error).pipe(Effect.as<ReadonlyArray<Row>>([])))),
  open: (since) =>
    store
      .transaction((database: Database) =>
        database
          .query<Stored, [number, string]>(
            "select * from actions where state in ('prepared', 'unknown') and at >= ? and coalesce(reason, '') not like ? order by at",
          )
          .all(since, `${unoffered}%`)
          .map(row),
      )
      .pipe(Effect.catchAll((error) => Effect.logWarning("Could not read what I did to your threads", error).pipe(Effect.as<ReadonlyArray<Row>>([])))),
  get: (commandId) => reading(store.transaction((database: Database) => one(database, commandId))),
  prune: (before) =>
    store
      .transaction((database: Database) => {
        database.query("delete from actions where at < ?").run(before)
      })
      .pipe(Effect.catchAll((error) => Effect.logWarning("Could not prune what I did to your threads", error))),
})

export const layer = Layer.effect(Ledger, Effect.map(Store.Store, fromStore))

/** A ledger of its own in memory, for tests. */
export const memory = Layer.scoped(Ledger, Effect.map(Store.make(":memory:"), fromStore)).pipe(Layer.orDie)
