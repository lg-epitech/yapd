import { Context, Duration, Effect, Either, Layer, Option, PubSub, Queue, Redacted, Schema, Stream } from "effect"
import * as Config from "./Config.ts"
import * as Server from "./T3CodeServer.ts"

// What T3 Code's threads are doing, kept up to date as it happens, through
// the same stream its own app follows. It's how yapd knows what's running,
// what's waiting on the user and what just failed without asking each time,
// and how it hears of a thread asking something mid-turn, which no hook says.
//
// The stream only ever sends each thread whole, so what changed is worked out
// here by comparing it with what came before.

const Pending = Schema.Struct({ id: Schema.String, kind: Schema.String, createdAt: Schema.String })

const PullRequest = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  repository: Schema.String,
  source: Schema.optional(Schema.String),
  snapshot: Schema.optionalWith(
    Schema.NullOr(
      Schema.Struct({
        state: Schema.String,
        title: Schema.String,
        checksState: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
        mergeability: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
        reviewDecision: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
      }),
    ),
    { default: () => null },
  ),
})

const nullable = <A, I>(schema: Schema.Schema<A, I>) => Schema.optionalWith(Schema.NullOr(schema), { default: () => null })

/** A thread as the shell sends it, with only what yapd uses. */
export const Thread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  branch: nullable(Schema.String),
  worktreePath: nullable(Schema.String),
  modelSelection: Schema.Struct({
    instanceId: Schema.String,
    model: Schema.String,
    options: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Union(Schema.String, Schema.Boolean) }))),
  }),
  runtimeMode: Schema.optionalWith(Schema.String, { default: () => "full-access" }),
  interactionMode: Schema.optionalWith(Schema.String, { default: () => "default" }),
  /** The run that's preparing, starting or running. Not one that's only finishing background work. */
  activeRunId: nullable(Schema.String),
  activityRunStatus: nullable(Schema.String),
  /** How its latest run ended, or that it's still going. Not to be trusted for whether it's busy. */
  status: Schema.String,
  latestRunId: nullable(Schema.String),
  latestRunCompletedAt: nullable(Schema.String),
  lastError: nullable(Schema.String),
  lastErrorClass: nullable(Schema.String),
  usageLimitResetAt: nullable(Schema.String),
  /** An approval it's waiting for, or a question for the user when its kind is "user_input". Only the newest. */
  pendingRuntimeRequest: nullable(Pending),
  hasActionableProposedPlan: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  branchPullRequest: nullable(Schema.Struct({ number: Schema.Number, url: Schema.String, repository: Schema.String })),
  pullRequests: Schema.optionalWith(Schema.Array(PullRequest), { default: () => [] }),
  lineage: nullable(
    Schema.Struct({ parentThreadId: nullable(Schema.String), relationshipToParent: nullable(Schema.String) }),
  ),
  goal: nullable(Schema.Struct({ objective: Schema.String, status: Schema.String })),
  settledOverride: nullable(Schema.String),
  snoozedUntil: nullable(Schema.String),
  archivedAt: nullable(Schema.String),
  latestUserMessageAt: nullable(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type Thread = typeof Thread.Type

export const Project = Schema.Struct({ id: Schema.String, title: Schema.String, workspaceRoot: Schema.String })
export type Project = typeof Project.Type

const Item = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: Schema.Struct({
      snapshotSequence: Schema.Number,
      projects: Schema.Array(Schema.Unknown),
      threads: Schema.Array(Schema.Unknown),
    }),
    resolvedRepositoryIdentityRoots: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ kind: Schema.Literal("project.updated"), sequence: Schema.Number, project: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("project.removed"), sequence: Schema.Number, projectId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("thread.updated"), sequence: Schema.Number, thread: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("thread.removed"), sequence: Schema.Number, threadId: Schema.String }),
)
type Item = typeof Item.Type

/** What T3 Code has, as of the last thing it sent. */
export interface View {
  readonly projects: ReadonlyMap<string, Project>
  readonly threads: ReadonlyMap<string, Thread>
  readonly sequence: number
  /** Whether it has caught up once, so what it sends from then on is news rather than history. */
  readonly synced: boolean
}

