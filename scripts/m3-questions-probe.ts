import { appendFileSync } from "node:fs"
import { ConfigProvider, Console, Effect, Either, Option, Schema } from "effect"
import * as Config from "../src/Config.ts"
import { settings } from "../src/Home.ts"
import * as T3Actions from "../src/T3Actions.ts"
import * as T3CodeLauncher from "../src/T3CodeLauncher.ts"
import * as T3CodeServer from "../src/T3CodeServer.ts"

// Checks, once, how T3 Code and the agents it runs take an agent's question
// and its answer, before yapd reads questions aloud and answers them by voice
// on real threads: how soon the question's card can be read once the thread
// shows it waits on one, what the card holds, how an option, a list and his
// own words reach the agent, what a part left out, nothing at all, and a
// cancel come to, what a message sent while it waits does to it, what's left
// to answer once the run is stopped, and how Codex asks. It's never loaded by
// the daemon, and sends nothing unless told to, and then only to threads it
// starts for itself, with Laurent's OK.
//
// Turn yapd off first. On, it would read each of the probe's questions aloud,
// and what he said or dictated meanwhile could answer one itself, spoiling
// the step. Run it on the Mac where yapd speaks, or turn off the yapd that
// follows this machine's T3 Code: yapd follows other machines' T3 Code
// through its tunnel, so one on Rosie reads and answers Rig's threads. With
// --send, it asks yapd's API here whether it's on, and goes on only when
// yapd says it's off. Nothing answering here isn't taken for off, since the
// yapd following this T3 Code may be on another Mac, unless it's told so
// with --yapd-not-running; nor is an answer that isn't yapd's state.
//
//   bun scripts/m3-questions-probe.ts
//     Prints every command it would send, in order, with what it can only
//     know once it's sending standing in, and sends nothing. It doesn't even
//     read T3 Code.
//   bun scripts/m3-questions-probe.ts --send --project <a T3 Code project's name or path> [--claude <model>] [--codex <model>] [--yapd-not-running]
//     First starts two threads of its own in that project, without a
//     worktree, as yapd starts work: one Claude, one Codex, each the first
//     ready model of its provider unless named. Each opens with "This is a
//     test thread from yapd, please ignore it: reply with just OK.", and it
//     waits up to two minutes for that turn to end. A thread that isn't on
//     full access is sent nothing more. It never reads or touches any other
//     thread: of the shell, which lists them all, it only looks at its own
//     two. Then, every id starting yapd:probe<time>:, on the Claude thread:
//       A. Asks Claude to call AskUserQuestion once, with "Which colour should
//          the test use?" (header "Colour"; "Red", "Blue (Recommended)";
//          single select) and "Which test extras should run?" ("Alpha",
//          "Beta", "Gamma"; multi-select), then to reply with the tool's
//          result word for word. While it waits, it notes when the shell
//          showed the request against when /bounded had its card, the card
//          itself, the run's status, and the arguments of its own Claude
//          process (`ps -ax -o args`, only the lines with its own session's
//          id). Answers {colour: "Blue (Recommended)", extras: ["Alpha",
//          "Gamma"]}, as the card writes them, and keeps Claude's reply.
//       B. The same, answered {colour: "Green please", extras: ["Beta"]}.
//       C. The same, answered with no answers at all; then the colour part
//          alone, answered with decision "cancel" alone; then that cancel
//          again under a new commandId, and again under its own.
//       D. The colour part alone, then, while it waits, "This is a test from
//          yapd, please ignore it: reply with just OK." sent as yapd sends
//          "now"; it notes what came of the question and whether OK came,
//          and, if the question still waits, answers it "Red".
//       E. The colour part alone, then the run stopped while it waits, as
//          "stop" sends it, then answered "Red".
//       G. The colour part alone, with "Red" given an empty description; it
//          notes whether the question shows at all, and answers "Red".
//       H. Both parts again, only the colour one answered, "Red".
//     and on the Codex thread:
//       F. Plan mode (thread.interaction-mode.set), then asks Codex to use
//          request_user_input once for the colour, with "Red" and "Blue",
//          answered "Blue"; then again, answered "Green please"; then default
//          mode and the same ask, answered "Red" if it comes.
//     Each step reads the shell and /bounded once a second, for at most 30
//     seconds, for the question to show or to change, and up to two minutes,
//     as the M2 probe does, for a turn to end. A question that doesn't come
//     within 30 seconds is noted, and the step goes no further. A turn of its
//     own still going two minutes on is stopped, so the next step can ask.
//     Everything it does is written to /tmp/yapd-m3-questions-probe.log as
//     well, and it ends by printing a JSON report. Both threads are left as
//     they are, for Laurent to look at or archive.

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}

