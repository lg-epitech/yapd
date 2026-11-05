import { Effect, Option } from "effect"
import * as Config from "../Config.ts"

/** Resolve the subscription-backed agent independently of other V1 providers. */
export const modelSettings = Effect.gen(function* () {
  const codexSettings = Option.contains(yield* Effect.option(Config.provider), "codex")
  const configuredModel = yield* Config.brainModel
  const configuredEffort = yield* Config.brainEffort
  const configuredTier = yield* Config.brainTier
  const legacyModel = codexSettings ? yield* Config.model : Option.none<string>()
  const legacyEffort = codexSettings ? yield* Config.effort : Option.none<string>()
  const legacyTier = codexSettings ? yield* Config.tier : Option.none<string>()
  const model = Option.orElse(configuredModel, () => legacyModel)
  const effort = Option.orElse(configuredEffort, () => legacyEffort)
  const tier = Option.orElse(configuredTier, () => legacyTier)
  return {
    model: Option.getOrElse(model, () => "gpt-6.1-sol"),
    effort: Option.getOrElse(effort, () => "low"),
    ...Option.match(tier, { onNone: () => ({}), onSome: (tier) => ({ tier }) }),
  }
})
