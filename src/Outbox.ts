import { Clock, Duration, Effect, Option, Queue, type Scope } from "effect"
import type { Notice } from "./Inbox.ts"
import type { Heard } from "./Recent.ts"
import { plain } from "./Relay.ts"
import * as Store from "./Store.ts"
import { type Listed, type Outgoing, type Threads, ThreadsError } from "./Threads.ts"

// Every message for a thread goes through here. One the thread can't take,
// because it's in the middle of a turn, is held in the database and passed
// on when the turn ends, and the user is told when it was. A message's ids
// are chosen and kept before the first try, and T3 Code answers a command it
// has already taken with what it did then, so a try after a crash can't
// deliver it twice. A try that ends without saying whether it went, like a
// machine that stopped answering, leaves the message held for the same reason.

export interface Options {
  /** What the user calls this machine, read each time since it can change with the network. It isn't named when the recipient is on it. */
  readonly here: () => string
  /** The threads on a machine, when it's one yapd reaches. */
  readonly threads: (machine: string) => Option.Option<Threads>
  readonly tell: (notice: Notice) => Effect.Effect<void>
  /** Notes what's about to be told, so "tell it to" right after can mean the thread it was about. */
  readonly note: (heard: Heard) => Effect.Effect<void>
  /** Says what's about to be sent, before every try, so the answer to it is heard however quick the turn. */
  readonly expect?: (text: string) => Effect.Effect<void>
  /** How long between tries at a held message, to start with. Each try that leaves it held doubles the wait, up to a minute. */
  readonly every?: Duration.DurationInput
  /** How long a message is held before it's given up on. */
  readonly patience?: Duration.DurationInput
}

/**
 * How a send went. "Sent" went. "Held" is kept for when the thread is out of
 * its turn, or behind an older message for it. "Pending" is kept too, because
 * the try ended without saying whether it went: it's tried again with the same
 * ids, which T3 Code tells apart from a new message.
 */
export type Delivery = { readonly _tag: "Sent" } | { readonly _tag: "Held" } | { readonly _tag: "Pending"; readonly reason: string }

export interface Outbox {
  /**
   * Sends `text` to `thread` as if the user typed it. Fails only when it's
   * sure nothing went and trying later won't help: the thread is gone or
   * waiting on the user in T3 Code, the machine isn't one yapd reaches, or
   * there's nothing to send.
   */
  readonly send: (machine: string, thread: Listed, text: string) => Effect.Effect<Delivery, ThreadsError | Store.StoreError>
}

interface Row {
  readonly command_id: string
  readonly message_id: string
  readonly machine: string
  readonly thread: string
  readonly title: string
  readonly project: string
  readonly directory: string
  readonly text: string
  /** Why it's still held, as of the last try. */
  readonly reason: string | null
  readonly created_at: string
}

const columns = "command_id, message_id, machine, thread, title, project, directory, text, reason, created_at"

const stamp = (millis: number) => new Date(millis).toISOString()

const outgoing = (row: Row): Outgoing => ({ commandId: row.command_id, messageId: row.message_id, text: row.text })

/** What the user is told when a thread has stopped on something only they can settle. */
export const waiting = "It's waiting on an approval or an answer from you in T3 Code, which I can't give. Answer it there, then say it again."

/** The longest wait between tries at one message, once it has been held a while. */
const longest = Duration.toMillis(Duration.seconds(60))