export const empty: View = { projects: new Map(), threads: new Map(), sequence: 0, synced: false }

/** Something that happened to a thread, worked out from how it changed. */
export type Change =
  | { readonly _tag: "Created"; readonly thread: Thread }
  | { readonly _tag: "Started"; readonly thread: Thread }
  /** Its run ended, however: `thread.status` says how, and `thread.lastError` why it failed. */
  | { readonly _tag: "Finished"; readonly thread: Thread; readonly before: Thread }
  /** It's waiting on the user: for an approval, or with a question. */
  | { readonly _tag: "Asked"; readonly thread: Thread; readonly request: typeof Pending.Type }
  /** What it was waiting on was dealt with, here or anywhere else. */
  | { readonly _tag: "Answered"; readonly thread: Thread; readonly request: typeof Pending.Type }
  | { readonly _tag: "Renamed"; readonly thread: Thread; readonly before: Thread }
  /** Archived or deleted, which the stream doesn't tell apart. */
  | { readonly _tag: "Removed"; readonly thread: Thread }

/** Whether it's doing something, which `status` alone can't say. */
export const busy = (thread: Thread) => thread.activeRunId !== null || ["preparing", "starting", "running"].includes(thread.activityRunStatus ?? "")

/** What changed between two versions of a thread. */
export const compare = (before: Thread | undefined, after: Thread): ReadonlyArray<Change> => {
  if (before === undefined) {
    return [
      { _tag: "Created", thread: after },
      ...(busy(after) ? [{ _tag: "Started", thread: after } as const] : []),
      ...(after.pendingRuntimeRequest === null ? [] : [{ _tag: "Asked", thread: after, request: after.pendingRuntimeRequest } as const]),
    ]
  }
  const changes: Array<Change> = []
  if (before.title !== after.title) changes.push({ _tag: "Renamed", thread: after, before })
  const ran = before.activeRunId
  const runs = after.activeRunId
  // A run seen going that has stopped, or one that came and went unseen, like a quick failure while disconnected.
  const unseen =
    after.latestRunId !== null &&
    after.latestRunId !== before.latestRunId &&
    after.latestRunId !== runs &&
    after.latestRunCompletedAt !== null
  if ((ran !== null && ran !== runs) || unseen) changes.push({ _tag: "Finished", thread: after, before })
  if (runs !== null && runs !== ran) changes.push({ _tag: "Started", thread: after })
  const was = before.pendingRuntimeRequest
  const is = after.pendingRuntimeRequest
  if (was !== null && was.id !== is?.id) changes.push({ _tag: "Answered", thread: after, request: was })
  if (is !== null && is.id !== was?.id) changes.push({ _tag: "Asked", thread: after, request: is })
  return changes
}

const decodeThread = Schema.decodeUnknownEither(Thread)
const decodeProject = Schema.decodeUnknownEither(Project)

/** Decodes each on its own, so one T3 Code changed the shape of doesn't take the others with it. */
const each = <A>(values: ReadonlyArray<unknown>, decode: (value: unknown) => Either.Either<A, unknown>) =>
  values.flatMap((value) => Either.match(decode(value), { onLeft: () => [], onRight: (decoded) => [decoded] }))

/**
 * Takes in one item from the stream. Changes are only worked out once the view
 * has caught up: before that it's history. A full snapshot after a reconnect
 * is compared with what was known, so nothing that happened meanwhile is missed.
 */