/** Where what it does is written as it goes, as well as printed. */
const logFile = "/tmp/yapd-m3-questions-probe.log"

/** What's sent, worded so whoever reads the thread knows to ignore it. */
const opening = "This is a test thread from yapd, please ignore it: reply with just OK."
const ok = "This is a test from yapd, please ignore it: reply with just OK."

/** The questions it asks Claude for, as AskUserQuestion takes them. */
const colour = {
  question: "Which colour should the test use?",
  header: "Colour",
  multiSelect: false,
  options: [
    { label: "Red", description: "A red test." },
    { label: "Blue (Recommended)", description: "A blue test." },
  ],
}
const extras = {
  question: "Which test extras should run?",
  header: "Extras",
  multiSelect: true,
  options: [
    { label: "Alpha", description: "The alpha extra." },
    { label: "Beta", description: "The beta extra." },
    { label: "Gamma", description: "The gamma extra." },
  ],
}
/** The colour part with an option T3 Code may drop, its description empty. */
const blank = { ...colour, options: [{ label: "Red", description: "" }, { label: "Blue", description: "A blue test." }] }

const asking = (questions: ReadonlyArray<object>) =>
  `This is a test from yapd, please ignore it. Call the AskUserQuestion tool exactly once, with this input and nothing else: ${JSON.stringify({ questions })} Once it's answered, reply with the tool's result word for word, and nothing else. Don't run anything else.`

const codexAsking =
  'This is a test from yapd, please ignore it. Use the request_user_input tool exactly once to ask me one question: "Which colour should the test use?", with the header "Colour" and the options "Red" (a red test) and "Blue" (a blue test). Once I answer, reply with my answer word for word, and nothing else. Don\'t change any file or run anything else.'

/** Its own threads, as the shell lists them: whether each waits on a request, and how it runs. Nothing else in the shell is looked at. */
const Shell = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      runtimeMode: Schema.optional(Schema.String),
      interactionMode: Schema.optional(Schema.String),
      pendingRuntimeRequest: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String, kind: Schema.String, createdAt: Schema.String }))),
    }),
  ),
})

/** A thread as the bounded view has it, with what the checks need. */
const Bounded = Schema.Struct({
  projection: Schema.Struct({
    runs: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String, userMessageId: Schema.optional(Schema.NullOr(Schema.String)) })),
    messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.optional(Schema.String), createdAt: Schema.optional(Schema.String) })),
    turnItems: Schema.Array(Schema.Unknown),
    runtimeRequests: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
    providerThreads: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
  }),
})
type Projection = (typeof Bounded.Type)["projection"]

/** A request T3 Code keeps, with how it ended and what it was answered with. */
const RuntimeRequest = Schema.Struct({
  id: Schema.String,
  kind: Schema.optional(Schema.String),
  status: Schema.String,
  responseCapability: Schema.optional(Schema.Unknown),
  decision: Schema.optional(Schema.Unknown),
  answers: Schema.optional(Schema.Unknown),
})
const runtimeRequest = Schema.decodeUnknownOption(RuntimeRequest)

/** A turn item, as far as finding a question's card goes. */
const Card = Schema.Struct({ type: Schema.String, requestId: Schema.optional(Schema.String) })
const card = Schema.decodeUnknownOption(Card)

/** The providers T3 Code can run, to pick a Claude model and a Codex one. */
const Providers = Schema.Struct({
  providers: Schema.Array(Schema.Struct({ instanceId: Schema.String, enabled: Schema.Boolean, status: Schema.String, models: Schema.Array(Schema.Struct({ slug: Schema.String })) })),
})