export const make = (options: Options): Effect.Effect<Outbox, never, Store.Store | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store.Store
    const every = Duration.toMillis(Duration.decode(options.every ?? "5 seconds"))
    const patience = Duration.toMillis(Duration.decode(options.patience ?? "24 hours"))
    /**
     * One try at a time per thread, whether from a dictation or the watcher,
     * so a message is never in flight twice and only one of them says how it
     * went. Per thread rather than for all, so a send here never waits behind
     * a machine that's slow to answer.
     */
    const flying = new Map<string, Effect.Semaphore>()
    const oneAtATime = <A, E, R>(machine: string, thread: string, effect: Effect.Effect<A, E, R>) => {
      const key = `${machine}\n${thread}`
      let semaphore = flying.get(key)
      if (semaphore === undefined) {
        semaphore = Effect.unsafeMakeSemaphore(1)
        flying.set(key, semaphore)
      }
      return semaphore.withPermits(1)(effect)
    }
    /** When each held message is next tried, and how long the wait after that is, by command id. Nothing for one not tried yet. */
    const later = new Map<string, { readonly next: number; readonly wait: number }>()
    /** Poked when something is held, so the watcher only runs while there's something to pass on. */
    const wake = yield* Queue.sliding<void>(1)

    /** Said just before each try, so it's there before the thread's hooks can report the prompt. */
    const expect = (text: string) => options.expect?.(text) ?? Effect.void

    const reach = (machine: string) =>
      Option.match(options.threads(machine), {
        onNone: () => Effect.fail(new ThreadsError({ reason: `I don't know how to reach ${machine}.` })),
        onSome: Effect.succeed,
      })

    const sent = (commandId: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.transaction((database) => {
          database
            .query<void, [string, string]>("update messages set state = 'sent', sent_at = ?, reason = null where command_id = ? and state = 'held'")
            .run(stamp(now), commandId)
          later.delete(commandId)
        }),
      )

    const failed = (commandId: string, reason: string) =>
      store.transaction((database) => {
        database
          .query<void, [string, string]>("update messages set state = 'failed', reason = ? where command_id = ? and state = 'held'")
          .run(reason, commandId)
        later.delete(commandId)
      })

    /** Keeps the row held with why, and puts off the next try: a little longer each time, so a thread or machine that stays out isn't hammered. */
    const stillHeld = (commandId: string, reason: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.transaction((database) => {
          database.query<void, [string, string]>("update messages set reason = ? where command_id = ? and state = 'held'").run(reason, commandId)
          const had = later.get(commandId)
          const wait = Math.min(had === undefined ? every : had.wait * 2, Math.max(every, longest))
          later.set(commandId, { next: now + wait, wait })
        }),
      )

    const recipient = (row: Row) => `${row.title}${row.project === "" ? "" : ` in ${row.project}`}${row.machine === options.here() ? "" : ` on ${row.machine}`}`

    /**
     * Tells the user what became of a message, noted first under the same id
     * with the thread it was for: once it plays, it's the latest thing they
     * heard, and "tell it to" means that thread and not whatever played before.
     */
    const notice = (row: Row, priority: Notice["priority"], spoken: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const id = `outbox:${row.command_id}`
        yield* options.note({
          id,
          project: row.project,
          directory: row.directory,
          spoken,
          message: row.text,
          thread: { machine: row.machine, id: row.thread },
          at,
        })
        yield* options.tell({ id, priority, spoken, at, stale: Effect.succeed(false) })
      })

    /** One more try at a held row, when one is due. Whether it's still held after. */
    const retry = (row: Row) =>
      Effect.gen(function* () {
        // Sent since it was listed, by a dictation that beat this pass to it, or tried by one just now.
        const state = yield* store.transaction((database) =>
          database.query<{ state: string }, [string]>("select state from messages where command_id = ?").get(row.command_id)?.state,
        )
        if (state !== "held") return false
        const now = yield* Clock.currentTimeMillis
        if ((later.get(row.command_id)?.next ?? now) > now) return true
        if (now - Date.parse(row.created_at) >= patience) {
          yield* failed(row.command_id, "Held for a day, then dropped.")
          yield* notice(row, "needs-you", `I dropped your message for ${recipient(row)}: it's been held for a day. ${row.reason ?? ""}`.trim())
          return false
        }
        const result = yield* Effect.either(Effect.flatMap(reach(row.machine), (threads) => Effect.zipRight(expect(row.text), threads.send(row.thread, outgoing(row)))))
        if (result._tag === "Right") {
          if (result.right === "busy") {
            yield* stillHeld(row.command_id, "It was still in the middle of a turn.")
            return true
          }
          if (result.right === "waiting") {
            yield* failed(row.command_id, waiting)
            yield* notice(row, "needs-you", `I couldn't pass your message on to ${recipient(row)}. ${waiting}`)
            return false
          }
          yield* sent(row.command_id)
          yield* notice(row, "done", `Passed your message on to ${recipient(row)} now that it finished.`)
          return false
        }
        if (result.left.gone) {
          yield* failed(row.command_id, result.left.reason)
          yield* notice(row, "needs-you", `I couldn't pass your message on to ${recipient(row)}. ${result.left.reason}`)
          return false
        }
        // The machine or T3 Code may be back later.
        yield* stillHeld(row.command_id, result.left.reason)
        return true
      })

    /**
     * A try at the oldest held message of each thread that's due one, so
     * several go one turn at a time, machine by machine at once so one that's
     * slow holds up no other. When the next try is due, if anything is held.
     */
    const pass = Effect.gen(function* () {
      const rows = yield* store.transaction((database) =>
        database.query<Row, []>(`select ${columns} from messages where state = 'held' order by created_at`).all(),
      )
      const oldest = new Map<string, Row>()
      for (const row of rows) {
        const key = `${row.machine}\n${row.thread}`
        if (!oldest.has(key)) oldest.set(key, row)
      }
      const byMachine = Map.groupBy(oldest.values(), (row) => row.machine)
      yield* Effect.forEach(
        byMachine.values(),
        (rows) => Effect.forEach(rows, (row) => oneAtATime(row.machine, row.thread, retry(row)), { discard: true }),
        { concurrency: "unbounded", discard: true },
      )
      const held = yield* store.transaction((database) =>
        database.query<{ command_id: string }, []>("select command_id from messages where state = 'held'").all(),
      )
      const now = yield* Clock.currentTimeMillis
      // One not tried yet, like the next behind one that just went, is due at the usual pace.
      return held.length === 0 ? Option.none() : Option.some(Math.min(...held.map(({ command_id }) => later.get(command_id)?.next ?? now + every)))
    })

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const due = yield* pass.pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError("Couldn't go through the held messages.", cause).pipe(Effect.zipRight(Effect.map(Clock.currentTimeMillis, (now) => Option.some(now + every)))),
            ),
          )
          if (Option.isNone(due)) return yield* Queue.take(wake)
          const now = yield* Clock.currentTimeMillis
          // A new message held meanwhile is worth a pass sooner.
          yield* Effect.race(Effect.sleep(Duration.millis(Math.max(0, due.value - now))), Queue.take(wake))
        }),
      ),
    )

    const send: Outbox["send"] = (machine, thread, text) =>
      Effect.gen(function* () {
        if (plain(text) === "") return yield* new ThreadsError({ reason: "I didn't catch what to send." })
        const threads = yield* reach(machine)
        const now = yield* Clock.currentTimeMillis
        const row: Row = {
          command_id: `yapd:${crypto.randomUUID()}`,
          message_id: crypto.randomUUID(),
          machine,
          thread: thread.id,
          title: thread.title,
          project: thread.project,
          directory: thread.directory,
          text,
          reason: null,
          created_at: stamp(now),
        }
        // Kept before the first try, so a crash during it is followed by a try with the same ids.
        const queued = yield* store.transaction((database) => {
          const older = database
            .query<{ command_id: string }, [string, string]>("select command_id from messages where machine = ? and thread = ? and state = 'held' limit 1")
            .get(machine, thread.id)
          database
            .query<void, [string, string, string, string, string, string, string, string, string | null, string]>(
              `insert into messages (${columns}, state) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held')`,
            )
            .run(
              row.command_id,
              row.message_id,
              row.machine,
              row.thread,
              row.title,
              row.project,
              row.directory,
              row.text,
              older === null ? null : "It's behind an older message for the same thread.",
              row.created_at,
            )
          return older !== null
        })
        /**
         * Keeps the message for the watcher, with why, which is what it says
         * if it has to give up, and has everything else held tried again at
         * the usual pace: the user is here, and may have unblocked something.
         */
        const hold = (reason: string | null) =>
          Effect.gen(function* () {
            later.clear()
            if (reason !== null) yield* stillHeld(row.command_id, reason)
            yield* Queue.offer(wake, undefined)
          })
        if (queued) {
          yield* hold(null)
          return { _tag: "Held" } as const
        }
        const result = yield* Effect.either(oneAtATime(machine, thread.id, Effect.zipRight(expect(text), threads.send(thread.id, outgoing(row)))))
        if (result._tag === "Left") {
          if (result.left.gone) {
            yield* failed(row.command_id, result.left.reason)
            return yield* result.left
          }
          // Whether it went is unknown: the same ids go again, and T3 Code takes a command it already has as done.
          yield* hold(result.left.reason)
          return { _tag: "Pending", reason: result.left.reason } as const
        }
        if (result.right === "waiting") {
          yield* failed(row.command_id, waiting)
          return yield* new ThreadsError({ reason: waiting })
        }
        if (result.right === "busy") {
          yield* hold("It was in the middle of a turn.")
          return { _tag: "Held" } as const
        }
        yield* sent(row.command_id)
        return { _tag: "Sent" } as const
      })

    return { send }
  })
