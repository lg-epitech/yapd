import { Effect, Option, type Redacted, Schema } from "effect"
import { plain } from "./Relay.ts"
import * as T3Code from "./T3Code.ts"
import * as Server from "./T3CodeServer.ts"
import { type Detail, type Listed, type Message, type Need, type Outgoing, type State, type Threads, ThreadsError } from "./Threads.ts"

// The threads T3 Code has on this machine, read and written through its
// HTTP API. What the schema leaves optional is decoded leniently: a field T3
// Code drops or adds in a release must not take the whole listing down.

/**
 * What yapd says on a machine that has no token: threads can't come from
 * anywhere else. Worded for any machine, since it's relayed as is from another
 * one, which can't know what the speaker calls it.
 */
export const tokenless = "Picking up threads needs T3 Code, and that machine has no T3 Code token."

const nullable = <A, I>(schema: Schema.Schema<A, I>) => Schema.optionalWith(Schema.NullOr(schema), { default: () => null })
const text = Schema.optionalWith(Schema.String, { default: () => "" })
const flag = Schema.optionalWith(Schema.Boolean, { default: () => false })

const Turn = Schema.Struct({ state: text, requestedAt: nullable(Schema.String), completedAt: nullable(Schema.String) })

const Session = Schema.Struct({ status: text, lastError: nullable(Schema.String) })

/** A thread as the shell lists it, and as its detail carries it. A superset of what `T3Code` reads, so its helpers apply. */
const Thread = Schema.Struct({
  id: Schema.String,
  projectId: text,
  title: text,
  branch: nullable(Schema.String),
  worktreePath: nullable(Schema.String),
  archivedAt: nullable(Schema.String),
  deletedAt: nullable(Schema.String),
  updatedAt: text,
  runtimeMode: Schema.optionalWith(Schema.String, { default: () => "full-access" }),
  interactionMode: Schema.optionalWith(Schema.String, { default: () => "default" }),
  latestTurn: nullable(Turn),
  session: nullable(Session),
  hasPendingApprovals: flag,
  hasPendingUserInput: flag,
  hasActionableProposedPlan: flag,
})
export type Thread = typeof Thread.Type

const Project = Schema.Struct({ id: Schema.String, title: text, workspaceRoot: text })

export const Shell = Schema.Struct({
  projects: Schema.optionalWith(Schema.Array(Project), { default: () => [] }),
  threads: Schema.optionalWith(Schema.Array(Thread), { default: () => [] }),
})
export type Shell = typeof Shell.Type

/** A message as the thread carries it. A user message's id is the messageId it was dispatched with. */
const Said = Schema.Struct({ id: text, role: text, text, createdAt: nullable(Schema.String), updatedAt: nullable(Schema.String) })

const Snapshot = Schema.Struct({
  thread: Schema.Struct({ ...Thread.fields, messages: Schema.optionalWith(Schema.Array(Said), { default: () => [] }) }),
})

/** What the thread waits on the user for. */
export const needs = (thread: Thread): ReadonlyArray<Need> => [
  ...(thread.hasPendingApprovals ? (["approval"] as const) : []),
  ...(thread.hasPendingUserInput ? (["input"] as const) : []),
  ...(thread.hasActionableProposedPlan ? (["plan"] as const) : []),
]

/**
 * What keeps a message from going: an approval or an answer that T3 Code waits
 * for, which the user gives there, and nothing sent gets through until they
 * do. A plan waiting to be accepted doesn't: answering it by message is how a
 * plan is answered.
 */
const stuck = (thread: Thread) => thread.hasPendingApprovals || thread.hasPendingUserInput

/** How many of the thread's latest turns are read to see whether a message already reached it. */
const lookback = 3

/**
 * Where the thread stands. T3 Code raises an approval or a question while the
 * turn is still running, and until the user answers in T3 Code nothing moves,
 * so what it waits on counts before the turn that's running.
 */
export const state = (thread: Thread): State =>
  needs(thread).length > 0
    ? "waiting"
    : T3Code.busy(thread)
      ? "running"
      : thread.latestTurn?.state === "error" || thread.session?.status === "error"
        ? "failed"
        : thread.latestTurn?.state === "interrupted"
          ? "stopped"
          : thread.latestTurn?.state === "completed"
            ? "done"
            : "new"

const gone = (thread: Thread) => thread.archivedAt !== null || thread.deletedAt !== null

/** The thread as listed. A project the shell doesn't have leaves its name and folder blank rather than the thread out. */
export const listed = (shell: Shell, thread: Thread): Listed => {
  const project = shell.projects.find(({ id }) => id === thread.projectId)
  return {
    id: thread.id,
    project: project?.title ?? "",
    directory: thread.worktreePath ?? project?.workspaceRoot ?? "",
    title: thread.title,
    branch: thread.branch,
    state: state(thread),
    needs: needs(thread),
    requestedAt: thread.latestTurn?.requestedAt ?? null,
    completedAt: thread.latestTurn?.completedAt ?? null,
    updatedAt: thread.updatedAt,
    error: thread.session?.lastError ?? null,
  }
}

/** The threads that are still around, newest first. */
export const listing = (shell: Shell): ReadonlyArray<Listed> =>
  shell.threads
    .filter((thread) => !gone(thread))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((thread) => listed(shell, thread))

/** What the user and the agent said, oldest first. Streaming and system messages have nothing to read out. */
export const said = (messages: ReadonlyArray<typeof Said.Type>): ReadonlyArray<Message> =>
  messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
      ? [{ role: message.role, text: message.text, at: message.createdAt ?? message.updatedAt ?? "" }]
      : [],
  )

