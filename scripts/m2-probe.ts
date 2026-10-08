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
//       2. message.dispatch, queue_after_active, likewise: "This is a test
//          from yapd, please ignore it: reply with just OK again." It should
//          wait behind 1, and stays there for the stop to hold.
//       3. queued-run.cancel with the run 1 waits in, as "scratch that"
//          sends it: only if it's still waiting in the queue.
//       4. run.interrupt with the first message's run and holdQueue true, as
//          "stop" sends it: only if that run is still going. 2 should then
//          stay in the queue, marked held (queueHeld).
//       5. queue.resume, as "carry on" sends it before its message: only if
//          the interrupt in 4 was taken and 2 is in the queue marked held, so
//          it only ever lets go of a queue the probe itself held. 2 should
//          then leave the queue, or stop being held, within 30 seconds, and
//          is let run and finish. If 2 isn't held, the stop didn't hold the
//          queue, and the resume isn't sent.
//       6. Only if 2 is still in the queue then: queued-run.cancel for it, so
//          nothing is left behind. Then it waits up to two minutes for the
//          thread to be idle.
//       7. message.dispatch, queue_after_active, on the idle thread: the
//          short message once more, to see whether "after" on an idle thread
//          starts at once or waits.
//       8. Only if that one is still waiting 30 seconds on:
//          queued-run.cancel for it, likewise. Then it waits for idle again.
//       9. message.dispatch, start_immediately with deliveryIntent auto, as
//          before: the slow message again, to have a turn under way.
//      10. run.interrupt with 9's run and holdQueue true, as "stop that and
//          tell it X instead" sends it first, once 9's run is going, whatever
//          it's doing: only if it gets going within 30 seconds. yapd never
//          uses T3 Code's own restart, which it turned down live for a turn
//          busy only in the background.
//      11. message.dispatch, start_immediately with deliveryIntent auto, as
//          yapd tells the turn it stopped: "This is a test from yapd, please
//          ignore it: stop that and reply with just OK instead." It's sent
//          only once 9's run shows stopped, within fifteen seconds, as yapd
//          waits for its live view to. It reports how long the stop took to
//          show, whether a run started by this message's own id shows up, and
//          whether that run waits in the queue the stop held, which would
//          leave it untold. Then it waits up to two minutes for the thread to
//          be idle.
//      12. Only if 11's run is still waiting in the queue then:
//          queued-run.cancel for it, so nothing is left behind.
//     Right after each message.dispatch it reads the thread once, as yapd
//     does to say whether a message was steered or queued, and to look for one
//     whose answer was lost. Otherwise it only reads the thread's bounded
//     view, once a second, for at most 30 seconds each time. It ends by
//     printing a JSON report: each command as sent and what T3 Code said back,
//     what that first read showed against what the thread settled on, and the
//     checks M2 depends on. If queued-run.cancel comes back refused, "scratch
//     that" is dropped from M2; if the stop doesn't hold the queue, or
//     queue.resume is refused or doesn't let go of what the stop held, "carry
//     on" becomes a plain message, as the spec says. A stop with nothing
//     queued behind it proves nothing either way, and is reported as
//     inconclusive. If the message after a stop waits in the queue instead of
//     starting a turn of its own, yapd has to let go of the queue too, or say
//     it waits. The thread it started is left for Laurent to look at or
//     archive.
//   bun scripts/m2-probe.ts --send --thread <the id of a thread it started>
//     Steps 9 to 12 alone, again, on a thread the probe started before, to
//     check "stop that and do this instead" once more without starting
//     another thread. It reads the whole thread once first, and refuses,
//     sending nothing, unless its first message is the probe's own opening
//     above, so it can never touch another thread. It waits up to two minutes
//     for that thread to be idle first, and stops if it isn't. It ends by
//     printing the same report's restart check. Without --send, it prints
//     those steps and sends nothing.

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}

