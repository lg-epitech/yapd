/** The conversation protocol is independent of speech and model transport. */
export interface ThreadRef {
  readonly machine: string
  readonly id: string
}

export type InputSource = "text" | "voice"

/** Notification identity comes from the source, never from generated speech. */
export interface NotificationFact {
  readonly key: string
  readonly id: string
  readonly version: number
  /** False invalidates an earlier update, e.g. the thread resumed or was dismissed. */
  readonly eligible: boolean
  /** Uncorrelated T3 hooks retain information without risking a duplicate announcement. */
  readonly automatic?: boolean
}
export interface ExternalInput {
  readonly eventId: string
  readonly text: string
  readonly notification?: NotificationFact
}

export type ConversationItem =
  | { readonly type: "message"; readonly role: "user" | "assistant"; readonly text: string; readonly turnId: string; readonly responseId?: string; readonly source?: InputSource }
  | { readonly type: "context"; readonly text: string; readonly eventId: string }
  | { readonly type: "function_call"; readonly callId: string; readonly name: string; readonly arguments: unknown; readonly turnId: string; readonly invocationId: string }
  | { readonly type: "function_result"; readonly callId: string; readonly name: string; readonly result: unknown; readonly turnId: string; readonly invocationId: string }

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly mode: "read" | "write" | "approval"
}

export interface ToolContext {
  readonly conversationId: string
  readonly turnId: string
  readonly revision: number
  /** Persisted before execution; use this namespace for stable command IDs. */
  readonly invocationId: string
  readonly userText: string
  readonly source: InputSource
  /** Event wakes may read and speak, but cannot authorize mutations. */
  readonly authorization?: "user" | "event"
  readonly focus?: ThreadRef
  readonly signal: AbortSignal
  /** False after a newer committed turn supersedes this generation. */
  readonly isCurrent: () => boolean
  /** Includes temporary suspension while an onset is being accepted/rejected. */
  readonly canWrite: () => boolean
  readonly assertCurrent: () => void
  /** Waits out a false onset; rejects if this request is superseded. */
  readonly waitForWrite: () => Promise<void>
}

export interface Tool extends ToolDefinition {
  /** Argument validation must happen before any side effect. */
  readonly execute: (arguments_: unknown, context: ToolContext) => Promise<unknown>
}

export type ModelEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "tool_call"
      readonly callId: string
      readonly name: string
      readonly arguments: unknown
      /** Dynamic-tool transports can continue the same run after this reply. */
      readonly respond?: (result: unknown) => Promise<void>
    }
  | { readonly type: "done" }

export interface Model {
  readonly stream: (request: {
    readonly items: ReadonlyArray<ConversationItem>
    readonly tools: ReadonlyArray<ToolDefinition>
    readonly signal: AbortSignal
  }) => AsyncIterable<ModelEvent>
}

export interface UserTurn {
  readonly turnId: string
  readonly revision: number
  readonly userText: string
  readonly source: InputSource
  readonly focus?: ThreadRef
}

export type SessionEvent =
  | { readonly type: "turn_committed"; readonly conversationId: string; readonly turnId: string; readonly revision: number; readonly text: string; readonly source: InputSource }
  | { readonly type: "response_started"; readonly turnId: string; readonly responseId: string; readonly authorization?: "user" | "event" }
  | { readonly type: "text_delta"; readonly turnId: string; readonly responseId: string; readonly delta: string }
  | { readonly type: "response_done"; readonly turnId: string; readonly responseId: string; readonly text: string }
  | { readonly type: "output_cancelled"; readonly responseId: string; readonly reason: "onset" | "superseded" | "stopped" | "closed" }
  | { readonly type: "output_resumed"; readonly responseId: string; readonly text: string }
  | { readonly type: "tool_result"; readonly turnId: string; readonly invocationId: string; readonly name: string; readonly result: unknown; readonly stale: boolean }
  | { readonly type: "error"; readonly turnId?: string; readonly responseId?: string; readonly message: string }
  | { readonly type: "external"; readonly eventId: string; readonly text: string }
  | { readonly type: "playback"; readonly responseId: string; readonly playedMs: number; readonly state: "playing" | "finished" | "interrupted"; readonly certainty: "exact" | "approximate"; readonly playedText?: string }

export class SupersededError extends Error {
  constructor() {
    super("The request was superseded before this action could run.")
    this.name = "SupersededError"
  }
}
