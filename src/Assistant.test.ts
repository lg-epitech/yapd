import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import * as Assistant from "./Assistant.ts"
import * as Brain from "./Brain.ts"
import type * as Conversation from "./Conversation.ts"
import * as Drafts from "./Drafts.ts"
import type { Notice } from "./Inbox.ts"
import * as Journal from "./Journal.ts"
import { type Catalog, LaunchError, type Request, type Started } from "./Launcher.ts"
import * as Persona from "./Persona.ts"
import * as Research from "./Research.ts"
import * as Store from "./Store.ts"
import * as T3Actions from "./T3Actions.ts"
import type * as T3CodeServer from "./T3CodeServer.ts"
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
  address: "sir",
}

/** An update from a session T3 Code doesn't run, read to him at `at`. */
const update = (project: string, spoken: string, at: number): Conversation.Update => ({
  session: `claude:${project}`,
  project,
  turn: { prompt: Option.none(), message: spoken },
  needsYou: false,
  spoken,
  audio: `/tmp/${project}.wav`,
  thread: { agent: "claude", session: project, cwd: `/code/${project}`, message: spoken, origin: {} },
  at,
})

/** A T3 Code that answers reads, has nothing pending, and finds for each word what `search` says, in its order. */
const transport = (search: (query: string) => ReadonlyArray<string>): Effect.Effect<T3CodeServer.Transport, T3CodeServer.Trouble> =>
  Effect.succeed({
    api: (<A, I>(_: string, schema: Schema.Schema<A, I>) =>
      Schema.decodeUnknown(schema)({
        projection: { runs: [{ id: "run-3", status: "running", ordinal: 3 }], messages: [{ role: "assistant", text: "Comparing fee tables.", createdAt: "x" }], turnItems: [] },
      }).pipe(Effect.orDie)) as T3CodeServer.Transport["api"],
    call: (<A, I>(method: string, params: { readonly query?: string }, schema: Schema.Schema<A, I>) =>
      Schema.decodeUnknown(schema)(
        method === "server.getConfig"
          ? { providers: [] }
          : {
              matches: search(params.query ?? "").map((threadId) => ({ threadId, projectId: "p", source: "message", snippet: params.query, messageCreatedAt: null })),
            },
      ).pipe(Effect.orDie)) as T3CodeServer.Transport["call"],
  })

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
    /** How long reading through a project takes, for a request that leans on something in it. */
    readonly researching?: number
    readonly launching?: number
    readonly hanging?: boolean
    readonly waiting?: boolean
    /** Threads besides those in the view, or in place of them. */
    readonly others?: ReadonlyArray<T3Live.Thread>
    /** The ids of the threads T3 Code's search finds for a word, best first. */
    readonly search?: (query: string) => ReadonlyArray<string>
    /** What's waiting to be said already, like an update a dictation cut off. */
    readonly queued?: ReadonlySet<string>
    /** How the speaker is got ready for what's about to be said, which can take a while. */
    readonly coming?: Effect.Effect<void>
    /** How updates are held for an answer, which can take a while to set up. */
    readonly awaiting?: Effect.Effect<Effect.Effect<void>>
    /** How long the model takes to work out what was said, on top of answering. */
    readonly deciding?: Effect.Effect<void>
    /** Told when writing a prompt begins, and when it stops, however it ends. */
    readonly writer?: { readonly begun: Effect.Effect<void>; readonly stopped: Effect.Effect<void> }
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const store = yield* Store.make(":memory:")
    const journal = Journal.fromStore(store)
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
    const threads = yield* Threads.make({
      machine: "Rosie",
      live: {
        view: Effect.succeed(Option.some({ ...view, threads: new Map([...view.threads, ...(given.others ?? []).map((other) => [other.id, other] as const)]) })),
        changes: Stream.never,
      },
      actions: Option.some(T3Actions.make(transport(given.search ?? (() => [])))),
      others: [],
      journal,
      store,
    })
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
              // Like T3 Code preparing a worktree that never gets ready, which its launcher gives up on after six minutes.
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
      recent: Effect.succeed([]),
    }).pipe(
      Effect.provideService(Writer, {
        decide: (material) =>
          (given.writer?.begun ?? Effect.void).pipe(
            Effect.zipRight(Effect.sleep(`${given.writing ?? 0} seconds`)),
            Effect.zipRight(Effect.sync(() => write(material))),
            Effect.ensuring(given.writer?.stopped ?? Effect.void),
          ),
        research: () =>
          Effect.sleep(`${given.researching ?? 0} seconds`).pipe(Effect.as({ action: "start" as const, why: "It's in the loader.", prompt: "Fix the loader.", spoken: "" })),
        prepare: Effect.void,
      }),
    )
    let power = { on: true, turns: 1 }
    let listening = Option.none<{ readonly update: Conversation.Update; readonly said: string; readonly at: number; readonly playing: boolean }>()
    const made = yield* Assistant.make({
      threads,
      journal,
      drafts,
      // Said at once and to the end, as when nothing else is being said.
      tell: (notice) =>
        Effect.zipRight(
          Effect.sync(() => void said.push(notice)),
          given.waiting === true ? Effect.void : Effect.zipRight(notice.saying ?? Effect.void, notice.heard ?? Effect.void),
        ),
      power: Effect.sync(() => power),
      lastHeard: Effect.sync(() => listening),
      coming: given.coming ?? Effect.void,
      awaiting: given.awaiting ?? Effect.succeed(Effect.void),
      queued: (spoken) => Effect.succeed(given.queued?.has(spoken) === true),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Brain.Brain, {
            decide: (situation) =>
              Effect.suspend(() => {
                seen.push(situation)
                const decided = model(situation)
                return Effect.zipRight(
                  given.deciding ?? Effect.void,
                  decided === undefined ? Effect.fail(new Brain.BrainError({ cause: "The model is down." })) : Effect.succeed(decided),
                )
              }),
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
      started,
      seen,
      journal,
      spoken: () => said.map(({ spoken }) => spoken),
      questions,
      flush,
      /** An update starts being read to him. */
      reading: (project: string, spoken: string) =>
        Effect.flatMap(TestClock.currentTimeMillis, (at) =>
          Effect.sync(() => {
            listening = Option.some({ update: update(project, spoken, at), said: spoken, at, playing: true })
          }),
        ),
      /** yapd starts saying something back over the update being read, like an answer to what he asked over it. */
      answering: (line: string) =>
        Effect.flatMap(TestClock.currentTimeMillis, (at) =>
          Effect.sync(() => {
            listening = Option.map(listening, (heard) => ({ ...heard, said: line, at, playing: true }))
          }),
        ),
      /** Its turn came, after whatever was being said, and it was said to the end. */
      play: (notice = said.at(-1)) => (notice?.saying ?? Effect.void).pipe(Effect.zipRight(notice?.heard ?? Effect.void), Effect.zipRight(flush)),
      /** Its turn came, and a dictation cut it off before the end. */
      cut: (notice = said.at(-1)) => (notice?.saying ?? Effect.void).pipe(Effect.zipRight(flush)),
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

  test("a question stays held while any dictation that may answer it is still being heard, however the others came out", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, prepare, heard, nothing, unanswered, wait, questions } = yield* assistant((situation) =>
          Option.isNone(situation.open)
            ? Brain.decision({ act: "answer", target: handle(situation, tezos), sure: "low", others: handle(situation, mina), spoken: "It's comparing formats." })
            : Brain.decision({ act: "resume", pending: "" }),
        )
        yield* dictate("What's the status on my Tesla's migration request comparison?")
        const question = questions()[0]!
        yield* unanswered()
        // He presses twice to answer it; the first comes out as a cough taken for words.
        yield* prepare(1, 1)
        yield* prepare(2, 1)
        yield* heard({ heard: "Thank you.", via: "shortcut", at: now, voiced: 0.2, turns: 1 }, 1)
        const heldByTheSecond = yield* question.stale
        yield* wait(90)
        const askedMeanwhile = questions().length
        // The second comes to nothing too: only now is it waited on again, and asked once more a minute later.
        yield* nothing(2)
        yield* wait(61)
        return { heldByTheSecond, askedMeanwhile, askedAfter: questions().length }
      }),
    )
    expect(result.heldByTheSecond).toBe(true)
    expect(result.askedMeanwhile).toBe(1)
    expect(result.askedAfter).toBe(2)
  })

  test("a request stopped while it waits its turn lets go of the question it held", async () => {
    let coming = 0
    const result = await run(
      Effect.gen(function* () {
        const { dictate, heard, unanswered, wait, questions } = yield* assistant(
          (situation) => Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" }),
          undefined,
          // The first request after the question takes a while, and the next waits its turn behind it.
          { coming: Effect.suspend(() => (++coming === 2 ? Effect.sleep("10 seconds") : Effect.void)) },
        )
        yield* dictate("Which migration is running?")
        yield* unanswered()
        const first = yield* Effect.fork(heard({ heard: "Thank you.", via: "shortcut", at: now, voiced: 0.2, turns: 1 }))
        yield* wait(0)
        const queued = yield* Effect.fork(heard({ heard: "Thank you.", via: "typed", at: now, voiced: 0.2, turns: 1 }))
        yield* wait(0)
        yield* Fiber.interrupt(queued)
        yield* wait(11)
        yield* Fiber.join(first)
        yield* wait(61)
        return questions().length
      }),
    )
    // Nothing holds it once both are done with, so it's asked once more.
    expect(result).toBe(2)
  })

  test("a press got ready across yapd being turned off and on holds no question asked since", async () => {
    let awaited = 0
    const result = await run(
      Effect.gen(function* () {
        const { prepare, heard, toggle, unanswered, wait, questions } = yield* assistant(
          (situation) => Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" }),
          undefined,
          // Holding updates for the first press takes a while to set up.
          { awaiting: Effect.suspend(() => (++awaited === 1 ? Effect.sleep("2 seconds").pipe(Effect.as(Effect.void)) : Effect.succeed(Effect.void))) },
        )
        const preparing = yield* Effect.fork(prepare(1, 1))
        yield* wait(0)
        yield* toggle(false)
        yield* toggle(true)
        yield* heard({ heard: "Which migration is running?", via: "typed", at: now, voiced: 3, turns: 3 })
        yield* unanswered()
        yield* wait(3)
        yield* Fiber.join(preparing)
        // What that press heard comes from before yapd was turned off, and isn't worked out.
        yield* heard({ heard: "Fix the loader in yapd.", via: "shortcut", at: now, voiced: 3, turns: 1 }, 1)
        yield* wait(90)
        return questions().length
      }),
    )
    // The question asked since was never held by it, so it's asked once more.
    expect(result).toBe(2)
  })

  test("a press whose dictation is over before it's got ready for holds no question", async () => {
    let awaited = 0
    const result = await run(
      Effect.gen(function* () {
        const { dictate, prepare, nothing, unanswered, wait, questions } = yield* assistant(
          (situation) => Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" }),
          undefined,
          // Holding updates for the press takes a while to set up, and its dictation comes to nothing meanwhile.
          { awaiting: Effect.suspend(() => (++awaited === 2 ? Effect.sleep("2 seconds").pipe(Effect.as(Effect.void)) : Effect.succeed(Effect.void))) },
        )
        yield* dictate("Which migration is running?")
        yield* unanswered()
        const preparing = yield* Effect.fork(prepare(1, 1))
        yield* wait(0)
        yield* nothing(1)
        yield* wait(3)
        yield* Fiber.join(preparing)
        yield* wait(61)
        return questions().length
      }),
    )
    // Nothing holds it once the press is over, so it's asked once more.
    expect(result).toBe(2)
  })

  test("a request stopped while the model works it out stops writing the prompt begun in case it was new work", async () => {
    const result = await run(
      Effect.gen(function* () {
        const begun = yield* Deferred.make<void>()
        let stopped = false
        const { heard, flush } = yield* assistant(() => Brain.decision({ act: "answer", spoken: "It's in the loader." }), undefined, {
          writing: 600,
          deciding: Effect.never,
          writer: { begun: Deferred.complete(begun, Effect.void).pipe(Effect.asVoid), stopped: Effect.sync(() => void (stopped = true)) },
        })
        const request = yield* Effect.fork(heard({ heard: "Tell me about the loader.", via: "typed", at: now, voiced: 3, turns: 1 }))
        yield* Deferred.await(begun)
        yield* Fiber.interrupt(request)
        yield* flush
        return stopped
      }),
    )
    expect(result).toBe(true)
  })

  test("turned off while the prompt is written again with the project he named, it stops being written", async () => {
    let writes = 0
    const result = await run(
      Effect.gen(function* () {
        const again = yield* Deferred.make<void>()
        let stopped = 0
        const { dictate, answer, toggle } = yield* assistant(
          (situation) => Brain.decision({ act: "start", text: situation.utterance.heard, pending: Option.isNone(situation.open) ? "" : "answers" }),
          ({ lines }) =>
            lines.length === 1 ? written({ action: "ask", project: "", evidence: "", spoken: "For the loader fix, is that yapd or std?" }) : written({ project: "std", evidence: "Std" }),
          // Written again with his answer, it takes as long as it takes.
          {
            writer: {
              begun: Effect.suspend(() => (++writes === 2 ? Effect.zipRight(Deferred.complete(again, Effect.void), Effect.never) : Effect.void)),
              stopped: Effect.sync(() => void stopped++),
            },
          },
        )
        yield* dictate("Fix the loader.")
        yield* Effect.fork(answer("Std."))
        yield* Deferred.await(again)
        yield* toggle(false)
        return stopped
      }),
    )
    expect(result).toBe(2)
  })

  test("starting new work that mentions an existing thread starts new work", async () => {
    const dictated =
      "Can you please go and look at what I did for the migration process for Mina and start another thread in integration on the main worktree to start working on the migration for Tezos, so I have a ticket open for that as well in my linear."
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, questions, started, journal } = yield* assistant(
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
        return { spoken: spoken(), questions: questions().length, started, kept: kept.map(({ thread, utterance }) => [thread, utterance !== undefined]) }
      }),
    )
    expect(result.questions).toBe(0)
    expect(result.started.map(({ project }) => project)).toEqual(["/code/integration"])
    expect(result.spoken).toEqual(["Started in integration, on Opus, without a worktree."])
    expect(result.kept).toEqual([["new-thread", true]])
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

  test("\"say that again\" over an update says what he heard last of it, like the answer to what he asked over it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { reading, answering, wait, dictate, spoken } = yield* assistant(() => undefined)
        yield* reading("yapd", "Yapd. The PR is ready.")
        yield* wait(10)
        yield* answering("The PR changes the microphone buffer.")
        yield* dictate("Say that again.")
        return spoken()
      }),
    )
    expect(result).toEqual(["The PR changes the microphone buffer."])
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
        yield* prepare(1, 1)
        const held = yield* questions()[0]!.stale
        yield* wait(5)
        const during = spoken().length
        // ...and cancels, so it's waited on again, and asked a minute later.
        yield* nothing(1)
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

  test("a dictation pressed before yapd was turned off and on is neither worked out nor acted on, however late it's handed on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { prepare, heard, nothing, toggle, wait, started, seen, spoken, questions, journal } = yield* assistant((situation) =>
          situation.utterance.heard === "Fix the loader in yapd."
            ? Brain.decision({ act: "start", text: situation.utterance.heard })
            : Brain.decision({ act: "clarify", target: handle(situation, tezos), others: handle(situation, mina), sure: "low" }),
        )
        yield* prepare(1, 1)
        yield* toggle(false)
        yield* toggle(true)
        // He asks something once it's on again, which yapd asks him about.
        yield* heard({ heard: "What's the status on the migration one?", via: "shortcut", at: now, voiced: 3, turns: 3 })
        // A press from before is only handed on now, which holds nothing up...
        yield* prepare(2, 1)
        const before = yield* questions()[0]!.stale
        // ...unlike his press to answer it, which its dictation coming to nothing doesn't let go of.
        yield* prepare(3, 3)
        yield* nothing(2)
        const held = yield* questions()[0]!.stale
        // And what he said before, which would start work.
        const taken = yield* heard({ heard: "Fix the loader in yapd.", via: "shortcut", at: now, voiced: 3, turns: 1 }, 1)
        yield* wait(5)
        const noted = yield* journal.since(0, { kinds: ["dictation"] })
        return {
          before,
          held,
          taken,
          asked: seen.map(({ utterance }) => utterance.heard),
          noted: noted.map(({ text }) => text),
          started: started.length,
          spoken: spoken(),
        }
      }),
    )
    expect(result.before).toBe(false)
    expect(result.held).toBe(true)
    expect(result.taken).toEqual(Option.none())
    expect(result.asked).toEqual(["What's the status on the migration one?"])
    expect(result.noted).toEqual(["What's the status on the migration one?"])
    expect(result.started).toBe(0)
    expect(result.spoken).toEqual(["Migrate Tezos Integration or Open Mina SSV2 Bug Tickets, sir?"])
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

  test("asked for again while yapd still reads through the project first, it's already under way and starts once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, wait, spoken, started, seen } = yield* assistant(
          (situation) =>
            situation.lately.some(({ kind }) => kind === "started")
              ? Brain.decision({ act: "answer", spoken: "The loader fix is already under way, sir." })
              : Brain.decision({ act: "start", text: situation.utterance.heard }),
          () => written({ action: "research", spoken: "Looking through yapd first." }),
          { researching: 10 },
        )
        yield* dictate("Fix the loader in yapd.")
        // Said again halfway through the reading.
        yield* wait(5)
        yield* dictate("Fix the loader in yapd.")
        yield* wait(5)
        return { told: seen[1]!.lately.map(({ kind, said }) => [kind, said]), spoken: spoken(), started: started.map(({ project }) => project) }
      }),
    )
    expect(result.told).toContainEqual(["started", "Starting the loader fix, once I've read through yapd."])
    expect(result.spoken).toEqual([
      "Looking through yapd first.",
      "The loader fix is already under way, sir.",
      "Started in yapd, on Claude Opus 5.5, without a worktree.",
    ])
    expect(result.started).toEqual(["/code/yapd"])
  })

  test("turned off as soon as he's told it reads through the project first, before the reading has begun, nothing starts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { heard, toggle, wait, spoken, started } = yield* assistant(
          (situation) => Brain.decision({ act: "start", text: situation.utterance.heard }),
          () => written({ action: "research", spoken: "Looking through yapd first." }),
          { researching: 5 },
        )
        yield* heard({ heard: "Fix the loader in yapd.", via: "typed", at: now, voiced: 3, turns: 1 })
        yield* toggle(false)
        yield* wait(10)
        return { spoken: spoken(), started: started.map(({ project }) => project) }
      }),
    )
    expect(result.spoken).toEqual(["Looking through yapd first."])
    expect(result.started).toEqual([])
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

  test("\"it\" in a dictation is what was being read as its shortcut was pressed, however long it took to say and hear, with the next press waiting", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { prepare, heard, reading, wait, seen } = yield* assistant(() => Brain.decision({ act: "answer", spoken: "It's comparing fee tables, sir." }))
        yield* reading("integration-connectors", "Integration-connectors. The Mina tickets are filed.")
        yield* prepare(1, 1)
        // He talks for nearly five minutes, then presses the shortcut again over the next update while the first is transcribed, which takes a while.
        yield* wait(290)
        yield* reading("integration", "Integration. The Tezos migration is comparing request formats.")
        yield* prepare(2, 1)
        yield* wait(100)
        yield* heard({ heard: "What is it doing?", via: "shortcut", at: now + 390_000, voiced: 250, turns: 1 }, 1)
        yield* heard({ heard: "Tell me more about it.", via: "shortcut", at: now + 390_000, voiced: 3, turns: 1 }, 2)
        return seen.map(({ subject }) => (subject._tag === "Nothing" ? "nothing" : subject.said))
      }),
    )
    expect(result).toEqual(["Integration-connectors. The Mina tickets are filed.", "Integration. The Tezos migration is comparing request formats."])
  })

  test("work T3 Code is still getting ready when yapd is turned off and on is still under way, so asking for it again doesn't start it twice", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, heard, toggle, wait, spoken, started, journal } = yield* assistant(
          (situation) =>
            situation.lately.some(({ kind }) => kind === "started")
              ? Brain.decision({ act: "answer", spoken: "The loader fix is already under way, sir." })
              : Brain.decision({ act: "start", text: situation.utterance.heard }),
          () => written({}),
          { launching: 10 },
        )
        yield* dictate("Fix the loader in yapd.")
        yield* toggle(false)
        yield* toggle(true)
        // Asked for again, typed, before T3 Code has the first one ready.
        yield* wait(5)
        yield* heard({ heard: "Fix the loader in yapd.", via: "typed", at: now + 5_000, voiced: 3, turns: 3 })
        yield* wait(10)
        const kept = yield* journal.since(0, { kinds: ["started"] })
        return { spoken: spoken(), started: started.map(({ project }) => project), kept: kept.map(({ thread }) => thread) }
      }),
    )
    // Turned off since it was asked for, it isn't said when it's ready, only noted.
    expect(result.spoken).toEqual(["The loader fix is already under way, sir."])
    expect(result.started).toEqual(["/code/yapd"])
    expect(result.kept).toEqual(["new-thread"])
  })

  test("what he missed counts as heard once he's heard the catch-up to the end, so one cut off leaves it for the next", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, play, cut, spoken, seen, journal } = yield* assistant(
          (situation) =>
            Brain.decision({ act: "answer", how: "missed", spoken: situation.unheard.length === 0 ? "Nothing new, sir." : "The loader fix is ready, sir." }),
          undefined,
          { waiting: true },
        )
        const unheard = Effect.map(journal.unheard(0, 12), (missed) => missed.map(({ said }) => said))
        yield* journal.write({ at: now - 60_000, kind: "update", project: "yapd", said: "yapd. The loader fix is ready." })
        // Asked while something else is being said, so the answer waits its turn...
        yield* dictate("What did I miss?")
        const waiting = yield* unheard
        // ...and a dictation cuts it off as it starts.
        yield* cut()
        const cutOff = yield* unheard
        yield* dictate("What did I miss?")
        const told = seen[1]!.unheard.map(({ said }) => said)
        yield* play()
        return { waiting, cutOff, told, after: yield* unheard, spoken: spoken() }
      }),
    )
    expect(result.waiting).toEqual(["yapd. The loader fix is ready."])
    expect(result.cutOff).toEqual(["yapd. The loader fix is ready."])
    expect(result.told).toEqual(["yapd. The loader fix is ready."])
    expect(result.after).toEqual([])
    expect(result.spoken).toEqual(["The loader fix is ready, sir.", "The loader fix is ready, sir."])
  })

  test("a cough taken for \"Thank you.\" doesn't count as him speaking, so it hides nothing from what he missed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { heard, dictate, seen, journal } = yield* assistant((situation) =>
          Brain.decision({ act: "answer", how: "missed", spoken: situation.unheard.length === 0 ? "Nothing new, sir." : "The loader fix is ready, sir." }),
        )
        yield* journal.write({ at: now - 60_000, kind: "update", project: "yapd", said: "yapd. The loader fix is ready." })
        yield* heard({ heard: "Thank you.", via: "shortcut", at: now, voiced: 0.2, turns: 1 })
        yield* dictate("What did I miss?")
        return seen.at(-1)!.unheard.map(({ said }) => said)
      }),
    )
    expect(result).toEqual(["yapd. The loader fix is ready."])
  })

  test("a request waiting its turn behind another when yapd is turned off and on is neither worked out nor noted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { heard, toggle, wait, seen, journal } = yield* assistant(
          (situation) =>
            situation.utterance.heard === "Fix the loader in yapd."
              ? Brain.decision({ act: "start", text: situation.utterance.heard })
              : Brain.decision({ act: "answer", spoken: "Four on the go, sir." }),
          undefined,
          { writing: 10 },
        )
        // Starting work takes a while to write up, and the next request waits for it.
        yield* Effect.fork(heard({ heard: "Fix the loader in yapd.", via: "typed", at: now, voiced: 0, turns: 1 }))
        yield* wait(1)
        const waiting = yield* Effect.fork(heard({ heard: "What's going on?", via: "typed", at: now, voiced: 0, turns: 1 }))
        yield* wait(1)
        yield* toggle(false)
        yield* toggle(true)
        yield* wait(12)
        const taken = yield* Fiber.join(waiting)
        const noted = yield* journal.since(0, { kinds: ["dictation"] })
        return { taken, asked: seen.map(({ utterance }) => utterance.heard), noted: noted.map(({ text }) => text) }
      }),
    )
    expect(result.taken).toEqual(Option.none())
    expect(result.asked).not.toContain("What's going on?")
    expect(result.noted).not.toContain("What's going on?")
  })

  test("a catch-up told on a second look is one too: cut off, what it told him is told again, and heard once it's heard to the end", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, play, cut, spoken, seen, journal } = yield* assistant(
          (situation) =>
            Option.isNone(situation.second)
              ? Brain.decision({ act: "find", how: "journal", text: "loader" })
              : Brain.decision({ act: "answer", how: "missed", spoken: situation.unheard.length === 0 ? "Nothing new, sir." : "The loader fix is ready, sir." }),
          undefined,
          { waiting: true },
        )
        const unheard = Effect.map(journal.unheard(0, 12), (missed) => missed.map(({ said }) => said))
        yield* journal.write({ at: now - 60_000, kind: "update", project: "yapd", said: "yapd. The loader fix is ready." })
        // Put the way the model has to look up, so it's told on a second look, and cut off as it starts.
        yield* dictate("Anything happen to the loader while I was out?")
        yield* cut()
        const cutOff = yield* unheard
        yield* dictate("Anything happen to the loader while I was out?")
        const told = seen[2]!.unheard.map(({ said }) => said)
        yield* play()
        return { cutOff, told, after: yield* unheard, spoken: spoken() }
      }),
    )
    expect(result.cutOff).toEqual(["yapd. The loader fix is ready."])
    expect(result.told).toEqual(["yapd. The loader fix is ready."])
    expect(result.after).toEqual([])
    expect(result.spoken).toEqual(["The loader fix is ready, sir.", "The loader fix is ready, sir."])
  })

  test("a catch-up said again is one too: cut off, what it told him is told again, and heard once he's heard it again to the end", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, play, cut, spoken, seen, journal } = yield* assistant(
          (situation) =>
            Brain.decision({ act: "answer", how: "missed", spoken: situation.unheard.length === 0 ? "Nothing new, sir." : "The loader fix is ready, sir." }),
          undefined,
          { waiting: true },
        )
        const unheard = Effect.map(journal.unheard(0, 12), (missed) => missed.map(({ said }) => said))
        yield* journal.write({ at: now - 60_000, kind: "update", project: "yapd", said: "yapd. The loader fix is ready." })
        // The catch-up is cut off as it starts, and so is hearing it again.
        yield* dictate("What did I miss?")
        yield* cut()
        yield* dictate("Say that again.")
        yield* cut()
        const cutOff = yield* unheard
        yield* dictate("What did I miss?")
        const told = seen.at(-1)!.unheard.map(({ said }) => said)
        // Cut off too, then heard again to the end.
        yield* cut()
        yield* dictate("Say that again.")
        yield* play()
        return { cutOff, told, after: yield* unheard, spoken: spoken() }
      }),
    )
    expect(result.cutOff).toEqual(["yapd. The loader fix is ready."])
    expect(result.told).toEqual(["yapd. The loader fix is ready."])
    expect(result.after).toEqual([])
    expect(result.spoken).toEqual([
      "The loader fix is ready, sir.",
      "The loader fix is ready, sir.",
      "The loader fix is ready, sir.",
      "The loader fix is ready, sir.",
    ])
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
})