/** Runs that are still going. */
const going = ["preparing", "starting", "running", "waiting"]

/** Whether nothing's going in the thread, once it's had a turn. */
const idle = (projection: Projection) => projection.runs.length > 0 && !projection.runs.some(({ status }) => going.includes(status))

/** The request it's kept as, by its id. */
const requestOf = (projection: Projection, id: string) =>
  projection.runtimeRequests.flatMap((request) => Option.toArray(runtimeRequest(request))).find((request) => request.id === id)

/** The card of a question the thread still waits on, the newest. */
const waitingCard = (projection: Projection) =>
  projection.turnItems
    .toReversed()
    .find((item) =>
      Option.exists(card(item), ({ type, requestId }) => type === "user_input_request" && requestId !== undefined && requestOf(projection, requestId)?.status === "pending"),
    )

/** What the agent last said. */
const lastSaid = (projection: Projection) => projection.messages.filter(({ role }) => role === "assistant").at(-1)?.text ?? null

/** What it knows of a question only once it's asked, or what stands in for it in what's printed. */
interface Known {
  readonly request: string
  readonly colour: string
  readonly extras: string
  readonly red: string
  readonly blue: string
  readonly alpha: string
  readonly beta: string
  readonly gamma: string
  readonly run: string
}

const unknown: Known = {
  request: "<the request it waits on>",
  colour: "<the colour part's id, as the card has it>",
  extras: "<the extras part's id, as the card has it>",
  red: "<Red, as the card writes it>",
  blue: "<Blue, as the card writes it>",
  alpha: "<Alpha, as the card writes it>",
  beta: "<Beta, as the card writes it>",
  gamma: "<Gamma, as the card writes it>",
  run: "<the run that asked>",
}

