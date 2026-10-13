import type { Database } from "bun:sqlite"
import { Clock, Effect, Option } from "effect"
import * as Brain from "./Brain.ts"
import type { Entry, Journal } from "./Journal.ts"
import { addressed, type Lines } from "./Persona.ts"
import type * as Store from "./Store.ts"
import * as Threads from "./Threads.ts"

// What he asked yapd to tell him later: at a time, when a thread finishes, or
// when one asks him something, or a message to offer a thread then, which is
// only ever sent on his yes. The model works out when and which thread; code
// only checks it can be done. Each is said once, ever, under its key in the
// journal, which is claimed as it's handed over to be said, and fired with it,
// so a restart may say one again but never drops one.

/** What a thread does that he asked to be told of. */
export type Event = "finished" | "asked"

/** A reminder, as it's kept. */
export interface Reminder {
  /** Never used again, so its key in the journal is always new. */
  readonly id: number
  /** When he asked for it. */
  readonly at: number
  /** The request it came from. */
  readonly utterance?: string | undefined
  /** His words as he said them: none when they may have been yapd's own voice. */
  readonly heard: string
  /** What to tell him then, as the model put it: "" when it's only that the thread did what he asked to hear of, and for an offer. */
  readonly text: string
  /** For an offer: the message to offer the thread then, which only his yes sends. */
  readonly propose?: string | undefined
  /** When it's due, for one at a time. */
  readonly due?: number | undefined
  /** The thread watched, or the one an offer is for. */
  readonly machine?: string | undefined
  readonly thread?: string | undefined
  /** What the thread was called aloud as he asked, for when it's gone. */
  readonly called?: string | undefined
  readonly event?: Event | undefined
  readonly state: "pending" | "fired" | "cancelled"
  readonly firedAt?: number | undefined
}

/** A reminder as he asks for it, before it's kept. */
export type Asked = Omit<Reminder, "id" | "state" | "firedAt">

/** The key it's said once under, ever. */
export const key = (id: number) => `remind:${id}`

/** The reminder a journal entry was kept for, if it was. */
export const of = (kept: { readonly key?: string | undefined; readonly detail?: unknown }) => {
  const found = kept.key === undefined ? null : /^remind:(\d+)$/.exec(kept.key)
  return found === null ? undefined : Number(found[1])
}

/** The thread it's about, if it's about one. */
export const ref = (reminder: Pick<Reminder, "machine" | "thread">): Option.Option<Threads.Ref> =>
  reminder.machine === undefined || reminder.thread === undefined ? Option.none() : Option.some({ machine: reminder.machine, id: reminder.thread })

interface Row {
  readonly id: number
  readonly at: number
  readonly utterance: string | null
  readonly heard: string
  readonly text: string
  readonly propose: string | null
  readonly due: number | null
  readonly machine: string | null
  readonly thread: string | null
  readonly called: string | null
  readonly event: Event | null
  readonly state: Reminder["state"]
  readonly fired_at: number | null
}

const reminder = (row: Row): Reminder => ({
  id: row.id,
  at: row.at,
  ...(row.utterance === null ? {} : { utterance: row.utterance }),
  heard: row.heard,
  text: row.text,
  ...(row.propose === null ? {} : { propose: row.propose }),
  ...(row.due === null ? {} : { due: row.due }),
  ...(row.machine === null ? {} : { machine: row.machine }),
  ...(row.thread === null ? {} : { thread: row.thread }),
  ...(row.called === null ? {} : { called: row.called }),
  ...(row.event === null ? {} : { event: row.event }),
  state: row.state,
  ...(row.fired_at === null ? {} : { firedAt: row.fired_at }),
})

export interface Reminders {
  /** Keeps one he asked for, and gives it back as it's kept. */
  readonly add: (asked: Asked) => Effect.Effect<Reminder, Store.StoreError>
  /** Those still to come, newest first. */
  readonly pending: Effect.Effect<ReadonlyArray<Reminder>>
  /** Cancels one still to come, and gives it back: none when it isn't. */
  readonly cancel: (id: number) => Effect.Effect<Option.Option<Reminder>>
  /** Brings back one he cancelled, and gives it back: none when it wasn't cancelled. */
  readonly restore: (id: number) => Effect.Effect<Option.Option<Reminder>>
  /** Those at a time that's come, the soonest first. */
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<Reminder>>
  /** Those still to come about a thread, for what it does when `event` says, or else all of them, offers at a time too, oldest first. */
  readonly on: (ref: Threads.Ref, event?: Event) => Effect.Effect<ReadonlyArray<Reminder>>
  readonly get: (id: number) => Effect.Effect<Option.Option<Reminder>>
  /**
   * Hands one over to be said: claims its key in the journal with `entry`,
   * unheard, and notes it fired, as one, so it's handed over once. None
   * when it's no longer to come, or its key was claimed already, which a
   * restart tells again if he never heard it; otherwise the entry's id, as
   * `Journal.claim` gives it.
   */
  readonly fire: (reminder: Pick<Reminder, "id">, entry: Entry) => Effect.Effect<Option.Option<Option.Option<number>>>
  /** Forgets those fired or cancelled before `before`. */
  readonly prune: (before: number) => Effect.Effect<void>
}

