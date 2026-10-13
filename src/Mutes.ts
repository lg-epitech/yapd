import type { Database } from "bun:sqlite"
import { Clock, Effect, Option, PubSub, Stream } from "effect"
import { hostname } from "node:os"
import type * as Conversation from "./Conversation.ts"
import type { Journal, Kept, Naming } from "./Journal.ts"
import { gist } from "./Responder.ts"
import type * as Store from "./Store.ts"
import type * as Threads from "./Threads.ts"

// The threads the user muted because they're noisy. A muted thread's progress
// and finished work are summed up and kept, but never said; whatever needs
// him still is: a question, an approval, a failure, a limit, and the answer
// to a message he sent it himself. A mute is his to make and take off, from
// the menu or by voice, and nothing about it ever reaches an agent. Beside
// them, the threads whose subagents he has read to him: every other thread's
// are kept to yapd, whatever they say.

/**
 * What a mute is kept under: `t3:<machine>:<thread>` for a thread T3 Code
 * runs, and `session:<machine>:<agent>:<session>` for a session yapd can't tie
 * to one, like one run in a terminal. Clients take it as a name, nothing more.
 * The machine is written as in a URL, so any name he gives it, like "My Mac",
 * reads back the same.
 */
export const key = {
  thread: (ref: Threads.Ref) => `t3:${encodeURIComponent(ref.machine)}:${ref.id}`,
  /** `session` is the agent and its own id for the session, as `Payload.key` puts them. */
  session: (machine: string, session: string) => `session:${encodeURIComponent(machine)}:${session}`,
}

/** A machine as a key has it, or none when no key yapd made could. */
const machineOf = (written: string) => {
  try {
    return Option.some(decodeURIComponent(written))
  } catch {
    return Option.none()
  }
}

/** What a key is about. */
export type About =
  | { readonly _tag: "Thread"; readonly ref: Threads.Ref }
  | { readonly _tag: "Session"; readonly machine: string; readonly agent: string; readonly session: string }

/** What a key is about, or none for one yapd never made, like a mangled one. */
export const parse = (text: string): Option.Option<About> => {
  const thread = /^t3:([^:\s]+):(\S+)$/.exec(text)
  if (thread !== null) return Option.map(machineOf(thread[1]!), (machine): About => ({ _tag: "Thread", ref: { machine, id: thread[2]! } }))
  const session = /^session:([^:\s]+):(claude|codex):(\S+)$/.exec(text)
  if (session !== null) {
    return Option.map(machineOf(session[1]!), (machine): About => ({ _tag: "Session", machine, agent: session[2]!, session: session[3]! }))
  }
  return Option.none()
}

/**
 * The keys an update is muted by: its thread's, when it's tied to one, here
 * or on another machine, or the subagent's it came from, and its session's,
 * unless it's a turn T3 Code told of, which has no session of its own. Never
 * the thread a subagent is part of, so unmuting one of its updates never
 * unmutes that thread.
 */
export const keysOf = (update: Pick<Conversation.Update, "session" | "about" | "owner" | "subagent" | "thread">, called: Naming): ReadonlyArray<string> => {
  const ref = update.about ?? update.owner ?? update.subagent?.child
  return [
    ...(ref === undefined ? [] : [key.thread(ref)]),
    ...(update.session.startsWith("finished:") ? [] : [key.session(called(update.thread.origin.host ?? hostname()), update.session)]),
  ]
}

/** The keys an update is kept quiet by: its own, and a subagent's, the thread's it's part of too, so muting that thread mutes its subagents. */
export const covering = (update: Pick<Conversation.Update, "session" | "about" | "owner" | "subagent" | "thread">, called: Naming): ReadonlyArray<string> => [
  ...keysOf(update, called),
  ...(update.subagent?.head === undefined ? [] : [key.thread(update.subagent.head.ref)]),
]

/**
 * The keys an update kept in the journal is muted by, as `keysOf` gives
 * them for the update it was: its thread's when it was tied to one, and the
 * session's it was kept under or tied from.
 */
export const keysOfKept = (kept: Pick<Kept, "machine" | "thread" | "detail">, called: Naming): ReadonlyArray<string> => {
  const detail = (typeof kept.detail === "object" && kept.detail !== null ? kept.detail : {}) as { readonly session?: unknown; readonly host?: unknown }
  const tied = typeof detail.session === "string" ? detail.session : undefined
  const session = tied ?? kept.thread
  const host = typeof detail.host === "string" ? detail.host : undefined
  return [
    ...(tied !== undefined && kept.machine !== undefined && kept.thread !== undefined ? [key.thread({ machine: kept.machine, id: kept.thread })] : []),
    ...(session === undefined || session.startsWith("finished:") ? [] : [key.session(called(host ?? hostname()), session)]),
  ]
}

