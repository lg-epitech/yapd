import { Effect, Option, Schema } from "effect"
import { realpath } from "node:fs/promises"
import * as Config from "./Config.ts"
import { type Relay, RelayError, type Thread, Unreachable } from "./Relay.ts"
import * as Server from "./T3CodeServer.ts"

// T3 Code's local API, the one its own CLI uses. Sending through it keeps the
// thread in step: resuming the agent behind T3 Code's back would fork it.

/** Sessions the desktop app starts inherit this; `t3 serve` passes nothing, so every session is looked up. */
export const bundle = "com.t3tools.t3code"

const ShellThread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  runtimeMode: Schema.String,
  interactionMode: Schema.optionalWith(Schema.String, { default: () => "default" }),
  worktreePath: Schema.NullOr(Schema.String),
  archivedAt: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  updatedAt: Schema.String,
  latestTurn: Schema.NullOr(Schema.Struct({ state: Schema.String })),
  session: Schema.NullOr(Schema.Struct({ status: Schema.String })),
})
export type ShellThread = typeof ShellThread.Type

export const Shell = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, workspaceRoot: Schema.String })),
  threads: Schema.Array(ShellThread),
})
export type Shell = typeof Shell.Type

const Message = Schema.Struct({ role: Schema.String, text: Schema.String })
const Detail = Schema.Struct({ thread: Schema.Struct({ messages: Schema.Array(Message) }) })

/** Threads that ran in `cwd`, newest first. `resolve` canonicalizes paths, like realpath. */
export const inDirectory = (shell: Shell, cwd: string, resolve: (path: string) => string) => {
  const roots = new Map(shell.projects.map((project) => [project.id, project.workspaceRoot]))
  return shell.threads
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

/** Sending while a turn runs would steer it instead. */
export const busy = (thread: ShellThread) =>
  thread.latestTurn?.state === "running" || thread.session?.status === "running" || thread.session?.status === "starting"

/** A message from the user. The thread's modes are required, and T3 Code keeps its own anyway. */
export const turnStart = (thread: ShellThread, text: string) => ({
  type: "thread.turn.start",
  commandId: `yapd:${crypto.randomUUID()}`,
  threadId: thread.id,
  message: { messageId: crypto.randomUUID(), role: "user", text, attachments: [] },
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  createdAt: new Date().toISOString(),
})

const canonical = (path: string) => realpath(path).catch(() => path)

/** A read of T3 Code's API, with whatever the caller makes of its failures. */
type Api<E> = <A, I>(path: string, schema: Schema.Schema<A, I>, init?: RequestInit) => Effect.Effect<A, E>

/**
 * The threads that ran in the session's directory and whose latest turn ends
 * with the message the hook saw, newest first. Two threads that ended the same
 * way, like "All tests pass.", can't be told apart, so more than one is a miss.
 */
export const matching = <E>(api: Api<E>, thread: Pick<Thread, "cwd" | "message">) =>
  Effect.gen(function* () {
    const shell = yield* api("/api/orchestration/shell", Shell)
    const directories = new Set(
      [...shell.threads.map(({ worktreePath }) => worktreePath), ...shell.projects.map(({ workspaceRoot }) => workspaceRoot)].filter(
        (directory) => directory !== null,
      ),
    )
    const resolved = new Map(
      yield* Effect.promise(() => Promise.all([...directories].map(async (directory) => [directory, await canonical(directory)] as const))),
    )
    const cwd = yield* Effect.promise(() => canonical(thread.cwd))

    const matches: Array<ShellThread> = []
    for (const candidate of inDirectory(shell, cwd, (directory) => resolved.get(directory) ?? directory)) {
      const detail = yield* api(`/api/orchestration/threads/${encodeURIComponent(candidate.id)}?turnLimit=1`, Detail)
      if (endsWith(detail.thread.messages, thread.message)) matches.push(candidate)
    }
    return matches
  })

/** The thread's id when exactly one matches. None is as good as two: either way it can't be told which. */
export const identified = <E>(api: Api<E>, thread: Pick<Thread, "cwd" | "message">) =>
  Effect.map(matching(api, thread), (matches) => (matches.length === 1 ? Option.some(matches[0]!.id) : Option.none()))

/** How long an update waits on T3 Code to say which thread it came from. Short, since the update is worth more than the link. */
const glance = "2 seconds"

/**
 * Which T3 Code thread an update came from, so that "tell that one to" can
 * follow it. Only for sessions the app started: every other session would cost
 * T3 Code a read per thread in its directory on each update, for nothing.
 * Never fails and never takes long: when T3 Code can't say in time, or two
 * threads could be it, there's no link.
 */
export const identify = Effect.gen(function* () {
  const token = yield* Config.t3codeToken
  return (thread: Thread): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      if (thread.origin.app !== bundle || Option.isNone(token)) return Option.none<string>()
      const server = yield* Server.locate
      return yield* identified(Server.api(server, token.value), thread)
    }).pipe(
      Effect.timeout(glance),
      Effect.catchAll((error) => Effect.logDebug("Couldn't tell which T3 Code thread that was", error).pipe(Effect.as(Option.none()))),
    )
})

export const relay = Effect.gen(function* () {
  const token = yield* Config.t3codeToken

  const send = (thread: Thread, text: string) =>
    Effect.gen(function* () {
      // Outside the app, a miss only means the session is somewhere else. Only Claude's hooks run in the
      // session's own process: Codex runs them in its shared daemon, whose environment could be anyone's.
      const miss = (reason: string, cause?: unknown) =>
        thread.agent === "claude" && thread.origin.app === bundle ? new RelayError({ reason, cause }) : new Unreachable()
      if (Option.isNone(token)) return yield* miss("I need a T3 Code token to send it messages.")
      const reach = ({ reason, cause }: Server.Trouble) => miss(reason, cause)
      const server = yield* Effect.mapError(Server.locate, reach)
      const request = Server.api(server, token.value)
      const api = <A, I>(path: string, schema: Schema.Schema<A, I>, init: RequestInit = {}) =>
        Effect.mapError(request(path, schema, init), reach)

      const [target, ...others] = yield* matching(api, thread)
      if (target === undefined) return yield* miss("That thread has moved on since, so I didn't send it.")
      // Two threads that ended the same way, like "All tests pass.", can't be told apart.
      if (others.length > 0) {
        return yield* new RelayError({ reason: "More than one thread could be it, so I didn't send it." })
      }
      if (target.archivedAt !== null) return yield* new RelayError({ reason: "That thread is archived, so I didn't send it." })
      if (busy(target)) return yield* new RelayError({ reason: "It's in the middle of another turn, so I didn't send it." })
      yield* api("/api/orchestration/dispatch", Schema.Unknown, {
        method: "POST",
        body: JSON.stringify(turnStart(target, text)),
      })
    })

  return { send } satisfies Relay
})