/** The commands, as yapd builds them, under the probe's own ids, with what isn't known until they're sent standing in. */
const commands = (threads: { readonly claude: string; readonly codex: string }, stamp: string, known: Known) => {
  const id = (step: string) => `yapd:${stamp}:${step}`
  const send = (thread: string, step: string, text: string) => T3Actions.command(thread, { _tag: "Send", text, messageId: `${id(step)}:m`, how: "now" }, undefined, id(step))
  const answer = (thread: string, step: string, answers: Readonly<Record<string, string | ReadonlyArray<string>>>) =>
    T3Actions.command(thread, { _tag: "Answer", requestId: known.request, answers }, undefined, id(step))
  const cancel = (step: string) => T3Actions.command(threads.claude, { _tag: "Decide", requestId: known.request, decision: "cancel" }, undefined, id(step))
  /** Plan mode or default, as T3 Code's app sets it; the field is named as the thread shell names it. */
  const mode = (step: string, interactionMode: "plan" | "default") => ({ type: "thread.interaction-mode.set", commandId: id(step), threadId: threads.codex, interactionMode })
  const { claude, codex } = threads
  return {
    A1: send(claude, "A1", asking([colour, extras])),
    A2: answer(claude, "A2", { [known.colour]: known.blue, [known.extras]: [known.alpha, known.gamma] }),
    B1: send(claude, "B1", asking([colour, extras])),
    B2: answer(claude, "B2", { [known.colour]: "Green please", [known.extras]: [known.beta] }),
    C1: send(claude, "C1", asking([colour, extras])),
    C2: answer(claude, "C2", {}),
    C3: send(claude, "C3", asking([colour])),
    C4: cancel("C4"),
    C5: cancel("C5"),
    D1: send(claude, "D1", asking([colour])),
    D2: send(claude, "D2", ok),
    D3: answer(claude, "D3", { [known.colour]: known.red }),
    E1: send(claude, "E1", asking([colour])),
    E2: T3Actions.command(claude, { _tag: "Stop" }, known.run, id("E2")),
    E3: answer(claude, "E3", { [known.colour]: known.red }),
    G1: send(claude, "G1", asking([blank])),
    G2: answer(claude, "G2", { [known.colour]: known.red }),
    H1: send(claude, "H1", asking([colour, extras])),
    H2: answer(claude, "H2", { [known.colour]: known.red }),
    F1: mode("F1", "plan"),
    F2: send(codex, "F2", codexAsking),
    F3: answer(codex, "F3", { [known.colour]: known.blue }),
    F4: send(codex, "F4", codexAsking),
    F5: answer(codex, "F5", { [known.colour]: "Green please" }),
    F6: mode("F6", "default"),
    F7: send(codex, "F7", codexAsking),
    F8: answer(codex, "F8", { [known.colour]: known.red }),
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

/** Prints a line and writes it to the log. */
const note = (line: string) =>
  Effect.zipRight(
    Console.log(line),
    Effect.sync(() => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)),
  )

/** Whether nothing listens on the port, as Bun or Node say when a connection is refused. */
const refused = (cause: unknown) => {
  const { code, cause: under } = (typeof cause === "object" && cause !== null ? cause : {}) as { readonly code?: unknown; readonly cause?: { readonly code?: unknown } }
  return [code, under?.code].some((said) => said === "ConnectionRefused" || said === "ECONNREFUSED")
}

/**
 * Whether yapd is on, as its API here says, which would read the probe's
 * questions aloud and could answer them. Off only when it says so. "absent"
 * when nothing listens here, which isn't off: a yapd on another Mac may follow
 * this machine's T3 Code through its tunnel, its hooks' tunnel here being
 * down. Anything else, like no answer in time, or one that isn't its state,
 * as when it's closing, isn't known.
 */
const yapd = Effect.gen(function* () {
  const port = yield* Config.port
  return yield* Effect.tryPromise({
    try: () => fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json() as Promise<unknown>),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((state): "on" | "off" | "absent" | "unknown" =>
      typeof state === "object" && state !== null && "on" in state && typeof state.on === "boolean" ? (state.on ? "on" : "off") : "unknown",
    ),
    Effect.catchAll((cause) => Effect.succeed(refused(cause) ? ("absent" as const) : ("unknown" as const))),
  )
})

/** T3 Code, reached with yapd's own token. */
const connected = Effect.gen(function* () {
  const token = yield* Effect.flatMap(
    Config.t3codeToken,
    Option.match({ onNone: () => Effect.dieMessage("Set YAPD_T3CODE_TOKEN in ~/.yapd/.env first."), onSome: Effect.succeed }),
  )
  const reach = T3CodeServer.connect(token)
  return { token, reach, ...(yield* reach) }
})
type Connection = Effect.Effect.Success<typeof connected>

/** Every command it sent, in order, and what T3 Code said back. */
const sent: Array<{ readonly name: string; readonly payload: unknown; readonly answer: unknown }> = []

/** Sends a command, keeping it and what came back. */
const dispatch = (connection: Connection, name: string, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const answer = yield* Effect.either(connection.call("orchestration.dispatchCommand", payload, Schema.Unknown))
    const told = Either.match(answer, {
      onRight: (value) => ({ ok: value }),
      onLeft: (error) => (error._tag === "Refusal" ? { refused: error.tag, message: error.message } : { trouble: error.reason, sent: error.sent === true }),
    })
    sent.push({ name, payload, answer: told })
    yield* note(`${name}: ${JSON.stringify(told)}`)
    return answer
  })

/** The sequence T3 Code gave back for a command it took. */
const sequence = (answer: Either.Either<unknown, unknown>) =>
  Either.match(answer, { onLeft: () => null, onRight: (value) => (typeof value === "object" && value !== null && "sequence" in value ? value.sequence : null) })