/** What's read back, as nothing when it can't be, since nothing that reads it should stop for that. */
const reading = <A>(effect: Effect.Effect<ReadonlyArray<A>, Store.StoreError>) =>
  effect.pipe(Effect.catchAll((error) => Effect.logWarning("Could not read your reminders", error).pipe(Effect.as<ReadonlyArray<A>>([]))))

const one = (effect: Effect.Effect<Option.Option<Reminder>, Store.StoreError>) =>
  effect.pipe(Effect.catchAll((error) => Effect.logWarning("Could not change your reminders", error).pipe(Effect.as(Option.none<Reminder>()))))

/** The reminders kept in `store`, fired through `journal`, which keeps its entries in the same store. */
export const make = (store: Store.Store["Type"], journal: Pick<Journal["Type"], "claim">): Reminders => {
  const find = (database: Database, id: number) => Option.map(Option.fromNullable(database.query<Row, [number]>("select * from reminders where id = ?").get(id)), reminder)
  /** Moves one from one state to another, giving it back as it is then, or none when it wasn't in `from`. */
  const move = (id: number, from: Reminder["state"], to: Reminder["state"]) =>
    one(
      store.transaction((database: Database) =>
        database.query("update reminders set state = ? where id = ? and state = ?").run(to, id, from).changes === 0 ? Option.none<Reminder>() : find(database, id),
      ),
    )
  return {
    add: (asked) =>
      store.transaction((database: Database) => {
        const id = Number(
          database
            .query(
              "insert into reminders (at, utterance, heard, text, propose, due, machine, thread, called, event, state) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
            )
            .run(
              asked.at,
              asked.utterance ?? null,
              asked.heard,
              asked.text,
              asked.propose ?? null,
              asked.due ?? null,
              asked.machine ?? null,
              asked.thread ?? null,
              asked.called ?? null,
              asked.event ?? null,
            ).lastInsertRowid,
        )
        return Option.getOrThrow(find(database, id))
      }),
    pending: reading(
      store.transaction((database: Database) => database.query<Row, []>("select * from reminders where state = 'pending' order by at desc, id desc").all().map(reminder)),
    ),
    cancel: (id) => move(id, "pending", "cancelled"),
    restore: (id) => move(id, "cancelled", "pending"),
    due: (now) =>
      reading(
        store.transaction((database: Database) =>
          database.query<Row, [number]>("select * from reminders where state = 'pending' and due is not null and due <= ? order by due, id").all(now).map(reminder),
        ),
      ),
    on: (ref, event) =>
      reading(
        store.transaction((database: Database) =>
          database
            .query<Row, [string, string]>("select * from reminders where state = 'pending' and machine = ? and thread = ? order by at, id")
            .all(ref.machine, ref.id)
            .map(reminder)
            .filter((found) => event === undefined || found.event === event),
        ),
      ),
    get: (id) => one(store.transaction((database: Database) => find(database, id))),
    fire: ({ id }, entry) =>
      journal.claim({ ...entry, key: key(id) }, (database) =>
        // Noted fired even when its key was claimed already, as by a yapd that stopped right after: a restart tells that again.
        database.query("update reminders set state = 'fired', fired_at = ? where id = ? and state = 'pending'").run(entry.at, id).changes > 0,
      ),
    prune: (before) =>
      store
        .transaction((database: Database) => {
          database.query("delete from reminders where state != 'pending' and coalesce(fired_at, at) < ?").run(before)
        })
        .pipe(Effect.catchAll((error) => Effect.logWarning("Could not prune your reminders", error))),
  }
}

/** A desk with nothing on it, for words said with no thread to name in them. */
const nowhere: Threads.Desk = { threads: [], away: [] }

/** Words of the model's said as they can be, without the mark that ends them, which the line puts back. */
const words = (text: string) => Brain.speakable(text, nowhere).replace(/[.!?]+$/, "").trim()

const capital = (text: string) => Brain.capital(text)

