import { Context, Data, Effect, JSONSchema, Layer, Option, Schema } from "effect"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Config from "./Config.ts"
import { run } from "./Process.ts"

export const Priority = Schema.Literal("needs-you", "done", "trivial")
export type Priority = typeof Priority.Type

export const Summary = Schema.Struct({
  priority: Priority,
  spoken: Schema.String,
})
export type Summary = typeof Summary.Type

export interface Turn {
  readonly prompt: Option.Option<string>
  readonly message: string
}

export class CondenseError extends Data.TaggedError("CondenseError")<{ readonly cause: unknown }> {}

export class Condenser extends Context.Tag("yapd/Condenser")<
  Condenser,
  { readonly condense: (turn: Turn) => Effect.Effect<Summary, CondenseError> }
>() {}

const instructions = `You turn a coding agent's final message into a short spoken update. The user is listening, not reading.

"spoken":
- At most 50 words, one to three sentences. Lead with the outcome, then anything the user must decide or do.
- If the user's prompt is given, answer what they asked rather than recounting everything the agent did.
- Natural speech: contractions, connected sentences. No lists, markdown, code, file paths or URLs. Say "the config loader", not "src/config/loader.ts". Round numbers that are hard to say, like 1,847 or 0.3127, but keep simple ones like 81.
- No filler like "I have successfully". Don't name the agent or the project; they're announced separately.
- Use the language the agent's message is written in.

"priority":
- "needs-you" if the agent asks a question, needs a decision or permission, or failed.
- "trivial" if nothing worth saying aloud happened, like a bare acknowledgement.
- "done" otherwise.`

/** Condenses with a headless `codex exec` call, so it runs on the user's existing Codex login. */
export const CodexCondenser = Layer.scoped(
  Condenser,
  Effect.gen(function* () {
    const model = yield* Config.model
    const effort = yield* Config.effort
    const schema = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const path = join(tmpdir(), `yapd-schema-${crypto.randomUUID()}.json`)
        await Bun.write(path, JSON.stringify(JSONSchema.make(Summary)))
        return path
      }),
      (path) => Effect.promise(() => rm(path, { force: true })),
    )
    const command = [
      "codex", "exec",
      "--model", model,
      "--config", `model_reasoning_effort=${effort}`,
      "--config", "project_doc_max_bytes=0",
      "--output-schema", schema,
      "--sandbox", "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      // The call must not trigger yapd's own Stop hook.
      "--disable", "hooks",
      "-",
    ]
    const decode = Schema.decode(Schema.parseJson(Summary))

    return {
      condense: (turn) => {
        const input = Option.match(turn.prompt, {
          onNone: () => `${instructions}\n\nAgent's message:\n${turn.message}`,
          onSome: (prompt) => `${instructions}\n\nUser's prompt:\n${prompt}\n\nAgent's message:\n${turn.message}`,
        })
        return run(command, { stdin: input, env: { YAPD_INTERNAL: "1" } }).pipe(
          Effect.flatMap((stdout) => decode(stdout.trim())),
          Effect.timeout("60 seconds"),
          Effect.mapError((cause) => new CondenseError({ cause })),
        )
      },
    }
  }),
)
