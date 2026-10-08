import { ConfigProvider, Console, Effect, Either, Option, Schema } from "effect"
import * as Config from "../src/Config.ts"
import { settings } from "../src/Home.ts"
import * as T3Actions from "../src/T3Actions.ts"
import * as T3CodeLauncher from "../src/T3CodeLauncher.ts"
import * as T3CodeServer from "../src/T3CodeServer.ts"

// Checks, once, that T3 Code does what yapd's hands count on before they're
// let loose on real threads: a command sent twice under the same id is done
// once, a message is found in its thread by the id yapd gave it, how it went
// in shows on the one read yapd makes right after sending it, and the
// commands behind "scratch that" and "carry on" take what yapd sends. It's
// never loaded by the daemon, and sends nothing unless told to, and then only
// to a thread it starts for itself, with Laurent's OK.
//
//   bun scripts/m2-probe.ts
//     Prints exactly what it would send, in order, and sends nothing. It
//     doesn't even read T3 Code.
//   bun scripts/m2-probe.ts --send --project <a T3 Code project's name or path>
//     First starts a thread of its own in that project, without a worktree,
//     as yapd starts work: "This is a test thread from yapd, please ignore
//     it: reply with just OK." It waits up to two minutes for that turn to
//     end, and stops if it doesn't. It touches no other thread. Then it sends
//     to that thread, in this order, every id starting yapd:probe<time>:
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
//       4. queue.resume, as "carry on" sends it before its message: only if
//          the interrupt in 3 was sent and taken, so it only ever lets go of
//          a queue the probe itself held.
//       5. message.dispatch, queue_after_active, on the thread now idle: the
//          short message again, to see whether "after" on an idle thread
//          starts at once or waits.
//       6. Only if that last one is still waiting 30 seconds on:
//          queued-run.cancel for it, so nothing is left behind.
//     Right after each message.dispatch it reads the thread once, as yapd
//     does to say whether a message was steered or queued, and to look for one
//     whose answer was lost. Otherwise it only reads the thread's bounded
//     view, once a second, for at most 30 seconds each time. It ends by
//     printing a JSON report: each command as sent and what T3 Code said back,
//     what that first read showed against what the thread settled on, and the
//     checks M2 depends on. If queue.resume or queued-run.cancel come back
//     refused, "carry on" becomes a plain message and "scratch that" is
//     dropped from M2, as the spec says. The thread it started is left for
//     Laurent to look at or archive.

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}

/** What's sent, worded so whoever reads the thread knows to ignore it. */
const opening = "This is a test thread from yapd, please ignore it: reply with just OK."
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

/** Runs that are still going. */
const going = ["preparing", "starting", "running", "waiting"]

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

/** What yapd would say of a message from one read of the thread: in at once, steered into the turn under way, queued behind it, or not there. */
const said = (found: Option.Option<T3Actions.Found>) =>
  Option.match(found, {
    onNone: () => "not there",
    onSome: ({ intent }) =>
      Option.match(intent, {
        onNone: () => "there, with no say how",
        onSome: (intent) => (intent === "steer" || intent === "promoted_queued_to_steer" ? "steered" : intent === "queued_turn" ? "queued" : "now"),
      }),
  })