/** What's sent, worded so whoever reads the thread knows to ignore it. */
const opening = "This is a test thread from yapd, please ignore it: reply with just OK."
const slow = "This is a test from yapd, please ignore it: run the shell command `sleep 45`, then reply with just OK."
const quick = "This is a test from yapd, please ignore it: reply with just OK."
const held = "This is a test from yapd, please ignore it: reply with just OK again."
const instead = "This is a test from yapd, please ignore it: stop that and reply with just OK instead."

/** A whole thread's messages, read once to make sure it's one the probe started. */
const Whole = Schema.Struct({
  projection: Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String, createdAt: Schema.String })) }),
})

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

/** Whether nothing's going in the thread, once it's had a turn. */
const idle = (projection: Projection) => projection.runs.length > 0 && !projection.runs.some(({ status }) => going.includes(status))

const runOf = (projection: Projection, messageId: string) => projection.runs.find(({ userMessageId }) => userMessageId === messageId)

/** The commands, in order, as yapd builds them, with what isn't known until they're sent standing in. */
const commands = (
  thread: string,
  stamp: string,
  runs: { readonly first: string; readonly queued: string; readonly held: string; readonly idle: string; readonly busy: string; readonly instead: string },
) => {
  const id = (step: number) => `yapd:${stamp}:${step}`
  const send = (step: number, text: string, how: T3Actions.When) =>
    T3Actions.command(thread, { _tag: "Send", text, messageId: `${id(step)}:m`, how }, undefined, id(step))
  return {
    first: send(0, slow, "now"),
    queued: send(1, quick, "after"),
    held: send(2, held, "after"),
    cancel: T3Actions.command(thread, { _tag: "Cancel", runId: runs.queued }, undefined, id(3)),
    interrupt: T3Actions.command(thread, { _tag: "Stop" }, runs.first, id(4)),
    resume: T3Actions.command(thread, { _tag: "Resume" }, undefined, id(5)),
    release: T3Actions.command(thread, { _tag: "Cancel", runId: runs.held }, undefined, id(6)),
    idle: send(7, quick, "after"),
    tidy: T3Actions.command(thread, { _tag: "Cancel", runId: runs.idle }, undefined, id(8)),
    busy: send(9, slow, "now"),
    stop: T3Actions.command(thread, { _tag: "Stop" }, runs.busy, id(10)),
    instead: send(11, instead, "now"),
    leftover: T3Actions.command(thread, { _tag: "Cancel", runId: runs.instead }, undefined, id(12)),
    /** The messages' own ids, to find them by. */
    messages: { first: `${id(0)}:m`, queued: `${id(1)}:m`, held: `${id(2)}:m`, idle: `${id(7)}:m`, busy: `${id(9)}:m`, instead: `${id(11)}:m` },
  }
}

/** None standing in for a run not known yet. */
const unknown = { first: "", queued: "", held: "", idle: "", busy: "", instead: "" }

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

/** T3 Code, reached with yapd's own token. */
const connected = Effect.gen(function* () {
  const token = yield* Effect.flatMap(
    Config.t3codeToken,
    Option.match({ onNone: () => Effect.dieMessage("Set YAPD_T3CODE_TOKEN in ~/.yapd/.env first."), onSome: Effect.succeed }),
  )
  const reach = T3CodeServer.connect(token)
  return { token, reach, ...(yield* reach), actions: T3Actions.make(reach) }
})

/** How it reads and sends to its own thread, keeping each command as sent, what came back, and the one read right after each message. */
const session = (thread: string, connection: Effect.Effect.Success<typeof connected>) => {
  const { api, call, actions } = connection
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
  return { read, until, steps, dispatch, firsts, sending }
}

/**
 * Steps 9 to 12: a turn under way, then "stop that and do this instead" as
 * yapd does it: the stop, holding the queue, once the turn is going, then,
 * once the thread shows it stopped, the message at once, under an id of its
 * own. What came of it, for the report.
 */
