import { Effect, Option, Schema } from "effect"
import * as Server from "./T3CodeServer.ts"

// What yapd can do to T3 Code's threads for the user: read where one got to,
// tell it something, stop it, answer what it's waiting on, and tidy it away.
// Each is a command T3 Code's own app sends, so its view stays in step.

const Message = Schema.Struct({
  role: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
  streaming: Schema.optionalWith(Schema.Boolean, { default: () => false }),
})

const Run = Schema.Struct({ id: Schema.String, status: Schema.String, ordinal: Schema.Number })

const Option_ = Schema.Struct({ decision: Schema.String, label: Schema.String })

const Question = Schema.Struct({
  id: Schema.String,
  header: Schema.optionalWith(Schema.String, { default: () => "" }),
  question: Schema.String,
  options: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        description: Schema.optionalWith(Schema.String, { default: () => "" }),
        /** What the answer carries when it isn't the label, as some forms have. */
        value: Schema.optional(Schema.String),
      }),
    ),
    { default: () => [] },
  ),
  multiSelect: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  allowCustomAnswer: Schema.optionalWith(Schema.Boolean, { default: () => true }),
})

/** What a thread waits on, as its turn items describe it. Anything else in them is left alone. */
const Item = Schema.Struct({
  type: Schema.String,
  status: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  requestKind: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  options: Schema.optional(Schema.Array(Option_)),
  questions: Schema.optional(Schema.Array(Question)),
  input: Schema.optional(Schema.Unknown),
})

const Plan = Schema.Struct({
  kind: Schema.String,
  status: Schema.String,
  markdown: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String, status: Schema.String }))),
})

const Bounded = Schema.Struct({
  projection: Schema.Struct({
    runs: Schema.Array(Run),
    messages: Schema.Array(Message),
    turnItems: Schema.Array(Schema.Unknown),
    plans: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
  }),
})

/** What a thread waits on the user for, in words that can be read out and answered. */
export type Request =
  | {
      readonly _tag: "Approval"
      readonly id: string
      /** What it wants to do, like the command it would run. */
      readonly what: string
      readonly kind: string
      /** The decisions it takes, like accept or decline. Every decision when the agent didn't say. */
      readonly decisions: ReadonlyArray<{ readonly decision: string; readonly label: string }>
    }
  | {
      readonly _tag: "Question"
      readonly id: string
      readonly questions: ReadonlyArray<typeof Question.Type>
    }

/** What answering with an option sends: its value when it has one, which isn't always its label. */
export const choice = (option: { readonly label: string; readonly value?: string | undefined }) => option.value ?? option.label

/** Where a thread got to: its latest messages, and what it waits on, if anything. */
export interface Detail {
  /** Oldest first, the last few. */
  readonly messages: ReadonlyArray<typeof Message.Type>
  readonly runs: ReadonlyArray<typeof Run.Type>
  readonly request: Option.Option<Request>
  /** Its plan or to-do list, if it has one under way. */
  readonly plan: Option.Option<string>
}

const decodeItem = Schema.decodeUnknownOption(Item)
const decodePlan = Schema.decodeUnknownOption(Plan)

const every = [
  { decision: "accept", label: "Allow" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "decline", label: "Deny" },
]

/** Reads what a thread waits on out of its turn items, by the request's id. */
export const request = (items: ReadonlyArray<unknown>, id: string): Option.Option<Request> => {
  for (const item of items.toReversed().map((item) => decodeItem(item))) {
    if (Option.isNone(item) || item.value.requestId !== id) continue
    const found = item.value
    if (found.type === "user_input_request" && found.questions !== undefined) {
      return Option.some({ _tag: "Question", id, questions: found.questions })
    }
    if (found.type === "approval_request") {
      const command = typeof found.input === "string" ? found.input : undefined
      return Option.some({
        _tag: "Approval",
        id,
        what: found.prompt ?? found.title ?? command ?? "something it needs your permission for",
        kind: found.requestKind ?? "permission",
        decisions: found.options !== undefined && found.options.length > 0 ? found.options : every,
      })
    }
  }
  return Option.none()
}

/** A plan under way, as a few lines. */
export const plan = (plans: ReadonlyArray<unknown>): Option.Option<string> => {
  const active = plans.flatMap((plan) => Option.toArray(decodePlan(plan))).filter(({ status }) => status === "active")
  const latest = active.at(-1)
  if (latest === undefined) return Option.none()
  if (latest.steps !== undefined) return Option.some(latest.steps.map(({ text, status }) => `- [${status}] ${text}`).join("\n"))
  return Option.fromNullable(latest.markdown)
}

/** How many of a thread's messages are read back. */
const recent = 6

export type Command =
  | { readonly _tag: "Send"; readonly text: string; /** Into the turn under way, rather than after it. */ readonly steer: boolean }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Decide"; readonly requestId: string; readonly decision: string }
  | { readonly _tag: "Answer"; readonly requestId: string; readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>> }
  | { readonly _tag: "Dismiss"; readonly requestId: string }
  | { readonly _tag: "Archive" }
  | { readonly _tag: "Unarchive" }
  | { readonly _tag: "Rename"; readonly title: string }
  | { readonly _tag: "Snooze"; readonly until: string }
  | { readonly _tag: "Settle" }
  | { readonly _tag: "Pin" }