/** How it reads one of its own threads: its bounded view, and its line in the shell. */
const session = (thread: string, connection: Connection) => {
  const { api } = connection
  const read = Effect.map(api(`/api/orchestration/threads/${encodeURIComponent(thread)}/bounded`, Bounded), ({ projection }) => projection)
  const listed = Effect.map(api("/api/orchestration/shell", Shell), ({ threads }) => threads.find(({ id }) => id === thread))

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

  /**
   * Waits, reading the shell then /bounded once a second for at most 30
   * seconds, for the thread to wait on a question, and notes when the shell
   * first showed it against when its card was first there to read. A card
   * the shell still doesn't show five seconds on is taken as it is.
   */
  const question = Effect.gen(function* () {
    const began = Date.now()
    let shownAt: number | undefined
    let cardAt: number | undefined
    let requestId: string | undefined
    for (let tries = 0; tries < 30; tries++) {
      const pending = (yield* listed)?.pendingRuntimeRequest ?? null
      if (pending !== null && pending.kind === "user_input") {
        requestId ??= pending.id
        shownAt ??= Date.now()
      }
      const projection = yield* read
      const found = Option.flatMap(Option.fromNullable(waitingCard(projection)), card)
      if (Option.isSome(found) && found.value.requestId !== undefined) {
        requestId ??= found.value.requestId
        if (found.value.requestId === requestId) cardAt ??= Date.now()
      }
      if (requestId !== undefined && cardAt !== undefined && (shownAt !== undefined || Date.now() - cardAt >= 5_000)) {
        const raw = projection.turnItems.find((item) => Option.exists(card(item), ({ type, requestId: of }) => type === "user_input_request" && of === requestId))
        return Option.some({
          requestId,
          projection,
          raw,
          request: T3Actions.request(projection.turnItems, requestId),
          shownAfterSeconds: shownAt === undefined ? null : (shownAt - began) / 1000,
          cardAfterSeconds: (cardAt - began) / 1000,
          // The shell is read first each time, so a card there by the same read is behind it only by the time /bounded takes.
          gapSeconds: shownAt === undefined ? null : (cardAt - shownAt) / 1000,
          runs: projection.runs.filter(({ status }) => going.includes(status)).map(({ id, status }) => ({ id, status })),
          kept: requestOf(projection, requestId) ?? null,
        })
      }
      yield* Effect.sleep("1 second")
    }
    return Option.none()
  })

  /** Waits up to two minutes for the turn to end, then what the agent last said, and how the request it answered ended. */
  const settled = (requestId: string | undefined) =>
    Effect.gen(function* () {
      const ended = yield* until(idle, 120)
      const projection = Option.getOrUndefined(ended) ?? (yield* read)
      return {
        ended: Option.isSome(ended),
        runs: projection.runs.slice(-2).map(({ id, status }) => ({ id, status })),
        said: lastSaid(projection),
        request: requestId === undefined ? null : (requestOf(projection, requestId) ?? null),
      }
    })

  /** Stops a turn of its own still going, so the next step can ask. */
  const tidy = (stamp: string, step: string) =>
    Effect.gen(function* () {
      const run = (yield* read).runs.find(({ status }) => going.includes(status))
      if (run === undefined) return
      yield* dispatch(connection, `${step}: run.interrupt, tidying up a turn still going`, T3Actions.command(thread, { _tag: "Stop" }, run.id, `yapd:${stamp}:${step}:tidy`))
      yield* until(idle, 30)
    })

  return { read, listed, until, question, settled, tidy }
}
type Session = ReturnType<typeof session>

/** What the probe knows of a question it asked, from its card: each part's id and each option as the card writes it. */
const knownOf = (asked: Option.Option<T3Actions.Request>, run: string, requestId: string): Known => {
  const questions = Option.match(asked, { onNone: () => [], onSome: (request) => (request._tag === "Question" ? request.questions : []) })
  /** The part asking this, or the one in its place when the agent worded it otherwise. */
  const part = (text: string, place: number) => questions.find(({ question }) => question === text) ?? questions[place]
  const first = part(colour.question, 0)
  const second = part(extras.question, 1)
  /** The option's label, or value, as the card writes it, by how it starts. */
  const named = (from: (typeof questions)[number] | undefined, name: string) =>
    Option.match(Option.fromNullable(from?.options.find(({ label }) => label.toLowerCase().startsWith(name.toLowerCase()))), {
      onNone: () => name,
      onSome: T3Actions.choice,
    })
  return {
    request: requestId,
    colour: first?.id ?? colour.question,
    extras: second?.id ?? extras.question,
    red: named(first, "Red"),
    blue: named(first, "Blue"),
    alpha: named(second, "Alpha"),
    beta: named(second, "Beta"),
    gamma: named(second, "Gamma"),
    run,
  }
}

