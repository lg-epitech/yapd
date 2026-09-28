import { Context, Effect, Layer, Option } from "effect"
import * as Config from "./Config.ts"
import { type ProcessError, run } from "./Process.ts"

/** Renders speech to an audio file ahead of time, so playback never waits on synthesis. */
export class Voice extends Context.Tag("yapd/Voice")<
  Voice,
  { readonly render: (text: string, path: string) => Effect.Effect<void, ProcessError> }
>() {}

/** File extension `render` writes, so players can pick the format. */
export const extension = ".aiff"

export const SayVoice = Layer.effect(
  Voice,
  Effect.gen(function* () {
    const voice = yield* Config.voice
    const flags = Option.match(voice, { onNone: () => [], onSome: (name) => ["-v", name] })
    return {
      render: (text, path) => run(["say", ...flags, "-o", path], { stdin: text }),
    }
  }),
)

export const play = (path: string) => run(["afplay", path])

export const chime = play("/System/Library/Sounds/Tink.aiff")