/** The thread a subagent's update kept in the journal is part of, by its key, as `covering` adds it: none for any other. */
export const headKept = (kept: Pick<Kept, "machine" | "detail">): string | undefined => {
  const detail = (typeof kept.detail === "object" && kept.detail !== null ? kept.detail : {}) as { readonly subagent?: unknown; readonly head?: unknown }
  return detail.subagent === true && typeof detail.head === "string" && kept.machine !== undefined ? key.thread({ machine: kept.machine, id: detail.head }) : undefined
}

/** The keys an update kept in the journal is kept quiet by, as `covering` gives them for the update it was. */
export const coveringKept = (kept: Pick<Kept, "machine" | "thread" | "detail">, called: Naming): ReadonlyArray<string> => {
  const head = headKept(kept)
  return [...keysOfKept(kept, called), ...(head === undefined ? [] : [head])]
}

/** Counts as they're said for how long a mute lasts, beside the digits Whisper often writes. */
const counts: ReadonlyMap<string, number> = new Map([
  ["a", 1], ["an", 1], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9],
  ["ten", 10], ["eleven", 11], ["twelve", 12], ["fifteen", 15], ["twenty", 20], ["thirty", 30], ["forty", 40], ["forty five", 45],
  ["fifty", 50], ["sixty", 60], ["ninety", 90],
])

/** How many minutes "an hour", "half an hour", "ten minutes" or "2 hours" is, or none when it's said any other way. */
export const lasting = (said: string) => {
  if (said === "half an hour") return 30
  const asked = /^(.+?) (minute|minutes|hour|hours)$/.exec(said)
  if (asked === null) return undefined
  const count = /^\d{1,3}$/.test(asked[1]!) ? Number(asked[1]) : counts.get(asked[1]!)
  if (count === undefined || count === 0) return undefined
  return asked[2]!.startsWith("hour") ? count * 60 : count
}

/**
 * When a time the model gave is: as his clock reads it, written with no
 * offset, like "2026-10-12T15:00", which stays right across a change of the
 * clocks, or as given with one, like a time yapd worked out itself. NaN for
 * anything else, and for a day or an hour that isn't on the calendar, like
 * October 32 or 25:00, never the one it would roll over to. 24:00 is the
 * midnight that ends its day, as ISO 8601 and ECMAScript have it.
 */
export const instant = (when: string) => {
  const written = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(when.trim())
  if (written === null) return Date.parse(when)
  const [year, month, day, hour, minute, second] = written.slice(1, 7).map((part) => Number(part ?? 0))
  const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate()
  const midnight = hour === 24 && minute === 0 && second === 0 && written[7] === undefined
  if (month! < 1 || month! > 12 || day! < 1 || day! > days || (hour! > 23 && !midnight) || minute! > 59 || second! > 59) return Number.NaN
  return written[8] === undefined ? new Date(year!, month! - 1, day!, hour!, minute!, second!).getTime() : Date.parse(when.trim())
}

/**
 * When a mute the model worked out ends: the time it gives, or, as it may
 * give how long instead, like "for an hour", that long from `now`. None for
 * a time that's gone or anything else, which mutes it until he unmutes it.
 */
export const ending = (when: string, now: number) => {
  const at = instant(when)
  if (!Number.isNaN(at)) return at > now ? at : undefined
  const minutes = lasting(gist(when).replace(/^for /, ""))
  return minutes === undefined ? undefined : now + minutes * 60_000
}

/** What he's on about, said as a whole: never a thread by name, which is the model's to tell. */
const it = "it|that|this|this thread|that thread|this one|that one"

/** Unmuting every thread, said as a whole. */
const everything: ReadonlySet<string> = new Set(["unmute everything", "unmute all", "unmute them all", "unmute all threads", "unmute every thread", "unmute all of them"])

/**
 * Muting or unmuting what he's on about, or unmuting everything, said in so
 * many words, like "mute it", "silence this one for an hour" or "unmute
 * that", with how many minutes a mute for a while lasts; or reading him its
 * subagents, or no longer, as "read me its subagents" or "stop reading their
 * subagents". Anything else, like a thread by name, a mute "until tomorrow",
 * or more said around it, is none: the model's to work out.
 */
