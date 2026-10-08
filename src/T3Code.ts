import { Effect, Option, Schema } from "effect"
import { realpath } from "node:fs/promises"
import * as Config from "./Config.ts"
import { type Relay, RelayError, type Thread, Unreachable } from "./Relay.ts"
import * as Server from "./T3CodeServer.ts"

// T3 Code's local API, the one its own app uses. Sending through it keeps the
// thread in step: resuming the agent behind T3 Code's back would fork it.

/** Sessions the desktop app starts inherit this; `t3 serve` passes nothing, so every session is looked up. */
export const bundle = "com.t3tools.t3code"

const ShellThread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  archivedAt: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  updatedAt: Schema.String,
  status: Schema.String,
  activeRunId: Schema.NullOr(Schema.String),
})
export type ShellThread = typeof ShellThread.Type

export const Shell = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, workspaceRoot: Schema.String })),
  threads: Schema.Array(ShellThread),
  archivedThreads: Schema.optionalWith(Schema.Array(ShellThread), { default: () => [] }),
})
export type Shell = typeof Shell.Type

const Message = Schema.Struct({ role: Schema.String, text: Schema.String })
/** The thread's latest stretch, which is all a reply needs. The whole of a long thread runs to megabytes. */
const Detail = Schema.Struct({ projection: Schema.Struct({ messages: Schema.Array(Message) }) })

/** Threads that ran in `cwd`, newest first. `resolve` canonicalizes paths, like realpath. */
export const inDirectory = (shell: Shell, cwd: string, resolve: (path: string) => string) => {
  const roots = new Map(shell.projects.map((project) => [project.id, project.workspaceRoot]))
  return [...shell.threads, ...shell.archivedThreads]
    .filter((thread) => {
      const directory = thread.worktreePath ?? roots.get(thread.projectId)
      return directory !== undefined && resolve(directory) === cwd
    })
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * Whether the thread's latest turn ends with the message the hook saw. T3 Code
 * can split it across several messages, so its last few together must equal it.
 */
export const endsWith = (messages: ReadonlyArray<typeof Message.Type>, message: string) => {
  const target = normalize(message)
  const trailing: Array<string> = []
  for (let index = messages.length - 1; index >= 0 && messages[index]?.role === "assistant"; index--) {
    trailing.unshift(messages[index]!.text)
    if (normalize(trailing.join(" ")) === target) return true
  }
  return false
}

const unfinished = ["preparing", "queued", "starting", "running", "waiting"]

/** Sending while a run is under way would only queue behind it. The status can lag behind the run, so either counts. */
export const busy = (thread: ShellThread) => thread.activeRunId !== null || unfinished.includes(thread.status)

/** A message from the user, as if typed in the app. The thread keeps its own model and modes. */
export const messageDispatch = (thread: ShellThread, text: string) => ({
  type: "message.dispatch",
  commandId: `yapd:${crypto.randomUUID()}`,
  createdBy: "user",
  creationSource: "web",
  threadId: thread.id,
  messageId: crypto.randomUUID(),
  text,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
})

const canonical = (path: string) => realpath(path).catch(() => path)

/** Why T3 Code didn't take the message, to be read out. */
const refused = (error: Server.Trouble | Server.Refusal) =>
  new RelayError({
    reason: error._tag === "Trouble" ? error.reason : `T3 Code wouldn't take it. ${error.message}`,
    cause: error._tag === "Trouble" ? error.cause : error,
  })

export const make = (connect = Server.connect) => Effect.gen(function* () {
  const token = yield* Config.t3codeToken

  const send = (thread: Thread, text: string) =>
    Effect.gen(function* () {
      // Outside the app, a miss only means the session is somewhere else. Only Claude's hooks run in the
      // session's own process: Codex runs them in its shared daemon, whose environment could be anyone's.
      const miss = (reason: string, cause?: unknown) =>
        thread.agent === "claude" && thread.origin.app === bundle ? new RelayError({ reason, cause }) : new Unreachable()
      if (Option.isNone(token)) return yield* miss("I need a T3 Code token to send it messages.")
      const reach = ({ reason, cause }: Server.Trouble) => miss(reason, cause)
      const transport = yield* Effect.mapError(connect(token.value), reach)
      const api = <A, I>(path: string, schema: Schema.Schema<A, I>) => Effect.mapError(transport.api(path, schema), reach)

      const shell = yield* api("/api/orchestration/shell", Shell)
      const directories = new Set(
        [
          ...[...shell.threads, ...shell.archivedThreads].map(({ worktreePath }) => worktreePath),
          ...shell.projects.map(({ workspaceRoot }) => workspaceRoot),
        ].filter(
          (directory) => directory !== null,
        ),
      )
      const resolved = new Map(
        yield* Effect.promise(() => Promise.all([...directories].map(async (directory) => [directory, await canonical(directory)] as const))),
      )
      const cwd = yield* Effect.promise(() => canonical(thread.cwd))

      const matches: Array<ShellThread> = []
      for (const candidate of inDirectory(shell, cwd, (directory) => resolved.get(directory) ?? directory)) {
        // endsWith rejects a user message sent after the reply.
        const detail = yield* api(`/api/orchestration/threads/${encodeURIComponent(candidate.id)}/bounded`, Detail)
        if (endsWith(detail.projection.messages, thread.message)) matches.push(candidate)
      }
      const [target, ...others] = matches
      if (target === undefined) return yield* miss("That thread has moved on since, so I didn't send it.")
      // Two threads that ended the same way, like "All tests pass.", can't be told apart.
      if (others.length > 0) {
        return yield* new RelayError({ reason: "More than one thread could be it, so I didn't send it." })
      }
      if (target.archivedAt !== null) return yield* new RelayError({ reason: "That thread is archived, so I didn't send it." })
      if (busy(target)) return yield* new RelayError({ reason: "It's in the middle of another turn, so I didn't send it." })
      yield* transport.call("orchestration.dispatchCommand", messageDispatch(target, text), Schema.Unknown).pipe(Effect.mapError(refused))
    })

  return { send } satisfies Relay
})

export const relay = make()