const restarting = (thread: string, stamp: string, connection: Effect.Effect.Success<typeof connected>, use: ReturnType<typeof session>) =>
  Effect.gen(function* () {
    const planned = commands(thread, stamp, unknown)
    const busyId = planned.messages.busy
    const insteadId = planned.messages.instead
    yield* use.sending("message.dispatch now, for a turn to stop", planned.busy, busyId)
    const underWay = runOf(Option.getOrUndefined(yield* use.until((projection) => going.includes(runOf(projection, busyId)?.status ?? ""))) ?? (yield* use.read), busyId)
    const stop =
      underWay === undefined || !going.includes(underWay.status)
        ? undefined
        : yield* use.dispatch("run.interrupt, holding the queue, to tell it something in its place", commands(thread, stamp, { ...unknown, busy: underWay.id }).stop)
    // Told only once the thread shows it stopped, as yapd waits for its live view to, for at most fifteen seconds.
    const began = Date.now()
    const shown = stop === undefined || Either.isLeft(stop) ? Option.none() : yield* use.until((projection) => !going.includes(runOf(projection, busyId)?.status ?? ""), 15)
    const told = Option.isNone(shown) ? undefined : yield* use.sending("message.dispatch now, once it shows stopped", planned.instead, insteadId)
    const own = told === undefined ? undefined : runOf(Option.getOrUndefined(yield* use.until((projection) => runOf(projection, insteadId) !== undefined)) ?? (yield* use.read), insteadId)
    // Nothing left waiting behind it: one the stop's held queue kept is taken out.
    if (own?.status === "queued") yield* use.dispatch("queued-run.cancel, tidying up what was held", commands(thread, stamp, { ...unknown, instead: own.id }).leftover)
    yield* use.until(idle, 120)
    return {
      stop: stop === undefined ? "not sent: the turn to stop never got going in 30 seconds" : Either.isRight(stop),
      stoppedRunStatus: Option.match(shown, { onNone: () => null, onSome: (projection) => runOf(projection, busyId)?.status ?? null }),
      shownStoppedAfterSeconds: Option.isNone(shown) ? null : Math.round((Date.now() - began) / 1000),
      told: told === undefined ? "not sent: it didn't show stopped within fifteen seconds" : Either.isRight(told),
      // A run of its own, started at once, is what yapd counts on; one waiting in the queue the stop held would leave it untold.
      ownRun: own === undefined ? null : { id: own.id, status: own.status, queueHeld: own.queueHeld ?? null },
      intent: { right: use.firsts[insteadId] ?? "not read", later: said(yield* Effect.orElseSucceed(connection.actions.message(thread, insteadId), () => Option.none<T3Actions.Found>())) },
    }
  })

