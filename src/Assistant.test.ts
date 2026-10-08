import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Logger, Option, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import * as Drafts from "./Drafts.ts"
import * as Hands from "./Hands.ts"
import type { Notice } from "./Inbox.ts"
import * as Journal from "./Journal.ts"
import { type Catalog, LaunchError, type Request, type Started } from "./Launcher.ts"
import * as Ledger from "./Ledger.ts"
import * as Persona from "./Persona.ts"
import * as Research from "./Research.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import * as T3CodeServer from "./T3CodeServer.ts"
import * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
import { type Decision as Written, type Material, Writer } from "./Writer.ts"

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

const written = (overrides: Partial<Written>): Written => ({
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
  ...overrides,
})

const lines: Persona.Lines = {
  ...Persona.plain,
  onIt: "On it, sir.",
  leaving: "I'll leave that one, sir.",
  cantTell: "I couldn't tell which one you meant, sir.",
  stopped: "Stopped, sir.",
  carrying: "Carrying on, sir.",
  address: "sir",
}

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
 * A T3 Code that answers reads, has nothing pending, finds for each word what
 * `search` says, in its order, and answers commands as `answer` says, keeping
 * them in `dispatched`.
 */
const transport = (
  search: (query: string) => ReadonlyArray<string>,
  dispatched: Array<Record<string, unknown>> = [],
  answer: () => Answer = () => takes,
): Effect.Effect<T3CodeServer.Transport, T3CodeServer.Trouble> => {
  const bounded: Bounded = {
    runs: [{ id: "run-3", status: "running", ordinal: 3 }],
    messages: [{ role: "assistant", text: "Comparing fee tables.", createdAt: "x" }],
    turnItems: [],
  }
  return Effect.succeed({
    api: (<A, I>(_: string, schema: Schema.Schema<A, I>) => Schema.decodeUnknown(schema)({ projection: bounded }).pipe(Effect.orDie)) as T3CodeServer.Transport["api"],
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
  })
}

/** The handle the model was shown a thread by. */
const handle = (situation: Brain.Situation, of: T3Live.Thread) => situation.desk.threads.find(({ ref }) => ref.id === of.id)?.handle ?? ""

/**
 * The assistant over that view, with a model that picks what the test says,
 * as the real one did in the log, or can't be asked when it says nothing, a
 * writer and a launcher for new work, which take as long as the test says or
 * never answer, and what it says kept in order rather than spoken, each heard
 * at once unless it waits for the test to `play` it.
 */
