import { describe, expect, test } from "bun:test"
import { Clock, Effect, Either, Option, Queue, type Scope, TestClock, TestContext } from "effect"
import * as Drafts from "./Drafts.ts"
import type { Notice } from "./Inbox.ts"
import { type Catalog, LaunchError, type Request, type Started } from "./Launcher.ts"
import type { Delivery, Outbox } from "./Outbox.ts"
import * as Recent from "./Recent.ts"
import type { Heard } from "./Recent.ts"
import type { Records } from "./Records.ts"
import { ReportError, Reporter, type Reporting, type Summarizing } from "./Reporter.ts"
import * as Research from "./Research.ts"
import { type Known, type Listed, type Threads, ThreadsError } from "./Threads.ts"
import { type Decision, type Material, type Written, WriteError, Writer } from "./Writer.ts"

const models: Catalog["models"] = [
  { name: "claude-fable-5-1", title: "Claude Fable 5.1", aliases: ["fable"], efforts: ["low", "high"] },
  { name: "claude-opus-5-5", title: "Claude Opus 5.5", aliases: ["opus-5.5"], efforts: ["low", "high", "xhigh"] },
  { name: "gpt-6-sol", title: "GPT-6-Sol", aliases: [], efforts: ["low", "high"] },
]

const project = (name: string, path: string, last: string, worked: string): Catalog["projects"][number] => ({
  name,
  path,
  repository: true,
  branch: "main",
  worktree: true,
  model: { name: last, effort: "high" },
  recent: [{ title: "Fix the loader", date: worked }],
})

const rosie: Catalog = {
  projects: [
    project("yapd", "/code/yapd", "claude-fable-5-1", "2026-09-29T10:00:00.000Z"),
    project("std", "/code/std", "claude-opus-5-5", "2026-09-28T10:00:00.000Z"),
    { ...project("notes", "/code/notes", "gpt-6-sol", "2026-09-20T10:00:00.000Z"), repository: false, worktree: false },
  ],
  models,
}

const rig: Catalog = {
  projects: [project("trainer", "/home/me/trainer", "gpt-6-sol", "2026-09-29T09:00:00.000Z"), project("yapd", "/home/me/yapd", "gpt-6-sol", "2026-09-01T10:00:00.000Z")],
  models,
}

const decision = (overrides: Partial<Decision>): Decision => ({
  action: "start",
  about: "the loader fix",
  settled: "named",
  evidence: "loader",
  project: "yapd",
  machine: "rosie",
  model: "claude-fable-5-1",
  effort: "high",
  worktreeFrom: "last used",
  worktree: true,
  branch: "",
  thread: "",
  threadFrom: "unclear",
  threadEvidence: "",
  description: "Fix the loader in yapd so that it streams.",
  why: "They named yapd.",
  prompt: "Fix the loader.",
  spoken: "Started in yapd, on Fable, in a worktree.",
  ...overrides,
})

/** A message or a question about a listed thread, settled by the user's own words. */
const addressed = (action: "message" | "summary", thread: string, threadEvidence: string, prompt = ""): Decision =>
  decision({ action, about: "the latency one", settled: "unclear", evidence: "", project: "", machine: "", description: "", thread, threadFrom: "named", threadEvidence, prompt, spoken: "" })

const at = "2026-09-30T10:00:00.000Z"

const listed = (id: string, overrides: Partial<Listed>): Listed => ({
  id,
  project: "yapd",
  directory: "/code/yapd",
  title: `Thread ${id}`,
  branch: null,
  state: "done",
  needs: [],
  requestedAt: null,
  completedAt: null,
  updatedAt: at,
  error: null,
  ...overrides,
})

const rosieThreads = [
  listed("a1", { title: "Reduce latency", state: "waiting", needs: ["approval"] }),
  listed("b2", { project: "std", directory: "/code/std", title: "Redis investigation", state: "running" }),
]
const rigThreads = [listed("c3", { project: "trainer", directory: "/home/me/trainer", title: "Stream the eval loader" })]

/** What yapd knew before: the thread it started itself. */
const latency: Known = {
  machine: "rosie",
  id: "a1",
  prompt: "Find out why updates take so long to be read out.",
  dictated: "why are updates so slow",
  description: "Measure where the time goes in yapd.",
  started: true,
  at,
}

/** Machines whose threads are never asked about. */
const noThreads: Threads = {
  list: Effect.die("not listed"),
  detail: () => Effect.die("not read"),
  opening: () => Effect.die("not read"),
  send: () => Effect.die("sent past the outbox"),
}

/**
 * Runs drafts against a writer that decides what the test says, launchers that
 * record what they're asked to start, and a clock the test moves.
 */
