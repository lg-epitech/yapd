import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Option, Queue, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import { Condenser } from "./Condenser.ts"
import type * as Conversation from "./Conversation.ts"
import * as Drafts from "./Drafts.ts"
import * as Hands from "./Hands.ts"
import type { Notice } from "./Inbox.ts"
import * as Journal from "./Journal.ts"
import { type Catalog, type Started } from "./Launcher.ts"
import * as Ledger from "./Ledger.ts"
import * as Memory from "./Memory.ts"
import * as Notices from "./Notices.ts"
import * as Persona from "./Persona.ts"
import type * as Preferences from "./Preferences.ts"
import * as Show from "./Show.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3CodeServer from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
import type * as Tunnel from "./Tunnel.ts"
import { type Decision as Written, Writer } from "./Writer.ts"

/** 22:18 on the evening of the reverted attempt. */
const now = Date.parse("2026-10-01T02:18:00.000Z")

const thread = (id: string, title: string, projectId: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(T3Live.Thread)({
    id,
    projectId,
    title,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    createdAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-09-30T20:00:00.000Z",
    ...overrides,
  })

const mina = thread("2d5cee5c-6a1f-4b7e-9d3c-1f0e8a7b6c5d", "Open Mina SSV2 Bug Tickets", "connectors", {
  latestRunCompletedAt: "2026-09-30T23:05:00.000Z",
  updatedAt: "2026-09-30T23:05:00.000Z",
})
const tezos = thread("850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f", "Migrate Tezos Integration", "integration", {
  activeRunId: "run-3",
  activityRunStatus: "running",
  latestRunStartedAt: "2026-10-01T01:40:00.000Z",
  updatedAt: "2026-10-01T02:10:00.000Z",
})

const projects = ["yapd", "std", "cloudmate", "laurent", "integration", "custody", "right-price", "integration-connectors"]
const titles = [
  "Fix the audio level after speaking", "Benchmark GPT-6.1 Sol against Haiku", "Shortcut to Option Space", "Lower the quick turn threshold",
  "Cloud deployment discovery", "Report on std issues", "Explain how T3 Code works", "Review my last pull request",
  "Apple Watch glucose sensor API", "Integration architecture idea", "Remove Fable from my preferences", "Transcription upload retries",
  "Custody balances drift", "Right price scraper", "Npm distribution for yapd", "Revert the routing merge",
  "Speech cut off at the end", "Outstanding tasks report", "Explain the first step of the issue", "Mina fee rounding notes",
]
/** Twenty others, the last of which yapd started, its description mentioning Mina. */
const distractors = titles.map((title, index) =>
  thread(`d${index}-0000-4000-8000-${String(index).padStart(12, "0")}`, title, projects[index % projects.length]!, {
    updatedAt: new Date(now - (index + 2) * 60 * 60_000).toISOString(),
  }),
)

const view: T3Live.View = {
  projects: new Map(
    [
      ["connectors", "integration-connectors"],
      ["integration", "integration"],
      ...projects.map((name) => [name, name] as const),
    ].map(([id, title]) => [id, { id, title, workspaceRoot: `/code/${title}` }]),
  ),
  threads: new Map([mina, tezos, ...distractors].map((thread) => [thread.id, thread])),
  sequence: 1,
  synced: true,
}

const catalog: Catalog = {
  projects: ["yapd", "std", "integration", "integration-connectors"].map((name) => ({
    name,
    path: `/code/${name}`,
    repository: true,
    branch: "main",
    worktree: false,
    model: { name: "claude-opus-5-5", effort: "high" },
    recent: [],
  })),
  models: [{ name: "claude-opus-5-5", title: "Claude Opus 5.5", aliases: ["opus"], efforts: ["high"] }],
}

/** What the prompt writer decides, which no kept test gets as far as. */
const written: Written = {
  action: "start",
  about: "the loader fix",
  settled: "named",
  evidence: "yapd",
  project: "yapd",
  machine: "Rosie",
  model: "claude-opus-5-5",
  effort: "high",
  worktreeFrom: "last used",
  worktree: false,
  branch: "",
  why: "They named it.",
  prompt: "Fix the loader.",
  spoken: "",
}

const lines: Persona.Lines = {
  ...Persona.plain,
  onIt: "On it, sir.",
  leaving: "I'll leave that one, sir.",
  cantTell: "I couldn't tell which one you meant, sir.",
  stopped: "Stopped, sir.",
  carrying: "Carrying on, sir.",
  approved: "Approved, sir.",
  declined: "Declined, sir.",
  address: "sir",
}

/** An update from a session T3 Code doesn't run, read to him at `at`. */
const update = (project: string, spoken: string, at: number, more?: string): Conversation.Update => ({
  session: `claude:${project}`,
  project,
  turn: { prompt: Option.none(), message: spoken },
  needsYou: false,
  spoken,
  ...(more === undefined ? {} : { more }),
  audio: `/tmp/${project}.wav`,
  thread: { agent: "claude", session: project, cwd: `/code/${project}`, message: spoken, origin: {} },
  at,
})

/** What a thread's bounded read gives, which what it's sent adds to. */
interface Bounded {
  runs: Array<{ id: string; status: string; ordinal: number; userMessageId?: string }>
  messages: Array<{ id?: string; role: string; text: string; createdAt: string }>
  turnItems: Array<Record<string, unknown>>
}

/** How T3 Code answers a command, by default taking it in as it does. */
type Answer = (payload: Record<string, unknown>, bounded: Bounded) => Effect.Effect<unknown, T3CodeServer.Trouble | T3CodeServer.Refusal>

/** Takes a message in as T3 Code does: into the run under way. */
const takes: Answer = (payload, bounded) =>
  Effect.sync(() => {
    if (payload.type === "message.dispatch") {
      bounded.messages.push({ id: String(payload.messageId), role: "user", text: String(payload.text), createdAt: "x" })
      bounded.turnItems.push({ type: "user_message", messageId: payload.messageId, inputIntent: "steer" })
    }
    return { sequence: 1 }
  })

/**
 * A T3 Code that answers reads with what the threads wait on in `items`,
 * finds for each word what `search` says, in its order, and answers
 * commands as `answer` says, keeping them in `dispatched`.
 */
const transport = (
  search: (query: string) => ReadonlyArray<string>,
  dispatched: Array<Record<string, unknown>> = [],
  answer: () => Answer = () => takes,
  items: ReadonlyArray<Record<string, unknown>> = [],
): Effect.Effect<T3CodeServer.Transport, T3CodeServer.Trouble> => {
  const bounded: Bounded = {
    runs: [{ id: "run-3", status: "running", ordinal: 3 }],
    messages: [{ role: "assistant", text: "Comparing fee tables.", createdAt: "x" }],
    turnItems: [...items],
  }
  return Effect.succeed({
    api: (<A, I>(_: string, schema: Schema.Schema<A, I>) =>
      Effect.suspend(() => Schema.decodeUnknown(schema)({ projection: bounded })).pipe(Effect.orDie)) as T3CodeServer.Transport["api"],
    call: (<A, I>(method: string, params: Record<string, unknown> & { readonly query?: string }, schema: Schema.Schema<A, I>) =>
      method === "orchestration.dispatchCommand"
        ? Effect.suspend(() => {
            dispatched.push(params)
            return answer()(params, bounded)
          }).pipe(Effect.flatMap((value) => Schema.decodeUnknown(schema)(value).pipe(Effect.orDie)))
        : Schema.decodeUnknown(schema)(
            method === "server.getConfig"
              ? { providers: [] }
              : {
                  matches: search(params.query ?? "").map((threadId) => ({ threadId, projectId: "p", source: "message", snippet: params.query, messageCreatedAt: null })),
                },
          ).pipe(Effect.orDie)) as T3CodeServer.Transport["call"],
    asset: () => Effect.die("not expected"),
  })
}

/** The handle the model was shown a thread by. */
const handle = (situation: Brain.Situation, of: T3Live.Thread) => situation.desk.threads.find(({ ref }) => ref.id === of.id)?.handle ?? ""

/**
 * The assistant over that view, with a model that picks what the test says,
 * as the real one did in the log, or can't be asked when it says nothing,
 * and what it says kept in order rather than spoken, each heard at once
 * unless it waits for the test to `play` it.
 */
const assistant = (
  model: (situation: Brain.Situation) => Brain.Decision | undefined,
  given: {
    readonly waiting?: boolean
    /** Threads besides those in the view, or in place of them. */
    readonly others?: ReadonlyArray<T3Live.Thread>
    /** The ids of the threads T3 Code's search finds for a word, best first. */
    readonly search?: (query: string) => ReadonlyArray<string>
    /** What the threads T3 Code reads wait on, as their turn items. */
    readonly items?: ReadonlyArray<Record<string, unknown>>
    /** How T3 Code answers commands, when not as it usually does. */
    readonly answer?: () => Answer
    /** How long the model takes, in seconds. */
    readonly thinking?: number
    /**
     * Rig, followed too: how its tunnel stands, and its threads; with
     * `dispatched`, a T3 Code of its own that answers, keeping what it's sent
     * there, what its threads wait on as `items`, and what it tells of as
     * `changes`.
     */
    readonly rig?: {
      readonly status: Effect.Effect<Tunnel.Status>
      readonly threads?: ReadonlyArray<T3Live.Thread>
      readonly dispatched?: Array<Record<string, unknown>>
      readonly items?: ReadonlyArray<Record<string, unknown>>
      readonly changes?: Stream.Stream<T3Live.Change>
    }
    /** Whether yapd can keep things in mind for him, kept in the same database, and the routines his preferences have. */
    readonly memories?: boolean
    readonly routines?: ReadonlyArray<Preferences.Routine>
    /**
     * What the model briefs him with on what was held or what he missed, from what it's given, or none when it can't be asked: its
     * words, or what it writes, its words and the handles of rows to read word for word.
     */
    readonly briefs?: (held: ReadonlyArray<Journal.Kept>, brief: Brain.Brief) => string | ReadonlyArray<string> | undefined
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const store = yield* Store.make(":memory:")
    const journal = Journal.fromStore(store)
    const ledger = Ledger.fromStore(store)
    const dispatched: Array<Record<string, unknown>> = []
    // yapd started the last of them, and described it.
    yield* store.transaction((database) =>
      database.run("insert into threads (machine, id, prompt, dictated, description, started, at) values ('Rosie', ?, ?, ?, ?, 1, ?)", [
        distractors.at(-1)!.id,
        "Write up the Mina fee rounding notes.",
        "Write up what we found about Mina's fee rounding.",
        "the Mina fee rounding notes",
        new Date(now - 26 * 60 * 60_000).toISOString(),
      ]),
    )
    /** Threads as T3 Code has them since, like once what one waited on was answered. */
    const changed = new Map<string, T3Live.Thread>()
    /** Rig's threads as its T3 Code has them since, like once what one waited on was answered there. */
    const rigChanged = new Map<string, T3Live.Thread>()
    /** As a machine's T3 Code answers a request, which the thread there then no longer waits on, as `known` had it before. */
    const answeringOn =
      (since: Map<string, T3Live.Thread>, known: ReadonlyArray<T3Live.Thread>) =>
      (): Answer =>
      (payload, bounded) =>
        Effect.zipRight(
          Effect.sync(() => {
            if (payload.type !== "runtime-request.respond") return
            const before = since.get(String(payload.threadId)) ?? known.find(({ id }) => id === payload.threadId)
            if (before !== undefined && before.pendingRuntimeRequest?.id === payload.requestId) since.set(before.id, { ...before, pendingRuntimeRequest: null })
          }),
          (given.answer ?? (() => takes))()(payload, bounded),
        )
    /** As T3 Code here answers a request. */
    const answering = answeringOn(changed, [...(given.others ?? []), ...view.threads.values()])
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: {
        view: Effect.sync(() =>
          Option.some({
            ...view,
            threads: new Map([...view.threads, ...[...(given.others ?? []), ...changed.values()].map((other) => [other.id, other] as const)]),
          }),
        ),
        changes: Stream.never,
      },
      actions: Option.some(T3Actions.make(transport(given.search ?? (() => []), dispatched, answering, given.items))),
      // Rig, whose threads can be seen when the test gives them, and which answers then only when the test gives it a T3 Code of its own,
      // never otherwise.
      others: Option.match(Option.fromNullable(given.rig), {
        onNone: () => [],
        onSome: (rig) => [
          {
            machine: "rig",
            live: {
              view: Effect.sync(() =>
                Option.map(Option.fromNullable(rig.threads), (threads) => ({
                  ...view,
                  threads: new Map([...threads, ...rigChanged.values()].map((thread) => [thread.id, thread] as const)),
                })),
              ),
              changes: rig.changes ?? Stream.never,
            },
            actions: T3Actions.make(
              rig.threads === undefined
                ? Effect.fail(new T3CodeServer.Trouble({ reason: "I can't reach rig right now." }))
                : rig.dispatched === undefined
                  ? Effect.never
                  : transport(() => [], rig.dispatched, answeringOn(rigChanged, rig.threads), rig.items),
            ),
            status: rig.status,
          },
        ],
      }),
      journal,
      store,
    })
    const hands = Hands.make({ threads, ledger })
    const said: Array<Notice> = []
    const persona = Layer.succeed(Persona.Persona, { lines: Effect.succeed(lines), onIt: () => Effect.succeed(lines.onIt), said: () => Effect.void })
    const seen: Array<Brain.Situation> = []
    const drafts = yield* Drafts.make({
      machines: [
        {
          name: "Rosie",
          here: true,
          hosts: ["Rosie.local"],
          launcher: {
            catalog: Effect.succeed(catalog),
            start: (request) =>
              Effect.succeed({ thread: "new-thread", project: request.project.replace("/code/", ""), directory: request.project, branch: null, model: "claude-opus-5-5", worktree: false } satisfies Started),
          },
        },
      ],
      rules: Effect.succeed(Option.none()),
      expect: () => Effect.void,
      ledger,
      find: (machine, id) => threads.find({ machine, id }),
      recent: Effect.succeed([]),
    }).pipe(Effect.provideService(Writer, { decide: () => Effect.succeed(written), prepare: Effect.void }), Effect.provide(persona))
    let power = { on: true, turns: 1 }
    let listening = Option.none<{ readonly update: Conversation.Update; readonly said: string; readonly at: number; readonly playing: boolean; readonly turns: number }>()
    /** What threads wait on him for, worded as notices word them, by a model that says what the agent wrote it wants, and whether it's risky. */
    const compose = yield* Notices.composer(threads).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Condenser, {
            condense: () => Effect.die("not expected"),
            ask: (request) => Effect.succeed({ spoken: `wants to ${request.what.replace(/^[\w.-]+: /, "run ")}`, risk: "low" as const }),
            // Only for a part of a question whose words can't be said as they are.
            question: () => Effect.succeed({ spoken: "Which network should we start with?" }),
          }),
          persona,
        ),
      ),
    )
    /** Plays a notice: what it says in place of its own words, when it says to by then, is told it was used. */
    const voice = (notice: Notice | undefined) =>
      Effect.flatMap(notice?.instead?.when ?? Effect.succeed(false), (instead) => (instead && notice?.instead !== undefined ? (notice.instead.used ?? Effect.void) : Effect.void))
    const show = yield* Show.make(threads.detail, () => Effect.void)
    const routines = Effect.sync(() => given.routines ?? [])
    const memories = given.memories === true ? Memory.make(store, routines) : undefined
    const made = yield* Assistant.make({
      ...(memories === undefined ? {} : { memories, routines }),
      threads,
      journal,
      drafts,
      hands,
      ledger,
      show,
      // Said at once and to the end, as when nothing else is being said.
      tell: (notice) =>
        Effect.zipRight(
          Effect.sync(() => void said.push(notice)),
          given.waiting === true
            ? Effect.void
            : voice(notice).pipe(
                Effect.zipRight(notice.saying ?? Effect.void),
                Effect.zipRight(notice.confirmed ?? Effect.void),
                Effect.zipRight(notice.question?.through ?? Effect.void),
                Effect.zipRight(notice.heard ?? Effect.void),
              ),
        ),
      power: Effect.sync(() => power),
      lastHeard: Effect.sync(() => listening),
      coming: Effect.succeed(Effect.void),
      awaiting: Effect.succeed(Effect.void),
      queued: () => Effect.succeed(false),
      skip: () => Effect.void,
      upcoming: Effect.succeed([]),
      compose,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Brain.Brain, {
            decide: (situation) =>
              Effect.suspend(() => {
                seen.push(situation)
                const decided = model(situation)
                return decided === undefined ? Effect.fail(new Brain.BrainError({ cause: "The model is down." })) : Effect.succeed(decided)
              }).pipe(Effect.delay(`${given.thinking ?? 0} seconds`)),
            brief: (brief, desk) =>
              Effect.suspend(() => {
                // What it tells of, oldest first, as it was held.
                const held = brief.groups.flatMap(({ rows }) => rows).toSorted((one, other) => one.at - other.at || one.id - other.id)
                const spoken = given.briefs?.(held, brief)
                return spoken === undefined
                  ? Effect.fail(new Brain.BrainError({ cause: "The model is down." }))
                  : typeof spoken === "string"
                    ? Effect.succeed({ spoken, read: [] })
                    : Brain.briefed(spoken, brief, desk, Effect.succeed)
              }),
          }),
          persona,
        ),
      ),
    )
    // Lets the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    /** Lets the fibers catch up until `ready` says they have, like a command T3 Code was sent, however slowly they run. */
    const until = (ready: () => boolean): Effect.Effect<void> => Effect.suspend(() => (ready() ? flush : Effect.zipRight(flush, until(ready))))
    const questions = () => said.filter(({ kind }) => kind === "question")
    return {
      ...made,
      threads,
      dispatched,
      ledger,
      memories,
      seen,
      journal,
      spoken: () => said.map(({ spoken }) => spoken),
      questions,
      flush,
      until,
      /** An update starts being read to him. */
      reading: (project: string, spoken: string) =>
        Effect.flatMap(TestClock.currentTimeMillis, (at) =>
          Effect.sync(() => {
            listening = Option.some({ update: update(project, spoken, at), said: spoken, at, playing: true, turns: power.turns })
          }),
        ),
      /** Its turn came, after whatever was being said, and it was said to the end. */
      play: (notice = said.at(-1)) =>
        voice(notice).pipe(
          Effect.zipRight(notice?.saying ?? Effect.void),
          Effect.zipRight(notice?.confirmed ?? Effect.void),
          Effect.zipRight(notice?.question?.through ?? Effect.void),
          Effect.zipRight(notice?.heard ?? Effect.void),
          Effect.zipRight(flush),
        ),
      /** What a thread waits on him for, read and worded as notices word it, if it still waits on it, on this machine unless `machine` says. */
      compose: (of: T3Live.Thread, machine = "Rosie") => compose({ machine, id: of.id }, of.pendingRuntimeRequest?.id ?? ""),
      /** T3 Code has the thread as it is now, like once what it waited on was answered there. */
      becomes: (next: T3Live.Thread) =>
        Effect.sync(() => {
          changed.set(next.id, next)
        }).pipe(Effect.zipRight(flush)),
      /** Its turn came, and a dictation cut it off before the end. */
      cut: (notice = said.at(-1)) => voice(notice).pipe(Effect.zipRight(notice?.saying ?? Effect.void), Effect.zipRight(flush)),
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
      /** Turned on or off from the menu bar, which drops what's under way for what he asked before, as yapd serves it. */
      toggle: (on: boolean) =>
        made.drop.pipe(
          Effect.zipRight(
            Effect.sync(() => {
              power = { on, turns: power.turns + 1 }
            }),
          ),
          Effect.zipRight(flush),
        ),
      /** Dictated by the shortcut. */
      dictate: (heard: string) =>
        Effect.gen(function* () {
          yield* made.heard({ heard, via: "shortcut", at: yield* TestClock.currentTimeMillis, voiced: 3, turns: 1 })
          yield* flush
        }),
      /** Said over or right after the question, as the conversation takes it: worked out, then acted on. */
      answer: (heard: string, to = questions().at(-1)) =>
        Effect.gen(function* () {
          const taken = yield* to!.question!.answer(heard, 1)
          if (Option.isSome(taken)) yield* taken.value
          yield* flush
          return Option.isSome(taken)
        }),
      /**
       * Said over or right after the answer, with so many seconds of speech, as the conversation takes it: worked out, then acted on,
       * unless it isn't taken. Said over it, with what it hadn't said yet.
       */
      followUp: (heard: string, voiced = 2, to = said.findLast(({ kind }) => kind === "answer"), echo?: string, afterPause?: string) =>
        Effect.gen(function* () {
          const taken = yield* to!.followUp!(heard, voiced, echo, afterPause)
          if (Option.isSome(taken)) yield* taken.value
          yield* flush
          return Option.isSome(taken)
        }),
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** The cloud deployment discovery, at work and waiting on him for what `pending` says. */
const waitingOn = (pending: { readonly id: string; readonly kind: string }) =>
  thread(distractors[4]!.id, "Cloud deployment discovery", "cloudmate", {
    activeRunId: "run-3",
    activityRunStatus: "running",
    pendingRuntimeRequest: { ...pending, createdAt: "2026-10-01T02:17:00.000Z" },
    updatedAt: "2026-10-01T02:17:00.000Z",
  })

/** What T3 Code keeps of an approval it waits on, with the command it's for. */
const approval = (requestId: string, command: string) => [
  { type: "approval_request", status: "waiting", requestId, requestKind: "command", prompt: `Bash: ${command}`, nativeItemRef: { nativeId: `tool-${requestId}` } },
  { type: "command_execution", status: "running", input: command, nativeItemRef: { nativeId: `tool-${requestId}` } },
]

/** What a thread waits on him for, worded and asked as notices have it asked. */
const asked = (
  made: { readonly compose: (of: T3Live.Thread, machine?: string) => Effect.Effect<Option.Option<Assistant.Worded>>; readonly ask: (asking: Assistant.Asking) => Effect.Effect<void> },
  of: T3Live.Thread,
  machine?: string,
) =>
  Effect.gen(function* () {
    const worded = Option.getOrThrow(yield* made.compose(of, machine))
    if (worded._tag !== "Ask") return yield* Effect.die(`Only told: ${worded.spoken}`)
    yield* made.ask(worded.asking)
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    return worded.asking
  })

/** No model: what's said to what a thread waits on is settled without it, or not at all. */
const unasked = () => undefined

/** What T3 Code keeps of a question a thread waits on, in its parts. */
const card = (requestId: string, questions: ReadonlyArray<Record<string, unknown>>) => [{ type: "user_input_request", status: "waiting", requestId, questions }]

/** A part as Claude asks it, by its question, with what each option means and the one it recommends. */
const colour = {
  id: "Which colour should the test use?",
  header: "Colour",
  question: "Which colour should the test use?",
  options: [
    { label: "Red", description: "A red test." },
    { label: "Blue (Recommended)", description: "A blue test." },
  ],
}

/** A part he can pick several of. */
const extras = {
  id: "Which test extras should run?",
  header: "Extras",
  question: "Which test extras should run?",
  options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
  multiSelect: true,
}

/** What's sent in answer to the questions threads asked. */
const answered = (dispatched: ReadonlyArray<Record<string, unknown>>) => dispatched.filter(({ type }) => type === "runtime-request.respond").map(({ answers }) => answers)

/**
 * Notices over the assistant's threads, as `yapd serve` has them: what a
 * thread on any machine yapd follows waits on him for is asked through the
 * assistant, worded by a model that only words what can't be said as it is.
 */
const noticing = (made: {
  readonly threads: Threads.Threads["Type"]
  readonly journal: Journal.Journal["Type"]
  readonly mention: Assistant.Assistant["Type"]["mention"]
  readonly ask: Assistant.Assistant["Type"]["ask"]
  readonly settled: Assistant.Assistant["Type"]["settled"]
  readonly returned: Assistant.Assistant["Type"]["returned"]
}) =>
  Notices.make({
    threads: made.threads,
    journal: made.journal,
    tell: () => Effect.void,
    power: Effect.succeed({ on: true, turns: 1 }),
    stopped: () => Effect.succeed([]),
    finished: () => Effect.void,
    overtaken: () => Effect.void,
    mention: made.mention,
    ask: made.ask,
    settled: made.settled,
    returned: made.returned,
    shortest: 60_000,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Condenser, {
          condense: () => Effect.die("not expected"),
          ask: () => Effect.die("not expected"),
          question: () => Effect.die("not expected"),
        }),
        Layer.succeed(Persona.Persona, { lines: Effect.succeed(lines), onIt: () => Effect.succeed(lines.onIt), said: () => Effect.void }),
      ),
    ),
  )