export const apply = (view: View, item: Item): { readonly view: View; readonly changes: ReadonlyArray<Change> } => {
  switch (item.kind) {
    case "synchronized":
      return { view: { ...view, synced: true }, changes: [] }
    case "snapshot": {
      const projects = new Map(view.projects)
      for (const project of each(item.snapshot.projects, decodeProject)) projects.set(project.id, project)
      // A snapshot that resolves repositories only patches what it names.
      if (item.resolvedRepositoryIdentityRoots !== undefined) return { view: { ...view, projects }, changes: [] }
      const threads = new Map(each(item.snapshot.threads, decodeThread).map((thread) => [thread.id, thread]))
      const fresh = new Map(each(item.snapshot.projects, decodeProject).map((project) => [project.id, project]))
      // Once there's a baseline, what follows is news to it, even if this connection drops before catching up.
      const next: View = { projects: fresh, threads, sequence: item.snapshot.snapshotSequence, synced: view.synced }
      if (!view.synced) return { view: next, changes: [] }
      const changes = [
        ...[...threads.values()].flatMap((thread) => compare(view.threads.get(thread.id), thread)),
        ...[...view.threads.values()].filter(({ id }) => !threads.has(id)).map((thread): Change => ({ _tag: "Removed", thread })),
      ]
      return { view: next, changes }
    }
    case "project.updated":
    case "project.removed": {
      if (item.sequence <= view.sequence) return { view, changes: [] }
      const projects = new Map(view.projects)
      if (item.kind === "project.removed") projects.delete(item.projectId)
      else Either.map(decodeProject(item.project), (project) => projects.set(project.id, project))
      return { view: { ...view, projects, sequence: item.sequence }, changes: [] }
    }
    case "thread.updated": {
      if (item.sequence <= view.sequence) return { view, changes: [] }
      const decoded = decodeThread(item.thread)
      if (Either.isLeft(decoded)) return { view: { ...view, sequence: item.sequence }, changes: [] }
      const thread = decoded.right
      const threads = new Map(view.threads).set(thread.id, thread)
      const changes = view.synced ? compare(view.threads.get(thread.id), thread) : []
      return { view: { ...view, threads, sequence: item.sequence }, changes }
    }
    case "thread.removed": {
      if (item.sequence <= view.sequence) return { view, changes: [] }
      const before = view.threads.get(item.threadId)
      const threads = new Map(view.threads)
      threads.delete(item.threadId)
      const changes: ReadonlyArray<Change> = view.synced && before !== undefined ? [{ _tag: "Removed", thread: before }] : []
      return { view: { ...view, threads, sequence: item.sequence }, changes }
    }
  }
}

/** What T3 Code sends back over the socket. */
const Message = Schema.parseJson(
  Schema.Struct({
    _tag: Schema.String,
    requestId: Schema.optional(Schema.Unknown),
    values: Schema.optional(Schema.Array(Schema.Unknown)),
    exit: Schema.optional(Schema.Unknown),
  }),
)
const decodeMessage = Schema.decodeUnknownEither(Message)
const decodeItem = Schema.decodeUnknownEither(Item)

/** The app pings this often, and gives up after three go unanswered. */
const ping = Duration.seconds(5)
const missed = 3

/** How long to wait before trying again, longer each time it fails in a row. */
const backoff = (failures: number) => Duration.seconds(Math.min(30, 2 ** Math.min(failures, 5)))

type Event =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Message"; readonly data: string }
  | { readonly _tag: "Closed"; readonly reason: string }

/** How yapd reaches T3 Code's socket, so tests can stand in for it. */
export type Dial = (url: string, token: Redacted.Redacted) => {
  readonly send: (data: string) => void
  readonly close: () => void
  readonly events: (listener: (event: Event) => void) => void
}

