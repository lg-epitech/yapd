import { Config } from "effect"

export const port = Config.integer("YAPD_PORT").pipe(Config.withDefault(4747))

/** Model used to condense agent messages, passed to `codex exec --model`. */
export const model = Config.string("YAPD_MODEL").pipe(Config.withDefault("gpt-6-luna"))

/** Reasoning effort for that model. Luna needs some to stay coherent. */
export const effort = Config.literal("low", "medium", "high", "xhigh")("YAPD_EFFORT").pipe(Config.withDefault("high"))

/** macOS voice name for `say -v`; the system voice when unset. */
export const voice = Config.option(Config.string("YAPD_VOICE"))
