import { Config, Schema } from "effect"
import * as Provider from "./Provider.ts"

export const port = Config.integer("YAPD_PORT").pipe(Config.withDefault(4747))

/** Coding agent CLI used to condense agent messages. */
export const provider = Schema.Config("YAPD_PROVIDER", Provider.Name).pipe(Config.withDefault("codex" as const))

/** Model for that CLI, in whatever form it takes. Defaults to the provider's own. */
export const model = Config.option(Config.string("YAPD_MODEL"))

/** Reasoning effort, passed through as is. Defaults to the provider's own. */
export const effort = Config.option(Config.string("YAPD_EFFORT"))

/** Kokoro voice, see https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md */
export const voice = Config.string("YAPD_VOICE").pipe(Config.withDefault("bm_fable"))

/** ffmpeg audio filter applied to Kokoro's output, or "none". The default is a light Jarvis-style treatment. */
export const effect = Config.string("YAPD_EFFECT").pipe(
  Config.withDefault(
    "highpass=f=120,equalizer=f=3000:t=q:w=1:g=3,chorus=0.7:0.9:25:0.25:0.3:2,aecho=0.8:0.5:40|70:0.25|0.15,volume=9dB",
  ),
)