/** The command T3 Code takes for it, under an id of its own, so sending it twice does it once. */
export const command = (threadId: string, what: Command, runId: string | undefined, commandId: string) => {
  const base = { commandId, threadId }
  switch (what._tag) {
    case "Send":
      return {
        ...base,
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        messageId: crypto.randomUUID(),
        text: what.text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        // As the app does: into the turn under way when the agent can take it, and after it when it can't.
        ...(what.steer ? { deliveryIntent: "auto" } : {}),
      }
    case "Stop":
      return { ...base, type: "run.interrupt", runId, holdQueue: true }
    case "Decide":
      return { ...base, type: "runtime-request.respond", requestId: what.requestId, decision: what.decision }
    case "Answer":
      return { ...base, type: "runtime-request.respond", requestId: what.requestId, answers: what.answers }
    case "Dismiss":
      return { ...base, type: "thread.user-input.dismiss", requestId: what.requestId }
    case "Archive":
      return { ...base, type: "thread.archive" }
    case "Unarchive":
      return { ...base, type: "thread.unarchive" }
    case "Rename":
      return { ...base, type: "thread.metadata.update", title: what.title }
    case "Snooze":
      return { ...base, type: "thread.snooze", snoozedUntil: what.until }
    case "Settle":
      return { ...base, type: "thread.settle" }
    case "Pin":
      return { ...base, type: "thread.pin" }
  }
}

/** Runs that are still going, and can be stopped. */
const going = ["preparing", "starting", "running", "waiting"]

const Dispatched = Schema.Struct({ sequence: Schema.Number })

const Search = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      projectId: Schema.String,
      source: Schema.String,
      snippet: Schema.String,
      messageCreatedAt: Schema.NullOr(Schema.String),
    }),
  ),
})

const Limits = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      displayName: Schema.optional(Schema.String),
      enabled: Schema.Boolean,
      status: Schema.String,
      usageLimits: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            windows: Schema.optionalWith(
              Schema.Array(
                Schema.Struct({
                  kind: Schema.String,
                  label: Schema.String,
                  usedPercent: Schema.Number,
                  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
                  windowDurationMins: Schema.optional(Schema.NullOr(Schema.Number)),
                }),
              ),
              { default: () => [] },
            ),
          }),
        ),
      ),
    }),
  ),
})

/** One of a provider's limits: "session", "weekly", "monthly" or "other", as T3 Code labels it, and how long it lasts when it says. */
export interface Window {
  readonly kind: string
  readonly label: string
  readonly minutes: number | undefined
  readonly usedPercent: number
  readonly resetsAt: string | undefined
}

/** What T3 Code says each provider has used of its limits. */
export type Usage = ReadonlyArray<{ readonly provider: string; readonly windows: ReadonlyArray<Window> }>

/** Why T3 Code wouldn't, in words that can be read out. */
export const reason = (error: Server.Trouble | Server.Refusal) =>
  error._tag === "Trouble"
    ? error.reason
    : error.tag === "EnvironmentAuthorizationError"
      ? "My T3 Code token isn't allowed to do that."
      : error.message

export const make = (reach: Effect.Effect<Server.Transport, Server.Trouble>) => ({
  /** Where it got to. `pending` is the request the shell says it waits on, when it knows. */
  detail: (threadId: string, pending?: string) =>
    Effect.gen(function* () {
      const { api } = yield* reach
      const { projection } = yield* api(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, Bounded)
      // Otherwise the newest that's still waiting.
      const waiting =
        pending ??
        projection.turnItems
          .flatMap((item) => Option.toArray(decodeItem(item)))
          .filter(({ type, status }) => (type === "approval_request" || type === "user_input_request") && (status === "waiting" || status === "pending"))
          .at(-1)?.requestId
      return {
        messages: projection.messages.filter(({ role }) => role !== "system").slice(-recent),
        runs: projection.runs,
        request: Option.flatMap(Option.fromNullable(waiting), (id) => request(projection.turnItems, id)),
        plan: plan(projection.plans),
      } satisfies Detail
    }),

  /** Does it to the thread. Stopping goes for the run under way, and fails when there's none. */
  run: (threadId: string, what: Command, commandId: string = `yapd:${crypto.randomUUID()}`) =>
    Effect.gen(function* () {
      const { api, call } = yield* reach
      let runId: string | undefined
      if (what._tag === "Stop") {
        const { projection } = yield* api(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, Bounded)
        runId = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal).find(({ status }) => going.includes(status))?.id
        if (runId === undefined) return yield* new Server.Refusal({ tag: "NotRunning", message: "It isn't doing anything right now." })
      }
      return yield* call("orchestration.dispatchCommand", command(threadId, what, runId, commandId), Dispatched)
    }),

  search: (query: string) =>
    Effect.gen(function* () {
      const { call } = yield* reach
      const trimmed = query.trim().slice(0, 200)
      if (trimmed.length < 2) return []
      const { matches } = yield* call("orchestration.searchThreads", { query: trimmed, limit: 20 }, Search)
      return matches
    }),

  usage: Effect.gen(function* () {
    const { call } = yield* reach
    const { providers } = yield* call("server.getConfig", {}, Limits)
    return providers
      .filter(({ enabled, status }) => enabled && status !== "disabled")
      .flatMap(({ instanceId, displayName, usageLimits }) =>
        usageLimits === undefined || usageLimits === null || usageLimits.windows.length === 0
          ? []
          : [
              {
                provider: displayName ?? instanceId,
                windows: usageLimits.windows.map(({ kind, label, windowDurationMins, usedPercent, resetsAt }) => ({
                  kind,
                  label,
                  minutes: windowDurationMins ?? undefined,
                  usedPercent,
                  resetsAt: resetsAt ?? undefined,
                })),
              },
            ],
      ) satisfies Usage
  }),
})

export type Actions = ReturnType<typeof make>