/** A thread on rig asking him which colour the test should use. */
const onRig = thread("rig-fees", "Fee table checks", "connectors", {
  activeRunId: "run-9",
  activityRunStatus: "running",
  pendingRuntimeRequest: { id: "q9", kind: "user_input", createdAt: "2026-10-01T02:17:00.000Z" },
  updatedAt: "2026-10-01T02:17:00.000Z",
})

describe("Assistant", () => {
  /** What the model logged for a message to the Tezos thread by a misheard name: the right thread, as sure as the test says. */
  const tezosMessage = (sure: Brain.Sure) => (situation: Brain.Situation) =>
    Brain.decision({
      act: "send",
      target: handle(situation, tezos),
      sure,
      others: sure === "high" ? "" : handle(situation, mina),
      text: "Use the fee table from the Mina work.",
      how: "now",
      pending: Option.isNone(situation.open) ? "" : "replaces",
    })

  /** Where each command went, and what it said. */
  const sent = (dispatched: ReadonlyArray<Record<string, unknown>>) => dispatched.map(({ type, threadId, text, commandId }) => ({ type, threadId, text, commandId }))

  test("a plain yes to an approval, harmless-looking or not, only gets that it needs an 'approve', with nothing sent, and 'approve' then allows it once", async () => {
    const cloud = waitingOn({ id: "r1", kind: "command" })
    for (const command of ["git status", "git checkout -f main"]) {
      const result = await run(
        Effect.gen(function* () {
          // The model, for what's said with nothing open, takes "approve" to allow what the thread waits on.
          const made = yield* assistant((situation) => Brain.decision({ act: "decide", target: handle(situation, cloud), how: "accept" }), {
            others: [cloud],
            items: approval("r1", command),
          })
          yield* asked(made, cloud)
          yield* made.answer("Yes.")
          const yes = { dispatched: made.dispatched.length, open: Option.isSome(yield* made.open) }
          yield* made.dictate("Approve.")
          return { yes, dispatched: made.dispatched.map(({ requestId, decision }) => `${requestId} ${decision}`) }
        }),
      )
      expect([command, result]).toEqual([command, { yes: { dispatched: 0, open: false }, dispatched: ["r1 accept"] }])
    }
  })

  test("'approve' over an approval he hasn't heard to the end asks it again in full, and allows it only once he has", async () => {
    const cloud = waitingOn({ id: "r1", kind: "command" })
    const result = await run(
      Effect.gen(function* () {
        const items = ["r1", "r2"].flatMap((requestId) => approval(requestId, "npm install left-pad"))
        const made = yield* assistant(unasked, { others: [cloud], items, waiting: true })
        yield* asked(made, cloud)
        // Said over it, before the end.
        yield* made.cut()
        yield* made.answer("Approve.")
        const before = made.dispatched.length
        // Asked again, and heard to the end this time.
        yield* made.play()
        yield* made.answer("Approve.")
        // Another, cut off both times it's asked: it's left waiting, never allowed.
        const again = { ...cloud, pendingRuntimeRequest: { id: "r2", kind: "command", createdAt: "2026-10-01T02:18:00.000Z" } }
        yield* made.becomes(again)
        yield* asked(made, again)
        yield* made.cut()
        yield* made.answer("Approve it.")
        yield* made.cut()
        yield* made.answer("Approved.")
        return { before, dispatched: made.dispatched.map(({ requestId, decision }) => `${requestId} ${decision}`) }
      }),
    )
    expect(result.before).toBe(0)
    expect(result.dispatched).toEqual(["r1 accept"])
  })

  test("'approve' with anything more to it, like a condition the model left out, never allows it: it's left waiting, needing an 'approve'", async () => {
    const cloud = waitingOn({ id: "r1", kind: "command" })
    const allow = (heard: string) =>
      run(
        Effect.gen(function* () {
          // A model that takes it all for a yes, with nothing left over.
          const made = yield* assistant((situation) => Brain.decision({ act: "decide", target: handle(situation, cloud), how: "accept", pending: "answers" }), {
            others: [cloud],
            items: approval("r1", "npm install left-pad"),
          })
          yield* asked(made, cloud)
          yield* made.play()
          yield* made.answer(heard)
          return made.dispatched.map(({ requestId, decision }) => `${requestId} ${decision}`)
        }),
      )
    for (const heard of ["Approve it unless the tests fail.", "Approve it provided the tests pass.", "Approve nothing."]) {
      expect([heard, await allow(heard)]).toEqual([heard, []])
    }
    expect(await allow("Approve it.")).toEqual(["r1 accept"])
  })

  test("a question in two parts is asked a part at a time, each answer acknowledged, and both go in one reply", async () => {
    const cloud = waitingOn({ id: "q1", kind: "user_input" })
    const result = await run(
      Effect.gen(function* () {
        const made = yield* assistant(unasked, { others: [cloud], items: card("q1", [colour, extras]) })
        yield* asked(made, cloud)
        yield* made.answer("Red.")
        const between = made.dispatched.length
        yield* made.answer("Alpha and Gamma.")
        return { between, answers: answered(made.dispatched) }
      }),
    )
    expect(result.between).toBe(0)
    expect(result.answers).toEqual([{ [colour.id]: "Red", [extras.id]: ["Alpha", "Gamma"] }])
  })

  test("nothing dictated is sent to a thread waiting on a secret, even as a message", async () => {
    const secret = "turn-item:secret-request:cloud:stripe"
    const cloud = waitingOn({ id: secret, kind: "user_input" })
    const result = await run(
      Effect.gen(function* () {
        const made = yield* assistant((situation) => Brain.decision({ act: "send", target: handle(situation, cloud), text: "The Stripe key is sk test four two.", how: "now" }), {
          others: [cloud],
          items: [{ type: "secret_request", id: secret, status: "waiting", label: "Stripe API key" }],
        })
        yield* made.dictate("Tell the cloud one the Stripe key is sk test four two.")
        return made.dispatched.length
      }),
    )
    expect(result).toBe(0)
  })

  test("an answer in his own words that looks like a secret, like a code he reads out, is never sent, however the question was worded, nor kept in the journal", async () => {
    const cloud = waitingOn({ id: "q1", kind: "user_input" })
    // Nothing in how it's worded says it's for a secret.
    const items = [{ type: "user_input_request", status: "waiting", requestId: "q1", questions: [{ id: "shown", header: "Question", question: "What does the dialog show?" }] }]
    const result = await run(
      Effect.gen(function* () {
        let act: "reply" | "send" = "reply"
        const made = yield* assistant(
          (situation) =>
            act === "reply"
              ? Brain.decision({ act: "reply", target: handle(situation, cloud), text: "four two seven one nine three", pending: "answers" })
              : Brain.decision({ act: "send", target: handle(situation, cloud), text: "It shows 4 2 7 1 9 3.", how: "now" }),
          { others: [cloud], items },
        )
        yield* asked(made, cloud)
        yield* made.answer("Four two seven one nine three.")
        // Nor told to it as a message while it waits on that, which goes as its answer.
        act = "send"
        yield* made.dictate("Tell the cloud one it shows 4 2 7 1 9 3.")
        const kept = yield* made.journal.since(0)
        return {
          dispatched: made.dispatched.length,
          steps: (yield* made.ledger.steps(0)).length,
          kept: kept.filter((entry) => /4 2 7|four two seven/i.test(JSON.stringify(entry))).length,
        }
      }),
    )
    expect(result.dispatched).toBe(0)
    expect(result.steps).toBe(0)
    expect(result.kept).toBe(0)
  })

  test("\"it\" in each dictation is what was being read as its own shortcut was pressed, though the next was pressed before it was heard", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { prepare, heard, reading, seen } = yield* assistant(() => Brain.decision({ act: "answer", spoken: "It's comparing fee tables, sir." }))
        // He presses the shortcut over one update, then over the next, before the first dictation is transcribed.
        yield* reading("integration-connectors", "Integration-connectors. The Mina tickets are filed.")
        yield* prepare(1, 1)
        yield* reading("integration", "Integration. The Tezos migration is comparing request formats.")
        yield* prepare(2, 1)
        yield* heard({ heard: "What is it doing?", via: "shortcut", at: now, voiced: 3, turns: 1 }, 1)
        yield* heard({ heard: "Tell me more about it.", via: "shortcut", at: now, voiced: 3, turns: 1 }, 2)
        return seen.map(({ subject }) => (subject._tag === "Nothing" ? "nothing" : subject.said))
      }),
    )
    expect(result).toEqual(["Integration-connectors. The Mina tickets are filed.", "Integration. The Tezos migration is comparing request formats."])
  })

  test("what he missed counts as heard once he's heard the catch-up to the end, so one cut off leaves it for the next", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, play, cut, seen, journal } = yield* assistant(() => Brain.decision({ act: "catchup" }), {
          waiting: true,
          briefs: () => "The loader fix is ready, sir.",
        })
        const unheard = Effect.map(journal.unheard(0, 12), (missed) => missed.map(({ said }) => said))
        yield* journal.write({ at: now - 60_000, kind: "update", project: "yapd", said: "yapd. The loader fix is ready." })
        // Asked while something else is being said, so the answer waits its turn...
        yield* dictate("What did I miss?")
        const waiting = yield* unheard
        // ...and a dictation cuts it off as it starts.
        yield* cut()
        const cutOff = yield* unheard
        yield* dictate("What did I miss?")
        const told = seen[1]!.missed.groups.flatMap(({ rows }) => rows.map(({ said }) => said))
        yield* play()
        return { waiting, cutOff, told, after: yield* unheard }
      }),
    )
    expect(result.waiting).toEqual(["yapd. The loader fix is ready."])
    expect(result.cutOff).toEqual(["yapd. The loader fix is ready."])
    expect(result.told).toEqual(["yapd. The loader fix is ready."])
    expect(result.after).toEqual([])
  })

  describe("a catch-up told a thread at a time", () => {
    const hours = (n: number) => now - n * 60 * 60_000
    /** A question from the Tezos migration that its later update overtook, and one from the Mina tickets that still stands. */
    const missed = (journal: Journal.Journal["Type"]) =>
      Effect.gen(function* () {
        const off = { held: "off" }
        yield* journal.write({ at: hours(3), kind: "update", machine: "Rosie", thread: tezos.id, project: "integration", said: "Fee table or the old rates?", detail: { ...off, priority: "needs-you" } })
        yield* journal.write({ at: hours(2), kind: "update", machine: "Rosie", thread: mina.id, project: "connectors", said: "The build failed. Retry it?", detail: { ...off, priority: "needs-you" } })
        yield* journal.write({ at: hours(1), kind: "update", machine: "Rosie", thread: tezos.id, project: "integration", said: "Went with the fee table. The migration is done.", detail: off })
      })
    const unheard = (journal: Journal.Journal["Type"]) => Effect.map(journal.unheard(0, 12), (rows) => rows.map(({ said }) => said).toSorted())

    test("gives the model each thread's updates together, oldest first, and reads word for word only what it says still stands", async () => {
      const result = await run(
        Effect.gen(function* () {
          const given: Array<Brain.Brief> = []
          const { dictate, spoken, journal } = yield* assistant(() => Brain.decision({ act: "catchup" }), {
            briefs: (_, brief) => {
              given.push(brief)
              // The Mina question is the second row that needs him, as the threads go, oldest first.
              return ["The Tezos migration went with the fee table and is done.", "The Mina tickets hit a failing build: r2"]
            },
          })
          yield* missed(journal)
          yield* dictate("What did I miss?")
          return { threads: given[0]?.groups.map(({ rows }) => rows.map(({ said }) => said)), said: spoken().at(-1) }
        }),
      )
      expect(result.threads).toEqual([["Fee table or the old rates?", "Went with the fee table. The migration is done."], ["The build failed. Retry it?"]])
      expect(result.said).toBe("The Tezos migration went with the fee table and is done. The Mina tickets hit a failing build: The build failed. Retry it?")
    })

    test("with the model down, reads only what needs him that nothing newer of its thread came after, and leaves the rest unheard", async () => {
      const result = await run(
        Effect.gen(function* () {
          const { dictate, play, spoken, journal } = yield* assistant(() => Brain.decision({ act: "catchup" }), { briefs: () => undefined })
          yield* missed(journal)
          yield* dictate("What did I miss?")
          const said = spoken().at(-1)
          yield* play()
          return { said, after: yield* unheard(journal) }
        }),
      )
      expect(result.said?.startsWith("The build failed. Retry it? I couldn't sum up the rest just now")).toBe(true)
      expect(result.after).toEqual(["Fee table or the old rates?", "Went with the fee table. The migration is done."])
    })
  })

  test("a write at medium confidence about a thread that isn't the focus asks once, naming both", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, questions, dispatched } = yield* assistant(tezosMessage("medium"))
        yield* dictate("Tell the migration one to use the fee table from the Mina work.")
        const before = dispatched.length
        yield* answer("The first.")
        return { before, questions: questions().length, sent: sent(dispatched) }
      }),
    )
    expect(result.before).toBe(0)
    expect(result.questions).toBe(1)
    expect(result.sent.map(({ threadId }) => threadId)).toEqual([tezos.id])
  })

  test("a message whose words the model left out goes in the words of his request, never those of his answer to a question about it", async () => {
    const request = "Tell the migration one to rebase on master."
    const unworded = (answered: (situation: Brain.Situation) => Brain.Decision | undefined, reply: string) =>
      run(
        Effect.gen(function* () {
          const { dictate, answer, dispatched } = yield* assistant((situation) =>
            situation.utterance.via === "reply"
              ? answered(situation)
              : Brain.decision({ act: "send", target: handle(situation, tezos), sure: "medium", others: handle(situation, mina), how: "now" }),
          )
          yield* dictate(request)
          yield* answer(reply)
          return dispatched.map(({ threadId, text }) => [threadId, text])
        }),
      )
    // By position, which needs no model, and by name, as the model takes it, leaving the words out again.
    expect(await unworded(() => undefined, "The first.")).toEqual([[tezos.id, request]])
    expect(await unworded((situation) => Brain.decision({ act: "send", target: handle(situation, tezos), pending: "answers" }), "The Tezos migration, I mean.")).toEqual([
      [tezos.id, request],
    ])
  })

  test("a message whose words the model left out, begun over yapd's own voice, sends none of what he said, at once or once he says which, and he's asked to say it again", async () => {
    const line = "Use staging, the Tezos thread says, sir."
    const heard = "Use staging. Tell the migration one to add tests."
    const unworded = (sure: Brain.Sure, echo?: string) =>
      run(
        Effect.gen(function* () {
          const { dictate, followUp, answer, dispatched } = yield* assistant((situation) =>
            situation.utterance.heard.startsWith("What")
              ? Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: line })
              : situation.utterance.heard === heard
                ? Brain.decision({ act: "send", target: handle(situation, tezos), sure, others: sure === "high" ? "" : handle(situation, mina), how: "now" })
                : undefined,
          )
          yield* dictate("What does the Tezos one say?")
          // He speaks over it, its own words heard first.
          yield* followUp(heard, 3, undefined, echo, echo === undefined ? undefined : "Tell the migration one to add tests.")
          // By position, which needs no model.
          if (sure !== "high") yield* answer("The first one.")
          return dispatched.map(({ threadId, text }) => [threadId, text])
        }),
      )
    expect(await unworded("high", line)).toEqual([])
    expect(await unworded("low", line)).toEqual([])
    // Begun once its own voice could no longer get in, his words go as he said them, as ever.
    expect(await unworded("high")).toEqual([[tezos.id, heard]])
    expect(await unworded("low")).toEqual([[tezos.id, heard]])
  })

  test("nothing is dispatched for a dictation heard before yapd was turned off and on", async () => {
    const sending = (toggled: boolean) =>
      run(
        Effect.gen(function* () {
          const { heard, toggle, wait, flush, dispatched, spoken } = yield* assistant(tezosMessage("high"), { thinking: 3 })
          const dictated = yield* Effect.fork(heard({ heard: "Tell the Tesla's migration to use the fee table.", via: "shortcut", at: now, voiced: 3, turns: 1 }))
          yield* flush
          // Off and on again while the model works it out.
          if (toggled) yield* Effect.zipRight(toggle(false), toggle(true))
          yield* wait(3)
          yield* Fiber.join(dictated)
          return { dispatched: dispatched.length, spoken: spoken().length }
        }),
      )
    // Left alone, it goes, so it's the off and on that stops it.
    expect(await sending(false)).toEqual({ dispatched: 1, spoken: 1 })
    expect(await sending(true)).toEqual({ dispatched: 0, spoken: 0 })
  })

  test("a message that may not have got there is offered again, and yes sends it once more under the same ids", async () => {
    let lost = true
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, dispatched } = yield* assistant(tezosMessage("high"), {
          answer: () => (payload, bounded) =>
            lost ? Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })) : takes(payload, bounded),
        })
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        lost = false
        yield* answer("Yes.")
        // A second yes, to nothing asked, sends nothing more.
        yield* dictate("Yes.")
        return { ids: dispatched.map(({ commandId, messageId }) => [commandId, messageId]) }
      }),
    )
    expect(result.ids).toHaveLength(2)
    expect(result.ids[1]).toEqual(result.ids[0])
  })

  test("scratch that once a message was read offers to have it ignored: yes tells the thread to, once, and no sends nothing", async () => {
    const original = "Use the fee table from the Mina work."
    const scratched = (reply: string) =>
      run(
        Effect.gen(function* () {
          const { dictate, answer, dispatched } = yield* assistant(tezosMessage("high"))
          yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
          yield* dictate("Scratch that.")
          yield* answer(reply)
          return dispatched.map(({ threadId, text }) => [threadId, text])
        }),
      )
    expect(await scratched("Yes.")).toEqual([
      [tezos.id, original],
      [tezos.id, Hands.ignore(original)],
    ])
    expect(await scratched("No.")).toEqual([[tezos.id, original]])
  })

  test("a request that never runs out of rest stops after four steps", async () => {
    let told = 0
    const endless = await run(
      Effect.gen(function* () {
        const { dictate, dispatched } = yield* assistant((situation) =>
          Brain.decision({ act: "send", target: handle(situation, tezos), text: `Step ${++told}.`, how: "now", rest: "and tell it once more" }),
        )
        yield* dictate("Tell the Tesla's migration to keep going, and tell it once more.")
        return dispatched.length
      }),
    )
    expect(endless).toBe(4)
  })

  test("rig being slow to search never keeps what this machine's search found from the model", async () => {
    // Settled three days ago, behind thirty newer threads, so only the search for "tezos" puts it in front of the model.
    const settled = thread(tezos.id, tezos.title, "integration", { updatedAt: new Date(now - 3 * 24 * 60 * 60_000).toISOString() })
    const newer = Array.from({ length: 30 }, (_, index) =>
      thread(`e${index}-0000-4000-8000-${String(index).padStart(12, "0")}`, `Grades export part ${index + 1}`, "std", {
        updatedAt: new Date(now - (index + 1) * 60_000).toISOString(),
      }),
    )
    const result = await run(
      Effect.gen(function* () {
        const { dictate, seen } = yield* assistant(
          (situation) => Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration finished three days ago, sir." }),
          {
            others: [settled, ...newer],
            search: (query) => (query === "tezos" ? [tezos.id] : []),
            rig: { status: Effect.succeed({ _tag: "Up" }), threads: [thread("std", "Add the std fee test", "std")] },
          },
        )
        const asked = yield* Effect.fork(dictate("My grades tezos."))
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(asked)
        return { shown: seen[0]?.desk.threads.some(({ ref, brief }) => ref.machine === "Rosie" && ref.id === tezos.id && !brief) }
      }),
    )
    expect(result.shown).toBe(true)
  })

  test("a question on a rig thread, heard from rig's T3 Code, is asked aloud, and his answer goes once to rig's T3 Code for that thread, never this Mac's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rig: Array<Record<string, unknown>> = []
        const changes = yield* Queue.unbounded<T3Live.Change>()
        /** What the ledger held as each command went out: written first, under the one command id it went with. */
        const written: Array<{ readonly sent: unknown; readonly rows: ReadonlyArray<string> }> = []
        let ledger: Ledger.Ledger["Type"] | undefined
        const made = yield* assistant(unasked, {
          rig: { status: Effect.succeed({ _tag: "Up" }), threads: [onRig], dispatched: rig, items: card("q9", [colour]), changes: Stream.fromQueue(changes) },
          answer: () => (payload, bounded) =>
            Effect.flatMap(ledger === undefined ? Effect.succeed([]) : ledger.steps(0), (rows) =>
              Effect.zipRight(
                Effect.sync(() => void written.push({ sent: payload.commandId, rows: rows.map(({ commandId, machine, thread, state }) => `${commandId} ${machine} ${thread} ${state}`) })),
                takes(payload, bounded),
              ),
            ),
        })
        ledger = made.ledger
        const notices = yield* noticing(made)
        yield* Effect.forkScoped(notices.follow)
        yield* made.flush
        // Rig's T3 Code tells of it, as this Mac's would.
        yield* Queue.offer(changes, { _tag: "Asked", thread: onRig, request: onRig.pendingRuntimeRequest! })
        yield* made.until(() => made.questions().length > 0)
        yield* made.answer("Red.")
        const steps = yield* made.ledger.steps(0)
        return {
          rig: rig.map(({ type, threadId, requestId, answers, commandId }) => ({ type, threadId, requestId, answers, commandId })),
          here: made.dispatched,
          written,
          steps: steps.map(({ commandId, machine, thread, state }) => ({ commandId, machine, thread, state })),
        }
      }),
    )
    const [step] = result.steps
    expect(result.steps).toEqual([{ commandId: step!.commandId, machine: "rig", thread: onRig.id, state: "sent" }])
    expect(result.rig).toEqual([{ type: "runtime-request.respond", threadId: onRig.id, requestId: "q9", answers: { [colour.id]: "Red" }, commandId: step!.commandId }])
    // Written down before it went, as the only step, under the id it went with.
    expect(result.written).toEqual([{ sent: step!.commandId, rows: [`${step!.commandId} rig ${onRig.id} prepared`] }])
    expect(result.here).toEqual([])
  })
})