/** Only the lines of its own agent's process: those naming its own session. */
const processes = (projection: Projection) => {
  const own = T3Actions.natives(projection.providerThreads)
  const listed = Bun.spawnSync(["ps", "-ax", "-o", "args"]).stdout.toString().split("\n")
  return listed.filter((line) => /claude/i.test(line) && own.some((id) => line.includes(id))).map((line) => line.slice(0, 600))
}

/**
 * One ask and its answer: sends the ask once the thread is idle, waits for
 * the question, answers it with what `answering` builds from what the card
 * says, and keeps what came of it.
 */
const step = (
  connection: Connection,
  use: Session,
  stamp: string,
  name: string,
  ask: (known: Known) => Record<string, unknown>,
  answering: ((known: Known) => Record<string, unknown>) | undefined,
  extra: (asked: Option.Option.Value<Effect.Effect.Success<Session["question"]>>, known: Known) => Effect.Effect<Record<string, unknown>, unknown> = () => Effect.succeed({}),
) =>
  Effect.gen(function* () {
    const ready = yield* use.until(idle, 120)
    if (Option.isNone(ready)) {
      yield* use.tidy(stamp, name)
      return { sent: "not sent: the thread wasn't idle within two minutes" }
    }
    yield* dispatch(connection, `${name}: message.dispatch now, asking`, ask(unknown))
    const asked = yield* use.question
    if (Option.isNone(asked)) {
      yield* note(`${name}: no question within 30 seconds`)
      const after = yield* use.settled(undefined)
      yield* use.tidy(stamp, name)
      return { question: "none within 30 seconds", after }
    }
    const { requestId, request, raw, shownAfterSeconds, cardAfterSeconds, gapSeconds, runs, kept } = asked.value
    const known = knownOf(request, runs[0]?.id ?? "", requestId)
    const more = yield* extra(asked.value, known)
    const answered = answering === undefined ? undefined : yield* dispatch(connection, `${name}: runtime-request.respond`, answering(known))
    const after = yield* use.settled(requestId)
    yield* use.tidy(stamp, name)
    return {
      question: { requestId, shownAfterSeconds, cardAfterSeconds, gapSeconds, runs, kept, card: raw ?? null },
      ...more,
      answered: answered === undefined ? null : Either.isRight(answered),
      after,
    }
  })