const dial: Dial = (url, token) => {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${Redacted.value(token)}` } })
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    events: (listener) => {
      socket.onopen = () => listener({ _tag: "Open" })
      socket.onmessage = (event) => listener({ _tag: "Message", data: String(event.data) })
      socket.onerror = () => {}
      socket.onclose = (event) => listener({ _tag: "Closed", reason: event.reason || `closed with ${event.code}` })
    },
  }
}

export class T3Live extends Context.Tag("yapd/T3Live")<
  T3Live,
  {
    /** What T3 Code has right now, once it has caught up. None while it can't be reached. */
    readonly view: Effect.Effect<Option.Option<View>>
    /** What happens to its threads from now on. */
    readonly changes: Stream.Stream<Change>
  }
>() {}

/**
 * Follows T3 Code's threads for as long as the scope lasts, connecting again
 * whenever the connection drops, like when T3 Code restarts, and picking up
 * from where it left off.
 */
export const follow = (
  token: Redacted.Redacted,
  locate: Effect.Effect<Server.Server, Server.Trouble> = Server.locate,
  connect: Dial = dial,
) =>
  Effect.gen(function* () {
    let view = empty
    let live = false
    const changes = yield* PubSub.unbounded<Change>()

    /** One connection, until it drops. Returns whether it got as far as catching up. */
    const session = (server: Server.Server) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<Event>()
        const socket = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const socket = connect(`${server.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${Server.protocol}`, token)
            socket.events((event) => Queue.unsafeOffer(events, event))
            return socket
          }),
          (socket) => Effect.sync(() => socket.close()),
        )
        // A socket that isn't open, or has just closed, throws: that connection is over, and the next one starts.
        const send = (message: object) =>
          Effect.sync(() => {
            try {
              socket.send(JSON.stringify(message))
              return true
            } catch {
              return false
            }
          })
        let unanswered = 0
        const subscription = "shell"
        /** Whether this connection has caught up, which only its own marker says: after a drop, what's known is from before. */
        let caughtUp = false
        while (true) {
          const event = yield* Queue.take(events).pipe(Effect.timeout(ping), Effect.option)
          if (Option.isNone(event)) {
            if (unanswered >= missed) return caughtUp
            unanswered++
            if (!(yield* send({ _tag: "Ping" }))) return caughtUp
            continue
          }
          switch (event.value._tag) {
            case "Open":
              if (
                !(yield* send({
                  _tag: "Request",
                  id: subscription,
                  tag: "orchestration.subscribeShell",
                  payload: { requestCompletionMarker: true, ...(view.sequence > 0 ? { afterSequence: view.sequence } : {}) },
                  headers: [],
                }))
              ) {
                return caughtUp
              }
              break
            case "Closed":
              return caughtUp
            case "Message": {
              unanswered = 0
              const message = decodeMessage(event.value.data)
              if (Either.isLeft(message)) break
              const { _tag, requestId, values } = message.right
              // The subscription ended, or the connection's own calls broke, whatever the socket still answers.
              if ((_tag === "Exit" && requestId === subscription) || _tag === "Defect") return caughtUp
              if (_tag !== "Chunk" || requestId !== subscription) break
              for (const value of values ?? []) {
                const item = decodeItem(value)
                if (Either.isLeft(item)) continue
                const applied = apply(view, item.right)
                view = applied.view
                if (item.right.kind === "synchronized" && !caughtUp) {
                  caughtUp = true
                  live = true
                  yield* Effect.logInfo(`Following T3 Code: ${view.threads.size} threads in ${view.projects.size} projects`)
                }
                yield* PubSub.publishAll(changes, applied.changes)
              }
              // It sends nothing more until this one is taken in.
              if (!(yield* send({ _tag: "Ack", requestId: subscription }))) return caughtUp
            }
          }
        }
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            live = false
          }),
        ),
      )

    const loop = Effect.gen(function* () {
      let failures = 0
      let said = false
      while (true) {
        const located = yield* Effect.either(locate)
        // Whatever goes wrong with one connection, like a socket that can't be made, the next is tried.
        const caughtUp = Either.isRight(located)
          ? yield* session(located.right).pipe(
              Effect.catchAllDefect((defect) => Effect.as(Effect.logWarning("Lost T3 Code", defect), false)),
            )
          : false
        if (caughtUp) {
          failures = 0
          said = false
          yield* Effect.logInfo("Lost T3 Code, connecting again")
        } else {
          failures++
          // Once, rather than every time while T3 Code is closed.
          if (!said) yield* Effect.logInfo("Can't follow T3 Code right now, I'll keep trying")
          said = true
        }
        yield* Effect.sleep(backoff(failures))
      }
    })
    yield* Effect.forkScoped(loop)

    return {
      view: Effect.sync(() => (live && view.synced ? Option.some(view) : Option.none())),
      changes: Stream.fromPubSub(changes),
    } satisfies T3Live["Type"]
  })

/** Nothing to follow without a token: no view, and nothing ever changes. */
export const none: T3Live["Type"] = { view: Effect.succeed(Option.none()), changes: Stream.never }

export const layer = Layer.scoped(
  T3Live,
  Effect.flatMap(Config.t3codeToken, Option.match({ onNone: () => Effect.succeed(none), onSome: (token) => follow(token) })),
)
