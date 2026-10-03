import { Config, ConfigError, Either, Option, Redacted, Schema } from "effect"
import * as Provider from "./Provider.ts"
import * as Remote from "./Remote.ts"
import * as Shortcut from "./Shortcut.ts"

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

/** Codex's service tier, like "priority" for its fast tier. Defaults to the provider's own. */
export const tier = optional("YAPD_TIER")

/** Coding agent CLI that writes the prompts for new work. Defaults to the one that writes summaries. */
export const writerProvider = optional("YAPD_WRITER_PROVIDER").pipe(
  Config.mapOrFail((value) =>
    Option.match(value, {
      onNone: () => Either.right(Option.none<Provider.Name>()),
      onSome: (name) =>
        Schema.decodeUnknownEither(Provider.Name)(name).pipe(
          Either.map(Option.some),
          Either.mapLeft(() => ConfigError.InvalidData([], `YAPD_WRITER_PROVIDER is "${name}", which isn't a provider I know`)),
        ),
    }),
  ),
)

/** Its model, effort and tier. With the same CLI as summaries, each defaults to theirs. */
export const writerModel = optional("YAPD_WRITER_MODEL")
export const writerEffort = optional("YAPD_WRITER_EFFORT")
export const writerTier = optional("YAPD_WRITER_TIER")

/** What the user calls this machine, like "rosie", since a Mac's hostname is rarely it. Defaults to the hostname, without its domain. */
export const name = optional("YAPD_NAME")

/** Where the user's rules for new work are, in plain language. Defaults to `preferences.md` in yapd's home, `~/.yapd`. */
export const preferences = optional("YAPD_PREFERENCES")

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

/**
 * Whisper model for dictation. Larger than for interruptions, since a misheard
 * prompt costs more than a misheard "merge it", and it loads on first use.
 */
export const dictationWhisper = Config.string("YAPD_DICTATION_WHISPER").pipe(
  Config.withDefault("onnx-community/whisper-small"),
)

/** The language the user speaks, as Whisper names it, like "english" or "french". */
export const language = Config.string("YAPD_LANGUAGE").pipe(Config.withDefault("english"))

/** Lets yapd send follow-ups to T3 Code threads. Issued by T3 Code's `auth session issue`. */
export const t3codeToken = Config.option(Config.redacted("YAPD_T3CODE_TOKEN")).pipe(
  Config.map(Option.filter((token) => Redacted.value(token) !== "")),
)

/**
 * Starts dictating new work from any app, and sends it when pressed again, or
 * "none". The default is clear of macOS's own shortcuts, like switching input
 * source on ctrl+option+space, and the command key keeps it from terminals.
 */
export const shortcut = Config.string("YAPD_SHORTCUT").pipe(
  Config.withDefault("ctrl+option+cmd+space"),
  Config.mapOrFail((value) => Either.mapLeft(Shortcut.parse(value), (message) => ConfigError.InvalidData([], message))),
)

/**
 * Folders that hold the user's projects, like `~/projects,~/work`. Every git
 * repository directly inside one can have work started in it from the command line.
 */
export const projects = Config.string("YAPD_PROJECTS").pipe(
  Config.withDefault(""),
  Config.map((value) => value.split(",").map((folder) => folder.trim()).filter((folder) => folder !== "")),
)

/** Whether work started from the command line gets a new worktree when the request doesn't say. */
export const worktree = Config.boolean("YAPD_WORKTREE").pipe(Config.withDefault(false))

/**
 * Claude Code's `--permission-mode` for the sessions yapd starts, like
 * "acceptEdits". Unset, they run with the user's own settings, and whatever
 * would have asked is refused, since nobody is there to answer.
 */
export const claudePermissions = optional("YAPD_CLAUDE_PERMISSIONS")

/**
 * Codex's sandbox for the sessions yapd starts, like "workspace-write". Unset,
 * they run with the user's own config, which for `codex exec` is read-only
 * unless it says otherwise.
 */
export const codexSandbox = optional("YAPD_CODEX_SANDBOX")

/** Machines whose hooks reach this daemon, like `rig` or `rig=me@rig.example.com`, so follow-ups can go back over SSH. */
export const remotes = Config.string("YAPD_REMOTES").pipe(
  Config.withDefault(""),
  Config.mapOrFail((value) => Either.mapLeft(Remote.parse(value), (message) => ConfigError.InvalidData([], message))),
)