/** Midnight of the day a time falls in, here. */
const midnight = (at: number) => new Date(new Date(at).toDateString()).getTime()

/** How many days on from `now`'s a time's day is. */
const daysOn = (at: number, now: number) => Math.round((midnight(at) - midnight(now)) / (24 * 60 * 60_000))

/** When one is due, said ahead: "at 3:00 PM" today, "tomorrow at 9:00 AM", "on Tuesday at 3:00 PM", or with its date further off. */
export const ahead = (due: number, now: number) => {
  const days = daysOn(due, now)
  const at = Brain.time(due)
  if (days <= 0) return `at ${at}`
  if (days === 1) return `tomorrow at ${at}`
  const weekday = new Date(due).toLocaleDateString("en-US", { weekday: "long" })
  if (days < 7) return `on ${weekday} at ${at}`
  return `on ${weekday}, ${new Date(due).toLocaleDateString("en-US", { month: "long", day: "numeric" })}, at ${at}`
}

/** When it was due, said once it is, so it reads right however late: "at 3:00 PM", "at 3:00 PM yesterday", "on Monday at 3:00 PM". */
export const was = (due: number, now: number) => {
  const days = daysOn(now, due)
  const at = Brain.time(due)
  if (days <= 0) return `at ${at}`
  if (days === 1) return `at ${at} yesterday`
  return `on ${new Date(due).toLocaleDateString("en-US", { weekday: "long" })} at ${at}`
}

/** What a thread is called in what's said of it, on its machine when that isn't this one, as what's said of it of its own accord names it. */
export const named = (listed: Pick<Threads.Listed, "called" | "here" | "ref">) => (listed.here ? listed.called : `${listed.called} on ${listed.ref.machine}`)

/** What an offer would send, as it's said, or how it's told when it can't be read out. */
const message = (propose: string, to: string) => (Brain.readable(propose) && words(propose) !== "" ? `tell ${to}: ${words(propose)}` : `send ${to} what you said`)

/**
 * What's said of reminders, in fixed words, `called` being how the thread
 * it's about is said, as it's on the desk now, or else as it was when he
 * asked: never an id, and numbers only as times.
 */
export const lines = (said: Pick<Lines, "address">, now: number) => {
  const sir = addressed(said)
  /** What he asked to be told then, after a colon, when there's anything. */
  const then = (text: string) => (words(text) === "" ? "" : `: ${words(text)}`)
  const doing = (event: Event | undefined) => (event === "asked" ? "asks you something" : "finishes")
  return {
    /** What's said as he sets it, reading back what was kept. `running` is whether a thread watched to finish is working now. */
    set: (reminder: Asked, called: string, running = true): string => {
      if (reminder.propose !== undefined) {
        if (reminder.event === undefined) return `${capital(ahead(reminder.due ?? now, now))} I'll offer to ${message(reminder.propose, called)}${sir}.`
        return `When ${called} ${doing(reminder.event)}, I'll offer to ${message(reminder.propose, "it")}${sir}.`
      }
      if (reminder.event === undefined) return `I'll remind you ${ahead(reminder.due ?? now, now)}${sir}${then(reminder.text)}.`
      if (reminder.event === "finished" && !running) {
        const remind = then(reminder.text) === "" ? "I'll tell you when it next finishes." : `When it next finishes, I'll remind you${then(reminder.text)}.`
        return `${capital(called)} isn't running now${sir}. ${remind}`
      }
      return then(reminder.text) === ""
        ? `I'll tell you when ${called} ${doing(reminder.event)}${sir}.`
        : `When ${called} ${doing(reminder.event)}, I'll remind you${sir}${then(reminder.text)}.`
    },
    /** What's said once it's due, naming the time even on time, so it reads right in a catch-up. */
    fired: (reminder: Reminder, called: string): string => {
      if (reminder.event === undefined) return `You asked me to remind you ${was(reminder.due ?? now, now)}${sir}${then(reminder.text)}.`
      const what = reminder.event === "asked" ? "is asking you something" : "has finished"
      return then(reminder.text) === ""
        ? `${capital(called)} ${what}${sir}${reminder.event === "asked" ? "" : ", as you asked"}.`
        : `${capital(called)} ${what}${sir}. You asked me to remind you then${then(reminder.text)}.`
    },
    /** What's said of a thread he wanted to hear finish that failed instead, with why, as a failure is said. */
    failed: (reminder: Reminder, called: string, why: string): string =>
      `${capital(called)} stopped${sir}, before finishing: ${why}${then(reminder.text) === "" ? "" : ` You asked me to remind you then${then(reminder.text)}.`}`,
    /** An offer, told rather than asked, like while yapd is off, for him to ask for it if he still wants it. */
    offer: (reminder: Reminder, called: string): string =>
      reminder.event === undefined
        ? `${capital(was(reminder.due ?? now, now))} you wanted me to offer to ${message(reminder.propose ?? "", called)}${sir}.`
        : `When ${called} ${reminder.event === "asked" ? "asked you something" : "finished"}, you wanted me to offer to ${message(reminder.propose ?? "", "it")}${sir}.`,
    /** An offer whose thread is gone, so it can't be asked. */
    gone: (reminder: Reminder, called: string): string =>
      `${
        reminder.event === undefined
          ? `${capital(was(reminder.due ?? now, now))} you wanted to ${message(reminder.propose ?? "", called)}${sir}.`
          : `You wanted to ${message(reminder.propose ?? "", called)} once it ${reminder.event === "asked" ? "asked you something" : "finished"}${sir}.`
      } It's gone from T3 Code.`,
    /** The question an offer is asked with once it's due: what a yes sends, and to which thread. */
    asking: (reminder: Reminder, called: string) => ({ doing: message(reminder.propose ?? "", called), question: `Shall I ${message(reminder.propose ?? "", called)}${sir}?` }),
    /** What's said once he cancels it, or takes back cancelling it, naming it. */
    cancelled: (reminder: Reminder, called: string, kept = false): string => {
      const done = kept ? "Kept" : "Cancelled"
      if (reminder.propose !== undefined) return `${done} your offer to ${called}${sir}.`
      if (reminder.event === undefined) return `${done} your reminder ${ahead(reminder.due ?? now, now)}${sir}${then(reminder.text)}.`
      return `${done} your reminder for when ${called} ${doing(reminder.event)}${sir}.`
    },
    /** What's said once a thread he set reminders on goes, which drops them. */
    dropped: (called: string, all: ReadonlyArray<Reminder>): string => {
      const offers = all.every(({ propose }) => propose !== undefined)
      const kind = offers ? "offer" : "reminder"
      return `${capital(called)} was archived or deleted${sir}, so I dropped your ${all.length === 1 ? kind : `${kind}s`}.`
    },
    /** It went off before it could be taken back. */
    over: `It's already gone off${sir}.`,
    /** It couldn't be kept. */
    unwritten: `I couldn't write that down${sir}.`,
    /** A time that's already gone, or too far off. */
    past: `That time's already gone${sir}.`,
    tooFar: `That's further out than I keep reminders${sir}.`,
  }
}