const probe = (project: string) =>
  Effect.gen(function* () {
    // Nothing starts while yapd may be on, here or on a Mac that follows this T3 Code, so it never reads these questions aloud, nor answers one.
    const state = yield* yapd
    if (state !== "off" && !(state === "absent" && process.argv.includes("--yapd-not-running"))) {
      return yield* Effect.dieMessage(
        state === "on"
          ? 'yapd is on, so it would read these questions aloud and could answer them: turn it off first, from the menu bar or with PUT /state {"on": false}, then run this again.'
          : state === "absent"
            ? "Nothing answers for yapd here, but a yapd on another Mac may follow this machine's T3 Code and would read these questions aloud: run this on the Mac where yapd speaks, or turn that yapd off. If no yapd follows this T3 Code at all, run this again with --yapd-not-running."
            : "yapd didn't say whether it's on, so nothing was started: make sure it's off, then run this again.",
      )
    }
    appendFileSync(logFile, `\n${new Date().toISOString()} m3-questions-probe --send --project ${project}\n`)
    const connection = yield* connected
    const { token, reach, call } = connection

    // A Claude model and a Codex one, as named, or each provider's first that's ready.
    const { providers } = yield* call("server.getConfig", {}, Providers)
    const first = (instance: string) =>
      providers.find((listed) => listed.instanceId === instance && listed.enabled && listed.status === "ready")?.models[0]?.slug
    const models = { claude: option("claude") ?? first("claudeAgent"), codex: option("codex") ?? first("codex") }
    if (models.claude === undefined) return yield* Effect.dieMessage("T3 Code has no Claude model ready, so nothing was started.")

    // Threads of its own, so nothing it does can touch his work.
    const launcher = T3CodeLauncher.launcher(token, reach)
    const start = (model: string) => Effect.either(launcher.start({ project, prompt: opening, model, worktree: false }))
    const claudeStarted = yield* start(models.claude)
    if (Either.isLeft(claudeStarted)) return yield* Effect.dieMessage(`Couldn't start a Claude thread of its own: ${claudeStarted.left.reason}`)
    const claude = claudeStarted.right.thread
    yield* note(`Started a Claude thread of its own in ${claudeStarted.right.project}: ${claude}`)
    const codexStarted = models.codex === undefined ? undefined : yield* start(models.codex)
    const codex = codexStarted !== undefined && Either.isRight(codexStarted) ? codexStarted.right.thread : undefined
    yield* note(
      codex !== undefined
        ? `Started a Codex thread of its own: ${codex}`
        : `No Codex thread, so step F is left out: ${codexStarted === undefined ? "no Codex model is ready" : Either.isLeft(codexStarted) ? codexStarted.left.reason : ""}`,
    )

    const stamp = `probe${Date.now().toString(36)}`
    const built = (known: Known) => commands({ claude, codex: codex ?? "<no Codex thread>" }, stamp, known)
    const claudeUse = session(claude, connection)
    const report: Record<string, unknown> = { stamp, threads: { claude, codex: codex ?? null }, models }

    // Only on full access, as his agents run, so nothing it asks waits on an approval.
    const fullAccess = (use: Session) => Effect.map(use.listed, (entry) => entry?.runtimeMode === "full-access")
    if (!(yield* fullAccess(claudeUse))) {
      yield* note(`${claude} isn't on full access, so nothing more was sent to it.`)
    } else {
      report.A = yield* step(connection, claudeUse, stamp, "A", (known) => built(known).A1, (known) => built(known).A2, ({ projection }) =>
        Effect.sync(() => ({ processes: processes(projection) })),
      )
      report.B = yield* step(connection, claudeUse, stamp, "B", (known) => built(known).B1, (known) => built(known).B2)
      const nothing = yield* step(connection, claudeUse, stamp, "C-nothing", (known) => built(known).C1, (known) => built(known).C2)
      const cancel = yield* step(connection, claudeUse, stamp, "C-cancel", (known) => built(known).C3, (known) => built(known).C4)
      // The cancel again, now it's settled: under a new id it should be turned down as resolved; under its own, T3 Code's first answer comes back.
      const cancelled = sent.findLast(({ name }) => name === "C-cancel: runtime-request.respond")
      const payload = cancelled?.payload
      const again =
        typeof payload === "object" && payload !== null && "requestId" in payload && typeof payload.requestId === "string"
          ? yield* Effect.gen(function* () {
              const known = { ...unknown, request: String(payload.requestId) }
              const anew = yield* dispatch(connection, "C-cancel: the cancel again, under a new commandId", built(known).C5)
              const same = yield* dispatch(connection, "C-cancel: the cancel again, under its own commandId", built(known).C4)
              return { first: cancelled?.answer ?? null, anew: Either.isRight(anew) ? "taken" : "turned down", sameSequence: sequence(same) }
            })
          : "not sent: the cancel wasn't"
      report.C = { nothing, cancel, again }
      report.D = yield* step(connection, claudeUse, stamp, "D", (known) => built(known).D1, undefined, ({ requestId }, known) =>
        Effect.gen(function* () {
          yield* dispatch(connection, "D: message.dispatch now, while the question waits", built(known).D2)
          // What came of the question, and whether the OK came, within 30 seconds.
          const changed = yield* claudeUse.until((projection) => requestOf(projection, requestId)?.status !== "pending" || /^ok\.?$/i.test(lastSaid(projection)?.trim() ?? ""))
          const projection = Option.getOrUndefined(changed) ?? (yield* claudeUse.read)
          const status = requestOf(projection, requestId)?.status ?? null
          const later = status === "pending" ? yield* dispatch(connection, "D: runtime-request.respond, once the message went", built(known).D3) : undefined
          return { afterMessage: { request: status, said: lastSaid(projection) }, answeredAfter: later === undefined ? null : Either.isRight(later) }
        }),
      )
      report.E = yield* step(connection, claudeUse, stamp, "E", (known) => built(known).E1, undefined, ({ requestId }, known) =>
        Effect.gen(function* () {
          yield* dispatch(connection, "E: run.interrupt while the question waits", built(known).E2)
          const ended = yield* claudeUse.until((projection) => requestOf(projection, requestId)?.status !== "pending")
          const projection = Option.getOrUndefined(ended) ?? (yield* claudeUse.read)
          const late = yield* dispatch(connection, "E: runtime-request.respond, once stopped", built(known).E3)
          return { afterStop: requestOf(projection, requestId) ?? null, lateAnswer: Either.isRight(late) ? "taken" : "turned down" }
        }),
      )
      report.G = yield* step(connection, claudeUse, stamp, "G", (known) => built(known).G1, (known) => built(known).G2)
      report.H = yield* step(connection, claudeUse, stamp, "H", (known) => built(known).H1, (known) => built(known).H2)
    }

    if (codex !== undefined) {
      const codexUse = session(codex, connection)
      if (!(yield* fullAccess(codexUse))) {
        yield* note(`${codex} isn't on full access, so nothing more was sent to it.`)
      } else {
        yield* codexUse.until(idle, 120)
        const plan = yield* dispatch(connection, "F: thread.interaction-mode.set plan", built(unknown).F1)
        const label = yield* step(connection, codexUse, stamp, "F-label", (known) => built(known).F2, (known) => built(known).F3)
        const words = yield* step(connection, codexUse, stamp, "F-words", (known) => built(known).F4, (known) => built(known).F5)
        const back = yield* dispatch(connection, "F: thread.interaction-mode.set default", built(unknown).F6)
        const usual = yield* step(connection, codexUse, stamp, "F-default", (known) => built(known).F7, (known) => built(known).F8)
        report.F = { plan: Either.isRight(plan), label, words, default: Either.isRight(back), usual, mode: (yield* codexUse.listed)?.interactionMode ?? null }
      }
    }

    const whole = JSON.stringify({ ...report, sent }, null, 2)
    yield* note(whole)
    yield* note(`The threads it started are left as they are: ${[claude, codex].filter((id) => id !== undefined).join(", ")}`)
  })

