import type { Database } from "bun:sqlite"
import { Clock, Effect, Option } from "effect"
import * as Brain from "./Brain.ts"
import { addressed, type Lines } from "./Persona.ts"
import type * as Preferences from "./Preferences.ts"
import type * as Store from "./Store.ts"

// What he asked yapd to keep in mind, by voice: facts about him and his work,
// and routines, steps sent to a thread whenever he says their name. Each is
// his words, kept beside all he said as he said it, and goes into every
// prompt, so there's only so much of it, and nothing is ever left out of a
// prompt to make room: past that, he's told to forget something first. It's
// information, never something to do: only a routine's name, said, sends its
// steps, as any message he sends goes. A routine in his preferences is the one
// for its name: one kept by voice called the same is kept still, but goes
// nowhere and counts toward nothing until that line goes.

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
 * took the place of, called the same, if it did; the fact kept already that
 * says the same, as nothing changed; or not, as there's no more room.
 */
export type Kept =
  | { readonly _tag: "Kept"; readonly memory: Memory; readonly retired: Option.Option<Memory> }
  | { readonly _tag: "Already"; readonly memory: Memory }
  | { readonly _tag: "Full" }

interface Row {
  readonly id: number
  readonly at: number
  readonly kind: Kind
  readonly name: string | null
  readonly called: string | null
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

/** Whether one is a routine kept by voice that one in his preferences, by its names as names compare, is called the same as. */
const shadowed = (theirs: ReadonlySet<string>) => (kept: Pick<Memory, "kind" | "name">) =>
  kept.kind === "routine" && kept.name !== undefined && theirs.has(Brain.calledAs(kept.name))

export interface Memories {
  /** What's kept, oldest first, but a routine kept by voice that one in his preferences is called the same as, which is the one. */
  readonly list: Effect.Effect<ReadonlyArray<Memory>>
  /**
   * Keeps one, if there's room: a routine called as one kept already, as
   * names compare, takes its place, as one, and gives it back, so taking this back
   * brings it back. A fact kept already that says the same is given back as
   * kept already, and nothing new is.
   */
  readonly add: (asked: Asked) => Effect.Effect<Kept, Store.StoreError>
  /** Forgets one kept, and gives it back: none when it isn't kept. */
  readonly forget: (id: number) => Effect.Effect<Option.Option<Memory>, Store.StoreError>
  /**
   * Brings back one forgotten, if there's room, and gives it back: a routine
   * whose name another took since takes its place again, as one, so taking
   * back what took its place puts them as they were. A fact kept since that
   * says the same is given back as kept already, and this stays forgotten.
   * None when it wasn't forgotten.
   */
  readonly restore: (id: number) => Effect.Effect<Option.Option<Kept>, Store.StoreError>
}

/** The memories kept in `store`, beside his routines `written` in his preferences, read as they are now. */
export const make = (store: Store.Store["Type"], written: Effect.Effect<ReadonlyArray<Preferences.Routine>> = Effect.succeed([])): Memories => {
  /** Whether one kept by voice is a routine one in his preferences is called the same as, as they are now. */
  const hidden = Effect.map(written, (routines) => shadowed(new Set(routines.map(({ name }) => Brain.calledAs(name)))))
  const find = (database: Database, id: number) => Option.map(Option.fromNullable(database.query<Row, [number]>("select * from memories where id = ?").get(id)), memory)
  /** The routine kept now under a name, as names compare, symbols and all, as the index tells it, so "C" is never "C++". */
  const called = (database: Database, name: string) =>
    Option.map(
      Option.fromNullable(database.query<Row, [string]>("select * from memories where kind = 'routine' and forgotten_at is null and called = ?").get(Brain.calledAs(name))),
      memory,
    )
  /**
   * The fact kept now that says the same, word for word, whatever their case,
   * or a comma or full stop: two such could never be told apart to forget
   * one, and forgetting one would leave the other. Symbols and all, so "rig
   * uses C" never stands for "rig uses C++".
   */
  const same = (database: Database, text: string) => {
    const words = Brain.worded(text)
    return Option.map(
      Option.fromNullable(database.query<Row, []>("select * from memories where kind = 'fact' and forgotten_at is null").all().find((row) => Brain.worded(row.text) === words)),
      memory,
    )
  }
  /**
   * Whether there's room for one more, `leaving` aside, which it takes the
   * place of, as is what `hides`: a routine one in his preferences is called
   * the same as, which counts toward nothing.
   */
  const room = (database: Database, adding: Pick<Memory, "kind" | "name" | "text">, leaving: Option.Option<Memory>, hides: (kept: Pick<Memory, "kind" | "name">) => boolean) => {
    const kept = database
      .query<Row, []>("select * from memories where forgotten_at is null")
      .all()
      .map(memory)
      .filter((row) => !hides(row) && !Option.exists(leaving, (left) => left.id === row.id))
    const counted = hides(adding) ? [] : [adding]
    return kept.length + counted.length <= most && [...kept, ...counted].reduce((sum, row) => sum + size(row), 0) <= longest
  }
  const retire = (database: Database, id: number, at: number) => database.query("update memories set forgotten_at = ? where id = ? and forgotten_at is null").run(at, id)
  return {
    list: Effect.flatMap(hidden, (hides) =>
      store.transaction((database: Database) =>
        database
          .query<Row, []>("select * from memories where forgotten_at is null order by id")
          .all()
          .map(memory)
          .filter((kept) => !hides(kept)),
      ),
    ).pipe(Effect.catchAll((error) => Effect.logWarning("Could not read what you asked me to remember", error).pipe(Effect.as<ReadonlyArray<Memory>>([])))),
    add: (asked) =>
      Effect.flatMap(hidden, (hides) =>
        store.transaction((database: Database): Kept => {
          // Said again, as when he didn't hear it was noted, it's kept once, and nothing changed.
          const kept = asked.kind === "fact" ? same(database, asked.text) : Option.none<Memory>()
          if (Option.isSome(kept)) return { _tag: "Already", memory: kept.value }
          const taken = asked.kind === "routine" && asked.name !== undefined ? called(database, asked.name) : Option.none<Memory>()
          if (!room(database, asked, taken, hides)) return { _tag: "Full" }
          // Retired first, since only one routine is kept under a name.
          if (Option.isSome(taken)) retire(database, taken.value.id, asked.at)
          const name = asked.kind === "routine" ? asked.name : undefined
          const id = Number(
            database
              .query("insert into memories (at, kind, name, called, text, heard, utterance) values (?, ?, ?, ?, ?, ?, ?)")
              .run(
                asked.at,
                asked.kind,
                name ?? null,
                name === undefined ? null : Brain.calledAs(name),
                asked.text,
                asked.heard,
                asked.utterance ?? null,
              ).lastInsertRowid,
          )
          return { _tag: "Kept", memory: Option.getOrThrow(find(database, id)), retired: Option.flatMap(taken, (left) => find(database, left.id)) }
        }),
      ),
    forget: (id) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.transaction((database: Database) => (retire(database, id, now).changes === 0 ? Option.none<Memory>() : find(database, id))),
      ),
    restore: (id) =>
      Effect.flatMap(Effect.zip(Clock.currentTimeMillis, hidden), ([now, hides]) =>
        store.transaction((database: Database): Option.Option<Kept> => {
          const forgotten = Option.filter(find(database, id), ({ forgottenAt }) => forgottenAt !== undefined)
          if (Option.isNone(forgotten)) return Option.none()
          const back = forgotten.value
          const kept = back.kind === "fact" ? same(database, back.text) : Option.none<Memory>()
          if (Option.isSome(kept)) return Option.some({ _tag: "Already", memory: kept.value })
          const taken = back.kind === "routine" && back.name !== undefined ? called(database, back.name) : Option.none<Memory>()
          if (!room(database, back, taken, hides)) return Option.some({ _tag: "Full" })
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
 * be read out as it is, read back whenever it's kept, so he hears exactly
 * what's kept of what he said, and a routine by its name, with its steps
 * read back as he said them whenever they're kept, so he hears exactly
 * what's sent for it.
 */
export const lines = (said: Pick<Lines, "address">) => {
  const sir = addressed(said)
  /** A fact as he said it, or what it's about, in its first words, when some of it can't be read out. */
  const fact = (text: string) => (Brain.readable(text) ? words(text) : `the one about ${words(text).split(/\s+/).slice(0, naming).join(" ")}`)
  /** A routine by its name and steps, read back. */
  const routine = (kept: Pick<Memory, "name" | "text">) => `${named(kept.name ?? "")}: ${words(kept.text)}.`
  return {
    /** What's said once it's kept, or found kept already: read back, a routine changed when it took the place of one called the same. */
    kept: (kept: Pick<Memory, "kind" | "name" | "text">, changed: boolean): string =>
      kept.kind === "routine" ? `${changed ? "Changed" : "Noted"}${sir}. ${routine(kept)}` : `Noted${sir}: ${fact(kept.text)}.`,
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
