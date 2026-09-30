import { Data, type Effect, Schema } from "effect"

// The agents' threads on each machine, as T3 Code has them. It's the only
// source: a thread it doesn't list can't be picked, and nothing falls back to
// guessing from hooks or the agents' own command lines.

/**
 * Where a thread stands, as T3 Code last saw it. "waiting" is a turn that
 * ended on something only the user can settle, like an approval.
 */
export const State = Schema.Literal("new", "running", "waiting", "done", "failed", "stopped")
export type State = typeof State.Type

/** What a thread waits on the user for. */
export const Need = Schema.Literal("approval", "input", "plan")
export type Need = typeof Need.Type

/** A thread as listed, without its messages. Archived and deleted threads are never listed. */
export const Listed = Schema.Struct({
  id: Schema.String,
  /** The project's title in T3 Code. */
  project: Schema.String,
  /** Where the agent works: its worktree, or the project's checkout. */
  directory: Schema.String,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  state: State,
  needs: Schema.Array(Need),
  /** When its latest turn was asked for, and when it ended. */
  requestedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  /** What went wrong, when T3 Code says. */
  error: Schema.NullOr(Schema.String),
})
export type Listed = typeof Listed.Type

export const Message = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
  at: Schema.String,
})
export type Message = typeof Message.Type

/** A thread with its latest turns' messages, oldest first. */
export const Detail = Schema.Struct({ thread: Listed, messages: Schema.Array(Message) })
export type Detail = typeof Detail.Type

/**
 * A message for a thread, as if the user typed it. The ids are chosen before
 * it's sent and kept, so sending it again after a crash can't deliver it twice:
 * T3 Code answers a command it already took with what it did then.
 */
export const Outgoing = Schema.Struct({ commandId: Schema.String, messageId: Schema.String, text: Schema.String })
export type Outgoing = typeof Outgoing.Type

/**
 * "busy" when the thread is in the middle of a turn, and "waiting" when it's
 * in the middle of one but stopped on an approval or an answer only the user
 * can give, in T3 Code. Nothing was sent in either case.
 */
export const Sent = Schema.Literal("sent", "busy", "waiting")
export type Sent = typeof Sent.Type

/**
 * Nothing could be listed, read or sent. The reason is read out. `gone` when
 * trying again won't help: the thread itself is archived, deleted or unknown,
 * or the machine has no T3 Code token to reach any thread with.
 */
export class ThreadsError extends Data.TaggedError("ThreadsError")<{
  readonly reason: string
  readonly gone?: boolean
  readonly cause?: unknown
}> {}

/**
 * What yapd keeps about a thread itself, to know it by when the user talks
 * about it: what the work is, in full. The user never sees it. Nothing here
 * changes as the thread goes on, so it can't drift from T3 Code.
 */
export interface Known {
  readonly machine: string
  readonly id: string
  /** The message the work started from: the prompt yapd wrote, or the user's first message for one it didn't start. */
  readonly prompt: string | null
  /** What the user dictated, for work yapd started. */
  readonly dictated: string | null
  /** The work in a few concrete sentences, as yapd put it when it started it. */
  readonly description: string | null
  /** Whether yapd started it. */
  readonly started: boolean
  /** When yapd first knew of it. */
  readonly at: string
}

/** The threads on one machine. */
export interface Threads {
  /** Newest first. */
  readonly list: Effect.Effect<ReadonlyArray<Listed>, ThreadsError>
  /** The thread with the messages of its latest `turns` turns. */
  readonly detail: (id: string, turns: number) => Effect.Effect<Detail, ThreadsError>
  /** The first message the user sent it, which is what the work started as. */
  readonly opening: (id: string) => Effect.Effect<string, ThreadsError>
  readonly send: (id: string, outgoing: Outgoing) => Effect.Effect<Sent, ThreadsError>
}
