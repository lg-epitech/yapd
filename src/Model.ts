import { ConfigError, Context, Data, Effect, JSONSchema, Layer, Option, Schema, Stream } from "effect"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CodexServer from "./CodexServer.ts"
import * as Config from "./Config.ts"
import * as Partial from "./Partial.ts"
import { run } from "./Process.ts"
import { json, type Name, type Provider, providers } from "./Provider.ts"

export class ModelError extends Data.TaggedError("ModelError")<{ readonly cause: unknown }> {}

/** A top-level field of an answer, told as soon as the model has written it. */
export type Field = (key: string, value: Partial.Value) => Effect.Effect<void>

/** Writes everything yapd says: summaries of turns, and replies when the user interrupts. */
export class Model extends Context.Tag("yapd/Model")<
  Model,
  {
    readonly ask: <A, I>(schema: Schema.Schema<A, I>, prompt: string) => Effect.Effect<A, ModelError>
    /**
     * Asks like `ask`, telling `field` each field of the answer as soon as
     * it's written, in order, while the model writes the rest: only where the
     * answer can be read as it's written, like Codex's. What it gives is the
     * whole answer, decoded, which is what counts: what was told before is
     * only ever a guess at it.
     */
    readonly stream?: <A, I>(schema: Schema.Schema<A, I>, prompt: string, field: Field) => Effect.Effect<A, ModelError>
  }
>() {}

/** Writes the prompts for new work, which can be left to another model than the one that talks. */
export class WriterModel extends Context.Tag("yapd/WriterModel")<
  WriterModel,
  Model["Type"] & {
    /** Gets ready for a call that's coming, like while the user dictates. */
    readonly prepare: Effect.Effect<void>
  }
>() {}

/** Works out what the user says to yapd, which can be left to a faster model than the one that talks, on the same CLI. */
export class BrainModel extends Context.Tag("yapd/BrainModel")<BrainModel, Model["Type"]>() {}

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

/**
 * What works out what the user says: the same, unless it's set apart, on the
 * same CLI. Its own model keeps the effort and tier set for summaries, unless
 * it has its own, but never the provider's defaults, tuned for its default
 * model.
 */
export const thinking = Effect.gen(function* () {
  const usual = yield* talking
  const own = { model: yield* Config.brainModel, effort: yield* Config.brainEffort, tier: yield* Config.brainTier }
  const shared = Option.isNone(own.model)
  const set = { effort: yield* Config.effort, tier: yield* Config.tier }
  return yield* choose(
    usual.name,
    {
      model: shared ? Option.fromNullable(usual.model) : own.model,
      effort: Option.orElse(own.effort, () => (shared ? Option.fromNullable(usual.effort) : set.effort)),
      tier: Option.orElse(own.tier, () => (shared ? Option.fromNullable(usual.tier) : set.tier)),
    },
    { effort: "YAPD_BRAIN_EFFORT", tier: "YAPD_BRAIN_TIER" },
  )
})

const described = ({ name, model, effort, tier }: Chosen) => [name, model, effort, tier && `${tier} tier`].filter(Boolean).join(" ")

/** Runs the CLI once for a call. */
const once = (chosen: Chosen, command: Provider["command"], schema: object, prompt: string) => {
  const provider = providers[chosen.name]
  const inline = JSON.stringify(schema)
  return Effect.acquireUseRelease(
    Effect.sync(() => join(tmpdir(), `yapd-schema-${crypto.randomUUID()}.json`)),
    (path) => Effect.gen(function* () {
      yield* Effect.tryPromise(() => Bun.write(path, inline)).pipe(Effect.uninterruptible)
      const { argv, stdin, env } = command({ prompt, ...chosen, schema: { json: inline, path } })
      // YAPD_INTERNAL keeps the call from triggering yapd's own hooks.
      return yield* run(argv, {
        ...(stdin === undefined ? {} : { stdin }),
        env: { ...env, YAPD_INTERNAL: "1" },
      }).pipe(Effect.flatMap((stdout) => Effect.try(() => (provider.reply ?? json)(stdout))))
    }),
    (path) => Effect.tryPromise(() => rm(path, { force: true })).pipe(
      Effect.catchAll((error) => Effect.logWarning("Couldn't remove the model's temporary schema", error)),
    ),
  )
}