const probe = (project: string) =>
  Effect.gen(function* () {
    const connection = yield* connected
    const { token, reach, actions } = connection

    // A thread of its own, so nothing it does can touch his work.
    const begun = yield* Effect.either(T3CodeLauncher.launcher(token, reach).start({ project, prompt: opening, worktree: false }))
    if (Either.isLeft(begun)) return yield* Effect.dieMessage(`Couldn't start a thread of its own: ${begun.left.reason}`)
    const thread = begun.right.thread
    yield* Console.log(`Started a thread of its own in ${begun.right.project}: ${thread}`)
    const use = session(thread, connection)
    const { read, until, steps, dispatch, firsts, sending } = use
    const ready = yield* until(idle, 120)
    if (Option.isNone(ready)) return yield* Effect.dieMessage(`The thread it started (${thread}) didn't finish its first turn in two minutes, so nothing more was sent.`)

    const stamp = `probe${Date.now().toString(36)}`
    const planned = commands(thread, stamp, unknown)
    const first = yield* sending("message.dispatch now", planned.first, planned.messages.first)
    const again = yield* dispatch("the same message.dispatch again", planned.first)
    const firstId = planned.messages.first
    const started = yield* until((projection) => ["running", "starting", "preparing"].includes(runOf(projection, firstId)?.status ?? ""))
    const seen = Option.getOrUndefined(started) ?? (yield* read)
    const firstRun = runOf(seen, firstId)

    yield* sending("message.dispatch after, while it runs", planned.queued, planned.messages.queued)
    yield* sending("message.dispatch after again, for the stop to hold", planned.held, planned.messages.held)
    const queuedId = planned.messages.queued
    const heldId = planned.messages.held
    const waiting =
      Option.getOrUndefined(yield* until((projection) => runOf(projection, queuedId) !== undefined && runOf(projection, heldId) !== undefined)) ?? (yield* read)
    const queuedRun = runOf(waiting, queuedId)
    const queuedSettled = said(yield* Effect.orElseSucceed(actions.message(thread, queuedId), () => Option.none<T3Actions.Found>()))

    // Only a run still in the queue, never one under way.
    const cancelled = queuedRun?.status !== "queued" ? undefined : yield* dispatch("queued-run.cancel", commands(thread, stamp, { ...unknown, queued: queuedRun.id }).cancel)
    const afterCancel = cancelled === undefined ? undefined : runOf(Option.getOrUndefined(yield* until((projection) => runOf(projection, queuedId)?.status !== "queued")) ?? (yield* read), queuedId)

    const still = runOf(yield* read, firstId)
    const interrupted =
      still === undefined || !going.includes(still.status) ? undefined : yield* dispatch("run.interrupt, holding the queue", commands(thread, stamp, { ...unknown, first: still.id }).interrupt)
    const afterInterrupt =
      interrupted === undefined
        ? undefined
        : runOf(Option.getOrUndefined(yield* until((projection) => !going.includes(runOf(projection, firstId)?.status ?? ""))) ?? (yield* read), firstId)
    // What the stop held: the second message, still in the queue and marked held, which nothing should start now.
    const heldBefore = interrupted === undefined ? undefined : runOf(yield* read, heldId)
    const holding = heldBefore?.status === "queued" && heldBefore.queueHeld === true

    // Only a queue it held itself, just now.
    const resumed = interrupted !== undefined && Either.isRight(interrupted) && holding ? yield* dispatch("queue.resume", planned.resume) : undefined
    const released = (run: Projection["runs"][number] | undefined) => run !== undefined && (run.status !== "queued" || run.queueHeld === false)
    const heldAfter =
      resumed !== undefined && Either.isRight(resumed) && holding
        ? runOf(Option.getOrUndefined(yield* until((projection) => released(runOf(projection, heldId)))) ?? (yield* read), heldId)
        : undefined
    const resume =
      interrupted === undefined || Either.isLeft(interrupted)
        ? "not sent: nothing was interrupted"
        : heldBefore === undefined
          ? "inconclusive: nothing was queued behind the stop, so the resume wasn't sent"
          : !holding
            ? "not sent: the stop didn't hold the queue, so carry on becomes a plain message"
            : resumed === undefined || Either.isLeft(resumed)
              ? "refused: carry on becomes a plain message"
              : released(heldAfter)
                ? "let go of what the stop held: carry on stands"
                : "didn't let go of what the stop held in 30 seconds: carry on becomes a plain message"
    // Nothing left waiting behind it: the held message, still queued, is taken out; started, it's let finish.
    const heldNow = runOf(yield* read, heldId)
    if (heldNow?.status === "queued") yield* dispatch("queued-run.cancel, tidying up what was held", commands(thread, stamp, { ...unknown, held: heldNow.id }).release)
    yield* until((projection) => !projection.runs.some(({ status }) => going.includes(status)), 120)

    yield* sending("message.dispatch after, on the idle thread", planned.idle, planned.messages.idle)
    const idleId = planned.messages.idle
    const begunIdle = yield* until((projection) => ["running", "completed"].includes(runOf(projection, idleId)?.status ?? ""))
    const idleRun = runOf(Option.getOrUndefined(begunIdle) ?? (yield* read), idleId)
    if (idleRun !== undefined && idleRun.status === "queued") {
      yield* dispatch("queued-run.cancel, tidying up", commands(thread, stamp, { ...unknown, idle: idleRun.id }).tidy)
    }
    yield* until((projection) => !projection.runs.some(({ status }) => going.includes(status)), 120)

    const restart = yield* restarting(thread, stamp, connection, use)

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
        interrupt: {
          answer: interrupted === undefined ? "not sent: the first run had ended" : Either.isRight(interrupted),
          statusAfter: afterInterrupt?.status ?? null,
          // The run the stop should hold: still queued, and held.
          held: heldBefore === undefined ? null : { status: heldBefore.status, queueHeld: heldBefore.queueHeld ?? null },
        },
        resume: {
          answer: resumed === undefined ? null : Either.isRight(resumed),
          held: heldAfter === undefined ? null : { status: heldAfter.status, queueHeld: heldAfter.queueHeld ?? null },
          verdict: resume,
        },
        afterOnAnIdleThread: idleRun?.status ?? "not seen",
        restart,
      },
    }
    yield* Console.log(JSON.stringify(report, null, 2))
    yield* Console.log(`The thread it started is left as it is: ${thread}`)
  })