const drafts = (
  decide: (material: Material) => Decision | undefined,
  options: {
    readonly written?: Written
    readonly refuse?: string
    readonly rigDown?: boolean
    /** Why rig's threads can't be listed, when they can't. */
    readonly rigUnlisted?: string
    /** How the outbox answers every send. */
    readonly outbox?: Delivery | ThreadsError
    /** What T3 Code lists on rosie. */
    readonly rosie?: ReadonlyArray<Listed>
    /** What the user heard before, like an agent's update. */
    readonly heard?: ReadonlyArray<Heard>
  } = {},
) =>
  Effect.gen(function* () {
    /** What the user has heard. Every notice plays as soon as it's told. */
    let recent = (options.heard ?? []).reduce((recent, heard) => Recent.heard(Recent.add(recent, heard, heard.at), heard.id, heard.at), Recent.empty)
    const started: Array<{ readonly machine: string; readonly request: Request }> = []
    const said: Array<Notice> = []
    const notices = yield* Queue.unbounded<Notice>()
    const asked: Array<Material> = []
    const researched: Array<{ readonly machine: string; readonly directory: string }> = []
    const catalogs: Array<string> = []
    /** Which machines' threads were listed, in order. */
    const listings: Array<string> = []
    const noted: Array<Heard> = []
    const sent: Array<{ readonly machine: string; readonly thread: Listed; readonly text: string }> = []
    const remembered: Array<Known> = []
    const openings: Array<string> = []
    const summaries: Array<Summarizing> = []
    const reports: Array<Reporting> = []
    const known = new Map<string, Known>([["rosie/a1", latency]])
    const records: Records = {
      remember: (thread) =>
        Effect.sync(() => {
          remembered.push(thread)
          known.set(`${thread.machine}/${thread.id}`, thread)
        }),
      recall: (machine, ids) => Effect.succeed(new Map(ids.flatMap((id) => (known.has(`${machine}/${id}`) ? [[id, known.get(`${machine}/${id}`)!]] : [])))),
    }
    const outbox: Outbox = {
      send: (machine, thread, text) =>
        Effect.suspend(() => {
          sent.push({ machine, thread, text })
          const answer: Delivery | ThreadsError = options.outbox ?? { _tag: "Sent" }
          return answer instanceof ThreadsError ? Effect.fail(answer) : Effect.succeed(answer)
        }),
    }
    /** What T3 Code lists on each machine, which can change between a question and its answer. */
    const lists = new Map<string, Array<Listed>>([
      ["rosie", [...(options.rosie ?? rosieThreads)]],
      ["rig", [...rigThreads]],
    ])
    const threads = (machine: string): Threads => ({
      list: Effect.sync(() => void listings.push(machine)).pipe(
        Effect.flatMap(() =>
          machine === "rig" && options.rigUnlisted !== undefined ? Effect.fail(new ThreadsError({ reason: options.rigUnlisted })) : Effect.succeed([...(lists.get(machine) ?? [])]),
        ),
      ),
      detail: (id) => {
        const thread = lists.get(machine)?.find((thread) => thread.id === id)
        return thread === undefined
          ? Effect.fail(new ThreadsError({ reason: "That thread is gone.", gone: true }))
          : Effect.succeed({
              thread,
              messages: [
                { role: "user" as const, text: "Find the slow part.", at },
                { role: "assistant" as const, text: "It's the echo canceller warming up.", at },
              ],
            })
      },
      opening: (id) => Effect.sync(() => void openings.push(`${machine}/${id}`)).pipe(Effect.as(`What ${id} started as.`)),
      send: () => Effect.die("sent past the outbox"),
    })
    const launcher = (machine: string, catalog: Catalog) => ({
      catalog: Effect.sync(() => void catalogs.push(machine)).pipe(
        Effect.zipRight(machine === "rig" && options.rigDown === true ? Effect.fail(new LaunchError({ reason: "I can't reach rig." })) : Effect.succeed(catalog)),
      ),
      start: (request: Request) =>
        Effect.gen(function* () {
          started.push({ machine, request })
          if (options.refuse !== undefined) return yield* new LaunchError({ reason: options.refuse })
          return {
            thread: "thread-1",
            project: catalog.projects.find(({ path }) => path === request.project)?.name ?? request.project,
            directory: request.project,
            branch: null,
            model: request.model ?? "claude-fable-5-1",
            worktree: request.worktree === true,
          } satisfies Started
        }),
    })
    const researcher = (machine: string): Research.Researcher => ({
      available: true,
      research: ({ directory }) => Effect.sync(() => void researched.push({ machine, directory })).pipe(Effect.as({})),
    })
    const made = yield* Drafts.make({
      machines: [
        { name: "rosie", here: true, hosts: ["Rosie.local"], launcher: launcher("rosie", rosie), researcher: researcher("rosie"), threads: threads("rosie") },
        { name: "rig", here: false, hosts: ["rig"], launcher: launcher("rig", rig), researcher: researcher("rig"), threads: threads("rig") },
      ],
      rules: Effect.succeed(Option.some("Fable on high for hard bugs.")),
      recent: (at) => Effect.sync(() => Recent.heardBy(recent, at)),
      note: (heard) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          noted.push(heard)
          recent = Recent.add(recent, heard, now)
        }),
      tell: (notice) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          said.push(notice)
          recent = Recent.heard(recent, notice.id, now)
        }).pipe(Effect.zipRight(Queue.offer(notices, notice)), Effect.asVoid),
      records,
      outbox,
    }).pipe(
      Effect.provideService(Reporter, {
        summarize: (input) => Effect.sync(() => void summaries.push(input)).pipe(Effect.as({ spoken: `${input.detail.thread.title} is waiting on you.` })),
        report: (input) =>
          input.question.includes("broken")
            ? Effect.fail(new ReportError({ cause: "The model is down" }))
            : Effect.sync(() => void reports.push(input)).pipe(Effect.as({ spoken: "Nobody needs you." })),
      }),
      Effect.provideService(Writer, {
        decide: (material) =>
          Effect.suspend(() => {
            asked.push(material)
            const decided = decide(material)
            return decided === undefined ? Effect.fail(new WriteError({ cause: "The model is down" })) : Effect.succeed(decided)
          }),
        research: (_, destination, researcher) =>
          researcher.research({ directory: destination.directory, prompt: destination.lookFor, schema: {} }).pipe(
            Effect.mapError((cause) => new WriteError({ cause })),
            Effect.zipRight(options.written === undefined ? Effect.fail(new WriteError({ cause: "Nothing written" })) : Effect.succeed(options.written)),
          ),
        prepare: Effect.void,
      }),
    )
    // Lets the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    const wait = (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush))
    /** Sends a dictation, pressed at `startedAt` when that was earlier than now. */
    const dictate = (heard: string, startedAt?: number) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => made.dictated({ heard, startedAt: startedAt ?? now })).pipe(Effect.zipRight(flush))
    /** Reads something out now, as the daemon does once a dictation lets go of the speaker. */
    const hear = (heard: Heard) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        recent = Recent.heard(Recent.add(recent, heard, now), heard.id, now)
      })
    /** Reads something out again now, as the daemon does with what a dictation cut off. */
    const replay = (id: string) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        recent = Recent.heard(recent, id, now)
      })
    const questions = () => said.filter(({ question }) => question !== undefined)
    /** Answers the latest question as the conversation does: worked out first, then taken in. */
    const answer = (heard: string, to = questions().at(-1)) =>
      Effect.gen(function* () {
        const taken = yield* to!.question!.answer(heard)
        if (Option.isSome(taken)) yield* taken.value
        yield* flush
        return Option.isSome(taken)
      })
    const unanswered = (to = questions().at(-1)) => to!.question!.unanswered.pipe(Effect.zipRight(flush))
    const spoken = () => said.map(({ spoken }) => spoken)
    /** A thread T3 Code lists on `machine` from now on. */
    const appears = (machine: string, thread: Listed) => Effect.sync(() => void lists.get(machine)?.push(thread))
    return { ...made, dictate, hear, replay, answer, unanswered, appears, wait, flush, nextNotice: Queue.take(notices), started, said, spoken, questions, asked, researched, catalogs, listings, noted, sent, remembered, openings, summaries, reports }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Drafts", () => {
  test("starts what the user said where they said, and says what it did", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, said } = yield* drafts(() =>
          decision({ model: "opus-5.5", effort: "XHigh", worktree: false, branch: "release", spoken: "Started in yapd, on Opus, without a worktree." }),
        )
        yield* dictate("In yapd, fix the loader, with Opus on extra high, no worktree, off the release branch.")
        return { started, said }
      }),
    )
    expect(result.started).toEqual([
      {
        machine: "rosie",
        request: { project: "/code/yapd", prompt: "Fix the loader.", model: "claude-opus-5-5", effort: "xhigh", worktree: false, baseBranch: "release" },
      },
    ])
    expect(result.said.map(({ spoken, priority }) => ({ spoken, priority }))).toEqual([
      { spoken: "Started in yapd, on Opus, without a worktree.", priority: "done" },
    ])
  })

  test("sends work to the machine the project is on, and to where it was worked on last when it's on several", () => {
    const listings = [
      { machine: "rosie", here: true, hosts: [], catalog: Option.some(rosie) },
      { machine: "rig", here: false, hosts: [], catalog: Option.some(rig) },
    ]
    const machines = listings.map(({ machine, here }) => ({
      name: machine,
      here,
      hosts: [],
      launcher: { start: () => Effect.die("not started"), catalog: Effect.die("not asked") },
      researcher: Research.unavailable("not here"),
      threads: noThreads,
    }))
    const where = (overrides: Partial<Decision>) =>
      Either.map(Drafts.resolve(machines, listings, decision(overrides)), ({ machine, request }) => [machine.name, request.project])
    expect(where({ project: "trainer", machine: "" })).toEqual(Either.right(["rig", "/home/me/trainer"]))
    expect(where({ project: "yapd", machine: "Rig" })).toEqual(Either.right(["rig", "/home/me/yapd"]))
    expect(where({ project: "yapd", machine: "" })).toEqual(Either.right(["rosie", "/code/yapd"]))
    // Not there, whatever the writer says.
    expect(where({ project: "trainer", machine: "rosie" })).toEqual(Either.right(["rig", "/home/me/trainer"]))
    expect(where({ project: "notes", worktree: true })).toMatchObject(Either.right(["rosie", "/code/notes"]))
    expect(Either.getOrThrow(Drafts.resolve(machines, listings, decision({ project: "notes", worktree: true }))).request.worktree).toBe(false)
    // What the project last used, when the writer names a model that isn't there.
    const made = decision({ project: "STD", machine: "", model: "claude-made-up", effort: "ludicrous" })
    expect(Either.getOrThrow(Drafts.resolve(machines, listings, made)).request).toMatchObject({ project: "/code/std", model: "claude-opus-5-5", effort: "high" })
  })

  test("asks rather than start in a project that isn't there", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, said } = yield* drafts(() => decision({ project: "billing", about: "the invoice retry" }))
        yield* dictate("In billing, add a retry to the invoice webhook.")
        return { started, said }
      }),
    )
    expect(result.started).toEqual([])
    expect(result.said.map(({ spoken, priority }) => ({ spoken, priority }))).toEqual([
      { spoken: "Which project is the invoice retry for?", priority: "needs-you" },
    ])
    expect(result.said[0]?.question).toBeDefined()
  })

  test("asks when the project is unclear, and starts once the user has answered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, started, spoken, asked } = yield* drafts(({ lines }) =>
          lines.length === 1
            ? decision({ action: "ask", project: "", prompt: "", spoken: "For the loader fix, is that yapd or std?" })
            : decision({ project: "std", spoken: "Started in std, on Fable, in a worktree." }),
        )
        yield* dictate("Fix the loader.")
        const before = [...started]
        const taken = yield* answer("Std.")
        return { before, taken, started, spoken: spoken(), lines: asked.at(-1)?.lines }
      }),
    )
    expect(result.before).toEqual([])
    expect(result.taken).toBe(true)
    expect(result.started.map(({ request }) => request.project)).toEqual(["/code/std"])
    expect(result.spoken).toEqual(["For the loader fix, is that yapd or std?", "Started in std, on Fable, in a worktree."])
    expect(result.lines).toEqual([
      { speaker: "user", text: "Fix the loader." },
      { speaker: "yapd", text: "For the loader fix, is that yapd or std?" },
      { speaker: "user", text: "Std." },
    ])
  })

  test("asks once more, later, when nobody answers, then drops it and says so", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, unanswered, wait, started, spoken, questions } = yield* drafts(() =>
          decision({ action: "ask", project: "", prompt: "", spoken: "For the loader fix, is that yapd or std?" }),
        )
        yield* dictate("Fix the loader.")
        yield* unanswered()
        yield* wait(59)
        const soon = questions().length
        yield* wait(1)
        const later = questions().length
        yield* unanswered()
        yield* wait(120)
        return { soon, later, started, spoken: spoken(), stale: yield* questions()[0]!.stale }
      }),
    )
    expect(result.soon).toBe(1)
    expect(result.later).toBe(2)
    expect(result.started).toEqual([])
    expect(result.spoken).toEqual([
      "For the loader fix, is that yapd or std?",
      "For the loader fix, is that yapd or std?",
      "I didn't hear back about the loader fix, so I dropped it.",
    ])
    // Nothing is left to ask about.
    expect(result.stale).toBe(true)
  })

  test("drops it when the user calls it off, and keeps asking when what they said wasn't an answer", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, started, spoken } = yield* drafts(({ lines }) =>
          lines.length === 1
            ? decision({ action: "ask", project: "", prompt: "", spoken: "Which project is the loader fix for?" })
            : lines.at(-1)?.text === "Never mind."
              ? decision({ action: "drop", project: "", prompt: "", spoken: "Dropped." })
              : decision({ action: "wait", project: "", prompt: "", spoken: "" }),
        )
        yield* dictate("Fix the loader.")
        const unrelated = yield* answer("Dinner's ready!")
        const afterUnrelated = spoken().length
        const calledOff = yield* answer("Never mind.")
        return { unrelated, afterUnrelated, calledOff, started, spoken: spoken() }
      }),
    )
    expect(result.unrelated).toBe(false)
    expect(result.afterUnrelated).toBe(1)
    expect(result.calledOff).toBe(true)
    expect(result.started).toEqual([])
    expect(result.spoken).toEqual(["Which project is the loader fix for?", "Dropped."])
  })

  test("takes an answer to the draft that asked, among several", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, started, questions } = yield* drafts(({ lines }) => {
          const about = lines[0]!.text.includes("loader") ? "the loader fix" : "the retry"
          return lines.length === 1
            ? decision({ action: "ask", about, project: "", prompt: "", spoken: `Which project is ${about} for?` })
            : decision({ about, evidence: lines.at(-1)!.text, project: lines.at(-1)!.text, prompt: lines[0]!.text })
        })
        yield* dictate("Fix the loader.")
        yield* dictate("Add a retry.")
        const [loader, retry] = questions()
        // Answered in the other order.
        yield* answer("std", retry)
        yield* answer("yapd", loader)
        return started.map(({ request }) => [request.project, request.prompt])
      }),
    )
    expect(result).toEqual([
      ["/code/std", "Add a retry."],
      ["/code/yapd", "Fix the loader."],
    ])
  })

  test("says it's reading the project before it does, where the project is", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, said, researched } = yield* drafts(
          () => decision({ action: "research", project: "trainer", machine: "rig", prompt: "What the eval loader does.", spoken: "Looking through trainer first." }),
          { written: { action: "start", why: "Read the loader.", prompt: "Make the eval loader stream.", spoken: "Started in trainer on rig, on Fable, in a worktree." } },
        )
        yield* dictate("In trainer, do the streaming thing for the eval loader.")
        return { started, researched, said: said.map(({ spoken, priority }) => ({ spoken, priority })), stale: yield* said[0]!.stale }
      }),
    )
    expect(result.researched).toEqual([{ machine: "rig", directory: "/home/me/trainer" }])
    expect(result.said).toEqual([
      { spoken: "Looking through trainer first.", priority: "needs-you" },
      { spoken: "Started in trainer on rig, on Fable, in a worktree.", priority: "done" },
    ])
    // Not worth saying any more, if it hadn't been yet.
    expect(result.stale).toBe(true)
    expect(result.started).toEqual([
      { machine: "rig", request: { project: "/home/me/trainer", prompt: "Make the eval loader stream.", model: "claude-fable-5-1", effort: "high", worktree: true } },
    ])
  })

  test("writes from what the user said when the project can't be read", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, spoken, asked } = yield* drafts(({ research }) =>
          research ? decision({ action: "research", prompt: "What the loader does.", spoken: "Looking through yapd first." }) : decision({}),
        )
        yield* dictate("In yapd, do the streaming thing for the loader.")
        return { started, spoken: spoken(), research: asked.map(({ research }) => research) }
      }),
    )
    expect(result.research).toEqual([true, false])
    expect(result.started.map(({ request }) => request.prompt)).toEqual(["Fix the loader."])
    expect(result.spoken).toEqual(["Looking through yapd first.", "Started in yapd, on Fable, in a worktree. I couldn't read through it first."])
  })

  test("resolves the fallback decision again when reading the project fails", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, nextNotice, started } = yield* drafts(({ research }) =>
          research
            ? decision({ action: "research", evidence: "yapd", spoken: "Looking through yapd first." })
            : decision({
                project: "std",
                evidence: "std",
                model: "opus-5.5",
                effort: "XHigh",
                worktree: false,
                prompt: "Fix the loader in std.",
                spoken: "Started in std, on Opus, without a worktree.",
              }),
        )
        yield* dictate("In yapd, compare the loader with std and fix it.")
        yield* nextNotice
        const notice = yield* nextNotice
        return { started, spoken: notice.spoken }
      }),
    )
    expect(result.started).toEqual([
      {
        machine: "rosie",
        request: { project: "/code/std", prompt: "Fix the loader in std.", model: "claude-opus-5-5", effort: "xhigh", worktree: false },
      },
    ])
    expect(result.spoken).toBe("Started in std, on Opus, without a worktree. I couldn't read through it first.")
  })

  test.each([
    { project: "std", evidence: "words they never said" },
    { project: "billing", evidence: "billing" },
  ])("asks when a research fallback isn't a valid grounded destination: $project / $evidence", async (fallback) => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, nextNotice, started } = yield* drafts(({ research }) =>
          research
            ? decision({ action: "research", evidence: "yapd", spoken: "Looking through yapd first." })
            : decision({ ...fallback, prompt: "Fix the loader." }),
        )
        yield* dictate("In yapd, compare the loader with billing and fix it.")
        yield* nextNotice
        const question = yield* nextNotice
        return { started, spoken: question.spoken, question: question.question !== undefined }
      }),
    )
    expect(result.started).toEqual([])
    expect(result.spoken).toBe("Which project is the loader fix for?")
    expect(result.question).toBe(true)
  })

  test("says what really started when that's not what was asked", () => {
    const resolved = Either.getOrThrow(
      Drafts.resolve(
        [{ name: "rig", here: false, hosts: [], launcher: { start: () => Effect.die(""), catalog: Effect.die("") }, researcher: Research.unavailable(""), threads: noThreads }],
        [{ machine: "rig", here: false, hosts: [], catalog: Option.some(rig) }],
        decision({ project: "trainer", machine: "rig" }),
      ),
    )
    const started: Started = { thread: "t", project: "trainer", directory: "/home/me/trainer", branch: "main", model: "claude-fable-5-1", worktree: true }
    expect(Drafts.confirmation("Started in trainer, in a worktree.", resolved, started)).toBe("Started in trainer, in a worktree.")
    expect(Drafts.confirmation("Started in trainer, in a worktree.", resolved, { ...started, worktree: false, warning: "It isn't in a worktree, since git wouldn't make one." })).toBe(
      "Started in trainer on rig, on Claude Fable 5.1, without a worktree. It isn't in a worktree, since git wouldn't make one.",
    )
    expect(Drafts.confirmation("", resolved, started)).toBe("Started in trainer on rig, on Claude Fable 5.1, in a worktree.")
  })

  test("always says whether there's a worktree, and when it couldn't tell which the user wanted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, spoken } = yield* drafts(() =>
          decision({ project: "std", evidence: "std", worktreeFrom: "unclear", worktree: false, spoken: "Started in std, on Fable." }),
        )
        yield* dictate("In std, reply with the single word OK and do nothing else on a work tree.")
        return { worktree: started[0]?.request.worktree, spoken: spoken() }
      }),
    )
    expect(result.worktree).toBe(false)
    expect(result.spoken).toEqual(["Started in std, on Fable. That's without a worktree. I couldn't tell whether you wanted a worktree, so I went by your rules."])
  })

  test("asks rather than start in a project the user neither named nor pointed at", async () => {
    const asked = (overrides: Partial<Decision>) =>
      run(
        Effect.gen(function* () {
          const { dictate, started, spoken } = yield* drafts(() => decision({ about: "the test", ...overrides }))
          yield* dictate("This is a test reply with the word okay and do nothing else.")
          return { started: started.length, spoken: spoken() }
        }),
      )
    const question = { started: 0, spoken: ["Which project is the test for?"] }
    // It looked like the one before, which is a guess.
    expect(await asked({ settled: "unclear", evidence: "" })).toEqual(question)
    // Words they never said.
    expect(await asked({ settled: "named", evidence: "free sound" })).toEqual(question)
    expect(await asked({ settled: "referred", evidence: "" })).toEqual(question)
    expect((await asked({ settled: "subject", evidence: "Reply with the word OKAY" })).started).toBe(1)
  })

  test("says why nothing started, whether the launcher refused or the prompt couldn't be written", async () => {
    const refused = await run(
      Effect.gen(function* () {
        const { dictate, said } = yield* drafts(() => decision({}), { refuse: "T3 Code isn't running." })
        yield* dictate("Fix the loader in yapd.")
        return said.map(({ spoken, priority }) => ({ spoken, priority }))
      }),
    )
    expect(refused).toEqual([{ spoken: "About the loader fix: T3 Code isn't running.", priority: "needs-you" }])
    const unwritten = await run(
      Effect.gen(function* () {
        const { dictate, spoken, started } = yield* drafts(() => undefined)
        yield* dictate("Fix the loader in yapd.")
        return { spoken: spoken(), started }
      }),
    )
    expect(unwritten).toEqual({ spoken: ["I couldn't work that out, so nothing was done. What you said is in my log."], started: [] })
  })

  test("asks every machine what it can start as the shortcut is pressed, and goes on without one that can't say", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { prepare, dictate, flush, catalogs, listings, asked, started, openings, remembered } = yield* drafts(() => decision({}), { rigDown: true })
        yield* prepare
        yield* flush
        const pressed = [...catalogs]
        yield* dictate("Fix the loader in yapd.")
        return {
          pressed,
          catalogs,
          listed: listings.length,
          listings: asked[0]?.listings.map(({ machine, reason }) => [machine, reason]),
          threads: asked[0]?.threads.map(({ machine, threads }) => [machine, threads.map(({ listed, known }) => [listed.id, Option.map(known, ({ prompt }) => prompt)])]),
          started: started.length,
          openings: openings.toSorted(),
          learnt: remembered.filter(({ started }) => !started).map(({ machine, id, prompt }) => [machine, id, prompt]),
        }
      }),
    )
    expect(result.pressed.toSorted()).toEqual(["rig", "rosie"])
    // Not asked again once dictated.
    expect(result.catalogs.length).toBe(2)
    expect(result.listings).toEqual([
      ["rosie", undefined],
      ["rig", "I can't reach rig."],
    ])
    // What the threads yapd didn't start are about is learnt in the background, once, and not for the one it did.
    expect(result.openings).toEqual(["rig/c3", "rosie/b2"])
    // Learnt after the threads were listed, and still there for the writer, without listing them again.
    expect(result.listed).toBe(2)
    expect(result.threads).toEqual([
      ["rosie", [["a1", Option.some(latency.prompt)], ["b2", Option.some("What b2 started as.")]]],
      ["rig", [["c3", Option.some("What c3 started as.")]]],
    ])
    expect(result.learnt.toSorted()).toEqual([
      ["rig", "c3", "What c3 started as."],
      ["rosie", "b2", "What b2 started as."],
    ])
    expect(result.started).toBe(1)
  })

  test("keeps what a thread it started is about, so the user can talk about it later", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, remembered, noted } = yield* drafts(() => decision({}))
        yield* dictate("In yapd, fix the loader.")
        return { remembered: remembered.filter(({ started }) => started), noted }
      }),
    )
    expect(result.remembered).toEqual([
      {
        machine: "rosie",
        id: "thread-1",
        prompt: "Fix the loader.",
        dictated: "In yapd, fix the loader.",
        description: "Fix the loader in yapd so that it streams.",
        started: true,
        at: "1970-01-01T00:00:00.000Z",
      },
    ])
    expect(result.noted.map(({ thread, started }) => ({ thread, started }))).toEqual([{ thread: { machine: "rosie", id: "thread-1" }, started: true }])
  })

  test("sends a message the user's words settle to that thread's machine, and names who got it", async () => {
    const here = await run(
      Effect.gen(function* () {
        const { dictate, sent, said, noted } = yield* drafts(() => addressed("message", "rosie/a1", "latency", "Keep the public API unchanged."))
        yield* dictate("Tell the latency one to keep the public API unchanged.")
        return { sent, said: said.map(({ id, spoken, priority }) => ({ id, spoken, priority })), noted }
      }),
    )
    expect(here.sent).toEqual([{ machine: "rosie", thread: rosieThreads[0]!, text: "Keep the public API unchanged." }])
    expect(here.said.map(({ spoken, priority }) => ({ spoken, priority }))).toEqual([{ spoken: "Sent to Reduce latency in yapd.", priority: "done" }])
    expect(here.noted.map(({ thread, message }) => ({ thread, message }))).toEqual([{ thread: { machine: "rosie", id: "a1" }, message: "Keep the public API unchanged." }])
    // Noted by the notice that reads it out, so it counts as heard when that plays.
    expect(here.noted[0]?.id).toBe(here.said[0]!.id)
    const away = await run(
      Effect.gen(function* () {
        const { dictate, sent, spoken } = yield* drafts(() => addressed("message", "rig/c3", "eval loader", "Stop there."))
        yield* dictate("Tell the eval loader one to stop there.")
        return { sent: sent.map(({ machine, thread }) => [machine, thread.id]), spoken: spoken() }
      }),
    )
    expect(away).toEqual({ sent: [["rig", "c3"]], spoken: ["Sent to Stream the eval loader in trainer on rig."] })
  })

  test("takes \"tell it to\" as the thread it just asked what to tell, once the question has played", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, sent, spoken } = yield* drafts(({ lines }) =>
          lines.length === 1
            ? addressed("message", "rosie/a1", "latency")
            : decision({ action: "message", about: "the latency one", project: "", thread: "rosie/a1", threadFrom: "referred", threadEvidence: "it", prompt: "Keep the API unchanged.", spoken: "" }),
        )
        yield* dictate("Tell the latency one.")
        yield* answer("Tell it to keep the API unchanged.")
        return { sent: sent.map(({ thread, text }) => [thread.id, text]), spoken: spoken() }
      }),
    )
    // The question was noted about the thread, and heard since the request was worked out: what "it" means is settled from now, not then.
    expect(result.spoken).toEqual(["What should I tell Reduce latency?", "Sent to Reduce latency in yapd."])
    expect(result.sent).toEqual([["a1", "Keep the API unchanged."]])
  })

  test("asks which thread rather than send to one the user didn't settle, and sends nothing meanwhile", async () => {
    // The writer picked one, on words the user never said.
    const guessed = await run(
      Effect.gen(function* () {
        const { dictate, sent, spoken, questions } = yield* drafts(() => addressed("message", "rosie/b2", "redis", "Stop there."))
        yield* dictate("Tell it to stop there.")
        return { sent, spoken: spoken(), questions: questions().length }
      }),
    )
    expect(guessed).toEqual({ sent: [], spoken: ["Which thread is that for?"], questions: 1 })
    // Two fit, so the writer asked, naming them.
    const ambiguous = await run(
      Effect.gen(function* () {
        const { dictate, sent, spoken } = yield* drafts(() =>
          decision({ action: "ask", about: "the message", project: "", prompt: "", spoken: "Is that the latency one in yapd, or the redis one in std?" }),
        )
        yield* dictate("Tell it to stop there.")
        return { sent, spoken: spoken() }
      }),
    )
    expect(ambiguous).toEqual({ sent: [], spoken: ["Is that the latency one in yapd, or the redis one in std?"] })
  })

  test("asks, saying why, rather than send to another machine's thread when the one the user named can't be listed", async () => {
    // rosie has a retry fix too, and the writer picked it: the message would go to the wrong machine.
    const result = await run(
      Effect.gen(function* () {
        const { dictate, sent, spoken } = yield* drafts(() => addressed("message", "rosie/r1", "the retry fix on rig", "Stop there."), {
          rosie: [...rosieThreads, listed("r1", { title: "Retry fix" })],
          rigUnlisted: "rig isn't answering.",
        })
        yield* dictate("Tell the retry fix on rig to stop there.")
        return { sent, spoken: spoken() }
      }),
    )
    expect(result).toEqual({ sent: [], spoken: ["I can't see rig's threads right now. rig isn't answering. Which thread is that for?"] })
  })

  test("says a message to a thread mid-turn is held, when it couldn't tell whether one went, and when one couldn't be sent", async () => {
    const held = await run(
      Effect.gen(function* () {
        const { dictate, spoken } = yield* drafts(() => addressed("message", "rosie/b2", "redis", "Look at the cache too."), { outbox: { _tag: "Held" } })
        yield* dictate("Ask the redis one to look at the cache too.")
        return spoken()
      }),
    )
    expect(held).toEqual(["Redis investigation in std is in the middle of a turn, so I'll pass it on when it finishes."])
    // Named without a project when T3 Code has none for it, and noted all the same: it's on its way.
    const pending = await run(
      Effect.gen(function* () {
        const { dictate, said, noted } = yield* drafts(() => addressed("message", "rosie/d4", "untitled", "Look at the cache too."), {
          outbox: { _tag: "Pending", reason: "T3 Code isn't answering." },
          rosie: [listed("d4", { project: "", directory: "", title: "Untitled work" })],
        })
        yield* dictate("Ask the untitled one to look at the cache too.")
        return { said: said.map(({ spoken, priority }) => ({ spoken, priority })), noted: noted.map(({ thread }) => thread) }
      }),
    )
    expect(pending).toEqual({
      said: [{ spoken: "I couldn't tell whether that reached Untitled work: T3 Code isn't answering. I'll keep trying, and it won't arrive twice.", priority: "needs-you" }],
      noted: [{ machine: "rosie", id: "d4" }],
    })
    const refused = await run(
      Effect.gen(function* () {
        const { dictate, said } = yield* drafts(() => addressed("message", "rosie/b2", "redis", "Look at the cache too."), {
          outbox: new ThreadsError({ reason: "T3 Code turned it down." }),
        })
        yield* dictate("Ask the redis one to look at the cache too.")
        return said.map(({ spoken, priority }) => ({ spoken, priority }))
      }),
    )
    expect(refused).toEqual([{ spoken: "About the latency one: I couldn't send that to Redis investigation in std. T3 Code turned it down.", priority: "needs-you" }])
  })

  test("sums up a thread from what T3 Code shows of it, and notes it so the next message can point at it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, said, summaries, noted, sent } = yield* drafts(() => addressed("summary", "rosie/a1", "latency"))
        yield* dictate("Where is the latency one at?")
        return { said: said.map(({ spoken, priority }) => ({ spoken, priority })), summaries, noted, sent }
      }),
    )
    expect(result.summaries.map(({ question, machine, here, detail, known }) => ({ question, machine, here, thread: detail.thread.id, messages: detail.messages.length, known }))).toEqual([
      { question: "Where is the latency one at?", machine: "rosie", here: true, thread: "a1", messages: 2, known: Option.some(latency) },
    ])
    // Waiting on the user, so it's said as needing them.
    expect(result.said).toEqual([{ spoken: "Reduce latency is waiting on you.", priority: "needs-you" }])
    expect(result.noted.map(({ thread, message }) => ({ thread, message }))).toEqual([{ thread: { machine: "rosie", id: "a1" }, message: "It's the echo canceller warming up." }])
    expect(result.sent).toEqual([])
  })

  test("answers a question across threads from the listing, and says when it couldn't", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, spoken, reports } = yield* drafts(({ lines }) =>
          decision({ action: "status", about: lines[0]!.text.includes("broken") ? "what's broken" : "who needs you", project: "", prompt: "", spoken: "" }),
        )
        yield* dictate("Who needs me?")
        yield* dictate("Is anything broken?")
        return { spoken: spoken(), reports: reports.map(({ question, threads }) => [question, threads.map(({ machine, threads }) => [machine, threads.length])]) }
      }),
    )
    expect(result.reports).toEqual([["Who needs me?", [["rosie", 2], ["rig", 1]]]])
    expect(result.spoken).toEqual(["Nobody needs you.", "About what's broken: I couldn't check on your threads right now."])
  })

  test("asks which thread a bare \"it\" means once a report across threads was the last thing heard", async () => {
    const update: Heard = { id: "update-1", project: "yapd", directory: "/code/yapd", spoken: "yapd. The latency fix is ready.", message: "The latency fix is ready.", thread: { machine: "rosie", id: "a1" }, at: 0 }
    const result = await run(
      Effect.gen(function* () {
        const { dictate, sent, spoken, noted } = yield* drafts(
          ({ lines }) =>
            lines[0]!.text.startsWith("Who")
              ? decision({ action: "status", about: "who needs you", project: "", prompt: "", spoken: "" })
              : decision({ action: "message", about: "the latency one", project: "", thread: "rosie/a1", threadFrom: "referred", threadEvidence: "it", prompt: "Stop there.", spoken: "" }),
          { heard: [update] },
        )
        // Right after the update, and after yapd said it sent that, "it" is the thread the update came from.
        yield* dictate("Tell it to stop there.")
        yield* dictate("Who needs me?")
        yield* dictate("Tell it to stop there.")
        return { sent: sent.map(({ thread }) => thread.id), spoken: spoken(), noted: noted.map(({ thread }) => thread?.id) }
      }),
    )
    expect(result.sent).toEqual(["a1"])
    expect(result.spoken).toEqual(["Sent to Reduce latency in yapd.", "Nobody needs you.", "Which thread is that for?"])
    // The report is noted about no thread, and so is the question: what "it" means has to be settled again.
    expect(result.noted).toEqual(["a1", undefined, undefined])
  })

  test("takes a bare \"it\" as what had played when the shortcut was pressed, not what played while the dictation was worked out", async () => {
    const before: Heard = { id: "update-1", project: "yapd", directory: "/code/yapd", spoken: "yapd. The latency fix is ready.", message: "The latency fix is ready.", thread: { machine: "rosie", id: "a1" }, at: 0 }
    const meanwhile: Heard = { id: "update-2", project: "std", directory: "/code/std", spoken: "std. Redis is done.", message: "Redis is done.", thread: { machine: "rosie", id: "b2" }, at: 0 }
    const referred = (thread: string) =>
      run(
        Effect.gen(function* () {
          const { dictate, hear, wait, sent, spoken, asked } = yield* drafts(
            () => decision({ action: "message", about: "that one", project: "", thread, threadFrom: "referred", threadEvidence: "it", prompt: "Stop there.", spoken: "" }),
            { heard: [before] },
          )
          const pressed = yield* Clock.currentTimeMillis
          yield* wait(1)
          // Queued behind the update, it plays the moment the dictation lets go of the speaker, before what was said is worked out.
          yield* hear(meanwhile)
          yield* dictate("Tell it to stop there.", pressed)
          return { sent: sent.map(({ thread }) => thread.id), spoken: spoken(), shown: asked[0]!.recent.map(({ id }) => id) }
        }),
      )
    expect(await referred("rosie/a1")).toEqual({ sent: ["a1"], spoken: ["Sent to Reduce latency in yapd."], shown: ["update-1"] })
    // The writer went by what the user hadn't heard, which settles nothing.
    expect(await referred("rosie/b2")).toEqual({ sent: [], spoken: ["Which thread is that for?"], shown: ["update-1"] })
  })

  test("places what the dictation cut off where it stood when the shortcut was pressed, not where reading it again puts it", async () => {
    const older: Heard = { id: "update-1", project: "yapd", directory: "/code/yapd", spoken: "yapd. The latency fix is ready.", message: "The latency fix is ready.", thread: { machine: "rosie", id: "a1" }, at: 0 }
    const latest: Heard = { id: "update-2", project: "std", directory: "/code/std", spoken: "std. Redis is done.", message: "Redis is done.", thread: { machine: "rosie", id: "b2" }, at: 0 }
    const referred = (thread: string) =>
      run(
        Effect.gen(function* () {
          const { dictate, hear, replay, wait, sent, spoken, asked } = yield* drafts(
            () => decision({ action: "message", about: "that one", project: "", thread, threadFrom: "referred", threadEvidence: "it", prompt: "Stop there.", spoken: "" }),
            { heard: [older] },
          )
          yield* wait(1)
          yield* hear(latest)
          yield* wait(1)
          const pressed = yield* Clock.currentTimeMillis
          yield* wait(1)
          // An earlier dictation had cut the older one off, so it's read again once this one lets go of the speaker.
          yield* replay("update-1")
          yield* dictate("Tell it to stop there.", pressed)
          return { sent: sent.map(({ thread }) => thread.id), spoken: spoken(), shown: asked[0]!.recent.map(({ id, heardAt }) => [id, heardAt]) }
        }),
      )
    // The latest thing heard as they spoke was the std update, and the older one is shown as heard when it first was.
    expect(await referred("rosie/b2")).toEqual({ sent: ["b2"], spoken: ["Sent to Redis investigation in std."], shown: [["update-2", 1000], ["update-1", 0]] })
    expect(await referred("rosie/a1")).toEqual({ sent: [], spoken: ["Which thread is that for?"], shown: [["update-2", 1000], ["update-1", 0]] })
  })

  test("answers a question across threads from a fresh listing, fetched again when the answer took a while", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, wait, listings, reports } = yield* drafts(({ lines }) =>
          lines.length === 1
            ? decision({ action: "ask", about: "who needs you", project: "", prompt: "", spoken: "On which machine?" })
            : decision({ action: "status", about: "who needs you", project: "", prompt: "", spoken: "" }),
        )
        yield* dictate("Who needs me?")
        const asked = listings.filter((machine) => machine === "rosie").length
        yield* wait(120)
        yield* answer("Everywhere.")
        return { asked, answered: listings.filter((machine) => machine === "rosie").length, reports: reports.length }
      }),
    )
    expect(result).toEqual({ asked: 1, answered: 2, reports: 1 })
  })

  test("decides an answer against the threads as they are now, not as they were listed when the question was asked", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, appears, wait, sent, spoken, listings, asked } = yield* drafts(({ lines }) =>
          lines.length === 1
            ? decision({ action: "ask", about: "the message", project: "", prompt: "", spoken: "Which thread is that for?" })
            : addressed("message", "rig/c3", "rig", "Stop there."),
        )
        yield* dictate("Tell it to stop there.")
        // Another thread starts on rig while the question waits, so "the one on rig" no longer names one. The answer
        // comes while the listing the question was asked from would still be kept, and it's listed again all the same.
        yield* appears("rig", listed("d4", { project: "trainer", directory: "/home/me/trainer", title: "Tune the optimizer" }))
        yield* wait(30)
        yield* answer("The one on rig.")
        return {
          sent,
          spoken: spoken(),
          listed: listings.filter((machine) => machine === "rig").length,
          shown: asked.at(-1)?.threads.find(({ machine }) => machine === "rig")?.threads.map(({ listed }) => listed.id),
        }
      }),
    )
    expect(result).toEqual({ sent: [], spoken: ["Which thread is that for?", "Which thread is that for?"], listed: 2, shown: ["c3", "d4"] })
  })

  test("keeps what had played at the press however much plays before a slow dictation is worked out", async () => {
    const before: Heard = { id: "update-1", project: "yapd", directory: "/code/yapd", spoken: "yapd. The latency fix is ready.", message: "The latency fix is ready.", thread: { machine: "rosie", id: "a1" }, at: 0 }
    const result = await run(
      Effect.gen(function* () {
        const { dictate, hear, wait, sent, spoken, asked } = yield* drafts(
          () => decision({ action: "message", about: "that one", project: "", thread: "rosie/a1", threadFrom: "referred", threadEvidence: "it", prompt: "Stop there.", spoken: "" }),
          { heard: [before] },
        )
        const pressed = yield* Clock.currentTimeMillis
        // More than are ever shown play once the dictation lets go of the speaker, while a long one is still being transcribed.
        for (const n of [1, 2, 3, 4, 5, 6]) {
          yield* wait(1)
          yield* hear({ id: `update-${n + 1}`, project: "std", directory: "/code/std", spoken: `std. Redis ${n}.`, message: `Redis ${n}.`, thread: { machine: "rosie", id: "b2" }, at: 0 })
        }
        yield* dictate("Tell it to stop there.", pressed)
        return { sent: sent.map(({ thread }) => thread.id), spoken: spoken(), shown: asked[0]!.recent.map(({ id }) => id) }
      }),
    )
    expect(result).toEqual({ sent: ["a1"], spoken: ["Sent to Reduce latency in yapd."], shown: ["update-1"] })
  })
})