/** Codex's app-server, kept running between calls. */
type Server = Effect.Effect.Success<ReturnType<typeof CodexServer.make>>

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

    /**
     * Like `reply` through the server, telling each field as Codex writes it. A
     * message it starts again is read afresh while none of it was told, and
     * fails the call once some was, which can't be taken back. Should the
     * server fail before the model wrote anything, `codex exec` answers instead,
     * its fields told all at once.
     */
    const streamed = (server: Server, schema: object, prompt: string, field: Field) =>
      Effect.suspend(() => {
        let scanner = new Partial.Scanner()
        let message: string | undefined
        let written = false
        let told = false
        let whole: string | undefined
        const read = (text: string) =>
          Effect.forEach(
            scanner.feed(text),
            (found) =>
              found._tag === "Field"
                ? Effect.zipRight(
                    Effect.sync(() => {
                      told = true
                    }),
                    field(found.key, found.value),
                  )
                : Effect.void,
            { discard: true },
          )
        return Stream.runForEach(server.stream({ prompt, schema }), (piece) => {
          if (piece._tag === "Whole") {
            whole = piece.text
            return Effect.void
          }
          written = true
          if (message !== undefined && piece.message !== message) {
            if (told) return Effect.fail(new CodexServer.TurnError({ cause: "The model started its answer again once part of it was told" }))
            scanner = new Partial.Scanner()
          }
          message = piece.message
          return read(piece.text)
        }).pipe(
          Effect.flatMap(() => Effect.try(() => json(whole ?? ""))),
          Effect.catchIf(
            (error) => error._tag === "ServerError" && !written,
            (error) =>
              Effect.logWarning("Codex's app-server isn't working, starting Codex for this call", error).pipe(
                Effect.zipRight(once(chosen, provider.command, schema, prompt)),
                Effect.tap((answer) =>
                  Effect.suspend(() => {
                    scanner = new Partial.Scanner()
                    return read(JSON.stringify(answer))
                  }),
                ),
              ),
          ),
        )
      })

    /** An answer asked for in the schema's JSON Schema, decoded with it, within a minute. */
    const decoded = <A, I, E>(schema: Schema.Schema<A, I>, answer: (shape: object) => Effect.Effect<unknown, E>) =>
      Effect.try(() => JSONSchema.make(schema)).pipe(
        Effect.flatMap(answer),
        Effect.flatMap(Schema.decodeUnknown(schema)),
        Effect.timeout("60 seconds"),
        Effect.mapError((cause) => new ModelError({ cause })),
      )

    return {
      ask: <A, I>(schema: Schema.Schema<A, I>, prompt: string) => decoded(schema, (shape) => reply(shape, prompt)),
      ...Option.match(server, {
        onNone: () => ({}),
        onSome: (server) => ({
          stream: <A, I>(schema: Schema.Schema<A, I>, prompt: string, field: Field) => decoded(schema, (shape) => streamed(server, shape, prompt, field)),
        }),
      }),
      prepare: Option.match(server, { onNone: () => Effect.void, onSome: (server) => server.prepare }),
    }
  })

/** One model for those set the same, so they share what Codex keeps ready: another has a server and threads of its own. */
export const ProviderModel = Layer.scopedContext(
  Effect.gen(function* () {
    const [usual, writer, brain] = [yield* talking, yield* writing, yield* thinking]
    yield* Effect.logInfo(`Writing with ${described(usual)}`)
    const model = yield* make(usual)
    const writes =
      described(usual) === described(writer) ? model : yield* Effect.zipRight(Effect.logInfo(`Writing prompts with ${described(writer)}`), make(writer))
    const thinks =
      described(brain) === described(usual)
        ? model
        : described(brain) === described(writer)
          ? writes
          : yield* Effect.zipRight(Effect.logInfo(`Working out what you say with ${described(brain)}`), make(brain))
    // A press gets the brain's own server ready too, as it does when the brain shares the writer's.
    const pressed =
      thinks === model || thinks === writes
        ? writes
        : { ...writes, prepare: Effect.all([writes.prepare, thinks.prepare], { concurrency: "unbounded", discard: true }) }
    return Context.make(Model, model).pipe(Context.add(WriterModel, pressed), Context.add(BrainModel, thinks))
  }),
)
