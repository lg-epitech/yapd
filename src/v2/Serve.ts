import { Cause, Clock, Effect, Fiber, Layer, Logger, Option, Redacted, Stream, SubscriptionRef } from "effect"
import { createHash } from "node:crypto"
import { hostname } from "node:os"
import { join } from "node:path"
import { Activity, Audio, DeviceAudio, Devices } from "../Audio.ts"
import * as Clients from "../Clients.ts"
import * as Config from "../Config.ts"
import * as Hands from "../Hands.ts"
import * as Home from "../Home.ts"
import * as Journal from "../Journal.ts"
import * as Ledger from "../Ledger.ts"
import * as Machines from "../Machines.ts"
import * as Mutes from "../Mutes.ts"
import * as Preferences from "../Preferences.ts"
import * as Server from "../Server.ts"
import * as Settings from "../Settings.ts"
import * as Show from "../Show.ts"
import { Shortcut } from "../Shortcut.ts"
import * as Store from "../Store.ts"
import * as T3Actions from "../T3Actions.ts"
import { bundle as t3Bundle } from "../T3Code.ts"
import * as T3CodeServer from "../T3CodeServer.ts"
import * as T3Live from "../T3Live.ts"
import * as Threads from "../Threads.ts"
import * as Tunnel from "../Tunnel.ts"
import { SileroVad, Vad } from "../Vad.ts"
import { KokoroVoice, Voice, Warmth } from "../Voice.ts"
import { createAudioPlayer, createVoiceSynthesizer } from "./AudioBridge.ts"
import { Codex } from "./Codex.ts"
import { createStopListeningTool } from "./ConversationTools.ts"
import { record, type Recording } from "./Capture.ts"
import { LiveView } from "./LiveView.ts"
import { createHistoryTool } from "./HistoryTool.ts"
import { createNotificationTools } from "./NotificationTools.ts"
import { organizationNotification, threadNotification, threadStopNotification } from "./NotificationFacts.ts"
import { html as page } from "./Page.ts"
import { Runtime, type RuntimeEvent } from "./Runtime.ts"
import { Session } from "./Session.ts"
import { createHttpRecognizer } from "./Speech.ts"
import { createStreamingRecognizer } from "./StreamingRecognizer.ts"
import { Store as ConversationStore } from "./Store.ts"
import { createT3Tools } from "./T3Tools.ts"
import * as VoiceTurns from "./VoiceTurns.ts"
import * as View from "./View.ts"

