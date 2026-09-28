import { Config, Option, Redacted, Schema } from "effect"
import * as Provider from "./Provider.ts"

export const port = Config.integer("YAPD_PORT").pipe(Config.withDefault(4747))

/** Turns that finish faster than this aren't spoken, since the user is likely still watching. 0 speaks everything. */
export const minSeconds = Config.integer("YAPD_MIN_SECONDS").pipe(Config.withDefault(20))

/** Coding agent CLI used to condense agent messages. */
export const provider = Schema.Config("YAPD_PROVIDER", Provider.Name).pipe(Config.withDefault("codex" as const))

/** An empty value, like `YAPD_MODEL=`, counts as unset. */
const optional = (name: string) => Config.option(Config.string(name)).pipe(Config.map(Option.filter((value) => value !== "")))

/** Model for that CLI, in whatever form it takes. Defaults to the provider's own. */
export const model = optional("YAPD_MODEL")

/** Reasoning effort, passed through as is. Defaults to the provider's own. */
export const effort = optional("YAPD_EFFORT")

/** How yapd talks, in the user's words, like "Talk like Jarvis and call me sir". Unset, it talks plainly. */
export const style = optional("YAPD_STYLE")

/** Kokoro voice, see https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md */
export const voice = Config.string("YAPD_VOICE").pipe(Config.withDefault("bm_fable"))

/** ffmpeg audio filter applied to Kokoro's output, or "none". The default is a light Jarvis-style treatment. */
export const effect = Config.string("YAPD_EFFECT").pipe(
  Config.withDefault(
    "highpass=f=120,equalizer=f=3000:t=q:w=1:g=3,chorus=0.7:0.9:25:0.25:0.3:2,aecho=0.8:0.5:40|70:0.25|0.15,volume=9dB",
  ),
)

/** Listen while speaking, so the user can interrupt. Off plays with afplay and never opens the microphone. */
export const listen = Config.boolean("YAPD_LISTEN").pipe(Config.withDefault(true))

/** Whisper model that hears the user when they interrupt. */
export const whisper = Config.string("YAPD_WHISPER").pipe(Config.withDefault("onnx-community/whisper-base"))

/** The language the user speaks, as Whisper names it, like "english" or "french". */
export const language = Config.string("YAPD_LANGUAGE").pipe(Config.withDefault("english"))

/** Lets yapd send follow-ups to T3 Code threads. Issued by T3 Code's `auth session issue`. */
export const t3codeToken = Config.option(Config.redacted("YAPD_T3CODE_TOKEN")).pipe(
  Config.map(Option.filter((token) => Redacted.value(token) !== "")),
)
