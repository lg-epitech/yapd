import { Effect, Either, Schema } from "effect"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Agent } from "./Payload.ts"
import { ProcessError, run } from "./Process.ts"

// What yapd knows about the agents' command lines: which models each has, how
// one is started headless or picked up again, and what its output says. A
// headless session is one process per turn, which prints what happens as JSON
// lines and exits when the turn ends.

export type Exec = (
  command: ReadonlyArray<string>,
  options?: { readonly cwd?: string },
) => Effect.Effect<string, ProcessError>

export const exec: Exec = (command, options = {}) => run(command, options)

export interface Model {
  readonly agent: Agent
  /** What the command line takes. */
  readonly name: string
  readonly title: string
  readonly aliases: ReadonlyArray<string>
  readonly efforts: ReadonlyArray<string>
}

const CodexModels = Schema.parseJson(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        display_name: Schema.String,
        visibility: Schema.optional(Schema.String),
        supported_reasoning_levels: Schema.optional(Schema.Array(Schema.Struct({ effort: Schema.String }))),
      }),
    ),
  }),
)

/** Codex's models from `codex debug models`, without the ones it keeps out of its own picker. */
export const codexModels = (stdout: string): ReadonlyArray<Model> =>
  Either.match(Schema.decodeUnknownEither(CodexModels)(stdout), {
    onLeft: () => [],
    onRight: ({ models }) =>
      models
        .filter(({ visibility }) => visibility === undefined || visibility === "list")
        .map((model) => ({
          agent: "codex" as const,
          name: model.slug,
          title: model.display_name,
          aliases: [],
          efforts: (model.supported_reasoning_levels ?? []).map(({ effort }) => effort),
        })),
  })

const ClaudeModels = Schema.parseJson(
  Schema.Struct({
    fetchedAt: Schema.Number,
    catalog: Schema.Struct({
      config: Schema.Struct({
        models: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            short_name: Schema.optional(Schema.String),
            section: Schema.optional(Schema.String),
            thinking: Schema.optional(
              Schema.Struct({ effort_options: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))) }),
            ),
          }),
        ),
      }),
    }),
  }),
)

/**
 * Claude Code's models, from the list it keeps for its own picker. It keeps one
 * per account it has signed in to, and the latest is the one in use. A short
 * name like "opus" means the newest of that family, which is the one it puts
 * up front.
 */
export const claudeModels = (files: ReadonlyArray<string>): ReadonlyArray<Model> => {
  const [latest] = files
    .flatMap((file) => Either.match(Schema.decodeUnknownEither(ClaudeModels)(file), { onLeft: () => [], onRight: (read) => [read] }))
    .toSorted((a, b) => b.fetchedAt - a.fetchedAt)
  const taken = new Set<string>()
  return (latest?.catalog.config.models ?? []).map((model) => {
    const short = model.section === "main" ? model.short_name?.toLowerCase() : undefined
    const alias = short === undefined || taken.has(short) ? [] : [short]
    alias.forEach((name) => taken.add(name))
    return {
      agent: "claude" as const,
      name: model.id,
      title: model.name,
      aliases: alias,
      efforts: (model.thinking?.effort_options ?? []).map(({ id }) => id),
    }
  })
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")

const claudeCatalogs = Effect.promise(async () => {
  const folder = join(claudeHome(), "cache", "model-catalog")
  const names = await readdir(folder).catch(() => [])
  return Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => Bun.file(join(folder, name)).text().catch(() => "")))
})

/** Whether each command line is there to run at all. */
export const installed = (): ReadonlySet<Agent> =>
  new Set((["claude", "codex"] as const).filter((agent) => Bun.which(agent) !== null))

/**
 * The models of the command lines that are installed. Codex is asked. Claude
 * Code has no command that lists them, so its own cached list is read instead,
 * which is there once it has been opened on this machine.
 */