const usage = "usage: bun scripts/m3-questions-probe.ts [--send --project <a T3 Code project's name or path> [--claude <model>] [--codex <model>] [--yapd-not-running]]"
const project = option("project")
if (project !== undefined && project.startsWith("--")) {
  console.error(usage)
  process.exit(2)
}
if (!process.argv.includes("--send")) {
  // What it would send, with what it can only know once it's sending standing in.
  const planned = commands({ claude: "<the probe's own Claude thread>", codex: "<the probe's own Codex thread>" }, "probe<time>", unknown)
  console.log(
    "Nothing is sent without --send. Turn yapd off first, and run this on the Mac where yapd speaks, since a yapd on another Mac may follow this machine's T3 Code: with --send, it goes on only once yapd here says it's off, since yapd would read its questions aloud and could answer them. With nothing answering for yapd here, it stops unless given --yapd-not-running.",
  )
  console.log("With --send --project <name or path>, it first starts two threads of its own there, as yapd starts work:")
  for (const [provider, model] of [["Claude", "<--claude, or the first Claude model ready>"], ["Codex", "<--codex, or the first Codex model ready>"]]) {
    console.log(`a ${provider} thread, as yapd's launcher starts one: ${JSON.stringify({ project: project ?? "<the project>", prompt: opening, model, worktree: false })}`)
  }
  console.log("then sends them, in order, the Claude thread's first, then the Codex thread's:")
  for (const [name, payload] of Object.entries(planned)) console.log(`${name}: ${JSON.stringify(payload)}`)
  console.log(
    "(each answer only once its question shows, with its ids and labels as the card has them; D3 only if the question still waits after D2; C4 once more under its own commandId after C5; and a run.interrupt for a turn of its own still going two minutes after a step)",
  )
} else if (project !== undefined) {
  await Effect.runPromise(Effect.flatMap(provider, (configured) => probe(project).pipe(Effect.withConfigProvider(configured))))
} else {
  console.error(usage)
  process.exit(2)
}
