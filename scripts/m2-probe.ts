import { ConfigProvider, Console, Effect, Either, Option, Schema } from "effect"
import * as Config from "../src/Config.ts"
import { settings } from "../src/Home.ts"
import * as T3Actions from "../src/T3Actions.ts"
import * as T3CodeServer from "../src/T3CodeServer.ts"

// Checks, once, that T3 Code does what yapd's hands count on before they're
// let loose on real threads: a command sent twice under the same id is done
// once, a message is found in its thread by the id yapd gave it, and the
// commands behind "scratch that" and "carry on" take what yapd sends. It's
// never loaded by the daemon, and sends nothing unless told to, on a scratch
// thread Laurent picks, with his OK.
//
//   bun scripts/m2-probe.ts --thread <id>
//     Prints exactly what it would send, in order, and sends nothing. It
//     doesn't even read T3 Code.
//   bun scripts/m2-probe.ts --thread <id> --send
//     Reads the thread first, and stops unless it's in T3 Code's active list
//     and idle. Then sends, in this order, every id starting yapd:probe<time>:
//       0. message.dispatch, start_immediately with deliveryIntent auto, as
//          yapd sends "now": "This is a test from yapd, please ignore it: run
//          the shell command `sleep 45`, then reply with just OK."
//       0. The very same command again, same commandId and messageId. T3 Code
//          should do it once and give the same sequence back.
//       1. message.dispatch, queue_after_active, as yapd sends "after", while
//          the first run is going: "This is a test from yapd, please ignore
//          it: reply with just OK." It should wait in the queue.
//       2. queued-run.cancel with the run that second message waits in, as
//          "scratch that" sends it: only if it's still waiting in the queue.
//       3. run.interrupt with the first message's run and holdQueue true, as
//          "stop" sends it: only if that run is still going.
//       4. queue.resume, as "carry on" sends it before its message.
//       5. message.dispatch, queue_after_active, on the thread now idle: the
//          short message again, to see whether "after" on an idle thread
//          starts at once or waits.
//       6. Only if that last one is still waiting 30 seconds on:
//          queued-run.cancel for it, so nothing is left behind.
//     Between them it only reads the thread's bounded view, once a second,
//     for at most 30 seconds each time. It ends by printing a JSON report:
//     each command as sent and what T3 Code said back, and the checks M2
//     depends on. If the payloads of queue.resume or queued-run.cancel come
//     back refused, "carry on" becomes a plain message and "scratch that" is
//     dropped from M2, as the spec says.

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}

/** What's sent, worded so whoever reads the thread knows to ignore it. */
const slow = "This is a test from yapd, please ignore it: run the shell command `sleep 45`, then reply with just OK."
const quick = "This is a test from yapd, please ignore it: reply with just OK."

/** A run as the bounded view has it, with what the queue checks need. */
const Bounded = Schema.Struct({
  projection: Schema.Struct({
    runs: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: Schema.String,
        ordinal: Schema.Number,
        userMessageId: Schema.optional(Schema.NullOr(Schema.String)),
        queuePosition: Schema.optional(Schema.NullOr(Schema.Number)),
        queueHeld: Schema.optional(Schema.Boolean),
      }),
    ),
    messages: Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String), role: Schema.String })),
    turnItems: Schema.Array(Schema.Unknown),
  }),
})
type Projection = (typeof Bounded.Type)["projection"]

const Shell = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      activeRunId: Schema.optional(Schema.NullOr(Schema.String)),
      activityRunStatus: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

/** The commands, in order, as yapd builds them, with what isn't known until they're sent standing in. */
const commands = (thread: string, stamp: string, runs: { readonly first: string; readonly queued: string; readonly idle: string }) => {
  const id = (step: number) => `yapd:${stamp}:${step}`
  const send = (step: number, text: string, how: T3Actions.When) =>
    T3Actions.command(thread, { _tag: "Send", text, messageId: `${id(step)}:m`, how }, undefined, id(step))
  return {
    first: send(0, slow, "now"),
    queued: send(1, quick, "after"),
    cancel: T3Actions.command(thread, { _tag: "Cancel", runId: runs.queued }, undefined, id(2)),
    interrupt: T3Actions.command(thread, { _tag: "Stop" }, runs.first, id(3)),
    resume: T3Actions.command(thread, { _tag: "Resume" }, undefined, id(4)),
    idle: send(5, quick, "after"),
    tidy: T3Actions.command(thread, { _tag: "Cancel", runId: runs.idle }, undefined, id(6)),
    /** The messages' own ids, to find them by. */
    messages: { first: `${id(0)}:m`, queued: `${id(1)}:m`, idle: `${id(5)}:m` },
  }
}