const probe = (project: string) =>
  Effect.gen(function* () {
    const token = yield* Effect.flatMap(
      Config.t3codeToken,
      Option.match({ onNone: () => Effect.dieMessage("Set YAPD_T3CODE_TOKEN in ~/.yapd/.env first."), onSome: Effect.succeed }),
    )
    const reach = T3CodeServer.connect(token)
    const { api, call } = yield* reach
    const actions = T3Actions.make(reach)

    // A thread of its own, so nothing it does can touch his work.
    const begun = yield* Effect.either(T3CodeLauncher.launcher(token, reach).start({ project, prompt: opening, worktree: false }))
    if (Either.isLeft(begun)) return yield* Effect.dieMessage(`Couldn't start a thread of its own: ${begun.left.reason}`)
    const thread = begun.right.thread
    yield* Console.log(`Started a thread of its own in ${begun.right.project}: ${thread}`)
    const read = Effect.map(api(`/api/orchestration/threads/${encodeURIComponent(thread)}/bounded`, Bounded), ({ projection }) => projection)
    /** Reads the thread once a second until it shows what's wanted, for at most `most` seconds. */
    const until = (wanted: (projection: Projection) => boolean, most = 30) =>
      Effect.gen(function* () {
        for (let tries = 0; tries < most; tries++) {
          const projection = yield* read
          if (wanted(projection)) return Option.some(projection)
          yield* Effect.sleep("1 second")
        }
        return Option.none<Projection>()
      })
    const idle = yield* until((projection) => projection.runs.length > 0 && !projection.runs.some(({ status }) => going.includes(status)), 120)
    if (Option.isNone(idle)) return yield* Effect.dieMessage(`The thread it started (${thread}) didn't finish its first turn in two minutes, so nothing more was sent.`)

    const stamp = `probe${Date.now().toString(36)}`
    const steps: Array<{ readonly name: string; readonly payload: unknown; readonly answer: unknown }> = []
    const dispatch = (name: string, payload: Record<string, unknown>) =>
      Effect.gen(function* () {
        const answer = yield* Effect.either(call("orchestration.dispatchCommand", payload, Schema.Unknown))
        const told = Either.match(answer, {
          onRight: (value) => ({ ok: value }),
          onLeft: (error) => (error._tag === "Refusal" ? { refused: error.tag, message: error.message } : { trouble: error.reason, sent: error.sent === true }),
        })
        steps.push({ name, payload, answer: told })
        yield* Console.log(`${name}: ${JSON.stringify(told)}`)
        return answer
      })
    /** The one read yapd makes right after a message goes, as it found it. */
    const firsts: Record<string, string> = {}
    const sending = (name: string, payload: Record<string, unknown>, messageId: string) =>
      Effect.gen(function* () {
        const answer = yield* dispatch(name, payload)
        firsts[messageId] = said(yield* Effect.orElseSucceed(actions.message(thread, messageId), () => Option.none<T3Actions.Found>()))
        return answer
      })
    const runOf = (projection: Projection, messageId: string) => projection.runs.find(({ userMessageId }) => userMessageId === messageId)

    const planned = commands(thread, stamp, { first: "", queued: "", idle: "" })
    const first = yield* sending("message.dispatch now", planned.first, planned.messages.first)
    const again = yield* dispatch("the same message.dispatch again", planned.first)
    const firstId = planned.messages.first
    const started = yield* until((projection) => ["running", "starting", "preparing"].includes(runOf(projection, firstId)?.status ?? ""))
    const seen = Option.getOrUndefined(started) ?? (yield* read)
    const firstRun = runOf(seen, firstId)

    yield* sending("message.dispatch after, while it runs", planned.queued, planned.messages.queued)
    const queuedId = planned.messages.queued
    const waiting = Option.getOrUndefined(yield* until((projection) => runOf(projection, queuedId) !== undefined)) ?? (yield* read)
    const queuedRun = runOf(waiting, queuedId)
    const queuedSettled = said(yield* Effect.orElseSucceed(actions.message(thread, queuedId), () => Option.none<T3Actions.Found>()))

    // Only a run still in the queue, never one under way.
    const cancelled = queuedRun?.status !== "queued" ? undefined : yield* dispatch("queued-run.cancel", commands(thread, stamp, { first: "", queued: queuedRun.id, idle: "" }).cancel)
    const afterCancel = cancelled === undefined ? undefined : runOf(Option.getOrUndefined(yield* until((projection) => runOf(projection, queuedId)?.status !== "queued")) ?? (yield* read), queuedId)

    const still = runOf(yield* read, firstId)
    const interrupted = still === undefined || !going.includes(still.status) ? undefined : yield* dispatch("run.interrupt, holding the queue", commands(thread, stamp, { first: still.id, queued: "", idle: "" }).interrupt)
    const afterInterrupt =
      interrupted === undefined
        ? undefined
        : runOf(Option.getOrUndefined(yield* until((projection) => !going.includes(runOf(projection, firstId)?.status ?? ""))) ?? (yield* read), firstId)

    // Only a queue it held itself, just now.
    const resumed = interrupted !== undefined && Either.isRight(interrupted) ? yield* dispatch("queue.resume", planned.resume) : undefined

    yield* sending("message.dispatch after, on the idle thread", planned.idle, planned.messages.idle)
    const idleId = planned.messages.idle
    const begunIdle = yield* until((projection) => ["running", "completed"].includes(runOf(projection, idleId)?.status ?? ""))
    const idleRun = runOf(Option.getOrUndefined(begunIdle) ?? (yield* read), idleId)
    if (idleRun !== undefined && idleRun.status === "queued") {
      yield* dispatch("queued-run.cancel, tidying up", commands(thread, stamp, { first: "", queued: "", idle: idleRun.id }).tidy)
    }

    const last = yield* read
    const settled = (messageId: string) => Effect.orElseSucceed(Effect.map(actions.message(thread, messageId), said), () => "unreadable")
    const sequence = (answer: Either.Either<unknown, unknown>) =>
      Either.match(answer, { onLeft: () => null, onRight: (value) => (typeof value === "object" && value !== null && "sequence" in value ? value.sequence : null) })
    const read1 = { first: firsts[firstId] ?? "not read", queued: firsts[queuedId] ?? "not read", idle: firsts[idleId] ?? "not read" }
    const later = { first: yield* settled(firstId), queued: queuedSettled, idle: yield* settled(idleId) }
    const report = {
      thread,
      stamp,
      steps,
      checks: {
        sameCommandOnce: { first: sequence(first), again: sequence(again), same: sequence(first) !== null && sequence(first) === sequence(again) },
        messageOnce: { messages: last.messages.filter(({ id }) => id === firstId).length, runs: last.runs.filter(({ userMessageId }) => userMessageId === firstId).length },
        foundByMessageId: firstRun !== undefined,
        // What yapd's one read right after sending says, against what the thread settled on: they should agree for "On it" and "queued" to be true.
        firstRead: { right: read1, later, agrees: read1.first === later.first && read1.queued === later.queued && read1.idle === later.idle },
        queued: { run: queuedRun ?? null },
        cancel: { answer: cancelled === undefined ? "not sent: no run in the queue" : Either.isRight(cancelled), statusAfter: afterCancel?.status ?? null },
        interrupt: { answer: interrupted === undefined ? "not sent: the first run had ended" : Either.isRight(interrupted), statusAfter: afterInterrupt?.status ?? null },
        resume: resumed === undefined ? "not sent: nothing was interrupted with its queue held" : Either.isRight(resumed),
        afterOnAnIdleThread: idleRun?.status ?? "not seen",
      },
    }
    yield* Console.log(JSON.stringify(report, null, 2))
    yield* Console.log(`The thread it started is left as it is: ${thread}`)
  })

if (!process.argv.includes("--send")) {
  // What it would send, with what it can only know once it's sending standing in.
  const planned = commands("<the probe's own new thread>", "probe<time>", { first: "<the first message's run>", queued: "<the queued message's run>", idle: "<the last message's run>" })
  console.log("Nothing is sent without --send. With --send --project <name or path>, it first starts a thread of its own there, then sends it, in order:")
  const { messages: _, ...sent } = planned
  for (const [name, payload] of Object.entries(sent)) console.log(`${name}: ${JSON.stringify(payload)}`)
  console.log("(the first is sent twice, resume only after its own interrupt was taken, and the last only if the one before it is still queued 30 seconds on)")
} else {
  const project = option("project")
  if (project === undefined || project.startsWith("--")) {
    console.error("usage: bun scripts/m2-probe.ts [--send --project <a T3 Code project's name or path>]")
    process.exit(2)
  }
  await Effect.runPromise(Effect.flatMap(provider, (configured) => probe(project).pipe(Effect.withConfigProvider(configured))))
}