export const command = (heard: string): Option.Option<{ readonly how: "mute" | "unmute" | "clear" | "subagents" | "nosubagents"; readonly minutes?: number }> => {
  const said = gist(heard)
  if (everything.has(said)) return Option.some({ how: "clear" })
  const reading = /^(read|stop reading|don't read)(?: me)? (?:its|their) subagents$/.exec(said)
  if (reading !== null) return Option.some({ how: reading[1] === "read" ? "subagents" : "nosubagents" })
  const asked = new RegExp(`^(mute|silence|unmute) (?:${it})(?: for (.+))?$`).exec(said)
  if (asked === null) return Option.none()
  const how = asked[1] === "unmute" ? "unmute" : "mute"
  if (asked[2] === undefined) return Option.some({ how })
  const minutes = how === "mute" ? lasting(asked[2]) : undefined
  return minutes === undefined ? Option.none() : Option.some({ how, minutes })
}

/**
 * Whether what he said is about muting a thread, but not in so many words,
 * like "mute it for a bit", "mute the Tezos one", "what's muted?" or "is it
 * muted?". Unmuting is never for an agent, but what's muted is plainly a
 * thread, a session or what he's on about, so "silence the linter
 * warnings", which could be for an agent, isn't.
 */
export const aboutMuting = (heard: string) => {
  const said = gist(heard)
  return (
    /^un ?mute\b/.test(said) ||
    new RegExp(`^(?:mute|silence) (?:(?:${it}|them|everything|all)(?: |$)|the .*\\b(?:one|ones|thread|threads|session|sessions)\\b)`).test(said) ||
    /^(?:what's|whats|what is|what are|which threads are|which ones are|which are|what have i|what did i|is anything|is everything|anything|is it|is this|is that|is this one|is that one|is this thread) (?:muted|mute)$/.test(said)
  )
}

/**
 * Whether what he said is about which of a thread's subagents are read to
 * him, but not in so many words, like "read me the subagents", "can you read
 * me its subagents" or "keep its subagents to yourself": as a whole, so
 * "have a subagent review it" or "read the subagents' findings and fix
 * them", which are for the agent, aren't.
 */
export const aboutSubagents = (heard: string) => {
  const said = gist(heard)
  return (
    /^(?:(?:can|could|would|will) you |please )?(?:read|hear|start reading|keep reading|stop reading|quit reading|don't read|dont read|do not read|mute|silence)(?: me| us)? (?:its|their|the|this thread's|that thread's) subagents(?: (?:too|again|aloud|out loud|from now on|please))?$/.test(said) ||
    /^keep (?:its|their|the) subagents (?:to yourself|quiet)$/.test(said)
  )
}

/** A thread whose subagents he has read to him. */
export interface Reading {
  /** Its key, as a thread's. */
  readonly key: string
  /** What it's called aloud, for when there's nothing else to call it by. */
  readonly called?: string | undefined
  readonly project?: string | undefined
  /** When he asked for them. */
  readonly at: number
}

/** A thread he muted. */
export interface Mute {
  readonly key: string
  /** What it's called aloud, like "the Tezos migration", for when there's nothing else to call it by. */
  readonly called?: string | undefined
  readonly project?: string | undefined
  /** When he muted it. */
  readonly at: number
  /** When it ends on its own, if it does. */
  readonly ends?: number | undefined
}

/**
 * A change he made to what's muted, or to whose subagents are read to him,
 * which "scratch that" takes back: the mutes it made and the ones it took
 * off, and the threads whose subagents it started or stopped reading.
 */
export interface Change {
  readonly how: "mute" | "unmute" | "clear" | "undo" | "subagents" | "nosubagents"
  readonly at: number
  readonly added: ReadonlyArray<Mute>
  readonly removed: ReadonlyArray<Mute>
  readonly read?: ReadonlyArray<Reading>
  readonly unread?: ReadonlyArray<Reading>
}

/** How long a change can be taken back for, as for anything else yapd did. */
const takeBack = 2 * 60_000

export interface Mutes {
  /** The mute any of these keys is under, if one is, from memory, so nothing waits on the database for it. */
  readonly muted: (keys: ReadonlyArray<string>) => Effect.Effect<Option.Option<Mute>>
  /** Mutes a thread, or changes when its mute ends, and says whether that changed anything. */
  readonly mute: (mute: Omit<Mute, "at">) => Effect.Effect<boolean>
  /** Takes a thread's mute off, and any under the `also` keys with it, as one change, and gives back the first taken off, or none when none was muted. */
  readonly unmute: (key: string, also?: ReadonlyArray<string>) => Effect.Effect<Option.Option<Mute>>
  /** Takes every mute off, and gives them back. */
  readonly clear: Effect.Effect<ReadonlyArray<Mute>>
  /** Undoes the last change, if it was made in the last two minutes, and gives back what undoing it changed. */
  readonly undo: Effect.Effect<Option.Option<Change>>
  /** Moves a session's mute to its thread once the session is found to be the thread's, keeping a mute the thread has already. */
  readonly rekey: (from: string, to: string) => Effect.Effect<void>
  /** Every mute, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<Mute>>
  /** The last change he made, if it was in the last two minutes. */
  readonly last: Effect.Effect<Option.Option<Change>>
  /** Each time what's muted changes, even when a mute ends on its own, or whose subagents are read. */
  readonly changes: Stream.Stream<void>
  /** Whether the subagents of the thread under this key are read to him, from memory. */
  readonly reads: (key: string) => Effect.Effect<boolean>
  /** Starts or stops reading him a thread's subagents, and says whether that changed anything. */
  readonly read: (thread: Omit<Reading, "at">, on: boolean) => Effect.Effect<boolean>
  /** The threads whose subagents are read to him, oldest first. */
  readonly reading: Effect.Effect<ReadonlyArray<Reading>>
}

/** What `settings` keeps the threads whose subagents are read under. */
const readingSetting = "subagents"

/** The threads whose subagents are read, as kept: none for anything that isn't a list of them. */
const readingsIn = (value: string): ReadonlyArray<Reading> => {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((one): ReadonlyArray<Reading> => {
      if (typeof one !== "object" || one === null) return []
      const { key, called, project, at } = one as Record<string, unknown>
      if (typeof key !== "string" || Option.isNone(parse(key)) || typeof at !== "number") return []
      return [{ key, ...(typeof called === "string" ? { called } : {}), ...(typeof project === "string" ? { project } : {}), at }]
    })
  } catch {
    return []
  }
}

interface Row {
  readonly key: string
  readonly called: string | null
  readonly project: string | null
  readonly at: number
  readonly ends_at: number | null
}

/** Whether two mutes are the same mute, made at the same time and ending at the same time, whichever copy each is. */
const same = (one: Mute | undefined, other: Mute) =>
  one !== undefined && one.key === other.key && one.called === other.called && one.project === other.project && one.at === other.at && one.ends === other.ends

const fromRow = (row: Row): Mute => ({
  key: row.key,
  ...(row.called === null ? {} : { called: row.called }),
  ...(row.project === null ? {} : { project: row.project }),
  at: row.at,
  ...(row.ends_at === null ? {} : { ends: row.ends_at }),
})

/**
 * The mutes kept in `store`, read once, then kept in memory as they change.
 * Should the database fail, what he asked for still holds until yapd restarts.
 */
export const make = (store: Store.Store["Type"]) =>
  Effect.gen(function* () {
    const kept = yield* store
      .transaction((database: Database) => database.query<Row, []>("select key, called, project, at, ends_at from mutes order by at, key").all())
      .pipe(Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not read what's muted", error), [] as ReadonlyArray<Row>)))
    const mutes = new Map(kept.map((row) => [row.key, fromRow(row)]))
    const stored = yield* store
      .transaction((database: Database) =>
        database.query<{ value: string }, [string]>("select value from settings where name = ?").get(readingSetting)?.value,
      )
      .pipe(Effect.catchAll((error) => Effect.as(Effect.logWarning("Could not read whose subagents I read you", error), undefined)))
    const readings = new Map((stored === undefined ? [] : readingsIn(stored)).map((reading) => [reading.key, reading]))
    /**
     * A session's mute moved to its thread since the last change: what it
     * was, and whether the thread had a mute of its own already, which it
     * kept.
     */
    interface Move {
      readonly from: string
      readonly to: string
      readonly before: Mute
      readonly merged: boolean
    }
    /** The last change, as it was made, and the mutes moved since, which taking it back goes by. */
    let last: (Change & { readonly moves: ReadonlyArray<Move> }) | undefined
    const changed = yield* PubSub.unbounded<void>()

    /** Writes what's added and taken off as one, in memory whatever the database makes of it. */
    const save = (added: ReadonlyArray<Mute>, removed: ReadonlyArray<Mute>) =>
      Effect.gen(function* () {
        const adding = new Set(added.map(({ key }) => key))
        for (const { key } of removed) if (!adding.has(key)) mutes.delete(key)
        for (const mute of added) mutes.set(mute.key, mute)
        yield* store
          .transaction((database: Database) => {
            for (const { key } of removed) if (!adding.has(key)) database.query("delete from mutes where key = ?").run(key)
            for (const mute of added) {
              database
                .query("insert or replace into mutes (key, called, project, at, ends_at) values (?, ?, ?, ?, ?)")
                .run(mute.key, mute.called ?? null, mute.project ?? null, mute.at, mute.ends ?? null)
            }
          })
          .pipe(Effect.catchAll((error) => Effect.logWarning("Could not keep what's muted", error)))
        yield* PubSub.publish(changed, undefined)
      })

    /** Writes whose subagents are read, in memory whatever the database makes of it. */
    const keep = (read: ReadonlyArray<Reading>, unread: ReadonlyArray<Reading>) =>
      Effect.gen(function* () {
        if (read.length === 0 && unread.length === 0) return
        for (const { key } of unread) readings.delete(key)
        for (const reading of read) readings.set(reading.key, reading)
        const value = JSON.stringify([...readings.values()])
        yield* store
          .transaction((database: Database) => {
            database.query("insert into settings (name, value) values (?, ?) on conflict (name) do update set value = excluded.value").run(readingSetting, value)
          })
          .pipe(Effect.catchAll((error) => Effect.logWarning("Could not keep whose subagents I read you", error)))
        yield* PubSub.publish(changed, undefined)
      })

    /** Records a change he made, for taking it back. */
    const change = (
      how: Change["how"],
      added: ReadonlyArray<Mute>,
      removed: ReadonlyArray<Mute>,
      reading: { readonly read: ReadonlyArray<Reading>; readonly unread: ReadonlyArray<Reading> } = { read: [], unread: [] },
    ) =>
      Effect.gen(function* () {
        if (added.length > 0 || removed.length > 0) yield* save(added, removed)
        yield* keep(reading.read, reading.unread)
        last = {
          how,
          at: yield* Clock.currentTimeMillis,
          added,
          removed,
          ...(reading.read.length === 0 ? {} : { read: reading.read }),
          ...(reading.unread.length === 0 ? {} : { unread: reading.unread }),
          moves: [],
        }
        return shown(last)
      })

    /** A change as he'd know it: what it did to a session that's since been found to be a thread's, it did to the thread. */
    const shown = ({ how, at, added, removed, read, unread, moves }: NonNullable<typeof last>): Change => {
      const follow = (all: ReadonlyArray<Mute>) =>
        all.map((mute) => moves.reduce((mute, { from, to }) => (mute.key === from ? { ...mute, key: to } : mute), mute))
      return { how, at, added: follow(added), removed: follow(removed), ...(read === undefined ? {} : { read }), ...(unread === undefined ? {} : { unread }) }
    }

    /**
     * What's muted once a change is taken back: as it would be had he never
     * made it, with the sessions' mutes moved to their threads since moved
     * all the same, so a thread muted before the session was found to be
     * its own stays muted.
     */
    const without = ({ added, removed, moves }: NonNullable<typeof last>) => {
      const after = new Map(mutes)
      // As it was before the moves.
      for (const { from, to, before, merged } of moves.toReversed()) {
        if (!merged) after.delete(to)
        after.set(from, before)
      }
      for (const { key } of added) after.delete(key)
      for (const mute of removed) after.set(mute.key, mute)
      for (const { from, to } of moves) {
        const mute = after.get(from)
        if (mute === undefined) continue
        after.delete(from)
        if (!after.has(to)) after.set(to, { ...mute, key: to })
      }
      return after
    }

    /** Mutes that ended on their own are let go of as they're next looked at. */
    const lapsed = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const ended = [...mutes.values()].filter(({ ends }) => ends !== undefined && ends <= now)
      if (ended.length > 0) yield* save([], ended)
    })

    const lately = Effect.map(Clock.currentTimeMillis, (now) => Option.filter(Option.fromNullable(last), ({ at }) => now - at <= takeBack))

    return {
      muted: (keys) =>
        Effect.zipRight(
          lapsed,
          Effect.sync(() => Option.fromNullable(keys.map((key) => mutes.get(key)).find((mute) => mute !== undefined))),
        ),
      mute: ({ key, called, project, ends }) =>
        Effect.gen(function* () {
          yield* lapsed
          const before = mutes.get(key)
          if (before !== undefined && before.ends === ends) return false
          const at = yield* Clock.currentTimeMillis
          const mute: Mute = {
            key,
            ...(called === undefined ? (before?.called === undefined ? {} : { called: before.called }) : { called }),
            ...(project === undefined ? (before?.project === undefined ? {} : { project: before.project }) : { project }),
            at,
            ...(ends === undefined ? {} : { ends }),
          }
          yield* change("mute", [mute], before === undefined ? [] : [before])
          return true
        }),
      unmute: (key, also = []) =>
        Effect.gen(function* () {
          yield* lapsed
          const before = [...new Set([key, ...also])].flatMap((key) => Option.toArray(Option.fromNullable(mutes.get(key))))
          if (before.length === 0) return Option.none()
          yield* change("unmute", [], before)
          return Option.fromNullable(before[0])
        }),
      clear: Effect.gen(function* () {
        yield* lapsed
        const all = [...mutes.values()]
        if (all.length > 0) yield* change("clear", [], all)
        return all
      }),
      undo: Effect.gen(function* () {
        const undone = yield* lately
        if (Option.isNone(undone)) return Option.none()
        const after = without(undone.value)
        // By what each mute is, as one moved since is put back as a mute of its own, the same as the one there now.
        const added = [...after.values()].filter((mute) => !same(mutes.get(mute.key), mute))
        const removed = [...mutes.values()].filter((mute) => !same(after.get(mute.key), mute))
        // Whose subagents are read flips back too: those it started reading stop, and those it stopped are read again.
        const read = (undone.value.unread ?? []).filter(({ key }) => !readings.has(key))
        const unread = (undone.value.read ?? []).flatMap(({ key }) => Option.toArray(Option.fromNullable(readings.get(key))))
        // Nothing to take back, as when the thread was muted before the session he muted was found to be its own.
        if (added.length === 0 && removed.length === 0 && read.length === 0 && unread.length === 0) return Option.none()
        // Taken back, it's a change of its own, so taking that back too puts things as they were before.
        return Option.some(yield* change("undo", added, removed, { read, unread }))
      }),
      rekey: (from, to) =>
        Effect.gen(function* () {
          const before = mutes.get(from)
          if (before === undefined) return
          const kept = mutes.get(to)
          yield* save(kept === undefined ? [{ ...before, key: to }] : [], [before])
          // Taking back the last change goes by it from now on.
          if (last !== undefined) last = { ...last, moves: [...last.moves, { from, to, before, merged: kept !== undefined }] }
        }),
      list: Effect.zipRight(
        lapsed,
        Effect.sync(() => [...mutes.values()].toSorted((one, other) => one.at - other.at || (one.key < other.key ? -1 : one.key > other.key ? 1 : 0))),
      ),
      last: Effect.map(lately, Option.map(shown)),
      changes: Stream.fromPubSub(changed),
      reads: (key) => Effect.sync(() => readings.has(key)),
      read: ({ key, called, project }, on) =>
        Effect.gen(function* () {
          const before = readings.get(key)
          if (on === (before !== undefined)) return false
          const now = yield* Clock.currentTimeMillis
          const reading: Reading = { key, ...(called === undefined ? {} : { called }), ...(project === undefined ? {} : { project }), at: now }
          yield* change(on ? "subagents" : "nosubagents", [], [], on ? { read: [reading], unread: [] } : { read: [], unread: before === undefined ? [] : [before] })
          return true
        }),
      reading: Effect.sync(() => [...readings.values()].toSorted((one, other) => one.at - other.at || (one.key < other.key ? -1 : one.key > other.key ? 1 : 0))),
    } satisfies Mutes
  })

/** What's done to mutes, from the menu or by voice: never anything sent to an agent. */
export interface Controls {
  /** Mutes a thread, drops what of it is waiting to be said, and notes it. Whether it wasn't muted already, as it is now. */
  readonly mute: (target: Omit<Mute, "at" | "ends">, ends?: number) => Effect.Effect<boolean>
  /** Unmutes a thread, and what it's muted under by the `also` keys, and notes it. Whether it was muted. */
  readonly unmute: (key: string, also?: ReadonlyArray<string>) => Effect.Effect<boolean>
  /** Unmutes every thread, and notes it. The mutes taken off. */
  readonly clear: Effect.Effect<ReadonlyArray<Mute>>
  /** Takes back the last change to what's muted, made in the last two minutes, and notes it. What taking it back changed. */
  readonly undo: Effect.Effect<Option.Option<Change>>
  /**
   * Starts or stops reading him a thread's subagents, and notes it: stopped,
   * what of them waits to be said is dropped, and what was held is kept
   * quiet, whatever it is. Whether that changed anything.
   */
  readonly subagents: (thread: Omit<Reading, "at">, on: boolean) => Effect.Effect<boolean>
}

/**
 * Mutes and unmutes threads in `mutes`, dropping what of a thread is waiting
 * to be said with `silence`, and noting each change in the journal.
 */
export const controls = (options: {
  readonly mutes: Mutes
  readonly silence: (keys: ReadonlyArray<string>) => Effect.Effect<void>
  /** Drops what of a thread's subagents waits to be said, whatever it is, and keeps what of them was held quiet: nothing without it. */
  readonly unread?: (key: string) => Effect.Effect<void>
  readonly journal: Journal["Type"]
}): Controls => {
  const { mutes, silence, journal } = options
  const unread = options.unread ?? (() => Effect.void)
  /** Under the thread it's about, when it's a thread. */
  const where = (key: string) =>
    Option.match(parse(key), {
      onNone: () => ({}),
      onSome: (about) => (about._tag === "Thread" ? { machine: about.ref.machine, thread: about.ref.id } : { machine: about.machine, thread: `${about.agent}:${about.session}` }),
    })
  const noted = (detail: Record<string, unknown>, key?: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => journal.write({ at, kind: "action", ...(key === undefined ? {} : where(key)), detail }))
  /** What's muted again is silenced again too. */
  const silenced = (added: ReadonlyArray<Mute>) => (added.length === 0 ? Effect.void : silence(added.map(({ key }) => key)))
  return {
    mute: (target, ends) =>
      Effect.gen(function* () {
        const muted = yield* mutes.mute({ ...target, ...(ends === undefined ? {} : { ends }) })
        // Muted already, what of it was waiting was dropped then, and nothing of it has been queued since.
        if (!muted) return false
        yield* silence([target.key])
        yield* noted({ mute: target.key, ...(ends === undefined ? {} : { until: new Date(ends).toISOString() }) }, target.key)
        return true
      }),
    unmute: (key, also) =>
      Effect.gen(function* () {
        const was = yield* mutes.unmute(key, also)
        if (Option.isSome(was)) yield* noted({ unmute: key }, key)
        return Option.isSome(was)
      }),
    clear: Effect.gen(function* () {
      const all = yield* mutes.clear
      if (all.length > 0) yield* noted({ unmute: all.map(({ key }) => key) })
      return all
    }),
    undo: Effect.gen(function* () {
      const undone = yield* mutes.undo
      if (Option.isNone(undone)) return undone
      const { added, removed, read = [], unread: stopped = [] } = undone.value
      yield* silenced(added)
      yield* Effect.forEach(stopped, ({ key }) => unread(key), { discard: true })
      yield* noted({
        undo: {
          mute: added.map(({ key }) => key),
          unmute: removed.map(({ key }) => key),
          ...(read.length === 0 ? {} : { subagents: read.map(({ key }) => key) }),
          ...(stopped.length === 0 ? {} : { nosubagents: stopped.map(({ key }) => key) }),
        },
      })
      return undone
    }),
    subagents: (thread, on) =>
      Effect.gen(function* () {
        const changed = yield* mutes.read(thread, on)
        if (!changed) return false
        if (!on) yield* unread(thread.key)
        yield* noted({ [on ? "subagents" : "nosubagents"]: thread.key }, thread.key)
        return true
      }),
  }
}

/**
 * Controls whose unmuting also takes off what a thread is muted under
 * besides its own key, as `under` says, like the session of its latest
 * update, muted before that session was found to be the thread's: the
 * thread shows muted by it, so unmuting the thread unmutes it.
 */
export const widened = (controls: Controls, under: (key: string) => Effect.Effect<ReadonlyArray<string>>): Controls => ({
  ...controls,
  unmute: (key, also = []) => Effect.flatMap(under(key), (more) => controls.unmute(key, [...also, ...more])),
})