/** Separate opt-in runtime: no V1 intent classifier, responder or writer. */
const running = Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis
  const settings = yield* Settings.Settings
  const store = yield* Store.Store
  const journal = yield* Journal.Journal
  const ledger = yield* Ledger.Ledger
  const audio = yield* Audio
  const devices = yield* Devices
  const voice = yield* Voice
  const shortcut = yield* Shortcut
  const vad = yield* Vad
  const activeResponses = new Set<string>()
  let view: LiveView<unknown> | undefined
  let voiceTurns: VoiceTurns.VoiceTurns | undefined
  const state = yield* SubscriptionRef.make<Server.State>({ on: yield* settings.on, activity: "idle", updates: [] })
  const emit = (event: RuntimeEvent) => {
    if (event.type === "runtime_error") Effect.runFork(Effect.logWarning("V2 voice error", event))
    if (event.type === "response_started") activeResponses.add(event.responseId)
    if (event.type === "response_done" || event.type === "error" && event.responseId !== undefined || event.type === "output_cancelled" && event.reason !== "onset") activeResponses.delete(event.responseId!)
    if (event.type !== "runtime_error" && event.type !== "recognition_final" && event.type !== "transcript_partial") voiceTurns?.event(event)
    view?.publish(event)
  }
  const fail = (message: string) => emit({ type: "runtime_error", message })
  const enabled = () => Effect.runSync(SubscriptionRef.get(state)).on
  yield* Clients.forward(Clients.joined())
  const tunnels = new Map(yield* Effect.forEach(yield* Config.remotes, ([host, destination]) =>
    Effect.map(Tunnel.forward(host, destination), (tunnel) => [host, tunnel] as const)))
  const everywhere = yield* Machines.machines(Tunnel.masters(tunnels))
  const machine = everywhere.find(({ here }) => here)?.name ?? hostname()
  const token = yield* Config.t3codeToken
  const live = yield* T3Live.T3Live
  const others = yield* Effect.forEach(tunnels, ([host, tunnel]) => Effect.map(T3Live.follow(tunnel.refresh), (live): Threads.Other => ({
    machine: host, live, actions: T3Actions.make(Tunnel.transport(tunnel.locate, host)), status: tunnel.status,
  })))
  const threads = yield* Threads.make({ machine, live, actions: Option.map(token, (token) => T3Actions.make(T3CodeServer.connect(token))), others, journal, store })
  const hands = Hands.make({ threads, ledger, started })
  const mutes = yield* Mutes.make(store)
  const show = yield* Show.make(threads.detail, (url) => Effect.asVoid(devices.open(url)))
  const tools = createT3Tools({
    threads, hands, ledger, launchers: new Map(everywhere.map(({ name, launcher }) => [name, launcher])),
    transport: (name) => name === machine
      ? Option.getOrUndefined(Option.map(token, T3CodeServer.connect))
      : (() => { const tunnel = tunnels.get(name); return tunnel === undefined ? undefined : Tunnel.transport(tunnel.locate, name) })(),
    show: async ({ title, text, url }) => { await Effect.runPromise(show.put({ kind: "said", title, markdown: text, ...(url === undefined ? {} : { url }) })) },
  })
  const configuredModel = Option.orElse(yield* Config.brainModel, () => Effect.runSync(Config.model))
  const configuredEffort = Option.orElse(yield* Config.brainEffort, () => Effect.runSync(Config.effort))
  const configuredTier = Option.orElse(yield* Config.brainTier, () => Effect.runSync(Config.tier))
  const model = yield* Effect.acquireRelease(Effect.sync(() => new Codex({
    model: Option.getOrElse(configuredModel, () => "gpt-6.1-sol"),
    effort: Option.getOrElse(configuredEffort, () => "low"),
    ...Option.match(configuredTier, { onNone: () => ({}), onSome: (tier) => ({ tier }) }),
  })), (model) => Effect.promise(() => model.close()))
  // Auth is checked before accepting work, and rejects API-key authentication.
  yield* Effect.tryPromise(() => model.prepare())
  // This is silent startup work, never an acknowledgment played to the user.
  yield* (yield* Warmth).warm(["Ready."])
  const conversationStore = yield* Effect.acquireRelease(Effect.sync(() => new ConversationStore(join(Home.home, "v2.sqlite"))), (store) => Effect.sync(() => store.close()))
  const catalog = [...tools, createHistoryTool(conversationStore, "main"), ...createNotificationTools(conversationStore, "main"), createStopListeningTool(async () => {
    if (voiceTurns === undefined) throw new Error("Voice input is not ready.")
    await Effect.runPromise(voiceTurns.suspend)
  })]
  yield* Effect.tryPromise(() => model.prepare(catalog))
  const session = new Session({ conversationId: "main", model, tools: catalog, store: conversationStore })
  const asrUrl = process.env.YAPD_V2_ASR_URL?.trim() || "http://127.0.0.1:8792/v1/transcribe"
  if (!["http:", "https:"].includes(new URL(asrUrl).protocol)) throw new Error("YAPD_V2_ASR_URL must be an HTTP endpoint for your self-hosted ASR.")
  const language = yield* Config.language
  const streamingUrl = process.env.YAPD_V2_ASR_WS_URL?.trim() || undefined
  if (streamingUrl !== undefined) {
    const address = new URL(streamingUrl)
    if (!["ws:", "wss:"].includes(address.protocol) || address.username !== "" || address.password !== "") throw new Error("YAPD_V2_ASR_WS_URL must name a self-hosted ws:// or wss:// endpoint without URL credentials.")
  }
  const recognitionMode = streamingUrl === undefined ? "prefix_upload" : "native_streaming"
  let speechContext = ""
  const runtime = new Runtime({
    session,
    recognize: ({ onPartial, onError }) => streamingUrl === undefined
      ? createHttpRecognizer({ url: asrUrl, language, context: speechContext, onPartial, onError })
      : createStreamingRecognizer({ url: streamingUrl, language: /^(fr|french)/i.test(language) ? "fr" : /^(en|english)/i.test(language) ? "en" : "auto", onError }),
    speech: { synthesize: createVoiceSynthesizer(voice), player: createAudioPlayer(audio) },
    onEvent: emit,
  })
  runtime.setEnabled(enabled())
  yield* Effect.addFinalizer(() => Effect.promise(() => runtime.close()))
  voiceTurns = yield* VoiceTurns.make({ audio, vad, runtime, onError: (error) => fail(`Hands-free input stopped: ${error.message}`) })

  let capture: Recording | undefined
  let starting: { readonly id: string; readonly fiber: Fiber.RuntimeFiber<Recording, unknown> } | undefined
  let lastDeviceId: string | undefined
  const closeInput = Effect.gen(function* () {
    const pending = starting
    starting = undefined
    if (pending !== undefined) {
      yield* Fiber.interrupt(pending.fiber)
      runtime.cancel({ captureId: pending.id })
    }
    const current = capture
    capture = undefined
    if (current !== undefined) yield* current.cancel
    return current
  })
  const releaseInput = shortcut.cancel.pipe(Effect.zipRight(voiceTurns.suspend), Effect.zipRight(closeInput))
  const stop = Effect.sync(() => runtime.stop()).pipe(Effect.zipRight(releaseInput))
  const outputDevice = Effect.gen(function* () {
    const selected = audio.listeningDevice === undefined ? Option.none() : Option.flatten(yield* Stream.runHead(audio.listeningDevice))
    return Option.getOrUndefined(selected)?.deviceId ?? lastDeviceId
  })
  const accept = (text: string, turnId?: string, expectedEpoch = runtime.inputEpoch) => Effect.gen(function* () {
    if (!enabled()) return Option.none<string>()
    const deviceId = yield* outputDevice
    const receipt = yield* Effect.tryPromise(() => runtime.text({ text, expectedEpoch, ...(turnId === undefined ? {} : { turnId }), ...(deviceId === undefined ? {} : { deviceId }) }))
    return Option.some(receipt.turnId)
  })
  const preferencesPath = yield* Preferences.path
  const preferences = Effect.tryPromise(() => Bun.file(preferencesPath).text()).pipe(Effect.orElseSucceed(() => ""))
  let lastPreferences: string | undefined
  let lastDesk: string | undefined
  const updatePreferences = Effect.gen(function* () {
    const text = yield* preferences
    if (lastPreferences !== text) {
      runtime.external({ eventId: `preferences:${crypto.randomUUID()}`, text: JSON.stringify({ kind: "user_preferences", text: Preferences.fit(text).rules }) })
      lastPreferences = text
    }
    const desk = yield* threads.desk(Option.none(), [], 50)
    const current = JSON.stringify({ kind: "current_workspace", instruction: "Current thread identities and cached status. Read tools for detailed task facts; search/list tools if the intended thread is outside this bounded snapshot.",
      threads: desk.threads.map(({ ref, called, project, state }) => ({ machine: ref.machine, threadId: ref.id, title: called, project, state })), unreachableMachines: desk.away })
    speechContext = desk.threads.map(({ called, project }) => `${called}, ${project}`).join("; ").slice(0, 2000)
    if (lastDesk !== current) {
      runtime.external({ eventId: `workspace:${crypto.randomUUID()}`, text: current })
      lastDesk = current
    }
  })
  yield* updatePreferences
  const textTurn = (text: string, turnId?: string) => Effect.gen(function* () {
    const epoch = runtime.inputEpoch
    yield* updatePreferences
    return yield* accept(text, turnId, epoch)
  })
  yield* shortcut.toggle(enabled())
  yield* Effect.forkScoped(Stream.runForEach(shortcut.events, (event) => Effect.gen(function* () {
    if (event._tag === "Cancelled") {
      const id = event.captureId ?? capture?.id ?? starting?.id
      if (id !== undefined) runtime.cancel({ captureId: id, reason: "manual" })
      yield* closeInput
      return
    }
    if (event._tag === "Sent") {
      const current = capture
      capture = undefined
      if (current !== undefined) {
        yield* current.seal
        yield* Effect.forkScoped(current.send.pipe(Effect.catchAllCause((cause) => Effect.logWarning("V2 transcription failed", cause).pipe(Effect.zipRight(Effect.sync(() => fail("The recording could not be verified or transcribed. It was not sent.")))))))
      }
      return
    }
    if (!enabled()) return
    const id = event.captureId ?? crypto.randomUUID()
    const deviceId = event.deviceId
    if (capture?.id === id) return
    runtime.start({ captureId: id, ...(deviceId === undefined ? {} : { deviceId }) })
    yield* voiceTurns!.suspend
    yield* closeInput
    yield* updatePreferences
    if (deviceId === undefined) {
      runtime.cancel({ captureId: id })
      yield* shortcut.cancel
      fail("The microphone client needs an update to identify its capture source.")
      return
    }
    lastDeviceId = deviceId
    // The phone never opts in; manual Send always wins there.
    const detector = event.onPause ? yield* vad.make.pipe(Effect.option) : Option.none()
    let voiced = 0, silence = 0
    const opening = yield* record({ id, deviceId, audio, runtime,
      inspect: (frame) => Effect.gen(function* () {
        if (Option.isNone(detector)) return
        const probability = yield* detector.value(frame).pipe(Effect.orDie)
        if (probability >= 0.6) { voiced += frame.length; silence = 0 }
        else silence += frame.length
        if (voiced >= 4000 && silence >= 19200) yield* shortcut.send
      }),
      onError: (cause) => {
        Effect.runFork(Effect.logWarning("V2 microphone capture failed", cause))
        if (capture?.id === id) capture = undefined
        Effect.runFork(shortcut.cancel)
        fail("Microphone capture stopped. Nothing was sent.")
      },
    }).pipe(Effect.forkScoped)
    starting = { id, fiber: opening }
    capture = yield* Fiber.join(opening).pipe(Effect.ensuring(Effect.sync(() => { if (starting?.fiber === opening) starting = undefined })))
  }).pipe(Effect.catchAllCause((cause) => closeInput.pipe(Effect.zipRight(shortcut.cancel), Effect.zipRight(Effect.sync(() => {
    if (!Cause.isInterruptedOnly(cause) && enabled()) {
      Effect.runFork(Effect.logWarning("V2 microphone setup or seal failed", cause))
      fail("The microphone recording failed. Nothing was sent.")
    }
  })))))))
  if (shortcut.interruptions !== undefined) yield* Effect.forkScoped(Stream.runForEach(shortcut.interruptions, () => stop))

  // All thread changes are attributed facts, never a new user authorization.
  yield* Effect.forkScoped(Stream.runForEach(threads.changes, ({ machine: on, change }) => Effect.gen(function* () {
    const thread = change.thread
    const eventId = `t3:${on}:${thread.id}:${change._tag}:${thread.updatedAt}:${thread.latestRunId ?? ""}`
    const eligible = ["Finished", "Asked"].includes(change._tag) && !Threads.subagent(thread) && Option.isNone(yield* mutes.muted([Mutes.key.thread({ machine: on, id: thread.id })]))
    const relevant = ["Finished", "Asked", "Started", "Answered", "Removed"].includes(change._tag)
    const now = yield* Clock.currentTimeMillis
    const notification = change._tag === "Organized" ? organizationNotification(on, thread, now) : relevant ? threadNotification(on, thread, eligible, enabled() && runtime.isEnabled, now) : undefined
    const fresh = runtime.external({ eventId, text: JSON.stringify({ kind: "thread_event", machine: on, change: change._tag, thread }), ...(notification === undefined ? {} : { notification }) })
    if (!enabled() || !eligible || !fresh) return
    const deviceId = yield* outputDevice
    yield* Effect.tryPromise(() => runtime.wake({ ...(deviceId === undefined ? {} : { deviceId }), ...(notification === undefined ? {} : { notificationId: notification.id }) })).pipe(Effect.catchAll(() => Effect.void))
  })))
  const served = Show.served(show, threads.desk(Option.none(), [], 1000), journal.page, Effect.map(mutes.list, (rows) => new Set(rows.map(({ key }) => key))))
  const snapshot = () => View.snapshot(conversationStore, session.conversationId, recognitionMode, activeResponses)
  view = new LiveView(snapshot)
  const events = Stream.fromAsyncIterable(view.events(), (error) => error).pipe(Stream.orDie)
  const power = yield* Effect.makeSemaphore(1)
  yield* Server.serve(yield* Config.port, {
    handle: (agent, payload, origin) => Effect.gen(function* () {
      if (process.env.YAPD_INTERNAL === "1") return undefined
      const eventId = `hook:${createHash("sha256").update(JSON.stringify({ agent, payload, origin })).digest("hex")}`
      const text = JSON.stringify({ kind: "agent_hook", agent, payload, origin })
      let notification: import("./Types.ts").NotificationFact | undefined
      if (payload.hook_event_name === "Stop") {
        const on = origin?.host ?? machine
        const linked = typeof payload.session_id === "string" && typeof payload.cwd === "string"
          ? Option.flatten(yield* threads.link(on, payload.session_id, payload.cwd).pipe(Effect.timeoutOption("1 second"))) : Option.none()
        if (Option.isSome(linked)) {
          if (linked.value._tag === "Thread") {
            const thread = yield* threads.find(linked.value.ref)
            if (Option.isSome(thread)) {
              notification = threadStopNotification(on, thread.value, Option.isNone(yield* mutes.muted([Mutes.key.thread(linked.value.ref)])), enabled() && runtime.isEnabled, yield* Clock.currentTimeMillis)
            }
          }
          // Subagent hooks stay context, without an independent announcement.
        } else notification = { key: JSON.stringify([on, agent, payload.session_id ?? payload.cwd]), id: eventId, version: Date.now(), eligible: true, automatic: enabled() && runtime.isEnabled && origin?.app !== t3Bundle }
      }
      const fresh = runtime.external({ eventId, text, ...(notification === undefined ? {} : { notification }) })
      if (payload.hook_event_name === "Stop" && enabled() && fresh && notification?.eligible) {
        const deviceId = yield* outputDevice
        yield* Effect.tryPromise(() => runtime.wake({ ...(deviceId === undefined ? {} : { deviceId }), notificationId: notification.id })).pipe(Effect.catchAll(() => Effect.void))
      }
      return undefined
    }),
    state: Show.stated(Stream.zipLatestWith(state.changes, (yield* Activity).changes, (state, activity) => ({ ...state, activity })), show),
    turn: (on) => Effect.gen(function* () {
      runtime.setEnabled(on)
      yield* SubscriptionRef.update(state, (s) => ({ ...s, on }))
      yield* settings.remember(on)
      if (!on) yield* releaseInput
      yield* shortcut.toggle(on)
    }).pipe(power.withPermits(1)),
    mode: () => Effect.fail(new Error("V2 uses one conversation; control notifications with thread mute or power.")),
    replay: () => Effect.succeed("unknown"),
    utter: (text) => textTurn(text), ...served,
    mute: (key, ends) => Effect.gen(function* () {
      if (Option.isNone(Mutes.parse(key))) return "invalid" as const
      yield* mutes.mute({ key, ...(ends === undefined ? {} : { ends }) }); return "muted" as const
    }),
    unmute: (key) => Effect.asVoid(mutes.unmute(key)),
    subagents: () => Effect.succeed("unknown"), replayThread: () => Effect.succeed("unknown"),
    details: () => Effect.succeedNone, icon: () => Effect.succeedNone,
    clearCatchup: Effect.succeed(0), cancelReminder: () => Effect.succeed("unknown"),
    audio: devices.sockets,
    conversation: {
      page, read: Effect.sync(snapshot), events,
      commit: ({ text, turnId }) => Effect.gen(function* () {
        if (!enabled()) return yield* Effect.fail(new Error("yapd is off."))
        const epoch = runtime.inputEpoch
        yield* updatePreferences
        const deviceId = yield* outputDevice
        return yield* Effect.tryPromise(() => runtime.text({ text, turnId, expectedEpoch: epoch, ...(deviceId === undefined ? {} : { deviceId }) }))
      }),
      stop,
    },
  }, Option.map(yield* settings.read("token"), Redacted.make))
  yield* Effect.logInfo("V2: Codex plan reasoning, self-hosted ASR, local speech; conversation at /v2")
  return yield* Effect.never
})

export const serve = running.pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(DeviceAudio, KokoroVoice, SileroVad, T3Live.layer, Settings.layer, Journal.layer, Ledger.layer).pipe(Layer.provideMerge(Store.layer))),
  Effect.provide(Logger.pretty),
)
