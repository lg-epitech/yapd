import { describe, expect, test } from "bun:test"
import { Effect, Either, Option, Queue, type Scope, TestClock, TestContext } from "effect"
import * as Drafts from "./Drafts.ts"
import type { Notice } from "./Inbox.ts"
import { type Catalog, LaunchError, type Request, type Started } from "./Launcher.ts"
import * as Research from "./Research.ts"
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
  why: "They named yapd.",
  prompt: "Fix the loader.",
  spoken: "Started in yapd, on Fable, in a worktree.",
  ...overrides,
})

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
  } = {},
) =>
  Effect.gen(function* () {
    const started: Array<{ readonly machine: string; readonly request: Request }> = []
    const said: Array<Notice> = []
    const notices = yield* Queue.unbounded<Notice>()
    const asked: Array<Material> = []
    const researched: Array<{ readonly machine: string; readonly directory: string }> = []
    const catalogs: Array<string> = []
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
        { name: "rosie", here: true, hosts: ["Rosie.local"], launcher: launcher("rosie", rosie), researcher: researcher("rosie") },
        { name: "rig", here: false, hosts: ["rig"], launcher: launcher("rig", rig), researcher: researcher("rig") },
      ],
      rules: Effect.succeed(Option.some("Fable on high for hard bugs.")),
      recent: Effect.succeed([]),
      note: () => Effect.void,
      tell: (notice) => Effect.sync(() => void said.push(notice)).pipe(Effect.zipRight(Queue.offer(notices, notice)), Effect.asVoid),
    }).pipe(
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
    const dictate = (heard: string) => made.dictated(heard).pipe(Effect.zipRight(flush))
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
    return { ...made, dictate, answer, unanswered, wait, flush, nextNotice: Queue.take(notices), started, said, spoken, questions, asked, researched, catalogs }
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
        const { dictated, nextNotice, started } = yield* drafts(({ research }) =>
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
        yield* dictated("In yapd, compare the loader with std and fix it.")
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
        const { dictated, nextNotice, started } = yield* drafts(({ research }) =>
          research
            ? decision({ action: "research", evidence: "yapd", spoken: "Looking through yapd first." })
            : decision({ ...fallback, prompt: "Fix the loader." }),
        )
        yield* dictated("In yapd, compare the loader with billing and fix it.")
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
        [{ name: "rig", here: false, hosts: [], launcher: { start: () => Effect.die(""), catalog: Effect.die("") }, researcher: Research.unavailable("") }],
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
    expect(unwritten).toEqual({ spoken: ["I couldn't write that up, so nothing started. What you said is in my log."], started: [] })
  })

  test("asks every machine what it can start as the shortcut is pressed, and goes on without one that can't say", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { prepare, dictate, flush, catalogs, asked, started } = yield* drafts(() => decision({}), { rigDown: true })
        yield* prepare
        yield* flush
        const pressed = [...catalogs]
        yield* dictate("Fix the loader in yapd.")
        return { pressed, catalogs, listings: asked[0]?.listings.map(({ machine, reason }) => [machine, reason]), started: started.length }
      }),
    )
    expect(result.pressed.toSorted()).toEqual(["rig", "rosie"])
    // Not asked again once dictated.
    expect(result.catalogs.length).toBe(2)
    expect(result.listings).toEqual([
      ["rosie", undefined],
      ["rig", "I can't reach rig."],
    ])
    expect(result.started).toBe(1)
  })
})