describe("Assistant memories", () => {
  test("a routine's name sends its steps to the focus thread once, as they're written", async () => {
    const steps = "Merge the PR once checks pass, then update the dev worktree and reinstall yapd."
    const result = await run(
      Effect.gen(function* () {
        const made = yield* assistant(
          (situation) => {
            const { heard } = situation.utterance
            if (heard === "How's the Tezos one doing?") return Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "It's migrating the fee tables, sir." })
            // The routine by its handle, never its steps, to the thread "it" is.
            if (heard === "Land it.") {
              const routine = Brain.remembered(situation).find(({ name }) => name === "land it")
              const on = Brain.focused(situation)
              return Brain.decision({ act: "send", text: routine?.handle ?? "", target: Option.match(on, { onNone: () => "", onSome: ({ handle }) => handle }), how: "now" })
            }
            return undefined
          },
          { memories: true, routines: [{ name: "land it", steps }] },
        )
        const messages = () => made.dispatched.filter(({ type }) => type === "message.dispatch").map(({ threadId, text }) => ({ threadId, text }))
        yield* made.dictate("How's the Tezos one doing?")
        const shown = Brain.prompt(made.seen.at(-1)!, Option.none())
        yield* made.dictate("Land it.")
        const sent = messages()
        // Said again, it isn't sent again behind his back.
        yield* made.dictate("Land it.")
        return { shown, sent, again: messages() }
      }),
    )
    // The model knows it by its name alone: only code puts its steps in.
    expect(result.shown).not.toContain(steps)
    expect(result.sent).toEqual([{ threadId: tezos.id, text: steps }])
    expect(result.again).toEqual([{ threadId: tezos.id, text: steps }])
  })

  test("a routine whose steps aren't his words as heard isn't saved, nor one that may be yapd's own voice", async () => {
    const asked = "When I say review it, have Sol review it until it's clean."
    const result = await run(
      Effect.gen(function* () {
        let reworded = true
        const made = yield* assistant(
          (situation) => {
            const { heard } = situation.utterance
            if (heard === asked) return Brain.decision({ act: "remember", how: "routine", text: reworded ? "review it: have Sol review the work until it's clean" : "review it: have Sol review it until it's clean" })
            // A name put right, as speech recognition got it wrong, isn't his either, and would go to the agent as he never said it.
            if (heard === "When I say review it, have Saul review it until it's clean.") return Brain.decision({ act: "remember", how: "routine", text: "review it: have Sol review it until it's clean" })
            return undefined
          },
          { memories: true },
        )
        const kept = () => Effect.map(made.memories!.list, (all) => all.map(({ name, text }) => `${name}: ${text}`))
        yield* made.dictate(asked)
        const unsaved = yield* kept()
        yield* made.dictate("When I say review it, have Saul review it until it's clean.")
        const corrected = yield* kept()
        reworded = false
        // Over yapd's own voice, what was heard may be its words.
        yield* made.heard({ heard: asked, via: "shortcut", at: yield* TestClock.currentTimeMillis, voiced: 3, turns: 1, echo: "I'll tell you when it finishes, sir." })
        yield* made.flush
        const echoed = yield* kept()
        yield* made.dictate(asked)
        return { unsaved, corrected, echoed, saved: yield* kept() }
      }),
    )
    expect(result).toEqual({ unsaved: [], corrected: [], echoed: [], saved: ["review it: have Sol review it until it's clean"] })
  })
})
