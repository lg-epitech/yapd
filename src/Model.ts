import { ConfigError, Context, Data, Effect, JSONSchema, Layer, Option, Schema } from "effect"
import { rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CodexServer from "./CodexServer.ts"
import * as Config from "./Config.ts"
import { run } from "./Process.ts"
import { json, type Name, type Provider, providers } from "./Provider.ts"
import * as Research from "./Research.ts"

export class ModelError extends Data.TaggedError("ModelError")<{ readonly cause: unknown }> {}

/** Writes everything yapd says: summaries of turns, and replies when the user interrupts. */
export class Model extends Context.Tag("yapd/Model")<
  Model,
  { readonly ask: <A, I>(schema: Schema.Schema<A, I>, prompt: string) => Effect.Effect<A, ModelError> }
>() {}

/** Writes the prompts for new work, which can be left to another model than the one that talks. */
export class WriterModel extends Context.Tag("yapd/WriterModel")<
  WriterModel,
  Model["Type"] & {
    /** Gets ready for a call that's coming, like while the user dictates. */
    readonly prepare: Effect.Effect<void>
  }
>() {}

interface Chosen {
  readonly name: Name
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly tier: string | undefined
}

interface Configured {
  readonly model: Option.Option<string>
  readonly effort: Option.Option<string>
  readonly tier: Option.Option<string>
}

const choose = (name: Name, configured: Configured, settings: { readonly effort: string; readonly tier: string }) =>
  Effect.gen(function* () {
    const provider = providers[name]
    // The provider's default effort and tier are tuned for its default model, so they only come with it.
    const { model, effort, tier } = Option.match(configured.model, {
      onNone: () => ({
        model: provider.defaults?.model,
        effort: Option.getOrElse(configured.effort, () => provider.defaults?.effort),
        tier: Option.getOrElse(configured.tier, () => provider.defaults?.tier),
      }),
      onSome: (model) => ({
        model,
        effort: Option.getOrUndefined(configured.effort),
        tier: Option.getOrUndefined(configured.tier),
      }),
    })
    if (effort !== undefined && !provider.takesEffort) {
      return yield* Effect.fail(
        ConfigError.InvalidData(
          [settings.effort],
          `${name} has no reasoning effort setting, pick a model that includes one instead`,
        ),
      )
    }
    if (tier !== undefined && name !== "codex") {
      return yield* Effect.fail(ConfigError.InvalidData([settings.tier], `${name} has no service tier setting, only codex does`))
    }
    return { name, model, effort, tier } satisfies Chosen
  })

/** What writes summaries and replies. */
export const talking = Effect.gen(function* () {
  const configured = { model: yield* Config.model, effort: yield* Config.effort, tier: yield* Config.tier }
  return yield* choose(yield* Config.provider, configured, { effort: "YAPD_EFFORT", tier: "YAPD_TIER" })
})

/**
 * What writes prompts: the same, unless it's set apart. As with the provider's
 * defaults, the effort and tier of summaries only come with their model.
 */
export const writing = Effect.gen(function* () {
  const usual = yield* talking
  const name = Option.getOrElse(yield* Config.writerProvider, () => usual.name)
  const own = { model: yield* Config.writerModel, effort: yield* Config.writerEffort, tier: yield* Config.writerTier }
  const shared = name === usual.name && Option.isNone(own.model)
  return yield* choose(
    name,
    {
      model: shared ? Option.fromNullable(usual.model) : own.model,
      effort: Option.orElse(own.effort, () => (shared ? Option.fromNullable(usual.effort) : Option.none())),
      tier: Option.orElse(own.tier, () => (shared ? Option.fromNullable(usual.tier) : Option.none())),
    },
    { effort: "YAPD_WRITER_EFFORT", tier: "YAPD_WRITER_TIER" },
  )
})

const described = ({ name, model, effort, tier }: Chosen) => [name, model, effort, tier && `${tier} tier`].filter(Boolean).join(" ")

/** Runs the CLI once for a call, from `cwd` when there is one. */
const once = (chosen: Chosen, command: Provider["command"], schema: object, prompt: string, cwd?: string) => {
  const provider = providers[chosen.name]
  const inline = JSON.stringify(schema)
  return Effect.acquireUseRelease(
    Effect.sync(() => join(tmpdir(), `yapd-schema-${crypto.randomUUID()}.json`)),
    (path) => Effect.gen(function* () {
      yield* Effect.tryPromise(() => Bun.write(path, inline)).pipe(Effect.uninterruptible)
      const { argv, stdin } = command({ prompt, ...chosen, schema: { json: inline, path } })
      // YAPD_INTERNAL keeps the call from triggering yapd's own hooks.
      return yield* run(argv, {
        ...(stdin === undefined ? {} : { stdin }),
        ...(cwd === undefined ? {} : { cwd }),
        env: { YAPD_INTERNAL: "1" },
      }).pipe(Effect.flatMap((stdout) => Effect.try(() => (provider.reply ?? json)(stdout))))
    }),
    (path) => Effect.tryPromise(() => rm(path, { force: true })).pipe(
      Effect.catchAll((error) => Effect.logWarning("Couldn't remove the model's temporary schema", error)),
    ),
  )
}

/** Asks a coding agent CLI, so it runs on the user's existing login. */
const make = (chosen: Chosen) =>
  Effect.gen(function* () {
    const provider = providers[chosen.name]
    // Codex can stay running between calls, with threads started ahead, which saves seconds each time.
    const server = chosen.name === "codex" ? Option.some(yield* CodexServer.make(chosen)) : Option.none()
    const reply = (schema: object, prompt: string) =>
      Option.match(server, {
        onNone: () => once(chosen, provider.command, schema, prompt),
        onSome: (server) =>
          server.run({ prompt, schema }).pipe(
            Effect.flatMap((text) => Effect.try(() => json(text))),
            Effect.catchTag("ServerError", (error) =>
              Effect.logWarning("Codex's app-server isn't working, starting Codex for this call", error).pipe(
                Effect.zipRight(once(chosen, provider.command, schema, prompt)),
              ),
            ),
          ),
      })

    return {
      ask: <A, I>(schema: Schema.Schema<A, I>, prompt: string) =>
        Effect.try(() => JSONSchema.make(schema)).pipe(
          Effect.flatMap((schema) => reply(schema, prompt)),
          Effect.flatMap(Schema.decodeUnknown(schema)),
          Effect.timeout("60 seconds"),
          Effect.mapError((cause) => new ModelError({ cause })),
        ),
      prepare: Option.match(server, { onNone: () => Effect.void, onSome: (server) => server.prepare }),
    }
  })

/** One model for both when they're set the same, so they share what Codex keeps ready. */
export const ProviderModel = Layer.scopedContext(
  Effect.gen(function* () {
    const [usual, writer] = [yield* talking, yield* writing]
    yield* Effect.logInfo(`Writing with ${described(usual)}`)
    const model = yield* make(usual)
    if (described(usual) === described(writer)) return Context.make(Model, model).pipe(Context.add(WriterModel, model))
    yield* Effect.logInfo(`Writing prompts with ${described(writer)}`)
    return Context.make(Model, model).pipe(Context.add(WriterModel, yield* make(writer)))
  }),
)

/**
 * Reads through projects on this machine with what writes prompts here, run
 * from the project's checkout and kept from changing anything by the CLI itself.
 */
export const researcher = Effect.map(writing, (chosen): Research.Researcher => {
  const { research } = providers[chosen.name]
  if (research === undefined) return Research.unavailable(`${chosen.name} can't be kept from changing a project, so I don't read through any with it.`)
  return {
    available: true,
    research: ({ directory, prompt, schema }) =>
      Effect.gen(function* () {
        if (!(yield* Effect.promise(() => stat(directory).then((found) => found.isDirectory(), () => false)))) {
          return yield* new Research.ResearchError({ reason: `${directory} isn't there.` })
        }
        return yield* once(chosen, research, schema, prompt, directory).pipe(
          Effect.timeout(Research.patience),
          Effect.mapError((cause) => new Research.ResearchError({ reason: `${chosen.name} couldn't read through it.`, cause })),
        )
      }),
  }
})