/** yapd's own settings, as the daemon reads them from its .env, after the environment. */
const provider = Effect.gen(function* () {
  const text = yield* Effect.promise(() => Bun.file(settings).text().catch(() => ""))
  const kept = new Map(
    text.split("\n").flatMap((line) => {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      return match === null ? [] : [[match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, "$2")] as const]
    }),
  )
  return ConfigProvider.fromEnv().pipe(ConfigProvider.orElse(() => ConfigProvider.fromMap(kept)))
})

const probe = (thread: string) =>
  Effect.gen(function* () {
    const token = yield* Effect.flatMap(
      Config.t3codeToken,
      Option.match({ onNone: () => Effect.dieMessage("Set YAPD_T3CODE_TOKEN in ~/.yapd/.env first."), onSome: Effect.succeed }),
    )
    const { api, call } = yield* T3CodeServer.connect(token)
    const shell = yield* api("/api/orchestration/shell", Shell)
    const found = shell.threads.find(({ id }) => id === thread)
    if (found === undefined) return yield* Effect.dieMessage("That thread isn't in T3 Code's active list. Pick a scratch thread that is.")
    if ((found.activeRunId ?? null) !== null || (found.activityRunStatus ?? null) !== null) {
      return yield* Effect.dieMessage(`"${found.title}" is busy. Pick an idle scratch thread.`)
    }
    yield* Console.log(`Probing "${found.title}".`)

    const stamp = `probe${Date.now().toString(36)}`
    const steps: Array<{ readonly name: string; readonly payload: unknown; readonly answer: unknown }> = []
    const dispatch = (name: string, payload: Record<string, unknown>) =>
      Effect.gen(function* () {
        const answer = yield* Effect.either(call("orchestration.dispatchCommand", payload, Schema.Unknown))
        const said = Either.match(answer, {
          onRight: (value) => ({ ok: value }),
          onLeft: (error) => (error._tag === "Refusal" ? { refused: error.tag, message: error.message } : { trouble: error.reason, sent: error.sent === true }),
        })
        steps.push({ name, payload, answer: said })
        yield* Console.log(`${name}: ${JSON.stringify(said)}`)
        return answer
      })
    const read = Effect.map(api(`/api/orchestration/threads/${encodeURIComponent(thread)}/bounded`, Bounded), ({ projection }) => projection)
    /** Reads the thread once a second until it shows what's wanted, for at most 30 seconds. */
    const until = (wanted: (projection: Projection) => boolean) =>
      Effect.gen(function* () {
        for (let tries = 0; tries < 30; tries++) {
          const projection = yield* read
          if (wanted(projection)) return Option.some(projection)
          yield* Effect.sleep("1 second")
        }
        return Option.none<Projection>()
      })
    const runOf = (projection: Projection, messageId: string) => projection.runs.find(({ userMessageId }) => userMessageId === messageId)
    const intentOf = (projection: Projection, messageId: string) =>
      projection.turnItems.flatMap((item) => {
        const decoded = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String, messageId: Schema.optional(Schema.String), inputIntent: Schema.optional(Schema.String) }))(item)
        return Option.isSome(decoded) && decoded.value.type === "user_message" && decoded.value.messageId === messageId ? [decoded.value.inputIntent ?? null] : []
      })[0] ?? null

    const planned = commands(thread, stamp, { first: "", queued: "", idle: "" })
    const first = yield* dispatch("message.dispatch now", planned.first)
    const again = yield* dispatch("the same message.dispatch again", planned.first)
    const firstId = planned.messages.first
    const going = yield* until((projection) => ["running", "starting", "preparing"].includes(runOf(projection, firstId)?.status ?? ""))
    const seen = Option.getOrUndefined(going) ?? (yield* read)
    const firstRun = runOf(seen, firstId)

    yield* dispatch("message.dispatch after, while it runs", planned.queued)
    const queuedId = planned.messages.queued
    const waiting = Option.getOrUndefined(yield* until((projection) => runOf(projection, queuedId) !== undefined)) ?? (yield* read)
    const queuedRun = runOf(waiting, queuedId)

    // Only a run still in the queue, never one under way.
    const cancelled = queuedRun?.status !== "queued" ? undefined : yield* dispatch("queued-run.cancel", commands(thread, stamp, { first: "", queued: queuedRun.id, idle: "" }).cancel)
    const afterCancel = cancelled === undefined ? undefined : runOf(Option.getOrUndefined(yield* until((projection) => runOf(projection, queuedId)?.status !== "queued")) ?? (yield* read), queuedId)

    const still = runOf(yield* read, firstId)
    const interrupted = still === undefined || !["running", "starting", "preparing", "waiting"].includes(still.status) ? undefined : yield* dispatch("run.interrupt, holding the queue", commands(thread, stamp, { first: still.id, queued: "", idle: "" }).interrupt)
    const afterInterrupt =
      interrupted === undefined
        ? undefined
        : runOf(Option.getOrUndefined(yield* until((projection) => !["running", "starting", "preparing", "waiting"].includes(runOf(projection, firstId)?.status ?? ""))) ?? (yield* read), firstId)

    const resumed = yield* dispatch("queue.resume", planned.resume)

    yield* dispatch("message.dispatch after, on the idle thread", planned.idle)
    const idleId = planned.messages.idle
    const started = yield* until((projection) => ["running", "completed"].includes(runOf(projection, idleId)?.status ?? ""))
    const idleRun = runOf(Option.getOrUndefined(started) ?? (yield* read), idleId)
    if (idleRun !== undefined && idleRun.status === "queued") {
      yield* dispatch("queued-run.cancel, tidying up", commands(thread, stamp, { first: "", queued: "", idle: idleRun.id }).tidy)
    }

    const last = yield* read
    const sequence = (answer: Either.Either<unknown, unknown>) =>
      Either.match(answer, { onLeft: () => null, onRight: (value) => (typeof value === "object" && value !== null && "sequence" in value ? value.sequence : null) })
    const report = {
      thread,
      stamp,
      steps,
      checks: {
        sameCommandOnce: { first: sequence(first), again: sequence(again), same: sequence(first) !== null && sequence(first) === sequence(again) },
        messageOnce: { messages: last.messages.filter(({ id }) => id === firstId).length, runs: last.runs.filter(({ userMessageId }) => userMessageId === firstId).length },
        foundByMessageId: firstRun !== undefined,
        howTheFirstWentIn: intentOf(last, firstId),
        queued: { run: queuedRun ?? null, howItWentIn: intentOf(waiting, queuedId) },
        cancel: { answer: cancelled === undefined ? "not sent: no run in the queue" : Either.isRight(cancelled), statusAfter: afterCancel?.status ?? null },
        interrupt: { answer: interrupted === undefined ? "not sent: the first run had ended" : Either.isRight(interrupted), statusAfter: afterInterrupt?.status ?? null },
        resume: Either.isRight(resumed),
        afterOnAnIdleThread: idleRun?.status ?? "not seen",
      },
    }
    yield* Console.log(JSON.stringify(report, null, 2))
  })

const thread = option("thread")
if (thread === undefined || thread.startsWith("--")) {
  console.error("usage: bun scripts/m2-probe.ts --thread <scratch thread id> [--send]")
  process.exit(2)
}
if (!process.argv.includes("--send")) {
  // What it would send, with the runs it can only know once it's sending standing in.
  const planned = commands(thread, "probe<time>", { first: "<the first message's run>", queued: "<the queued message's run>", idle: "<the last message's run>" })
  console.log("Nothing is sent without --send. In order, it would send:")
  const { messages: _, ...sent } = planned
  for (const [name, payload] of Object.entries(sent)) console.log(`${name}: ${JSON.stringify(payload)}`)
  console.log("(the first is sent twice, and the last only if the one before it is still queued 30 seconds on)")
} else {
  await Effect.runPromise(Effect.flatMap(provider, (configured) => probe(thread).pipe(Effect.withConfigProvider(configured))))
}