export const models = (run: Exec = exec, has: ReadonlySet<Agent> = installed()) =>
  Effect.all(
    [
      has.has("claude") ? Effect.map(claudeCatalogs, claudeModels) : Effect.succeed([]),
      has.has("codex")
        ? run(["codex", "debug", "models"]).pipe(
            Effect.timeout("10 seconds"),
            Effect.map(codexModels),
            Effect.orElseSucceed((): ReadonlyArray<Model> => []),
          )
        : Effect.succeed([]),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.map((found) => found.flat()))

/**
 * The model a name means, by any of its names. One that Claude Code's list
 * doesn't have is still passed to it when it's named the way Claude's models
 * are, since the list can be missing or behind.
 */
export const pick = (models: ReadonlyArray<Model>, wanted: string, has: ReadonlySet<Agent>): Either.Either<Model, string> => {
  const name = wanted.trim().toLowerCase()
  const [match, ...others] = models.filter((model) =>
    [model.name, model.title, ...model.aliases].some((known) => known.toLowerCase() === name),
  )
  if (match !== undefined && others.length === 0) return Either.right(match)
  if (match !== undefined) return Either.left(`More than one model is called ${wanted.trim()}. Tell me its full name.`)
  if (name.startsWith("claude-") && has.has("claude")) {
    return Either.right({ agent: "claude", name, title: name, aliases: [], efforts: [] })
  }
  return Either.left(`I don't have a model called ${wanted.trim()} here.`)
}

/** One turn of a session: its first, or a later one that picks it up again. */
export interface Turn {
  readonly agent: Agent
  /** Claude Code takes the id of a new session. Codex makes its own, so it only has one to pick up again. */
  readonly session: string | undefined
  readonly resume: boolean
  readonly model: string
  readonly effort: string | undefined
  /** Claude Code's permission mode or Codex's sandbox, when the user set one for the sessions yapd starts. */
  readonly permissions: string | undefined
  /** Codex won't run outside a repository unless it's told to. */
  readonly repository: boolean
}

const flag = (name: string, value: string | undefined) => (value === undefined ? [] : [name, value])

/**
 * The command that runs the turn, which takes the prompt on stdin. Nothing in
 * it skips approvals unless the user's setting says so: the session runs with
 * the permissions that command line is set up with.
 */
export const command = (turn: Turn): ReadonlyArray<string> =>
  turn.agent === "claude"
    ? [
        "claude", "-p",
        ...flag(turn.resume ? "--resume" : "--session-id", turn.session),
        "--model", turn.model,
        ...flag("--effort", turn.effort),
        ...flag("--permission-mode", turn.permissions),
        "--output-format", "stream-json",
        "--verbose",
      ]
    : [
        "codex", "exec",
        ...(turn.resume ? ["resume"] : []),
        "--json",
        "--model", turn.model,
        ...flag("--config", turn.effort === undefined ? undefined : `model_reasoning_effort=${turn.effort}`),
        // Not --sandbox, which picking a session up again doesn't take.
        ...flag("--config", turn.permissions === undefined ? undefined : `sandbox_mode=${turn.permissions}`),
        ...(turn.repository ? [] : ["--skip-git-repo-check"]),
        ...(turn.resume && turn.session !== undefined ? [turn.session] : []),
        "-",
      ]

/** How the user picks the session up in a terminal. */
export const resume = (agent: Agent, session: string, directory: string) =>
  `cd ${/^[\w@%+=:,./-]+$/.test(directory) ? directory : `'${directory.replaceAll("'", `'\\''`)}'`} && ${
    agent === "claude" ? `claude --resume ${session}` : `codex resume ${session}`
  }`

/** Something the agent tried that needed an approval nobody was there to give. */
export interface Denial {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
}

/** What a turn's output has said so far. */
export interface Heard {
  readonly session?: string
  /**
   * Whether the turn got under way. Claude Code names its session before it
   * has reached the model, so a model it doesn't have only shows after that.
   */
  readonly began: boolean
  /** The agent's last message. */
  readonly message?: string
  readonly denied: ReadonlyArray<Denial>
  /** Why the turn failed, in the command line's words. */
  readonly error?: string
}

export const silence: Heard = { began: false, denied: [] }

const Line = Schema.parseJson(
  Schema.Struct({
    type: Schema.String,
    subtype: Schema.optional(Schema.String),
    session_id: Schema.optional(Schema.String),
    thread_id: Schema.optional(Schema.String),
    is_error: Schema.optional(Schema.Boolean),
    result: Schema.optional(Schema.String),
    message: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
    estimated_tokens: Schema.optional(Schema.Number),
    permission_denials: Schema.optional(
      Schema.Array(
        Schema.Struct({
          tool_name: Schema.String,
          tool_input: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
        }),
      ),
    ),
    item: Schema.optional(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  }),
)

/** Claude Code speaks for a model it couldn't reach, under a name in angle brackets. */
const real = (message: unknown) =>
  typeof message === "object" && message !== null && "model" in message && typeof message.model === "string" && !message.model.startsWith("<")

const said = (error: unknown) =>
  typeof error === "string"
    ? error
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : undefined

/** Takes in one line of a turn's output. Lines it can't read, like a warning printed in between, change nothing. */
export const hear = (agent: Agent, heard: Heard, line: string): Heard => {
  const read = Schema.decodeUnknownEither(Line)(line)
  if (Either.isLeft(read)) return heard
  const event = read.right
  if (agent === "claude") {
    if (event.type === "system" && event.subtype === "init" && event.session_id !== undefined) {
      return { ...heard, session: event.session_id }
    }
    if (event.type === "assistant" && real(event.message)) return { ...heard, began: true }
    if (event.type === "system" && event.estimated_tokens !== undefined) return { ...heard, began: true }
    if (event.type !== "result") return heard
    return {
      ...heard,
      ...(event.result === undefined || event.is_error === true ? {} : { message: event.result }),
      ...(event.is_error === true ? { error: event.result ?? "It ended on an error." } : {}),
      denied: [...heard.denied, ...(event.permission_denials ?? []).map((denial) => ({ tool: denial.tool_name, input: denial.tool_input ?? {} }))],
    }
  }
  if (event.type === "thread.started" && event.thread_id !== undefined) return { ...heard, session: event.thread_id, began: true }
  if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text !== undefined) {
    return { ...heard, message: event.item.text }
  }
  if (event.type === "turn.failed") return { ...heard, error: said(event.error) ?? "The turn failed." }
  // Codex says so when it retries, too, so this only explains a run that then fails.
  if (event.type === "error") return { ...heard, error: said(event.message) ?? "It ended on an error." }
  return heard
}

const short = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= length ? flat : `${flat.slice(0, length)}...`
}

/** What a refused step was going to do, to be said. */
export const wanted = ({ tool, input }: Denial) => {
  const text = (key: string) => (typeof input[key] === "string" ? input[key] : undefined)
  const path = text("file_path") ?? text("notebook_path")
  if (path !== undefined) return `change ${basename(path)}`
  const command = text("command")
  if (command !== undefined) return `run "${short(command, 80)}"`
  const url = text("url")
  if (url !== undefined) return `open ${url}`
  return `use ${tool}`
}
