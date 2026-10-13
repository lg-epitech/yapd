import type { Database } from "bun:sqlite"
import { Clock, Effect, Option } from "effect"
import * as Brain from "./Brain.ts"
import { addressed, type Lines } from "./Persona.ts"
import type * as Store from "./Store.ts"

// What he asked yapd to keep in mind, by voice: facts about him and his work,
// and routines, steps sent to a thread whenever he says their name. Each is
// his words, kept beside all he said as he said it, and goes into every
// prompt, so there's only so much of it, and nothing is ever left out of a
// prompt to make room: past that, he's told to forget something first. It's
// information, never something to do: only a routine's name, said, sends its
// steps, as any message he sends goes.

export type Kind = "fact" | "routine"

/** A memory, as it's kept. */
export interface Memory {
  /** Never used again, so one forgotten and brought back is always the same memory. */
  readonly id: number
  /** When he asked for it. */
  readonly at: number
  readonly kind: Kind
  /** A routine's name, as he says it. */
  readonly name?: string | undefined
  /** The fact, or a routine's steps, in his words. */
  readonly text: string
  /** All he said as he asked for it, as he said it. */
  readonly heard: string
  /** The dictation it came in. */
  readonly utterance?: string | undefined
  readonly forgottenAt?: number | undefined
}

/** A memory as he asks for it, before it's kept. */
export type Asked = Omit<Memory, "id" | "forgottenAt">

/** How many are kept at most. */
export const most = 40

/** How much of them is kept at most, every fact, name and step counted, since every prompt waits on reading them. */
export const longest = 4000

/**
 * What came of keeping one, or bringing one back: kept, with the routine it
 * took the place of, called the same, if it did; or not, as there's no more
 * room.
 */
export type Kept = { readonly _tag: "Kept"; readonly memory: Memory; readonly retired: Option.Option<Memory> } | { readonly _tag: "Full" }

interface Row {
  readonly id: number
  readonly at: number
  readonly kind: Kind
  readonly name: string | null
  readonly text: string
  readonly heard: string
  readonly utterance: string | null
  readonly forgotten_at: number | null
}

const memory = (row: Row): Memory => ({
  id: row.id,
  at: row.at,
  kind: row.kind,
  ...(row.name === null ? {} : { name: row.name }),
  text: row.text,
  heard: row.heard,
  ...(row.utterance === null ? {} : { utterance: row.utterance }),
  ...(row.forgotten_at === null ? {} : { forgottenAt: row.forgotten_at }),
})

/** How much of what's kept one takes up. */
const size = (kept: Pick<Memory, "name" | "text">) => kept.text.length + (kept.name?.length ?? 0)

export interface Memories {
  /** What's kept, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<Memory>>
  /**
   * Keeps one, if there's room: a routine called as one kept already, in any
   * case, takes its place, as one, and gives it back, so taking this back
   * brings it back.
   */
  readonly add: (asked: Asked) => Effect.Effect<Kept, Store.StoreError>
  /** Forgets one kept, and gives it back: none when it isn't kept. */
  readonly forget: (id: number) => Effect.Effect<Option.Option<Memory>, Store.StoreError>
  /**
   * Brings back one forgotten, if there's room, and gives it back: a routine
   * whose name another took since takes its place again, as one, so taking
   * back what took its place puts them as they were. None when it wasn't
   * forgotten.
   */
  readonly restore: (id: number) => Effect.Effect<Option.Option<Kept>, Store.StoreError>
}

