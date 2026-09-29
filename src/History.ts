import { Database } from "bun:sqlite"
import { Effect, Either, Schema } from "effect"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Agent } from "./Payload.ts"

// What the agents' command lines remember of their own sessions, which is all
// there is to say what was worked on lately without T3 Code to ask. Neither
// has a command that lists it, so their own files are read: Claude Code's
// transcripts, and the database Codex keeps its threads in. Both can change
// with a new version, and then there's just nothing to tell.

/** A session that ran, whoever started it. */
export interface Past {
  readonly agent: Agent
  /** Where it ran. */
  readonly directory: string
  readonly title: string
  readonly date: string
  readonly model?: string
  readonly effort?: string
}

const short = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}...`
}

const Line = Schema.parseJson(
  Schema.Struct({
    type: Schema.String,
    aiTitle: Schema.optional(Schema.String),
    customTitle: Schema.optional(Schema.String),
    perTurnEffort: Schema.optional(Schema.String),
    isSidechain: Schema.optional(Schema.Boolean),
    message: Schema.optional(
      Schema.Struct({
        model: Schema.optional(Schema.String),
        content: Schema.optional(
          Schema.Union(Schema.String, Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
        ),
      }),
    ),
  }),
)

/**
 * What a transcript of Claude Code's says its session was. The title is the
 * one Claude gave it, or else what the user first asked. Lines that can't be
 * read are skipped, like one cut in half by reading only part of the file.
 */
export const claudePast = (directory: string, transcript: string, date: string): Past | undefined => {
  let title: string | undefined
  let asked: string | undefined
  let model: string | undefined
  let effort: string | undefined
  for (const line of transcript.split("\n")) {
    const read = Schema.decodeUnknownEither(Line)(line)
    if (Either.isLeft(read) || read.right.isSidechain === true) continue
    const { type, message } = read.right
    if (type === "ai-title" || type === "custom-title") title = read.right.customTitle ?? read.right.aiTitle ?? title
    if (type === "user" && asked === undefined) {
      const content = message?.content
      asked = typeof content === "string" ? content : content?.find((part) => part.type === "text")?.text
    }
    // Anything in angle brackets is what Claude Code says to itself.
    if (type === "assistant" && message?.model !== undefined && !message.model.startsWith("<")) {
      model = message.model
      effort = read.right.perTurnEffort ?? effort
    }
  }
  const named = title ?? asked
  if (named === undefined || named.trim() === "") return undefined
  return {
    agent: "claude",
    directory,
    title: short(named),
    date,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }
}

/** The folder Claude Code keeps a directory's transcripts in. */
export const claudeFolder = (directory: string) => directory.replace(/[^a-zA-Z0-9]/g, "-")

/** Enough to find how a session started and how it ended, without reading a long one whole. */
const part = 128 * 1024

const ends = async (path: string, size: number) => {
  const file = Bun.file(path)
  if (size <= 2 * part) return file.text()
  const [head, tail] = await Promise.all([file.slice(0, part).text(), file.slice(size - part).text()])
  return `${head}\n${tail}`
}

/** The latest sessions Claude Code ran in a directory, newest first. */
export const claude = (directory: string, few: number) =>
  Effect.promise(async (): Promise<ReadonlyArray<Past>> => {
    const folder = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", claudeFolder(directory))
    const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".jsonl"))
    const files = await Promise.all(
      names.map(async (name) => {
        const path = join(folder, name)
        const { mtimeMs, size } = await stat(path).catch(() => ({ mtimeMs: 0, size: 0 }))
        return { path, mtimeMs, size }
      }),
    )
    const latest = files.toSorted((a, b) => b.mtimeMs - a.mtimeMs).slice(0, few)
    const read = await Promise.all(
      latest.map(async ({ path, mtimeMs, size }) =>
        claudePast(directory, await ends(path, size).catch(() => ""), new Date(mtimeMs).toISOString()),
      ),
    )
    return read.filter((past) => past !== undefined)
  })

const Thread = Schema.Struct({
  cwd: Schema.String,
  title: Schema.String,
  name: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  reasoning_effort: Schema.NullOr(Schema.String),
  updated_at: Schema.Number,
})

/** A thread of Codex's as yapd tells it. One without a title never got as far as a prompt. */
export const codexPast = (row: unknown): Past | undefined => {
  const read = Schema.decodeUnknownEither(Thread)(row)
  if (Either.isLeft(read)) return undefined
  const { cwd, title, name, model, reasoning_effort: effort, updated_at } = read.right
  const named = name?.trim() || title.trim()
  if (named === "") return undefined
  return {
    agent: "codex",
    directory: cwd,
    title: short(named),
    date: new Date(updated_at * 1000).toISOString(),
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
  }
}

/** How far back Codex's threads are read. */
const many = 2000

/**
 * Codex's latest threads, newest first, wherever they ran. Its database is
 * numbered by version, so the highest is the one in use. What it ran for
 * another agent's sake, like a review, isn't the user's work.
 */
export const codex = Effect.promise(async (): Promise<ReadonlyArray<Past>> => {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex")
  const version = (name: string) => Number(/^state_(\d+)\.sqlite$/.exec(name)?.[1] ?? Number.NaN)
  const [latest] = (await readdir(home).catch(() => []))
    .filter((name) => !Number.isNaN(version(name)))
    .toSorted((a, b) => version(b) - version(a))
  if (latest === undefined) return []
  try {
    const database = new Database(join(home, latest), { readonly: true })
    try {
      return database
        .query(
          `select cwd, title, name, model, reasoning_effort, updated_at from threads
           where archived = 0 and source not like '{%' order by updated_at desc limit ${many}`,
        )
        .all()
        .map(codexPast)
        .filter((past) => past !== undefined)
    } finally {
      database.close()
    }
  } catch {
    return []
  }
})