/** Steps 9 and 10 again, on a thread the probe started before, and on no other. */
const again = (thread: string) =>
  Effect.gen(function* () {
    const connection = yield* connected
    // Only its own: a thread whose first message is the probe's own opening, read in full, since a busy thread's bounded view may no longer reach back to it.
    const whole = yield* connection.api(`/api/orchestration/threads/${encodeURIComponent(thread)}`, Whole)
    const first = whole.projection.messages.filter(({ role }) => role === "user").toSorted((one, other) => one.createdAt.localeCompare(other.createdAt))[0]
    if (first?.text.trim() !== opening) {
      return yield* Effect.dieMessage(`${thread} isn't a thread this probe started: its first message isn't the probe's own opening, so nothing was sent.`)
    }
    const use = session(thread, connection)
    const ready = yield* use.until(idle, 120)
    if (Option.isNone(ready)) return yield* Effect.dieMessage(`${thread} wasn't idle within two minutes, so nothing was sent.`)
    const stamp = `probe${Date.now().toString(36)}`
    const restart = yield* restarting(thread, stamp, connection, use)
    yield* Console.log(JSON.stringify({ thread, stamp, steps: use.steps, checks: { restart } }, null, 2))
  })

const usage = "usage: bun scripts/m2-probe.ts [--send] [--project <a T3 Code project's name or path> | --thread <the id of a thread it started>]"
const project = option("project")
const thread = option("thread")
if ((project !== undefined && project.startsWith("--")) || (thread !== undefined && thread.startsWith("--")) || (project !== undefined && thread !== undefined)) {
  console.error(usage)
  process.exit(2)
}
if (!process.argv.includes("--send")) {
  // What it would send, with what it can only know once it's sending standing in.
  const planned = commands(thread ?? "<the probe's own new thread>", "probe<time>", {
    first: "<the first message's run>",
    queued: "<the first queued message's run>",
    held: "<the held message's run>",
    idle: "<the message sent after on the idle thread's run>",
    busy: "<the run of the turn to stop>",
    instead: "<the run of the message in its place>",
  })
  const { messages: _, ...sent } = planned
  const stopThenTell = "the stop only once the turn before it is going, the message in its place only once that turn shows stopped within fifteen seconds, and its cancel only if it's still queued"
  if (thread !== undefined) {
    console.log(`Nothing is sent without --send. With --send --thread ${thread}, once it's made sure the probe started that thread, it sends it, in order:`)
    for (const name of ["busy", "stop", "instead", "leftover"] as const) console.log(`${name}: ${JSON.stringify(sent[name])}`)
    console.log(`(${stopThenTell})`)
  } else {
    console.log("Nothing is sent without --send. With --send --project <name or path>, it first starts a thread of its own there, then sends it, in order:")
    for (const [name, payload] of Object.entries(sent)) console.log(`${name}: ${JSON.stringify(payload)}`)
    console.log(
      `(the first is sent twice, resume only after its own interrupt was taken and held the queue, the cancels after it only for what's still queued then, ${stopThenTell})`,
    )
  }
} else if (thread !== undefined) {
  await Effect.runPromise(Effect.flatMap(provider, (configured) => again(thread).pipe(Effect.withConfigProvider(configured))))
} else if (project !== undefined) {
  await Effect.runPromise(Effect.flatMap(provider, (configured) => probe(project).pipe(Effect.withConfigProvider(configured))))
} else {
  console.error(usage)
  process.exit(2)
}