/** The memories kept in `store`. */
export const make = (store: Store.Store["Type"]): Memories => {
  const find = (database: Database, id: number) => Option.map(Option.fromNullable(database.query<Row, [number]>("select * from memories where id = ?").get(id)), memory)
  /** The routine kept now under a name, told by its letters whatever their case, as the index tells it. */
  const called = (database: Database, name: string) =>
    Option.map(
      Option.fromNullable(database.query<Row, [string]>("select * from memories where kind = 'routine' and forgotten_at is null and lower(name) = lower(?)").get(name)),
      memory,
    )
  /** Whether there's room for one more, `leaving` aside, which it takes the place of. */
  const room = (database: Database, adding: Pick<Memory, "name" | "text">, leaving: Option.Option<Memory>) => {
    const kept = database
      .query<Row, []>("select * from memories where forgotten_at is null")
      .all()
      .filter(({ id }) => !Option.exists(leaving, (left) => left.id === id))
    return kept.length < most && kept.reduce((sum, row) => sum + size({ name: row.name ?? undefined, text: row.text }), 0) + size(adding) <= longest
  }
  const retire = (database: Database, id: number, at: number) => database.query("update memories set forgotten_at = ? where id = ? and forgotten_at is null").run(at, id)
  return {
    list: store
      .transaction((database: Database) => database.query<Row, []>("select * from memories where forgotten_at is null order by id").all().map(memory))
      .pipe(Effect.catchAll((error) => Effect.logWarning("Could not read what you asked me to remember", error).pipe(Effect.as<ReadonlyArray<Memory>>([])))),
    add: (asked) =>
      store.transaction((database: Database): Kept => {
        const taken = asked.kind === "routine" && asked.name !== undefined ? called(database, asked.name) : Option.none<Memory>()
        if (!room(database, asked, taken)) return { _tag: "Full" }
        // Retired first, since only one routine is kept under a name.
        if (Option.isSome(taken)) retire(database, taken.value.id, asked.at)
        const id = Number(
          database
            .query("insert into memories (at, kind, name, text, heard, utterance) values (?, ?, ?, ?, ?, ?)")
            .run(asked.at, asked.kind, asked.kind === "routine" ? (asked.name ?? null) : null, asked.text, asked.heard, asked.utterance ?? null).lastInsertRowid,
        )
        return { _tag: "Kept", memory: Option.getOrThrow(find(database, id)), retired: Option.flatMap(taken, (left) => find(database, left.id)) }
      }),
    forget: (id) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.transaction((database: Database) => (retire(database, id, now).changes === 0 ? Option.none<Memory>() : find(database, id))),
      ),
    restore: (id) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.transaction((database: Database): Option.Option<Kept> => {
          const forgotten = Option.filter(find(database, id), ({ forgottenAt }) => forgottenAt !== undefined)
          if (Option.isNone(forgotten)) return Option.none()
          const back = forgotten.value
          const taken = back.kind === "routine" && back.name !== undefined ? called(database, back.name) : Option.none<Memory>()
          if (!room(database, back, taken)) return Option.some({ _tag: "Full" })
          if (Option.isSome(taken)) retire(database, taken.value.id, now)
          database.query("update memories set forgotten_at = null where id = ?").run(id)
          return Option.some({ _tag: "Kept", memory: Option.getOrThrow(find(database, id)), retired: Option.flatMap(taken, (left) => find(database, left.id)) })
        }),
      ),
  }
}

/** His words as they can be said, and as they're kept otherwise, without the mark that ends them, which the line puts back. */
const words = (text: string) => Brain.sayable(text).replace(/[.!?]+$/, "").trim()

/** A routine's name, to start a sentence. */
const named = (name: string) => Brain.capital(words(name))

/** How many words of a fact name it when it can't be read out as it is. */
const naming = 6

/**
 * What's said of memories, in fixed words: a fact as he said it, when it can
 * be read out as it is, and a routine by its name, with its steps read back
 * as he said them whenever they're kept, so he hears exactly what's sent for
 * it.
 */
export const lines = (said: Pick<Lines, "address">) => {
  const sir = addressed(said)
  /** A fact as he said it, or what it's about, in its first words, when some of it can't be read out. */
  const fact = (text: string) => (Brain.readable(text) ? words(text) : `the one about ${words(text).split(/\s+/).slice(0, naming).join(" ")}`)
  /** A routine by its name and steps, read back. */
  const routine = (kept: Pick<Memory, "name" | "text">) => `${named(kept.name ?? "")}: ${words(kept.text)}.`
  return {
    /** What's said once it's kept: a routine read back, changed when it took the place of one called the same. */
    kept: (kept: Pick<Memory, "kind" | "name" | "text">, changed: boolean): string =>
      kept.kind === "routine" ? `${changed ? "Changed" : "Noted"}${sir}. ${routine(kept)}` : `Noted${sir}.`,
    /** What's said once it's forgotten, naming it. */
    forgotten: (kept: Pick<Memory, "kind" | "name" | "text">): string =>
      kept.kind === "routine" ? `Forgotten${sir}: ${words(kept.name ?? "")}.` : `Forgotten${sir}: ${fact(kept.text)}.`,
    /** What's said once one forgotten is brought back, naming it; a routine read back, changed back when it took the place of one called the same. */
    restored: (kept: Pick<Memory, "kind" | "name" | "text">, changed: boolean): string =>
      kept.kind === "routine" ? (changed ? `Changed back${sir}. ${routine(kept)}` : `Kept${sir}: ${words(kept.name ?? "")}.`) : `Kept${sir}: ${fact(kept.text)}.`,
    /** There's no more room. */
    full: `I'm keeping as much as I can${sir}. Forget something first.`,
    /** What may give a secret away is never kept. */
    secret: `I won't keep that${sir}. It looks like a secret.`,
    /** What may have been yapd's own voice is never kept, since it would be in every prompt as his. */
    echoed: `I didn't keep that${sir}: it may have been my own voice. Say it again?`,
    /** It couldn't be kept, or forgotten. */
    unwritten: `I couldn't write that down${sir}.`,
    /** It was forgotten, or brought back, already. */
    over: `There's nothing to take back${sir}.`,
  }
}