/** The message, with the ids that were chosen for it, so sending it twice can't deliver it twice. */
export const turnStart = (thread: Thread, outgoing: Outgoing) => {
  const command = T3Code.turnStart(thread, outgoing.text)
  return { ...command, commandId: outgoing.commandId, message: { ...command.message, messageId: outgoing.messageId } }
}

/** How T3 Code is reached, so tests can stand in for it. Only reads and dispatches go over HTTP. */
export interface Transport {
  readonly api: ReturnType<typeof Server.api>
}

export const connect = (token: Redacted.Redacted) => Effect.map(Server.locate, (server): Transport => ({ api: Server.api(server, token) }))

/**
 * Whether T3 Code answered 404. `api` keeps only the status and path of a
 * refused request, as "404 from /api/...", so that's what there is to go on.
 */
const missing = (error: Server.Trouble) => typeof error.cause === "string" && /^404\b/.test(error.cause)

const heard = <A, R>(effect: Effect.Effect<A, ThreadsError | Server.Trouble, R>) =>
  Effect.catchTag(effect, "Trouble", (error) => Effect.fail(new ThreadsError({ reason: error.reason, cause: error.cause })))

const archived = (what: string) => new ThreadsError({ reason: `That thread is archived, so I ${what}.`, gone: true })

export const threads = (
  token: Option.Option<Redacted.Redacted>,
  reach: (token: Redacted.Redacted) => Effect.Effect<Transport, Server.Trouble> = connect,
): Threads => {
  // Nothing stands in for T3 Code, so a machine without a token has no threads to speak of, and won't until it's set up.
  const transport = Option.match(token, { onNone: () => Effect.fail(new ThreadsError({ reason: tokenless, gone: true })), onSome: reach })

  // A 404 only means the thread is gone when the shell doesn't list it either. One the shell has that can't be
  // read right now is worth asking for again, and so is one whose absence the shell couldn't confirm: a held
  // message must not be given up on because T3 Code was out for a moment.
  const snapshot = (api: Transport["api"], id: string, query = "") =>
    api(`/api/orchestration/threads/${encodeURIComponent(id)}${query}`, Snapshot).pipe(
      Effect.catchTag("Trouble", (error) =>
        Effect.gen(function* () {
          if (!missing(error)) return yield* error
          const shell = yield* api("/api/orchestration/shell", Shell).pipe(Effect.orElseFail(() => error))
          if (shell.threads.some((thread) => thread.id === id)) return yield* error
          return yield* new ThreadsError({ reason: "T3 Code doesn't have that thread any more.", gone: true, cause: error })
        }),
      ),
    )

  return {
    list: Effect.gen(function* () {
      const { api } = yield* transport
      return listing(yield* api("/api/orchestration/shell", Shell))
    }).pipe(heard),

    detail: (id, turns) =>
      Effect.gen(function* () {
        const { api } = yield* transport
        const [shell, { thread }] = yield* Effect.all(
          [api("/api/orchestration/shell", Shell), snapshot(api, id, `?turnLimit=${Math.max(1, Math.floor(turns))}`)],
          { concurrency: "unbounded" },
        )
        if (gone(thread)) return yield* archived("can't read it")
        return { thread: listed(shell, thread), messages: said(thread.messages) } satisfies Detail
      }).pipe(heard),

    // T3 Code only pages from the newest turn back, so the first message means reading the whole thread. It's read once and kept.
    opening: (id) =>
      Effect.gen(function* () {
        const { api } = yield* transport
        const { thread } = yield* snapshot(api, id)
        if (gone(thread)) return yield* archived("can't read it")
        const first = said(thread.messages).find(({ role }) => role === "user")
        return first?.text ?? (yield* new ThreadsError({ reason: "That thread has no message from you yet." }))
      }).pipe(heard),

    send: (id, outgoing) =>
      Effect.gen(function* () {
        // A leading slash would run as a T3 Code command, like /compact, and nothing dictated means one: "/compact
        // the notes" is sent as "compact the notes" rather than turned down.
        const text = plain(outgoing.text)
        if (text === "") return yield* new ThreadsError({ reason: "I didn't catch what to send." })
        const { api } = yield* transport
        const shell = yield* api("/api/orchestration/shell", Shell)
        const thread = shell.threads.find((thread) => thread.id === id)
        if (thread === undefined) {
          return yield* new ThreadsError({ reason: "T3 Code doesn't have that thread any more, so I didn't send it.", gone: true })
        }
        if (gone(thread)) return yield* archived("didn't send it")
        // Sending now would steer the turn that's running instead of following it. Stopped on an approval or a
        // question, the thread won't move until the user answers in T3 Code, which yapd can't do for them.
        if (T3Code.busy(thread) || stuck(thread)) {
          // Unless the turn is this very message's: a try whose answer was lost finds it accepted and under way.
          // Then it went, and saying otherwise would have the user say it again.
          const { thread: read } = yield* snapshot(api, id, `?turnLimit=${lookback}`)
          if (read.messages.some((message) => message.id === outgoing.messageId)) return "sent"
          return stuck(thread) ? "waiting" : "busy"
        }
        yield* api("/api/orchestration/dispatch", Schema.Unknown, {
          method: "POST",
          body: JSON.stringify(turnStart(thread, { ...outgoing, text })),
        })
        return "sent"
      }).pipe(heard),
  }
}
