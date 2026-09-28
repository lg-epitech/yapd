import { Schema } from "effect"

// Claude Code and Codex send the same field names to their hooks.

export const Agent = Schema.Literal("claude", "codex")
export type Agent = typeof Agent.Type

export const Stop = Schema.Struct({
  hook_event_name: Schema.Literal("Stop"),
  session_id: Schema.String,
  cwd: Schema.String,
  last_assistant_message: Schema.optional(Schema.NullOr(Schema.String)),
})

export const PromptSubmit = Schema.Struct({
  hook_event_name: Schema.Literal("UserPromptSubmit"),
  session_id: Schema.String,
  cwd: Schema.String,
  prompt: Schema.optional(Schema.String),
})

export const Payload = Schema.Union(Stop, PromptSubmit)
export type Payload = typeof Payload.Type