const assistant = (
  model: (situation: Brain.Situation) => Brain.Decision | undefined,
  write: (material: Material) => Written = () => written({}),
  given: {
    readonly writing?: number
    readonly launching?: number
    readonly hanging?: boolean
    readonly waiting?: boolean
    /** Threads besides those in the view, or in place of them. */
    readonly others?: ReadonlyArray<T3Live.Thread>
    /** The ids of the threads T3 Code's search finds for a word, best first. */
    readonly search?: (query: string) => ReadonlyArray<string>
    /** What's waiting to be said already, like an update a dictation cut off. */
    readonly queued?: ReadonlySet<string>
    /** How T3 Code answers commands, when not as it usually does. */
    readonly answer?: () => Answer
    /** How long the model takes, in seconds. */
    readonly thinking?: number
    /** T3 Code never answers a launch it was sent, having started it or not. */
    readonly unanswered?: "started" | "not started"
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
    /** Threads T3 Code made since, without saying so. */
    const appeared: Array<T3Live.Thread> = []
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: {
        view: Effect.sync(() =>
          Option.some({ ...view, threads: new Map([...view.threads, ...[...(given.others ?? []), ...appeared].map((other) => [other.id, other] as const)]) }),
        ),
        changes: Stream.never,
      },
      actions: Option.some(T3Actions.make(transport(given.search ?? (() => []), dispatched, given.answer))),
      others: [],
      journal,
      store,
    })
    const hands = Hands.make({ threads, ledger })
    const started: Array<Request> = []
    const said: Array<Notice> = []
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
              given.unanswered !== undefined
                ? Effect.suspend(() => {
                    if (given.unanswered === "started" && request.ids !== undefined) appeared.push(thread(request.ids.thread, "Fix the loader", "yapd"))
                    return Effect.fail(new LaunchError({ reason: "T3 Code is taking too long, so I don't know if it started.", sent: true }))
                  })
                : // Like T3 Code preparing a worktree that never gets ready, which its launcher gives up on after six minutes.
                  (given.hanging === true ? Effect.never : Effect.sleep(`${given.launching ?? 0} seconds`)).pipe(
                    Effect.timeoutFail({ duration: "6 minutes", onTimeout: () => new LaunchError({ reason: "T3 Code is taking too long, so I don't know if it started." }) }),
                    Effect.zipRight(
                      Effect.sync(() => {
                        started.push(request)
                        return { thread: "new-thread", project: request.project.replace("/code/", ""), directory: request.project, branch: null, model: "claude-opus-5-5", worktree: false } satisfies Started
                      }),
                    ),
                  ),
          },
          researcher: Research.unavailable("Not here."),
        },
      ],
      rules: Effect.succeed(Option.none()),
      ledger,
      find: (machine, id) => threads.find({ machine, id }),
      recent: Effect.succeed([]),
    }).pipe(
      Effect.provideService(Writer, {
        decide: (material) => Effect.sleep(`${given.writing ?? 0} seconds`).pipe(Effect.zipRight(Effect.sync(() => write(material)))),
        research: () => Effect.die("no research"),
        prepare: Effect.void,
      }),
    )
    let power = { on: true, turns: 1 }
    const made = yield* Assistant.make({
      threads,
      journal,
      drafts,
      hands,
      ledger,
      // Said at once, as when nothing else is being said.
      tell: (notice) => Effect.zipRight(Effect.sync(() => void said.push(notice)), given.waiting === true ? Effect.void : (notice.saying ?? Effect.void)),
      power: Effect.sync(() => power),
      lastHeard: Effect.succeed(Option.none()),
      coming: Effect.void,
      awaiting: Effect.succeed(Effect.void),
      queued: (spoken) => Effect.succeed(given.queued?.has(spoken) === true),
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
          }),
          Layer.succeed(Persona.Persona, { lines: Effect.succeed(lines) }),
        ),
      ),
    )
    // Lets the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    const questions = () => said.filter(({ kind }) => kind === "question")
    return {
      ...made,
      dispatched,
      ledger,
      started,
      seen,
      journal,
      spoken: () => said.map(({ spoken }) => spoken),
      questions,
      flush,
      /** Its turn came, after whatever was being said. */
      play: (notice = said.at(-1)) => (notice?.saying ?? Effect.void).pipe(Effect.zipRight(flush)),
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
      /** Turned on or off from the menu bar, which drops what's under way when it's off. */
      toggle: (on: boolean) =>
        Effect.suspend(() => {
          power = { on, turns: power.turns + 1 }
          return on ? Effect.void : made.drop
        }).pipe(Effect.zipRight(flush)),
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
      /** Nothing was said in the time the question leaves for an answer. */
      unanswered: (to = questions().at(-1)) => to!.question!.unanswered.pipe(Effect.zipRight(flush)),
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** What the model logged for the Mina status: the right thread, sure of it. */
const minaStatus = (situation: Brain.Situation) =>
  Brain.decision({ act: "answer", target: handle(situation, mina), spoken: "The Mina SSV2 tickets are filed, sir: four bugs, and fee rounding is the worst." })

describe("Assistant", () => {
  test("status on MiNAS SV2 is answered about the Mina tickets first time, with no question", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, open, journal, seen } = yield* assistant(minaStatus)
        yield* dictate("Can you please tell me what's the status on MiNAS SV2?")
        const answers = yield* journal.since(0, { kinds: ["answer"] })
        return { spoken: spoken(), questions: questions().length, open: yield* open, about: answers.map(({ thread }) => thread), shown: seen[0]!.desk.threads.length }
      }),
    )
    expect(result.spoken).toEqual(["The Mina SSV2 tickets are filed, sir: four bugs, and fee rounding is the worst."])
    expect(result.questions).toBe(0)
    expect(result.open).toEqual(Option.none())
    expect(result.about).toEqual([mina.id])
    expect(result.shown).toBe(22)
  })

  test("each misheard Tezos name is answered about the Tezos migration first time", async () => {
    const heard = ["What's the status on my Tesla's migration request comparison?", "Tesla celebration comparison", "Dazzles migration", "migrate stasos", "My grades tezos."]
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, journal } = yield* assistant((situation) =>
          Brain.decision({
            act: "answer",
            target: handle(situation, tezos),
            // The most mangled ones it's only fairly sure of, which is still enough to answer.
            ...(["Dazzles", "stasos", "grades"].some((word) => situation.utterance.heard.includes(word)) ? { sure: "medium" as const, others: handle(situation, mina) } : {}),
            spoken: "The Tezos migration is comparing both request formats, sir.",
          }),
        )
        for (const words of heard) yield* dictate(words)
        const answers = yield* journal.since(0, { kinds: ["answer"] })
        return { spoken: spoken(), questions: questions().length, about: answers.map(({ thread }) => thread) }
      }),
    )
    expect(result.questions).toBe(0)
    expect(result.spoken).toEqual(heard.map(() => "The Tezos migration is comparing both request formats, sir."))
    expect(result.about).toEqual(heard.map(() => tezos.id))
  })

  test("a thread named by one word reaches the model when thirty newer ones are about another word he said", async () => {
    // Settled three days ago, behind thirty newer threads, seven of which mention grades, as on his machine.
    const settled = thread(tezos.id, tezos.title, "integration", { updatedAt: new Date(now - 3 * 24 * 60 * 60_000).toISOString() })
    const newer = Array.from({ length: 30 }, (_, index) =>
      thread(`e${index}-0000-4000-8000-${String(index).padStart(12, "0")}`, `Grades export part ${index + 1}`, "std", {
        updatedAt: new Date(now - (index + 1) * 60_000).toISOString(),
      }),
    )
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, seen } = yield* assistant(
          (situation) => Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration finished three days ago, sir." }),
          undefined,
          {
            others: [settled, ...newer],
            search: (query) => (query === "grades" ? newer.slice(0, 7).map(({ id }) => id) : query === "tezos" ? [distractors[9]!.id, tezos.id] : []),
          },
        )
        yield* dictate("My grades tezos.")
        return { shown: seen[0]!.desk.threads.some(({ ref }) => ref.id === tezos.id), spoken: spoken() }
      }),
    )
    expect(result.shown).toBe(true)
    expect(result.spoken).toEqual(["The Tezos migration finished three days ago, sir."])
  })

  test("a dictation while a question is open answers it, one answer is spoken, and the question is never said again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, unanswered, wait, spoken, questions, open } = yield* assistant((situation) =>
          Option.isNone(situation.open)
            ? Brain.decision({ act: "answer", target: handle(situation, tezos), sure: "low", others: handle(situation, mina), spoken: "It's comparing formats." })
            : Brain.decision({ act: "answer", target: handle(situation, tezos), pending: "answers", spoken: "The Tezos migration is comparing request formats, sir." }),
        )
        yield* dictate("What's the status on my Tesla's migration request comparison?")
        const question = questions()[0]!
        // Its time for an answer went by, then he pressed the shortcut and answered by dictating.
        yield* unanswered()
        yield* wait(20)
        yield* dictate("Migrate Tezos.")
        yield* wait(120)
        return { spoken: spoken(), questions: questions().length, open: yield* open, stale: yield* question.stale }
      }),
    )
    expect(result.spoken).toEqual([
      "Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?",
      "The Tezos migration is comparing request formats, sir.",
    ])
    expect(result.questions).toBe(1)
    expect(result.open).toEqual(Option.none())
    expect(result.stale).toBe(true)
  })

  test("starting new work that mentions an existing thread starts new work", async () => {
    const dictated =
      "Can you please go and look at what I did for the migration process for Mina and start another thread in integration on the main worktree to start working on the migration for Tezos, so I have a ticket open for that as well in my linear."
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, started, journal, ledger } = yield* assistant(
          () => Brain.decision({ act: "start", text: dictated }),
          ({ lines }) =>
            written({
              about: "the Tezos migration",
              project: "integration",
              evidence: "integration",
              prompt: "Look at what I did for the Mina migration and start on the migration for Tezos.",
              spoken: "Started in integration, on Opus, without a worktree.",
              ...(lines[0]?.text === dictated ? {} : { action: "none" }),
            }),
        )
        yield* dictate(dictated)
        const kept = yield* journal.since(0, { kinds: ["started"] })
        const row = yield* ledger.latest("1 hour", { kinds: ["start"] })
        return { spoken: spoken(), questions: questions().length, started, kept: kept.map(({ thread, utterance }) => [thread, utterance !== undefined]), row }
      }),
    )
    expect(result.questions).toBe(0)
    expect(result.started.map(({ project }) => project)).toEqual(["/code/integration"])
    expect(result.spoken).toEqual(["Started in integration, on Opus, without a worktree."])
    expect(result.kept).toEqual([["new-thread", true]])
    // Written down first, and asked for under the ids it was written down with.
    expect(Option.map(result.row, ({ state, commandId }) => ({ state, commandId }))).toEqual(Option.some({ state: "sent", commandId: result.started[0]!.ids!.command }))
  })

  test("\"say that again\" says the last answer once more, and nothing when it's about to be said again anyway", async () => {
    const answer = "The Mina SSV2 tickets are filed, sir: four bugs, and fee rounding is the worst."
    const queued = new Set<string>()
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken } = yield* assistant(minaStatus, undefined, { queued })
        yield* dictate("Can you please tell me what's the status on MiNAS SV2?")
        yield* dictate("Say that again.")
        // Already waiting to be said, it isn't said twice.
        queued.add(answer)
        yield* dictate("Say that again.")
        return spoken()
      }),
    )
    expect(result).toEqual([answer, answer])
  })

  test("a garbled answer to an open question closes it without asking again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, unanswered, wait, spoken, questions, open, journal } = yield* assistant((situation) =>
          Option.isNone(situation.open)
            ? Brain.decision({ act: "answer", target: handle(situation, mina), sure: "low", others: handle(situation, tezos), spoken: "Filed." })
            : Brain.decision({ act: "resume", pending: "answers" }),
        )
        yield* dictate("Can you please tell me what's the status on MiNAS SV2?")
        yield* dictate("We will reach one d have.")
        // The same, said over the question rather than dictated.
        yield* dictate("Can you please tell me what's the status on MiNAS SV2?")
        const taken = yield* answer("We will reach one d have.")
        if (!taken) yield* unanswered()
        yield* wait(180)
        const closed = yield* journal.since(0, { kinds: ["action"] })
        return { taken, spoken: spoken(), questions: questions().length, open: yield* open, closed: closed.map(({ detail }) => (detail as { open: string }).open) }
      }),
    )
    expect(result.taken).toBe(true)
    expect(result.spoken).toEqual([
      "Open Mina SSV2 Bug Tickets or Migrate Tezos Integration, sir?",
      "Which one, sir: Open Mina SSV2 Bug Tickets or Migrate Tezos Integration?",
    ])
    expect(result.questions).toBe(2)
    expect(result.open).toEqual(Option.none())
    expect(result.closed).toEqual(["dropped: unclear", "dropped: unclear"])
  })

  test("a second clarification closes the request instead of asking again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, wait, spoken, questions, open } = yield* assistant((situation) =>
          Brain.decision({
            act: "clarify",
            target: handle(situation, tezos),
            others: handle(situation, mina),
            sure: "low",
            pending: Option.isNone(situation.open) ? "" : "answers",
          }),
        )
        yield* dictate("What's the status on the migration one?")
        const taken = yield* answer("The recent one with mean migrations.")
        yield* wait(180)
        return { taken, spoken: spoken(), questions: questions().length, open: yield* open }
      }),
    )
    expect(result.taken).toBe(true)
    expect(result.spoken).toEqual(["Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?", "I'll leave that one, sir."])
    expect(result.questions).toBe(1)
    expect(result.open).toEqual(Option.none())
  })

  test("a question is never asked in the same words twice within ten minutes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, unanswered, wait, spoken, questions } = yield* assistant(
          (situation) =>
            situation.utterance.heard.includes("loader")
              ? Brain.decision({ act: "start", text: situation.utterance.heard, pending: Option.isNone(situation.open) ? "" : "replaces" })
              : Brain.decision({
                  act: "clarify",
                  target: handle(situation, tezos),
                  others: handle(situation, mina),
                  sure: "low",
                  pending: Option.isNone(situation.open) ? "" : "replaces",
                }),
          () => written({ action: "ask", project: "", evidence: "", spoken: "For the loader fix, is that yapd or std?" }),
        )
        yield* dictate("What's the status on the migration one?")
        yield* wait(60)
        yield* dictate("And the migration thing?")
        // Asked once more a minute after nobody answered, still in other words.
        yield* unanswered()
        yield* wait(60)
        yield* dictate("The migration, what's it doing?")
        // Which project new work goes in, asked again and let go, then dictated again.
        yield* dictate("Fix the loader.")
        yield* unanswered()
        yield* wait(60)
        yield* unanswered()
        yield* wait(30)
        yield* dictate("Fix the loader.")
        return { spoken: spoken(), asked: questions().map(({ spoken }) => spoken) }
      }),
    )
    const words = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, "")
    expect(new Set(result.asked.map(words)).size).toBe(result.asked.length)
    expect(result.spoken).toEqual([
      "Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?",
      "Which one, sir: Migrate Tezos Integration or Open Mina SSV2 Bug Tickets?",
      "I still need to know which you meant, sir: Migrate Tezos Integration or Open Mina SSV2 Bug Tickets?",
      "I couldn't tell which one you meant, sir.",
      "For the loader fix, is that yapd or std?",
      "Which project should the loader fix go in, sir?",
      "I didn't hear back about the loader fix, so I dropped it, sir.",
      "I still need a project for the loader fix, sir.",
    ])
  })

  test("the project question for new work is the one open question", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, spoken, questions, open, started } = yield* assistant(
          (situation) => {
            if (situation.utterance.heard.includes("MiNAS")) return { ...minaStatus(situation), pending: Option.isNone(situation.open) ? "" : "replaces" }
            return Brain.decision({ act: "start", text: situation.utterance.heard, pending: Option.isNone(situation.open) ? "" : "answers" })
          },
          ({ lines }) =>
            lines.length === 1
              ? written({ action: "ask", project: "", evidence: "", spoken: "For the loader fix, is that yapd or std?" })
              : written({ project: "std", evidence: "Std", spoken: "Started in std, on Opus, without a worktree." }),
        )
        yield* dictate("Fix the loader.")
        const first = yield* open
        // Something else, said while it's open, takes its place.
        yield* dictate("Can you please tell me what's the status on MiNAS SV2?")
        const replaced = { open: yield* open, stale: yield* questions()[0]!.stale }
        yield* dictate("Fix the loader.")
        yield* answer("Std.")
        return { first, replaced, spoken: spoken(), questions: questions().length, open: yield* open, started }
      }),
    )
    expect(Option.map(result.first, ({ kind, about }) => ({ kind, about }))).toEqual(Option.some({ kind: "project", about: "the loader fix" }))
    expect(result.replaced).toEqual({ open: Option.none(), stale: true })
    expect(result.spoken).toEqual([
      "For the loader fix, is that yapd or std?",
      "The Mina SSV2 tickets are filed, sir: four bugs, and fee rounding is the worst.",
      // The same question again within ten minutes, so in other words.
      "Which project should the loader fix go in, sir?",
      "Started in std, on Opus, without a worktree.",
    ])
    expect(result.started.map(({ project }) => project)).toEqual(["/code/std"])
    expect(result.open).toEqual(Option.none())
  })

  test("a request with fewer than two candidates says it couldn't tell, without asking", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, open } = yield* assistant((situation) =>
          Brain.decision({ act: "clarify", target: handle(situation, tezos), others: "t99", sure: "low" }),
        )
        yield* dictate("What's that one doing?")
        return { spoken: spoken(), questions: questions().length, open: yield* open }
      }),
    )
    expect(result.spoken).toEqual(["I couldn't tell which one you meant, sir."])
    expect(result.questions).toBe(0)
    expect(result.open).toEqual(Option.none())
  })

  test("an unanswered question is asked once more in other words a minute later, then let go with a word", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, unanswered, drop, wait, spoken, questions, open } = yield* assistant((situation) =>
          Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" }),
        )
        yield* dictate("What's the status on the migration one?")
        yield* unanswered()
        yield* wait(59)
        const soon = questions().length
        yield* wait(1)
        const again = questions().length
        yield* unanswered()
        const after = { spoken: spoken(), open: yield* open }
        // Turned off, a question waiting to be asked again never is.
        yield* wait(600)
        yield* dictate("What's the status on the migration one?")
        yield* unanswered()
        yield* drop
        yield* wait(120)
        return { soon, again, after, last: spoken().at(-1), open: yield* open }
      }),
    )
    expect(result.soon).toBe(1)
    expect(result.again).toBe(2)
    expect(result.after.spoken).toEqual([
      "Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?",
      "Which one, sir: Migrate Tezos Integration or Open Mina SSV2 Bug Tickets?",
      "I didn't hear back about whether you meant Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, so I dropped it, sir.",
    ])
    expect(result.after.open).toEqual(Option.none())
    expect(result.last).toBe("Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?")
    expect(result.open).toEqual(Option.none())
  })

  test("a question is asked again only if nothing was said meanwhile: not while he dictates, nor after he answers an update", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, unanswered, prepare, nothing, replied, wait, spoken, questions, open } = yield* assistant((situation) =>
          Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" }),
        )
        yield* dictate("What's the status on the migration one?")
        yield* unanswered()
        // He presses the shortcut just before it's asked again: it isn't said while he talks...
        yield* wait(58)
        yield* prepare
        const held = yield* questions()[0]!.stale
        yield* wait(5)
        const during = spoken().length
        // ...and cancels, so it's waited on again, and asked a minute later.
        yield* nothing
        yield* wait(60)
        const cancelled = spoken()
        // Asked afresh, then he answers an update instead, which takes its place.
        yield* wait(600)
        yield* dictate("What's the status on the migration one?")
        yield* unanswered()
        yield* replied
        yield* wait(120)
        return { held, during, cancelled, spoken: spoken(), open: yield* open }
      }),
    )
    const asked = "Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?"
    expect(result.held).toBe(true)
    expect(result.during).toBe(1)
    expect(result.cancelled).toEqual([asked, "Which one, sir: Migrate Tezos Integration or Open Mina SSV2 Bug Tickets?"])
    expect(result.spoken).toEqual([...result.cancelled, asked])
    expect(result.open).toEqual(Option.none())
  })

  test("a question he hasn't heard yet is left by talk over an update, and named when something new takes its place", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, replied, play, spoken, questions, open, seen } = yield* assistant(
          (situation) =>
            situation.utterance.heard.includes("loader")
              ? Brain.decision({ act: "start", text: situation.utterance.heard })
              : { ...minaStatus(situation), pending: Option.isNone(situation.open) ? "" : "replaces" },
          () => written({ action: "ask", project: "", evidence: "", spoken: "For the loader fix, is that yapd or std?" }),
          { waiting: true },
        )
        // Asked while an update is still being read, so it waits its turn...
        yield* dictate("Fix the loader.")
        // ...while he answers the update, which isn't about it.
        yield* replied
        const kept = { open: Option.isSome(yield* open), stale: yield* questions()[0]!.stale }
        // Its turn comes, and he dictates something else instead of answering.
        yield* play(questions()[0])
        yield* replied
        const heard = Option.isSome(yield* open)
        // Asked again, then cut off by a dictation before he heard it.
        yield* dictate("Fix the loader.")
        yield* dictate("Can you please tell me what's the status on MiNAS SV2?")
        return { kept, heard, shown: seen.at(-1)!.open, spoken: spoken(), open: yield* open }
      }),
    )
    expect(result.kept).toEqual({ open: true, stale: false })
    expect(result.heard).toBe(false)
    expect(result.shown).toEqual(Option.none())
    expect(result.spoken).toEqual([
      "For the loader fix, is that yapd or std?",
      "Which project should the loader fix go in, sir?",
      "I left the loader fix, since you'd moved on, sir.",
      "The Mina SSV2 tickets are filed, sir: four bugs, and fee rounding is the worst.",
    ])
    expect(result.open).toEqual(Option.none())
  })

  test("nothing is started for what was said before yapd was turned off and on", async () => {
    const starting = (toggled: boolean) =>
      run(
        Effect.gen(function* () {
          const { heard, toggle, wait, flush, started, spoken } = yield* assistant(
            () => Brain.decision({ act: "start", text: "Fix the loader in yapd." }),
            () => written({}),
            { writing: 5 },
          )
          const dictated = yield* Effect.fork(heard({ heard: "Fix the loader in yapd.", via: "shortcut", at: now, voiced: 3, turns: 1 }))
          yield* flush
          // Off and on again while its prompt is still being written.
          if (toggled) yield* Effect.zipRight(toggle(false), toggle(true))
          yield* wait(5)
          yield* Fiber.join(dictated)
          return { started: started.map(({ project }) => project), spoken: spoken().length }
        }),
      )
    // Left alone, it starts, so it's the off and on that stops it.
    expect(await starting(false)).toEqual({ started: ["/code/yapd"], spoken: 1 })
    expect(await starting(true)).toEqual({ started: [], spoken: 0 })
  })

  test("still starts what was being started when yapd was turned off, and notes it, without a word", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, toggle, wait, started, spoken, journal } = yield* assistant(
          (situation) => Brain.decision({ act: "start", text: situation.utterance.heard, pending: Option.isNone(situation.open) ? "" : "answers" }),
          ({ lines }) =>
            lines.length === 1
              ? written({ action: "ask", project: "", evidence: "", spoken: "For the loader fix, is that yapd or std?" })
              : written({ project: "std", evidence: "Std", spoken: "Started in std, on Opus, without a worktree." }),
          { launching: 5 },
        )
        yield* dictate("Fix the loader.")
        yield* answer("Std.")
        yield* toggle(false)
        yield* wait(5)
        const kept = yield* journal.since(0, { kinds: ["started"] })
        return { started: started.map(({ project }) => project), kept: kept.map(({ thread }) => thread), spoken: spoken() }
      }),
    )
    expect(result.started).toEqual(["/code/std"])
    expect(result.kept).toEqual(["new-thread"])
    expect(result.spoken).toEqual(["For the loader fix, is that yapd or std?"])
  })

  test("a launch that never answers holds nothing up, isn't started again meanwhile, and is given up on with its reason", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { heard, dictate, wait, spoken, started, seen } = yield* assistant(
          (situation) =>
            situation.lately.some(({ kind }) => kind === "started")
              ? Brain.decision({ act: "answer", spoken: "The loader fix is already under way, sir." })
              : Brain.decision({ act: "start", text: "Fix the loader in yapd." }),
          () => written({}),
          { hanging: true },
        )
        yield* dictate("Fix the loader in yapd.")
        yield* wait(1)
        yield* heard({ heard: "Who needs me?", via: "typed", at: now, voiced: 3, turns: 1 })
        // Said again while T3 Code is still getting the first one ready.
        yield* dictate("Fix the loader in yapd.")
        const meanwhile = spoken()
        yield* wait(6 * 60)
        return { meanwhile, spoken: spoken(), started: [...started], told: seen.at(-1)!.lately.map(({ kind, said }) => [kind, said]) }
      }),
    )
    expect(result.meanwhile).toEqual(["Nothing needs you right now, sir.", "The loader fix is already under way, sir."])
    expect(result.told).toContainEqual(["started", "Starting the loader fix, which T3 Code is still getting ready."])
    expect(result.spoken).toEqual([...result.meanwhile, "About the loader fix: T3 Code is taking too long, so I don't know if it started."])
    expect(result.started).toEqual([])
  })

  test("new work T3 Code never answered for is looked for once: there, it's said as started; not there, as maybe started", async () => {
    const launched = (unanswered: "started" | "not started") =>
      run(
        Effect.gen(function* () {
          const { dictate, wait, spoken, journal, ledger, seen } = yield* assistant(
            (situation) => Brain.decision({ act: "start", text: situation.utterance.heard }),
            () => written({ spoken: "Started in yapd, on Opus, without a worktree." }),
            { unanswered },
          )
          yield* dictate("Start a thread in yapd to fix the loader.")
          yield* wait(2)
          const kept = yield* journal.since(0, { kinds: ["started"] })
          const row = yield* ledger.latest("1 hour", { kinds: ["start"] })
          // Asked again, what it's told shows it may be under way.
          yield* dictate("Start a thread in yapd to fix the loader.")
          return {
            spoken: spoken().slice(0, 1),
            started: kept.map(({ thread }) => thread === Option.getOrUndefined(row)?.thread),
            state: Option.map(row, ({ state }) => state),
            told: seen.at(-1)!.lately.map(({ said }) => said),
          }
        }),
      )
    const there = await launched("started")
    expect(there.spoken).toEqual(["Started in yapd, on Opus, without a worktree."])
    expect(there.started).toEqual([true])
    expect(there.state).toEqual(Option.some("sent"))
    const missing = await launched("not started")
    expect(missing.spoken).toEqual(["About the loader fix: T3 Code is taking too long, so I don't know if it started."])
    expect(missing.started).toEqual([])
    expect(missing.state).toEqual(Option.some("unknown"))
    expect(missing.told).toContain("About the loader fix: T3 Code is taking too long, so I don't know if it started.")
  })

  test("when the model can't be asked, what he missed stays unheard and the question he heard is closed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, wait, spoken, open, journal } = yield* assistant((situation) =>
          situation.utterance.heard === "What did I miss?"
            ? undefined
            : Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" }),
        )
        yield* journal.write({ at: now - 60_000, kind: "update", project: "yapd", said: "yapd. The PR is ready." })
        yield* dictate("What's the status on the migration one?")
        yield* dictate("What did I miss?")
        const missed = (yield* journal.unheard(0, 12)).length
        const kept = Option.isSome(yield* open)
        // He's moved on, so it isn't asked again a minute later.
        yield* wait(120)
        return { missed, kept, spoken: spoken() }
      }),
    )
    expect(result.missed).toBe(1)
    expect(result.kept).toBe(false)
    expect(result.spoken).toEqual([
      "Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?",
      "I couldn't work that out just now, sir. What you said is in my log.",
    ])
  })

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

  test("a misheard thread name in a message goes to the right thread first time, with no question", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, dispatched, journal } = yield* assistant(tezosMessage("high"))
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        const kept = yield* journal.since(0, { kinds: ["sent"] })
        return { spoken: spoken(), questions: questions().length, sent: sent(dispatched), kept: kept.map(({ thread, text, said }) => ({ thread, text, said })) }
      }),
    )
    expect(result.questions).toBe(0)
    expect(result.sent).toEqual([{ type: "message.dispatch", threadId: tezos.id, text: "Use the fee table from the Mina work.", commandId: expect.stringMatching(/^yapd:u\w+:0$/) }])
    // It isn't the thread he was hearing about, so it's named: his one-word chance to put it right.
    expect(result.spoken).toEqual(["On it, sir: Migrate Tezos Integration."])
    expect(result.kept).toEqual([{ thread: tezos.id, text: "Use the fee table from the Mina work.", said: "On it, sir: Migrate Tezos Integration." }])
  })

  test("a write at medium confidence about a thread that isn't the focus asks once, naming both", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, spoken, questions, dispatched } = yield* assistant(tezosMessage("medium"))
        yield* dictate("Tell the migration one to use the fee table from the Mina work.")
        const before = dispatched.length
        yield* answer("The first.")
        return { before, spoken: spoken(), questions: questions().length, sent: sent(dispatched) }
      }),
    )
    expect(result.before).toBe(0)
    expect(result.questions).toBe(1)
    expect(result.spoken).toEqual(["Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?", "On it, sir: Migrate Tezos Integration."])
    expect(result.sent.map(({ threadId }) => threadId)).toEqual([tezos.id])
  })

  test("a write at medium confidence about the focus thread goes ahead", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, dispatched } = yield* assistant((situation) =>
          situation.utterance.heard.startsWith("What")
            ? Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration is comparing fee tables, sir." })
            : tezosMessage("medium")(situation),
        )
        yield* dictate("What's the Tezos one doing?")
        // "It" is the thread he just heard about, which is all medium needs.
        yield* dictate("Tell it to use the fee table from the Mina work.")
        return { spoken: spoken(), questions: questions().length, sent: sent(dispatched) }
      }),
    )
    expect(result.questions).toBe(0)
    expect(result.spoken).toEqual(["The Tezos migration is comparing fee tables, sir.", "On it, sir."])
    expect(result.sent.map(({ threadId }) => threadId)).toEqual([tezos.id])
  })

  test("a stop only fairly sure of the focus thread is confirmed first, and yes stops it, holding its queue", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, spoken, dispatched } = yield* assistant((situation) =>
          situation.utterance.heard.startsWith("What")
            ? Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration is comparing fee tables, sir." })
            : Brain.decision({ act: "stop", target: handle(situation, tezos), sure: "medium", others: handle(situation, mina) }),
        )
        yield* dictate("What's the Tezos one doing?")
        yield* dictate("Stop it.")
        const before = dispatched.length
        yield* answer("Yes.")
        return { before, spoken: spoken(), dispatched: dispatched.map(({ type, threadId, holdQueue }) => ({ type, threadId, holdQueue })) }
      }),
    )
    expect(result.before).toBe(0)
    // The question named it, so what's said once it's done doesn't again.
    expect(result.spoken.slice(1)).toEqual(["Stop Migrate Tezos Integration, sir?", "Stopped, sir."])
    expect(result.dispatched).toEqual([{ type: "run.interrupt", threadId: tezos.id, holdQueue: true }])
  })

  test("a no naming another thread, or other words, does what he said instead and never what was asked about", async () => {
    const corrected = (
      model: (situation: Brain.Situation) => Brain.Decision,
      steps: (helpers: { dictate: (heard: string) => Effect.Effect<void>; answer: (heard: string) => Effect.Effect<boolean> }) => Effect.Effect<void>,
    ) =>
      run(
        Effect.gen(function* () {
          const { dictate, answer, spoken, dispatched } = yield* assistant(model)
          yield* steps({ dictate, answer: (heard) => answer(heard) })
          return { spoken: spoken(), sent: dispatched.map(({ type, threadId, text }) => ({ type, threadId, text })) }
        }),
      )
    // "Stop it?" about the Tezos one, and he meant the Mina one, which has nothing to stop: nothing is stopped.
    const stopped = await corrected(
      (situation) =>
        situation.utterance.heard.startsWith("What")
          ? Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration is comparing fee tables, sir." })
          : situation.utterance.heard.startsWith("No")
            ? Brain.decision({ act: "stop", target: handle(situation, mina), sure: "high", pending: "answers" })
            : Brain.decision({ act: "stop", target: handle(situation, tezos), sure: "medium" }),
      ({ dictate, answer }) =>
        Effect.gen(function* () {
          yield* dictate("What's the Tezos one doing?")
          yield* dictate("Stop it.")
          yield* answer("No, the Mina one.")
        }),
    )
    expect(stopped.sent).toEqual([])
    expect(stopped.spoken.at(-1)).toBe("Open Mina SSV2 Bug Tickets isn't doing anything right now, sir.")
    // "I sent that a minute ago. Again?", and he meant it for the Mina one: it goes there, and the Tezos one gets it once.
    const twin = (situation: Brain.Situation) =>
      situation.utterance.heard.startsWith("No, tell the Mina")
        ? Brain.decision({ act: "send", target: handle(situation, mina), sure: "high", pending: "answers" })
        : situation.utterance.heard.startsWith("No, tell it")
          ? Brain.decision({ act: "send", target: handle(situation, tezos), sure: "high", text: "Use the other fee table.", pending: "answers" })
          : tezosMessage("high")(situation)
    const elsewhere = await corrected(twin, ({ dictate, answer }) =>
      Effect.gen(function* () {
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* answer("No, tell the Mina one instead.")
      }),
    )
    expect(elsewhere.spoken.at(-2)).toBe("I sent that a minute ago, sir. Again?")
    expect(elsewhere.sent).toEqual([
      { type: "message.dispatch", threadId: tezos.id, text: "Use the fee table from the Mina work." },
      { type: "message.dispatch", threadId: mina.id, text: "Use the fee table from the Mina work." },
    ])
    // Other words for the same thread: those go, and the first ones don't go again.
    const reworded = await corrected(twin, ({ dictate, answer }) =>
      Effect.gen(function* () {
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* answer("No, tell it to use the other fee table instead.")
      }),
    )
    expect(reworded.sent).toEqual([
      { type: "message.dispatch", threadId: tezos.id, text: "Use the fee table from the Mina work." },
      { type: "message.dispatch", threadId: tezos.id, text: "Use the other fee table." },
    ])
  })

  test("a yes or no that says more, like when it goes, what to do next or what to do instead, is about the thread that was asked about", async () => {
    const replying = (reply: string, answered: (situation: Brain.Situation) => Brain.Decision) =>
      run(
        Effect.gen(function* () {
          const { dictate, answer, spoken, questions, dispatched } = yield* assistant((situation) =>
            situation.utterance.via === "reply" ? answered(situation) : tezosMessage("high")(situation),
          )
          yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
          yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
          yield* answer(reply)
          return {
            spoken: spoken(),
            questions: questions().length,
            sent: dispatched.map(({ type, threadId, dispatchMode }) => [type, threadId, (dispatchMode as { type?: string } | undefined)?.type]),
          }
        }),
      )
    // "I sent that a minute ago, sir. Again?", and yes, only later: it's queued, and not asked about again.
    const later = await replying("Yes, but once it's done.", () => Brain.decision({ act: "send", how: "after", pending: "answers" }))
    expect(later.questions).toBe(1)
    expect(later.sent).toEqual([
      ["message.dispatch", tezos.id, "start_immediately"],
      ["message.dispatch", tezos.id, "queue_after_active"],
    ])
    // No, and stop it instead: "it" is the thread asked about.
    const stopped = await replying("No, stop it instead.", () => Brain.decision({ act: "stop", pending: "answers" }))
    expect(stopped.sent).toEqual([
      ["message.dispatch", tezos.id, "start_immediately"],
      ["run.interrupt", tezos.id, undefined],
    ])
    // "Stop Migrate Tezos Integration, sir?", and yes, then something to tell it: both, in order.
    const then = await run(
      Effect.gen(function* () {
        const { dictate, answer, spoken, dispatched } = yield* assistant((situation) =>
          situation.utterance.heard.startsWith("What")
            ? Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration is comparing fee tables, sir." })
            : situation.utterance.heard.startsWith("Yes")
              ? Brain.decision({ act: "stop", target: handle(situation, tezos), rest: "tell it to write up why it stopped", pending: "answers" })
              : situation.utterance.heard.startsWith("tell")
                ? Brain.decision({ act: "send", target: handle(situation, tezos), text: "Write up why you stopped.", how: "now" })
                : Brain.decision({ act: "stop", target: handle(situation, tezos), sure: "medium" }),
        )
        yield* dictate("What's the Tezos one doing?")
        yield* dictate("Stop it.")
        yield* answer("Yes, and then tell it to write up why it stopped.")
        return { spoken: spoken().at(-1), sent: dispatched.map(({ type, text, commandId }) => [type, text, String(commandId).replace(/^yapd:u\w+:/, "")]) }
      }),
    )
    expect(then.sent).toEqual([
      ["run.interrupt", undefined, "0"],
      ["message.dispatch", "Write up why you stopped.", "1"],
    ])
    expect(then.spoken).toBe("Stopped, sir. On it.")
  })

  test("the same message dictated again over 'I sent that a minute ago' is a yes to it, so that's never asked twice, and a no that sends elsewhere leaves an offer to send again for good", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, dispatched } = yield* assistant(tezosMessage("high"))
        for (let times = 0; times < 3; times++) yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        return { spoken: spoken(), questions: questions().length, ids: dispatched.map(({ commandId }) => String(commandId)) }
      }),
    )
    expect(result.questions).toBe(1)
    expect(result.spoken).toEqual(["On it, sir: Migrate Tezos Integration.", "I sent that a minute ago, sir. Again?", "On it, sir."])
    // The third time went as a step of its own.
    expect(result.ids).toHaveLength(2)
    expect(result.ids[1]).not.toBe(result.ids[0])
    let lost = true
    const redirected = await run(
      Effect.gen(function* () {
        const { dictate, answer, dispatched, ledger } = yield* assistant(
          (situation) =>
            situation.utterance.heard.startsWith("No") ? Brain.decision({ act: "send", target: handle(situation, mina), sure: "high", pending: "answers" }) : tezosMessage("high")(situation),
          undefined,
          { answer: () => (payload, bounded) => (lost ? Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })) : takes(payload, bounded)) },
        )
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        lost = false
        yield* answer("No, tell the Mina one instead.")
        return { sent: dispatched.map(({ threadId }) => threadId), restart: yield* ledger.open(0) }
      }),
    )
    expect(redirected.sent).toEqual([tezos.id, mina.id])
    // Nor offered again after a restart.
    expect(redirected.restart).toEqual([])
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
    // Said twice, and yes to sending it again.
    const twice = await run(
      Effect.gen(function* () {
        const { dictate, answer, dispatched } = yield* assistant((situation) => Brain.decision({ act: "send", target: handle(situation, tezos), how: "now" }))
        yield* dictate("Tell the Tesla's migration to rebase on master.")
        yield* dictate("Tell the Tesla's migration to rebase on master.")
        yield* answer("Yes.")
        return dispatched.map(({ text }) => text)
      }),
    )
    expect(twice).toEqual(["Tell the Tesla's migration to rebase on master.", "Tell the Tesla's migration to rebase on master."])
  })

  test("nothing is dispatched for a dictation heard before yapd was turned off and on", async () => {
    const sending = (toggled: boolean) =>
      run(
        Effect.gen(function* () {
          const { heard, toggle, wait, flush, dispatched, spoken } = yield* assistant(tezosMessage("high"), undefined, { thinking: 3 })
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

  test("turning yapd off while a message is being sent still notes what came of it, so scratch that knows it went", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, heard, toggle, wait, spoken, dispatched, ledger, journal } = yield* assistant(tezosMessage("medium"), undefined, {
          // T3 Code takes it, and is slow to say so.
          answer: () => (payload, bounded) => Effect.zipLeft(takes(payload, bounded), Effect.sleep("10 seconds")),
        })
        yield* dictate("Tell the migration one to use the fee table from the Mina work.")
        yield* answer("The first.")
        yield* toggle(false)
        yield* wait(10)
        const row = yield* ledger.latest("1 hour", { kinds: ["message"] })
        const kept = yield* journal.since(0, { kinds: ["sent"] })
        const before = spoken().length
        yield* toggle(true)
        yield* heard({ heard: "Scratch that.", via: "shortcut", at: yield* TestClock.currentTimeMillis, voiced: 1, turns: 3 })
        return { state: Option.map(row, ({ state }) => state), kept: kept.length, before, after: spoken().slice(before), dispatched: dispatched.length }
      }),
    )
    expect(result.state).toEqual(Option.some("sent"))
    expect(result.kept).toBe(1)
    // Nothing was said of it once yapd was off.
    expect(result.before).toBe(1)
    expect(result.after).toEqual(["Migrate Tezos Integration has already read it, sir. Shall I tell it to ignore that?"])
    expect(result.dispatched).toBe(1)
  })

  test("a message that didn't go is said with why, logged and journaled with it", async () => {
    const warned: Array<string> = []
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel._tag === "Warning") warned.push(String(Array.isArray(message) ? message.join(" ") : message))
    })
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, journal } = yield* assistant(tezosMessage("high"), undefined, {
          answer: () => () => Effect.fail(new T3CodeServer.Refusal({ tag: "OrchestrationV2DispatchCommandError", message: "The provider is offline." })),
        })
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        const kept = yield* journal.since(0, { kinds: ["sent"] })
        return { spoken: spoken(), questions: questions().length, reasons: kept.map(({ detail }) => (detail as { reason?: string }).reason) }
      }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
    )
    expect(result.spoken).toEqual(["That didn't go to Migrate Tezos Integration, sir: the provider is offline."])
    expect(result.questions).toBe(0)
    expect(result.reasons).toEqual(["The provider is offline."])
    expect(warned.some((line) => line.includes("The provider is offline."))).toBe(true)
  })

  test("a message that may not have got there is offered again, and yes sends it once more under the same ids", async () => {
    let lost = true
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, spoken, dispatched } = yield* assistant(tezosMessage("high"), undefined, {
          answer: () => (payload, bounded) =>
            lost ? Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })) : takes(payload, bounded),
        })
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        lost = false
        yield* answer("Yes.")
        // A second yes, to nothing asked, sends nothing more.
        yield* dictate("Yes.")
        return { spoken: spoken(), ids: dispatched.map(({ commandId, messageId }) => [commandId, messageId]) }
      }),
    )
    expect(result.spoken.slice(0, 2)).toEqual(["I couldn't confirm it got to Migrate Tezos Integration, sir. Send it again?", "On it, sir."])
    expect(result.ids).toHaveLength(2)
    expect(result.ids[1]).toEqual(result.ids[0])
  })

  test("yes, but once it's done, to sending again goes after the turn under way if it never left, and is left, saying why, if it may have got there", async () => {
    const later = (left: boolean) => {
      let down = true
      return run(
        Effect.gen(function* () {
          const { dictate, answer, spoken, dispatched, ledger } = yield* assistant(
            (situation) => (situation.utterance.via === "reply" ? Brain.decision({ act: "send", how: "after", pending: "answers" }) : tezosMessage("high")(situation)),
            undefined,
            {
              answer: () => (payload, bounded) =>
                down
                  ? Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code isn't answering.", ...(left ? { sent: true } : {}) }))
                  : Effect.sync(() => {
                      // Behind the turn under way, as T3 Code queues it.
                      bounded.messages.push({ id: String(payload.messageId), role: "user", text: String(payload.text), createdAt: "x" })
                      bounded.runs.push({ id: "run-4", status: "queued", ordinal: 4, userMessageId: String(payload.messageId) })
                      return { sequence: 2 }
                    }),
            },
          )
          yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
          down = false
          yield* answer("Yes, but once it's done.")
          return {
            spoken: spoken().slice(1),
            sent: dispatched.map(({ commandId, messageId, dispatchMode }) => [commandId, messageId, (dispatchMode as { type: string }).type]),
            restart: yield* ledger.open(0),
          }
        }),
      )
    }
    // It never left, so T3 Code never saw its ids: it goes under them, after the turn under way.
    const unsent = await later(false)
    expect(unsent.spoken).toEqual(["Noted. I'll get to it once the current task is done."])
    expect(unsent.sent).toHaveLength(2)
    expect(unsent.sent[1]).toEqual([unsent.sent[0]![0], unsent.sent[0]![1], "queue_after_active"])
    // It may be in the thread as it first went, at once, which is all it can go again as.
    const unsure = await later(true)
    expect(unsure.spoken).toEqual(["I left it, sir: it may have got there already, so it can only go again as it first went, at once."])
    expect(unsure.sent).toHaveLength(1)
    expect(unsure.restart).toEqual([])
  })

  test("a yes or a pick too faint to be his sends nothing, and leaves the question open to be asked again", async () => {
    const faintly = (model: (situation: Brain.Situation) => Brain.Decision, said: string, failing: boolean) =>
      run(
        Effect.gen(function* () {
          const { dictate, questions, flush, unanswered, wait, open, spoken, dispatched, journal } = yield* assistant(model, undefined, {
            ...(failing ? { answer: () => () => Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })) } : {}),
          })
          yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
          // A fifth of a second of it from across the room.
          const taken = yield* questions().at(-1)!.question!.answer(said, 0.2)
          if (Option.isSome(taken)) yield* taken.value
          yield* flush
          const left = yield* open
          const closed = yield* journal.since(0, { kinds: ["action"] })
          yield* unanswered()
          yield* wait(60)
          return {
            taken: Option.isSome(taken),
            open: Option.isSome(left),
            answered: closed.some(({ detail }) => (detail as { open?: string } | undefined)?.open === "answered"),
            asked: questions().length,
            spoken: spoken().length,
            dispatched: dispatched.length,
          }
        }),
      )
    // "Yeah" to sending again what may not have got there: the one try that may have, and nothing more.
    expect(await faintly(tezosMessage("high"), "Yeah.", true)).toEqual({ taken: false, open: true, answered: false, asked: 2, spoken: 2, dispatched: 1 })
    // "Tezos" to which thread a message is for.
    expect(await faintly(tezosMessage("medium"), "Tezos.", false)).toEqual({ taken: false, open: true, answered: false, asked: 2, spoken: 2, dispatched: 0 })
  })

  test("an offer to send again left unanswered is asked once more in other words, then let go, and never sent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, unanswered, wait, spoken, dispatched, ledger } = yield* assistant(tezosMessage("high"), undefined, {
          answer: () => () => Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })),
        })
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* unanswered()
        yield* wait(60)
        yield* unanswered()
        yield* wait(600)
        const row = yield* ledger.latest("1 hour", { kinds: ["message"] })
        return { spoken: spoken(), dispatched: dispatched.length, state: Option.map(row, ({ state }) => state), restart: yield* ledger.open(0) }
      }),
    )
    expect(result.spoken).toEqual([
      "I couldn't confirm it got to Migrate Tezos Integration, sir. Send it again?",
      "Shall I still send that to Migrate Tezos Integration again, sir?",
      "I didn't hear back about whether to send that to Migrate Tezos Integration again, so I left it, sir.",
    ])
    expect(result.dispatched).toBe(1)
    // It may still have got there, so it's kept as it was, though a restart doesn't offer it again.
    expect(result.state).toEqual(Option.some("unknown"))
    expect(result.restart).toEqual([])
  })

  test("scratch that once a message was read offers to have it ignored: yes tells the thread to, once, and no sends nothing", async () => {
    const original = "Use the fee table from the Mina work."
    const scratched = (reply: string) =>
      run(
        Effect.gen(function* () {
          const { dictate, answer, spoken, dispatched } = yield* assistant(tezosMessage("high"))
          yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
          yield* dictate("Scratch that.")
          const offered = spoken().at(-1)
          yield* answer(reply)
          return { offered, sent: dispatched.map(({ threadId, text }) => [threadId, text]) }
        }),
      )
    const yes = await scratched("Yes.")
    expect(yes.offered).toBe("It's already read it, sir. Shall I tell it to ignore that?")
    expect(yes.sent).toEqual([
      [tezos.id, original],
      [tezos.id, Hands.ignore(original)],
    ])
    expect((await scratched("No.")).sent).toEqual([[tezos.id, original]])
  })

  test("guards: cancel that with a question open sends nothing, and a request that never runs out of rest stops after four steps", async () => {
    const cancelled = await run(
      Effect.gen(function* () {
        const { dictate, answer, spoken, dispatched } = yield* assistant((situation) =>
          situation.utterance.heard.startsWith("What")
            ? Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration is comparing fee tables, sir." })
            : situation.utterance.heard.startsWith("Cancel")
              ? Brain.decision({ act: "dismiss", pending: "answers" })
              : situation.utterance.heard.startsWith("Stop")
                ? Brain.decision({ act: "stop", target: handle(situation, tezos), sure: "medium" })
                : tezosMessage("high")(situation),
        )
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* dictate("What's the Tezos one doing?")
        yield* dictate("Stop it.")
        yield* answer("Cancel that.")
        return { said: spoken().at(-1), dispatched: dispatched.length }
      }),
    )
    // A no to stopping it, not taking back the message before.
    expect(cancelled).toEqual({ said: "I'll leave that one, sir.", dispatched: 1 })
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

  test("scratch that right after starting new work leaves the message sent before it alone, and says why", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, wait, spoken, questions, dispatched, started } = yield* assistant(
          (situation) =>
            situation.utterance.heard.startsWith("When")
              ? Brain.decision({ act: "send", target: handle(situation, tezos), text: "Open a PR.", how: "after" })
              : Brain.decision({ act: "start", text: situation.utterance.heard }),
          () => written({ spoken: "Started in yapd, on Opus, without a worktree." }),
        )
        yield* dictate("When it's done, tell the Tesla's migration to open a PR.")
        yield* wait(30)
        yield* dictate("Start a thread in yapd to fix the loader.")
        yield* wait(5)
        yield* dictate("Scratch that.")
        return { spoken: spoken(), questions: questions().length, dispatched: dispatched.map(({ type }) => type), started: started.length }
      }),
    )
    expect(result.started).toBe(1)
    expect(result.dispatched).toEqual(["message.dispatch"])
    expect(result.questions).toBe(0)
    expect(result.spoken.at(-1)).toBe("I couldn't take that back, sir: starting work can't be taken back yet.")
  })

  test("a message that may not have got there, turned down for sending again, is asked about again under its own ids when it's said again", async () => {
    let lost = true
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, spoken, dispatched, ledger } = yield* assistant(tezosMessage("high"), undefined, {
          answer: () => (payload, bounded) =>
            lost ? Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })) : takes(payload, bounded),
        })
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* answer("No.")
        // Nor is it offered again after a restart.
        const restart = yield* ledger.open(0)
        lost = false
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        const before = dispatched.length
        yield* answer("Yes.")
        return { spoken: spoken(), restart, before, ids: dispatched.map(({ commandId, messageId }) => [commandId, messageId]) }
      }),
    )
    expect(result.restart).toEqual([])
    expect(result.spoken).toEqual([
      "I couldn't confirm it got to Migrate Tezos Integration, sir. Send it again?",
      "I'll leave that one, sir.",
      "I couldn't confirm that got to Migrate Tezos Integration before, sir. Send it again?",
      "On it, sir.",
    ])
    // Nothing went for the second time he said it, and his yes went under the first's ids.
    expect(result.before).toBe(1)
    expect(result.ids).toHaveLength(2)
    expect(result.ids[1]).toEqual(result.ids[0])
  })

  test("a message a restart found didn't get there isn't offered once it's been sent again meanwhile", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, undelivered, answer, spoken, dispatched, ledger } = yield* assistant((situation) =>
          situation.utterance.heard.startsWith("What")
            ? Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" })
            : tezosMessage("high")(situation),
        )
        const text = "Use the fee table from the Mina work."
        const row = yield* ledger.prepare({
          utterance: "u-old",
          step: 0,
          kind: "message",
          machine: "Rosie",
          thread: tezos.id,
          body: ({ messageId }) => ({ _tag: "Send", text, messageId, how: "now" }),
          message: true,
          digest: Ledger.digest(text),
        })
        yield* ledger.settle(row.commandId, "unknown")
        // A question is open, so the offer waits its turn.
        yield* dictate("What's the migration one doing?")
        yield* undelivered([row])
        // Meanwhile he says it again, and yes to sending it once more.
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work.")
        yield* answer("Yes.")
        const kept = yield* ledger.get(row.commandId)
        return { spoken: spoken(), ids: dispatched.map(({ commandId }) => commandId), state: Option.map(kept, ({ state }) => state) }
      }),
    )
    expect(result.ids).toEqual(["yapd:u-old:0"])
    expect(result.spoken.some((line) => line.startsWith("Before I restarted"))).toBe(false)
    // What went stays sent, whatever's left of the offer.
    expect(result.state).toEqual(Option.some("sent"))
  })

  test("after a restart, each message that didn't get there is offered once, one at a time, and yes sends it under its own ids", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { undelivered, answer, spoken, questions, dispatched, ledger } = yield* assistant(() => undefined)
        const lost = (utterance: string, text: string) =>
          Effect.zipLeft(
            ledger.prepare({
              utterance,
              step: 0,
              kind: "message",
              machine: "Rosie",
              thread: tezos.id,
              body: ({ messageId }) => ({ _tag: "Send", text, messageId, how: "now" }),
              message: true,
            }),
            ledger.settle(`yapd:${utterance}:0`, "unknown"),
          )
        const rows = [yield* lost("u-old1", "Use the fee table."), yield* lost("u-old2", "Also add a test.")]
        yield* undelivered(rows)
        const first = questions().length
        yield* answer("No.")
        yield* answer("Yes.")
        const states = yield* Effect.forEach(rows, ({ commandId }) => Effect.map(ledger.get(commandId), Option.map(({ state }) => state)))
        return { first, spoken: spoken(), sent: dispatched.map(({ commandId, text }) => [commandId, text]), states: states.map(Option.getOrNull) }
      }),
    )
    const offered = "Before I restarted, I couldn't confirm your message to Migrate Tezos Integration got there, sir. Send it again?"
    expect(result.first).toBe(1)
    expect(result.spoken).toEqual([offered, "I'll leave that one, sir.", offered, "On it, sir."])
    expect(result.sent).toEqual([["yapd:u-old2:0", "Also add a test."]])
    expect(result.states).toEqual(["unknown", "sent"])
  })

  test("a message a restart couldn't confirm waits while yapd is off, and one too long ago to send again by its turn is said so, with why", async () => {
    const warned: Array<string> = []
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel._tag === "Warning") warned.push(String(Array.isArray(message) ? message.join(" ") : message))
    })
    const result = await run(
      Effect.gen(function* () {
        const { undelivered, heard, toggle, wait, spoken, dispatched, ledger, journal } = yield* assistant(() => undefined)
        const lost = (utterance: string) =>
          Effect.zipLeft(
            ledger.prepare({
              utterance,
              step: 0,
              kind: "message",
              machine: "Rosie",
              thread: tezos.id,
              body: ({ messageId }) => ({ _tag: "Send", text: "Use the fee table.", messageId, how: "now" }),
              message: true,
            }),
            ledger.settle(`yapd:${utterance}:0`, "unknown"),
          )
        // Off as the restart's look finds it: it's offered once he's back and says something.
        yield* toggle(false)
        yield* undelivered([yield* lost("u-old1")])
        const off = spoken().length
        yield* toggle(true)
        yield* heard({ heard: "Who needs me?", via: "shortcut", at: yield* TestClock.currentTimeMillis, voiced: 2, turns: 3 })
        const back = spoken().at(-1)
        // Found sixteen minutes after it was sent, it's too long ago to send again.
        const old = yield* lost("u-old2")
        yield* wait(16 * 60)
        yield* heard({ heard: "No.", via: "shortcut", at: yield* TestClock.currentTimeMillis, voiced: 2, turns: 3 })
        yield* undelivered([old])
        const kept = yield* journal.since(0, { kinds: ["action"] })
        return {
          off,
          back,
          last: spoken().at(-1),
          reasons: kept.flatMap(({ detail }) => Option.toArray(Option.fromNullable((detail as { reason?: string }).reason))),
          dispatched: dispatched.length,
        }
      }).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
    )
    expect(result.off).toBe(0)
    expect(result.back).toBe("Before I restarted, I couldn't confirm your message to Migrate Tezos Integration got there, sir. Send it again?")
    expect(result.last).toBe("Before I restarted, I couldn't confirm your message to Migrate Tezos Integration got there, sir, and it's too long ago to send it again now.")
    expect(result.reasons).toContain("It's too long ago to send it again now.")
    expect(warned.some((line) => line.includes("It's too long ago to send it again now."))).toBe(true)
    expect(result.dispatched).toBe(0)
  })

  test("what a restart found while yapd was off is said once it's turned on, without waiting for him to say something", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { undelivered, unconfirmed, back, toggle, flush, spoken, dispatched, ledger } = yield* assistant(() => undefined)
        const message = yield* ledger.prepare({
          utterance: "u-old1",
          step: 0,
          kind: "message",
          machine: "Rosie",
          thread: tezos.id,
          body: ({ messageId }) => ({ _tag: "Send", text: "Use the fee table.", messageId, how: "now" }),
          message: true,
        })
        yield* ledger.settle(message.commandId, "unknown")
        const stop = yield* ledger.prepare({ utterance: "u-old2", step: 0, kind: "stop", machine: "Rosie", thread: tezos.id, body: () => ({ _tag: "Stop" }), message: false })
        yield* toggle(false)
        yield* unconfirmed([{ ...stop, state: "abandoned", reason: Hands.unconfirmable }])
        yield* undelivered([message])
        const off = spoken().length
        // Turned on from the menu bar.
        yield* toggle(true)
        yield* back
        yield* flush
        return { off, spoken: spoken(), dispatched: dispatched.length }
      }),
    )
    expect(result.off).toBe(0)
    expect(result.spoken).toEqual([
      "Before I restarted, I couldn't confirm Migrate Tezos Integration stopped, sir.",
      "Before I restarted, I couldn't confirm your message to Migrate Tezos Integration got there, sir. Send it again?",
    ])
    expect(result.dispatched).toBe(0)
  })

  test("a stop a restart couldn't confirm is said once, with why, and journaled, never done again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { unconfirmed, spoken, dispatched, ledger, journal } = yield* assistant(() => undefined)
        const row = yield* ledger.prepare({ utterance: "u-old", step: 0, kind: "stop", machine: "Rosie", thread: tezos.id, body: () => ({ _tag: "Stop" }), message: false })
        yield* unconfirmed([{ ...row, state: "abandoned", reason: "I couldn't tell whether it went through before I restarted." }])
        const kept = yield* journal.since(0, { kinds: ["action"] })
        return { spoken: spoken(), dispatched: dispatched.length, kept: kept.map(({ said, detail }) => [said, (detail as { reason?: string }).reason]) }
      }),
    )
    expect(result.spoken).toEqual(["Before I restarted, I couldn't confirm Migrate Tezos Integration stopped, sir."])
    expect(result.dispatched).toBe(0)
    expect(result.kept).toEqual([["Before I restarted, I couldn't confirm Migrate Tezos Integration stopped, sir.", "I couldn't tell whether it went through before I restarted."]])
  })

  test("the first step is said at once when the rest takes longer than a second to work out, and the rest is said only if it doesn't go", async () => {
    const twoSteps = (refusing: boolean) =>
      run(
        Effect.gen(function* () {
          const { heard, wait, flush, spoken, dispatched } = yield* assistant(
            (situation) =>
              situation.utterance.heard.startsWith("Stop")
                ? Brain.decision({ act: "stop", target: handle(situation, tezos), rest: "tell the Mina one to use its fee table" })
                : Brain.decision({ act: "send", target: handle(situation, mina), text: "Use your fee table.", how: "now" }),
            undefined,
            {
              thinking: 3,
              answer: () => (payload, bounded) =>
                refusing && payload.type === "message.dispatch"
                  ? Effect.fail(new T3CodeServer.Refusal({ tag: "OrchestrationV2DispatchCommandError", message: "The provider is offline." }))
                  : takes(payload, bounded),
            },
          )
          const dictated = yield* Effect.fork(heard({ heard: "Stop the Tezos one and tell the Mina one to use its fee table.", via: "shortcut", at: now, voiced: 3, turns: 1 }))
          yield* flush
          yield* wait(3)
          yield* wait(1)
          yield* Fiber.join(dictated)
          const first = { spoken: spoken(), dispatched: dispatched.length }
          yield* wait(2)
          return { first, spoken: spoken(), dispatched: dispatched.map(({ type }) => type) }
        }),
      )
    const done = await twoSteps(false)
    expect(done.first).toEqual({ spoken: ["Stopped, sir: Migrate Tezos Integration."], dispatched: 1 })
    expect(done.spoken).toEqual(["Stopped, sir: Migrate Tezos Integration."])
    expect(done.dispatched).toEqual(["run.interrupt", "message.dispatch"])
    const refused = await twoSteps(true)
    expect(refused.spoken).toEqual(["Stopped, sir: Migrate Tezos Integration.", "That didn't go to Open Mina SSV2 Bug Tickets, sir: the provider is offline."])
  })

  test("nothing is dispatched for the rest of a request when yapd was turned off and on while it was worked out", async () => {
    const sending = (toggled: boolean) =>
      run(
        Effect.gen(function* () {
          const { heard, toggle, wait, flush, dispatched } = yield* assistant(
            (situation) =>
              situation.utterance.heard.startsWith("Stop")
                ? Brain.decision({ act: "stop", target: handle(situation, tezos), rest: "tell the Mina one to use its fee table" })
                : Brain.decision({ act: "send", target: handle(situation, mina), text: "Use your fee table.", how: "now" }),
            undefined,
            { thinking: 0.5 },
          )
          const dictated = yield* Effect.fork(heard({ heard: "Stop the Tezos one and tell the Mina one to use its fee table.", via: "shortcut", at: now, voiced: 3, turns: 1 }))
          yield* flush
          yield* wait(0.5)
          // Off and on again while the rest is worked out.
          if (toggled) yield* Effect.zipRight(toggle(false), toggle(true))
          yield* wait(0.5)
          yield* Fiber.join(dictated)
          return dispatched.map(({ type }) => type)
        }),
      )
    expect(await sending(false)).toEqual(["run.interrupt", "message.dispatch"])
    expect(await sending(true)).toEqual(["run.interrupt"])
  })

  test("the rest of a request follows an answer, and a yes to sending again, and is said as left after starting new work", async () => {
    const rest = "tell the Mina one to use its fee table"
    const toMina = (situation: Brain.Situation) => Brain.decision({ act: "send", target: handle(situation, mina), text: "Use your fee table.", how: "now" })
    const answered = await run(
      Effect.gen(function* () {
        const { dictate, spoken, dispatched } = yield* assistant((situation) =>
          situation.utterance.heard.startsWith("What")
            ? Brain.decision({ act: "answer", target: handle(situation, tezos), spoken: "The Tezos migration is comparing fee tables, sir.", rest })
            : toMina(situation),
        )
        yield* dictate("What's the Tezos one doing, and tell the Mina one to use its fee table.")
        return { spoken: spoken(), sent: dispatched.map(({ threadId, commandId }) => [threadId, String(commandId).replace(/^yapd:u\w+:/, "")]) }
      }),
    )
    expect(answered.spoken).toEqual(["The Tezos migration is comparing fee tables, sir. On it: Open Mina SSV2 Bug Tickets."])
    expect(answered.sent).toEqual([[mina.id, "1"]])
    let lost = true
    const resent = await run(
      Effect.gen(function* () {
        const { dictate, answer, dispatched } = yield* assistant(
          (situation) => (situation.utterance.heard.startsWith("Tell") ? { ...tezosMessage("high")(situation), rest } : toMina(situation)),
          undefined,
          { answer: () => (payload, bounded) => (lost ? Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code is taking too long.", sent: true })) : takes(payload, bounded)) },
        )
        yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work, and tell the Mina one to use its fee table.")
        lost = false
        yield* answer("Yes.")
        return dispatched.map(({ threadId }) => threadId)
      }),
    )
    expect(resent).toEqual([tezos.id, tezos.id, mina.id])
    const begun = await run(
      Effect.gen(function* () {
        const { dictate, spoken, dispatched } = yield* assistant(
          (situation) => Brain.decision({ act: "start", text: situation.utterance.heard, rest }),
          () => written({ spoken: "Started in yapd, on Opus, without a worktree." }),
        )
        yield* dictate("Start a thread in yapd to fix the loader, and tell the Mina one to use its fee table.")
        return { spoken: spoken(), dispatched: dispatched.length }
      }),
    )
    expect(begun.spoken).toEqual(["I left the rest for now, sir: tell the Mina one to use its fee table.", "Started in yapd, on Opus, without a worktree."])
    expect(begun.dispatched).toBe(0)
  })

  test("when the question a request's first step raised is replaced, what was left of it is said, and an unheard offer to send again still says what didn't go and why", async () => {
    const rest = "tell the Mina one to use its fee table"
    const replaced = (waiting: boolean) =>
      run(
        Effect.gen(function* () {
          const { dictate, spoken, dispatched } = yield* assistant(
            (situation) => (situation.utterance.heard.startsWith("What") ? minaStatus(situation) : { ...tezosMessage("high")(situation), rest }),
            undefined,
            { waiting, answer: () => () => Effect.fail(new T3CodeServer.Trouble({ reason: "T3 Code isn't answering." })) },
          )
          yield* dictate("Tell the Tesla's migration to use the fee table from the Mina work, and tell the Mina one to use its fee table.")
          // Asked whether to send it again, he asks about something else.
          yield* dictate("What's the Mina one doing?")
          return { spoken: spoken().slice(1), dispatched: dispatched.length }
        }),
      )
    expect(await replaced(false)).toEqual({
      spoken: ["I left the rest, sir: tell the Mina one to use its fee table. The Mina SSV2 tickets are filed: four bugs, and fee rounding is the worst."],
      dispatched: 1,
    })
    // He pressed again before the question was said, so he never heard it, nor why it was asked.
    expect(await replaced(true)).toEqual({
      spoken: [
        "That didn't get to Migrate Tezos Integration, sir: T3 Code isn't answering. I didn't ask about sending it again, since you'd moved on. I left the rest: tell the Mina one to use its fee table.",
        "The Mina SSV2 tickets are filed, sir: four bugs, and fee rounding is the worst.",
      ],
      dispatched: 1,
    })
  })

  test("what's left of a request is said when its first step doesn't go, and done after a thanks", async () => {
    const twoSteps = (heard: string, model: (situation: Brain.Situation) => Brain.Decision, refusing = false) =>
      run(
        Effect.gen(function* () {
          const { dictate, spoken, dispatched } = yield* assistant(model, undefined, {
            ...(refusing ? { answer: () => () => Effect.fail(new T3CodeServer.Refusal({ tag: "OrchestrationV2DispatchCommandError", message: "The provider is offline." })) } : {}),
          })
          yield* dictate(heard)
          return { spoken: spoken(), sent: dispatched.map(({ type, threadId }) => [type, threadId]) }
        }),
      )
    // Turned down, with the rest written by the model as the handle it knows the thread by, which is never said.
    const refused = await twoSteps(
      "Tell the Tesla's migration to use the fee table from the Mina work, and stop the Mina one.",
      (situation) => ({ ...tezosMessage("high")(situation), rest: `stop ${handle(situation, mina)}` }),
      true,
    )
    expect(refused.spoken).toEqual(["That didn't go to Migrate Tezos Integration, sir: the provider is offline. I left the rest: stop Open Mina SSV2 Bug Tickets."])
    // Nothing to stop.
    const idle = await twoSteps("Stop the Mina one and tell the Tezos one to open a PR.", (situation) =>
      Brain.decision({ act: "stop", target: handle(situation, mina), rest: "tell the Tezos one to open a PR" }),
    )
    expect(idle).toEqual({ spoken: ["Open Mina SSV2 Bug Tickets isn't doing anything right now, sir. I left the rest: tell the Tezos one to open a PR."], sent: [] })
    // Thanks, and something to do.
    const thanks = await twoSteps("Thanks, and tell the Tezos one to open a PR.", (situation) =>
      situation.utterance.heard.startsWith("Thanks")
        ? Brain.decision({ act: "dismiss", rest: "tell the Tezos one to open a PR" })
        : Brain.decision({ act: "send", target: handle(situation, tezos), text: "Open a PR.", how: "now" }),
    )
    expect(thanks.sent).toEqual([["message.dispatch", tezos.id]])
  })

  test("the rest of a request is done as its next step, once the first is", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, dispatched } = yield* assistant((situation) =>
          situation.utterance.heard.startsWith("Stop")
            ? Brain.decision({ act: "stop", target: handle(situation, tezos), rest: "tell the Mina one to use its fee table" })
            : Brain.decision({ act: "send", target: handle(situation, mina), text: "Use your fee table.", how: "now" }),
        )
        yield* dictate("Stop the Tezos one and tell the Mina one to use its fee table.")
        return { spoken: spoken(), sent: dispatched.map(({ type, threadId, commandId }) => [type, threadId, String(commandId).replace(/^yapd:u\w+:/, "")]) }
      }),
    )
    expect(result.sent).toEqual([
      ["run.interrupt", tezos.id, "0"],
      ["message.dispatch", mina.id, "1"],
    ])
    // One line for the lot, and "sir" once.
    expect(result.spoken).toEqual(["Stopped, sir: Migrate Tezos Integration. On it: Open Mina SSV2 Bug Tickets."])
  })
})
