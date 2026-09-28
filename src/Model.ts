import { ConfigError, Context, Data, Effect, JSONSchema, Layer, Option, Schema } from "effect"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CodexServer from "./CodexServer.ts"
import * as Config from "./Config.ts"
import { run } from "./Process.ts"
import { json, providers } from "./Provider.ts"

export class ModelError extends Data.TaggedError("ModelError")<{ readonly cause: unknown }> {}

/** Writes everything yapd says: summaries of turns, and replies when the user interrupts. */
export class Model extends Context.Tag("yapd/Model")<
  Model,
  { readonly ask: <A, I>(schema: Schema.Schema<A, I>, prompt: string) => Effect.Effect<A, ModelError> }
>() {}

/** Asks the configured coding agent CLI, so it runs on the user's existing login. */
export const ProviderModel = Layer.scoped(
  Model,
  Effect.gen(function* () {
    const name = yield* Config.provider
    const provider = providers[name]
    const configured = { model: yield* Config.model, effort: yield* Config.effort }
    // The provider's default effort and tier are tuned for its default model, so they only come with it.
    const { model, effort, tier } = Option.match(configured.model, {
      onNone: () => ({
        model: provider.defaults?.model,
        effort: Option.getOrElse(configured.effort, () => provider.defaults?.effort),
        tier: provider.defaults?.tier,
      }),
      onSome: (model) => ({ model, effort: Option.getOrUndefined(configured.effort), tier: undefined }),
    })
    if (effort !== undefined && !provider.takesEffort) {
      return yield* Effect.fail(
        ConfigError.InvalidData(
          ["YAPD_EFFORT"],
          `${name} has no reasoning effort setting, pick a model that includes one instead`,
        ),
      )
    }
    yield* Effect.logInfo(`Writing with ${[name, model, effort, tier && `${tier} tier`].filter(Boolean).join(" ")}`)

    /** Runs the CLI once for the call. */
    const once = (schema: object, prompt: string) => {
      const inline = JSON.stringify(schema)
      return Effect.acquireUseRelease(
        Effect.promise(async () => {
          const path = join(tmpdir(), `yapd-schema-${crypto.randomUUID()}.json`)
          await Bun.write(path, inline)
          return path
        }),
        (path) => {
          const { argv, stdin } = provider.command({ prompt, model, effort, schema: { json: inline, path } })
          // YAPD_INTERNAL keeps the call from triggering yapd's own hooks.
          return run(argv, { ...(stdin === undefined ? {} : { stdin }), env: { YAPD_INTERNAL: "1" } }).pipe(
            Effect.flatMap((stdout) => Effect.try(() => (provider.reply ?? json)(stdout))),
          )
        },
        (path) => Effect.promise(() => rm(path, { force: true })),
      )
    }

    // Codex can stay running between calls, which saves starting it each time.
    const server = name === "codex" ? Option.some(yield* CodexServer.make) : Option.none()
    const reply = (schema: object, prompt: string) =>
      Option.match(server, {
        onNone: () => once(schema, prompt),
        onSome: (server) =>
          server.run({ prompt, model, effort, tier, schema }).pipe(
            Effect.flatMap((text) => Effect.try(() => json(text))),
            Effect.catchTag("ServerError", (error) =>
              Effect.logWarning("Codex's app-server isn't working, starting Codex for this call", error).pipe(
                Effect.zipRight(once(schema, prompt)),
              ),
            ),
          ),
      })

    return {
      ask: <A, I>(schema: Schema.Schema<A, I>, prompt: string) =>
        reply(JSONSchema.make(schema), prompt).pipe(
          Effect.flatMap(Schema.decodeUnknown(schema)),
          Effect.timeout("60 seconds"),
          Effect.mapError((cause) => new ModelError({ cause })),
        ),
    }
  }),
)
