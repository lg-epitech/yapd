import { Config } from "effect"

export const port = Config.integer("YAPD_PORT").pipe(Config.withDefault(4747))

/** Model used to condense agent messages, passed to `codex exec --model`. */
export const model = Config.string("YAPD_MODEL").pipe(Config.withDefault("gpt-6-luna"))

/** Reasoning effort for that model. Luna needs some to stay coherent. */
export const effort = Config.literal("low", "medium", "high", "xhigh")("YAPD_EFFORT").pipe(Config.withDefault("high"))

/** Kokoro voice, see https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md */
export const voice = Config.string("YAPD_VOICE").pipe(Config.withDefault("bm_fable"))

/** ffmpeg audio filter applied to Kokoro's output, or "none". The default is a light Jarvis-style treatment. */
export const effect = Config.string("YAPD_EFFECT").pipe(
  Config.withDefault(
    "highpass=f=120,equalizer=f=3000:t=q:w=1:g=3,chorus=0.7:0.9:25:0.25:0.3:2,aecho=0.8:0.5:40|70:0.25|0.15,volume=9dB",
  ),
)
