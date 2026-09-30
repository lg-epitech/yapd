import { Effect, Layer, Logger, Option, Stream } from "effect"
import { hostname } from "node:os"
import { DeviceAudio } from "./Audio.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as CliLauncher from "./CliLauncher.ts"
import * as Codex from "./Codex.ts"
import { ProviderCondenser } from "./Condenser.ts"
import * as Config from "./Config.ts"
import * as Daemon from "./Daemon.ts"
import { Dictation, WhisperDictation } from "./Dictation.ts"
import * as Drafts from "./Drafts.ts"
import * as Floor from "./Floor.ts"
import { machines } from "./Machines.ts"
import { ProviderModel } from "./Model.ts"
import * as Outbox from "./Outbox.ts"
import * as Preferences from "./Preferences.ts"
import * as Records from "./Records.ts"
import * as Relay from "./Relay.ts"
import * as Remote from "./Remote.ts"
import { ProviderReporter } from "./Reporter.ts"
import { ProviderResponder } from "./Responder.ts"
import * as Server from "./Server.ts"
import { Shortcut } from "./Shortcut.ts"
import * as Store from "./Store.ts"
import * as T3Code from "./T3Code.ts"
import { Vocabulary, WhisperTranscriber } from "./Transcriber.ts"
import { SileroVad } from "./Vad.ts"
import { KokoroVoice } from "./Voice.ts"
import { ProviderWriter } from "./Writer.ts"

// `yapd serve`, apart from the other commands, since only the daemon needs the
// models and the native onnxruntime they bring, which hooks would load on every turn.

/**
 * T3 Code first, since it only claims threads it can find, and its sessions
 * must go through it. Then each agent's own way in, whatever it runs in. A
 * waiting Claude Code hook holds its connection wherever it runs, but other
 * machines' T3 Code and Codex are only reachable from there. The sessions yapd
 * started itself come last, as what's left when nothing has them open.
 */
const Relays = Layer.effect(
  Relay.Relays,
  Effect.gen(function* () {
    const remotes = yield* Config.remotes
    const here = Remote.here(hostname)
    return Relay.make([
      here(yield* T3Code.relay),
      yield* ClaudeCode.relay,
      Remote.relay(remotes, hostname),
      here(Codex.relay),
      here(CliLauncher.relay()),
    ])
  }),
)

export const serve = Effect.gen(function* () {
  const reached = yield* machines
  const own = reached.find(({ here }) => here)
  const identify = yield* T3Code.identify
  /** The machine a hook came from: this Mac unless the hook names another's hostname. Hooks older than hostnames don't say, and were all local. */
  const from = (host: string | undefined) => (host === undefined ? own : reached.find(({ hosts }) => hosts.some((named) => named.toLowerCase() === host.toLowerCase())))
  const daemon = yield* Daemon.make({
    // Only this machine's T3 Code is asked which thread an update came from. Another machine's hooks
    // name it, and its threads are only listed from there, so its updates go without a link.
    locate: (thread) =>
      own === undefined || from(thread.origin.host) !== own
        ? Effect.succeed(Option.none())
        : Effect.map(identify(thread), Option.map((linked) => ({ machine: own.name, ...linked }))),
    // By the name the user calls it, which is what the outbox sends by, so a message is only taken as the prompt of a session there.
    machine: ({ host }) => Option.map(Option.fromNullable(from(host)), ({ name }) => name),
  })
  yield* Server.serve(yield* Config.port, daemon.handle)
  const preferences = yield* Preferences.path
  const drafts = yield* Drafts.make({
    machines: reached,
    rules: Preferences.load(preferences),
    recent: daemon.recent,
    note: daemon.note,
    tell: daemon.tell,
    records: yield* Records.make,
    outbox: yield* Outbox.make({
      // Read each time it's said, since this Mac's name follows its hostname.
      here: () => reached.find(({ here }) => here)?.name ?? "",
      threads: (machine) => Option.fromNullable(reached.find(({ name }) => name === machine)?.threads),
      tell: daemon.tell,
      note: daemon.note,
      // What's sent turns up as a thread's prompt, and its answer is wanted however quick. Not once it's given up on.
      expect: daemon.expect,
      retract: daemon.retract,
    }),
    expect: (yield* Vocabulary).expect,
  })
  yield* Effect.logInfo(`Your rules for new work go in ${preferences}`)
  const { events } = yield* Shortcut
  const { transcripts } = yield* Dictation
  // Asked as the user starts talking, so it's there by the time they've finished.
  yield* Effect.forkScoped(Stream.runForEach(events, (event) => (event._tag === "Started" ? drafts.prepare : Effect.void)))
  yield* Effect.forkScoped(Stream.runForEach(transcripts, drafts.dictated))
  return yield* daemon.speak
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Layer.mergeAll(ProviderCondenser, ProviderResponder, ProviderWriter, ProviderReporter).pipe(Layer.provide(ProviderModel)),
      WhisperDictation,
      Relays,
    ).pipe(
      Layer.provideMerge(Layer.mergeAll(KokoroVoice, DeviceAudio, SileroVad, WhisperTranscriber, Floor.layer, Store.layer)),
      Layer.provideMerge(ClaudeCode.WaitingLive),
    ),
  ),
  // Outermost, so layers log through it too.
  Effect.provide(Logger.pretty),
)
