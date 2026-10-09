import { Data, Effect, Schema } from "effect"

// Starting new work is handed to `yapd start` on the machine it should run on,
// like follow-ups are to `yapd relay`: what starts a session is local to it.

/** New work, as whoever wrote the prompt decided it. What it leaves out follows the launcher's own defaults. */
export const Request = Schema.Struct({
  /** The project's name, or the path to its checkout. */
  project: Schema.String,
  prompt: Schema.String,
  /** A model's name as its provider lists it, like `claude-fable-5-1`. */
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  /** Whether to work in a new worktree rather than the project's checkout. */
  worktree: Schema.optional(Schema.Boolean),
  /** The branch a new worktree starts from. */
  baseBranch: Schema.optional(Schema.String),
  /**
   * The ids yapd wrote down before asking, so asking again under them starts
   * it once. What has no ids of its own, like an agent's command line, goes
   * without, and a machine whose yapd is older ignores them.
   */
  ids: Schema.optional(Schema.Struct({ thread: Schema.String, message: Schema.String, command: Schema.String })),
})
export type Request = typeof Request.Type

/** What was really started, which can differ from what was asked: a worktree needs a repository. */
export const Started = Schema.Struct({
  thread: Schema.String,
  project: Schema.String,
  /** Where the agent works: the worktree, or the project's checkout. */
  directory: Schema.String,
  /** Not the final one in a new worktree: it gets renamed once the first turn is under way. */
  branch: Schema.NullOr(Schema.String),
  model: Schema.String,
  effort: Schema.optional(Schema.String),
  worktree: Schema.Boolean,
  /** What picks the session up in a terminal, for one that runs headless. */
  resume: Schema.optional(Schema.String),
  /** Where a headless session's output goes. */
  log: Schema.optional(Schema.String),
  /** What didn't go as asked, to be read out, like work that was meant for a worktree and isn't in one. */
  warning: Schema.optional(Schema.String),
})
export type Started = typeof Started.Type

/** What can be started on one machine, for whoever writes requests to choose from. */
export const Catalog = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      repository: Schema.Boolean,
      /** What a new worktree starts from when the request doesn't say. */
      branch: Schema.NullOr(Schema.String),
      /** Whether work starts in a new worktree when the request doesn't say. */
      worktree: Schema.Boolean,
      /** What a request that names no model gets. */
      model: Schema.optional(Schema.Struct({ name: Schema.String, effort: Schema.optional(Schema.String) })),
      /** The latest work there, newest first, since the user refers to it: "the latency thing from yesterday". */
      recent: Schema.Array(Schema.Struct({ title: Schema.String, date: Schema.String })),
    }),
  ),
  /** The models that are ready to use. A request can name one by any of its names. */
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      aliases: Schema.Array(Schema.String),
      efforts: Schema.Array(Schema.String),
    }),
  ),
})
export type Catalog = typeof Catalog.Type

/** Nothing was started, unless the reason says otherwise. The reason is read out. */
export class LaunchError extends Data.TaggedError("LaunchError")<{
  readonly reason: string
  readonly cause?: unknown
  /** It was asked for before it went wrong, so it may have started all the same. */
  readonly sent?: boolean
}> {}

/** One way of starting agents, like T3 Code's threads. Which one is used comes from configuration, and nothing falls through to another. */
export interface Launcher {
  readonly start: (request: Request) => Effect.Effect<Started, LaunchError>
  readonly catalog: Effect.Effect<Catalog, LaunchError>
}

/** Either what started, or the reason nothing did, and whether it was asked for before that went wrong, so it may have started all the same. */
export const Response = Schema.Struct({ started: Schema.optional(Started), reason: Schema.optional(Schema.String), sent: Schema.optional(Schema.Boolean) })

/**
 * What `yapd start` says on stderr once it has what to start, just before it
 * asks for it. SSH reports a connection that drops before the answer as it
 * does one it never made, so this is how the machine that asked tells that
 * it may have started all the same.
 */
export const asking = "yapd: asking for it to start."

/** `yapd start`: starts the work described on stdin and prints how it went, doing `asking` once it has what to start, before it asks for it. */
export const serve = (launcher: Launcher, input: string, asking: Effect.Effect<void> = Effect.void) =>
  Schema.decodeUnknown(Schema.parseJson(Request))(input).pipe(
    Effect.mapError(() => new LaunchError({ reason: "yapd here and on the machine that speaks don't match. Update both." })),
    Effect.filterOrFail(
      ({ prompt }) => prompt.trim() !== "",
      () => new LaunchError({ reason: "I didn't catch what to start." }),
    ),
    Effect.tap(() => asking),
    Effect.flatMap(launcher.start),
    Effect.map((started) => Response.make({ started })),
    Effect.catchTag("LaunchError", ({ reason, sent }) => Effect.succeed(Response.make({ reason, ...(sent === true ? { sent } : {}) }))),
    Effect.map((response) => JSON.stringify(response)),
  )

/** Either the catalog, or the reason there's none. */
export const Listing = Schema.Struct({ catalog: Schema.optional(Catalog), reason: Schema.optional(Schema.String) })

/** `yapd catalog`: prints what can be started here. */
export const list = (launcher: Launcher) =>
  launcher.catalog.pipe(
    Effect.map((catalog) => Listing.make({ catalog })),
    Effect.catchTag("LaunchError", ({ reason }) => Effect.succeed(Listing.make({ reason }))),
    Effect.map((listing) => JSON.stringify(listing)),
  )