/** How a reminder's thread is called: as it's on the desk now, or else as it was when he asked. */
export const calling = (reminder: Pick<Reminder, "called" | "machine" | "thread">, desk: Threads.Desk) => {
  const on = Option.flatMap(ref(reminder), (about) => Option.fromNullable(desk.threads.find((listed) => Threads.same(listed.ref, about))))
  return Option.match(on, { onNone: () => reminder.called ?? "that thread", onSome: named })
}

/**
 * The reminders to tell him of as a thread he watched finishes, with what's
 * said of each, as `finishing` gives them for an update about to be said:
 * never an offer, which is asked on its own, after. Each is fired as it's
 * taken, and dropped when it fired elsewhere meanwhile.
 */
export interface Leading {
  readonly line: string
  /** Fires it, kept unheard, held as yapd was off when `off`: its entry, or none when it fired elsewhere meanwhile. */
  readonly fire: (off: boolean) => Effect.Effect<Option.Option<Option.Option<number>>>
}

/** What a finished turn's update is led by, for the thread it's about: the reminders he set on it finishing. */
export const finishing = (options: {
  readonly reminders: Reminders
  readonly desk: (ref: Threads.Ref) => Effect.Effect<Threads.Desk>
  readonly lines: Effect.Effect<Lines>
}) =>
  (about: Threads.Ref): Effect.Effect<ReadonlyArray<Leading>> =>
    Effect.gen(function* () {
      const set = (yield* options.reminders.on(about, "finished")).filter(({ propose }) => propose === undefined)
      if (set.length === 0) return []
      const now = yield* Clock.currentTimeMillis
      const said = lines(yield* options.lines, now)
      const desk = yield* options.desk(about)
      return set.map((reminder): Leading => {
        const called = calling(reminder, desk)
        const line = said.fired(reminder, called)
        return {
          line,
          fire: (off) =>
            options.reminders.fire(reminder, {
              at: now,
              kind: "notice",
              machine: about.machine,
              thread: about.id,
              said: line,
              detail: { reminder: reminder.id, ...(off ? { held: "off" } : {}) },
            }),
        }
      })
    })
