import { describe, expect, test } from "bun:test"
import { Effect, Either, Fiber, Option, type Scope, TestClock, TestContext } from "effect"
import * as Drafts from "./Drafts.ts"
import { asking, type Catalog, LaunchError, list, type Request, type Started, serve } from "./Launcher.ts"
import * as Ledger from "./Ledger.ts"
import * as Persona from "./Persona.ts"
import { ProcessError } from "./Process.ts"
import * as Remote from "./Remote.ts"
import * as Research from "./Research.ts"
import type { Line } from "./Responder.ts"
import * as Store from "./Store.ts"
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
  spoken: "In yapd, on Fable, in a worktree.",
  ...overrides,
})

/**
 * Runs new work against a writer that decides what the test says, and
 * launchers that record what they're asked to start, saying what came of each
 * request as whoever heard it would, with the persona's `lines`, or the plain ones.
 */
const drafts = (
  decide: (material: Material) => Decision | undefined,
  options: {
    readonly written?: Written
    readonly refuse?: string
    /** T3 Code took what was started, but its answer was lost, so it may have started all the same. */
    readonly lost?: boolean
    readonly rigDown?: boolean
    /** Whether rig is reached as it is for real, through `yapd start` and `yapd catalog` there. */
    readonly remote?: boolean
    /** Whether the connection to rig drops once `yapd start` there has what to start, before its answer gets here. */
    readonly dropped?: boolean
    /** Whether what's started is written down first, in a ledger of its own, and whether writing it down takes a second. */
    readonly ledger?: boolean | "slow"
    readonly lines?: Persona.Lines
  } = {},
) =>
  Effect.gen(function* () {
    const started: Array<{ readonly machine: string; readonly request: Request }> = []
    const said: Array<{ readonly spoken: string; readonly came: Drafts.Outcome["_tag"] | "Failed" }> = []
    const asked: Array<Material> = []
    const researched: Array<{ readonly machine: string; readonly directory: string }> = []
    const catalogs: Array<string> = []
    /** How many times a line for going ahead was picked. */
    let picks = 0
    const launcher = (machine: string, catalog: Catalog) => ({
      catalog: Effect.sync(() => void catalogs.push(machine)).pipe(
        Effect.zipRight(machine === "rig" && options.rigDown === true ? Effect.fail(new LaunchError({ reason: "I can't reach rig." })) : Effect.succeed(catalog)),
      ),
      start: (request: Request) =>
        Effect.gen(function* () {
          started.push({ machine, request })
          if (options.refuse !== undefined) return yield* new LaunchError({ reason: options.refuse })
          if (options.lost === true) return yield* new LaunchError({ reason: "T3 Code is taking too long, so I don't know if it started.", sent: true })
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
    /** `yapd start` on rig as SSH brings it back, with what it said on stderr ahead of SSH's own. */
    const there = (command: ReadonlyArray<string>, stdin: string) => {
      let said = ""
      const answered = serve(launcher("rig", rig), stdin, Effect.sync(() => void (said += `${asking}\n`)))
      if (options.dropped !== true) return answered
      return Effect.flatMap(answered, () => Effect.fail(new ProcessError({ command: command.join(" "), code: 255, stderr: `${said}client_loop: send disconnect: Broken pipe` })))
    }
    const kept = Ledger.fromStore(yield* Store.make(":memory:"))
    const ledger: Ledger.Ledger["Type"] = options.ledger === "slow" ? { ...kept, prepare: (step) => Effect.zipLeft(kept.prepare(step), Effect.sleep("1 second")) } : kept
    const made = yield* Drafts.make({
      machines: [
        { name: "rosie", here: true, hosts: ["Rosie.local"], launcher: launcher("rosie", rosie), researcher: researcher("rosie") },
        {
          name: "rig",
          here: false,
          hosts: ["rig"],
          launcher:
            options.remote === true
              ? Remote.launcher("rig", "rig", (command, stdin) => (command.at(-1)?.endsWith("start") ? there(command, stdin) : list(launcher("rig", rig))))
              : launcher("rig", rig),
          researcher: researcher("rig"),
        },
      ],
      rules: Effect.succeed(Option.some("Fable on high for hard bugs.")),
      recent: Effect.succeed([]),
      ...(options.ledger === undefined || options.ledger === false ? {} : { ledger }),
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
      Effect.provideService(Persona.Persona, {
        lines: Effect.succeed(options.lines ?? Persona.plain),
        onIt: () => Effect.sync(() => (picks++, (options.lines ?? Persona.plain).onIt)),
        said: () => Effect.void,
      }),
    )
    let material: Material | undefined
    /** Says what came of it, and what came of reading the project first once that's done. */
    const told = (outcome: Drafts.Outcome): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (outcome._tag) {
          case "Asked":
            material = outcome.material
            said.push({ spoken: outcome.question, came: "Asked" })
            return
          case "Started":
            said.push({ spoken: outcome.spoken, came: "Started" })
            return
          case "Said":
            said.push({ spoken: outcome.spoken, came: outcome.failed ? "Failed" : "Said" })
            return
          case "Looking":
            said.push({ spoken: outcome.spoken, came: "Looking" })
            return yield* told(yield* outcome.then)
          case "Launching":
            return yield* told(yield* outcome.then)
        }
      })
    const carry = (lines: ReadonlyArray<Line>, answering?: Material, step?: Drafts.Step) =>
      Effect.gen(function* () {
        const written = yield* made.begin(lines, answering)
        if (Either.isLeft(written)) return said.push({ spoken: written.left, came: "Failed" })
        yield* told(yield* made.start(written.right, undefined, undefined, step))
      })
    // Lets the fibers catch up on what the test did, since the clock only moves when told to.
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    return {
      prepare: made.prepare([]),
      /** As a step of a request, when `step` is given. */
      dictate: (heard: string, step?: Drafts.Step) => carry([{ speaker: "user", text: heard }], undefined, step),
      /** Answers the question asked last, as the one open. */
      answer: (heard: string) =>
        carry(
          [
            { speaker: "yapd", text: said.at(-1)?.spoken ?? "" },
            { speaker: "user", text: heard },
          ],
          material,
        ),
      flush,
      wait: (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush)),
      started,
      said,
      ledger,
      spoken: () => said.map(({ spoken }) => spoken),
      picks: () => picks,
      asked,
      researched,
      catalogs,
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Drafts", () => {
  test("starts what the user said where they said, and says what it did", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, said } = yield* drafts(() =>
          decision({ model: "opus-5.5", effort: "XHigh", worktree: false, branch: "release", spoken: "In yapd, on Opus, without a worktree." }),
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
    expect(result.said).toEqual([{ spoken: "On it. In yapd, on Opus, without a worktree.", came: "Started" }])
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
    expect(result.said).toEqual([{ spoken: "Which project is the invoice retry for?", came: "Asked" }])
  })

  test("asks when the project is unclear, and starts once the user has answered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, answer, started, spoken, asked } = yield* drafts(({ lines }) =>
          lines.length === 1
            ? decision({ action: "ask", project: "", prompt: "", spoken: "For the loader fix, is that yapd or std?" })
            : decision({ project: "std", evidence: "std", spoken: "In std, on Fable, in a worktree." }),
        )
        yield* dictate("Fix the loader.")
        const before = [...started]
        yield* answer("Std.")
        return { before, started, spoken: spoken(), lines: asked.at(-1)?.lines }
      }),
    )
    expect(result.before).toEqual([])
    expect(result.started.map(({ request }) => request.project)).toEqual(["/code/std"])
    expect(result.spoken).toEqual(["For the loader fix, is that yapd or std?", "On it. In std, on Fable, in a worktree."])
    expect(result.lines).toEqual([
      { speaker: "user", text: "Fix the loader." },
      { speaker: "yapd", text: "For the loader fix, is that yapd or std?" },
      { speaker: "user", text: "Std." },
    ])
  })

  test("says it's reading the project before it does, where the project is", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, said, researched } = yield* drafts(
          () => decision({ action: "research", project: "trainer", machine: "rig", prompt: "What the eval loader does.", spoken: "Looking through trainer first." }),
          { written: { action: "start", why: "Read the loader.", prompt: "Make the eval loader stream.", spoken: "In trainer on rig, on Fable, in a worktree." } },
        )
        yield* dictate("In trainer, do the streaming thing for the eval loader.")
        return { started, researched, said }
      }),
    )
    expect(result.researched).toEqual([{ machine: "rig", directory: "/home/me/trainer" }])
    expect(result.said).toEqual([
      { spoken: "Looking through trainer first.", came: "Looking" },
      { spoken: "On it. In trainer on rig, on Fable, in a worktree.", came: "Started" },
    ])
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
    expect(result.spoken).toEqual(["Looking through yapd first.", "On it. In yapd, on Fable, in a worktree. I couldn't read through it first."])
  })

  test("resolves the fallback decision again when reading the project fails", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, said, started } = yield* drafts(({ research }) =>
          research
            ? decision({ action: "research", evidence: "yapd", spoken: "Looking through yapd first." })
            : decision({
                project: "std",
                evidence: "std",
                model: "opus-5.5",
                effort: "XHigh",
                worktree: false,
                prompt: "Fix the loader in std.",
                spoken: "In std, on Opus, without a worktree.",
              }),
        )
        yield* dictate("In yapd, compare the loader with std and fix it.")
        return { started, spoken: said.at(-1)?.spoken }
      }),
    )
    expect(result.started).toEqual([
      {
        machine: "rosie",
        request: { project: "/code/std", prompt: "Fix the loader in std.", model: "claude-opus-5-5", effort: "xhigh", worktree: false },
      },
    ])
    expect(result.spoken).toBe("On it. In std, on Opus, without a worktree. I couldn't read through it first.")
  })

  test.each([
    { project: "std", evidence: "words they never said" },
    { project: "billing", evidence: "billing" },
  ])("asks when a research fallback isn't a valid grounded destination: $project / $evidence", async (fallback) => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, said, started } = yield* drafts(({ research }) =>
          research
            ? decision({ action: "research", evidence: "yapd", spoken: "Looking through yapd first." })
            : decision({ ...fallback, prompt: "Fix the loader." }),
        )
        yield* dictate("In yapd, compare the loader with billing and fix it.")
        return { started, last: said.at(-1) }
      }),
    )
    expect(result.started).toEqual([])
    expect(result.last).toEqual({ spoken: "Which project is the loader fix for?", came: "Asked" })
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
    const lines = { onIt: "Right away, sir.", address: "sir" }
    expect(Drafts.confirmation("In trainer, in a worktree.", resolved, started, lines)).toBe("Right away, sir. In trainer, in a worktree.")
    expect(Drafts.confirmation("In trainer, in a worktree.", resolved, { ...started, worktree: false, warning: "It isn't in a worktree, since git wouldn't make one." }, lines)).toBe(
      "Started in trainer on rig, on Claude Fable 5.1, without a worktree. It isn't in a worktree, since git wouldn't make one.",
    )
    expect(Drafts.confirmation("", resolved, started, lines)).toBe("Started in trainer on rig, on Claude Fable 5.1, in a worktree.")
  })

  test("says his own line for going ahead once work starts, in front of the writer's words and in place of an \"On it\" it wrote anyway", async () => {
    const said = (spoken: string) =>
      run(
        Effect.gen(function* () {
          const { dictate, spoken: told, picks } = yield* drafts(() => decision({ evidence: "yapd", spoken }), {
            lines: { ...Persona.plain, onIt: "Right away, sir.", address: "sir" },
          })
          yield* dictate("In yapd, fix the loader.")
          return { said: told(), picks: picks() }
        }),
      )
    expect(await said("In yapd, on Fable, in a worktree.")).toEqual({ said: ["Right away, sir. In yapd, on Fable, in a worktree."], picks: 1 })
    expect(await said("On it, sir, in yapd, on Fable, in a worktree.")).toEqual({ said: ["Right away, sir. In yapd, on Fable, in a worktree."], picks: 1 })
    // With only the plain facts said, no line is picked, so none is kept from coming up as if it were about to play.
    expect(await said("On it.")).toEqual({ said: ["Started in yapd, on Claude Fable 5.1, in a worktree."], picks: 0 })
  })

  test("says the line for going ahead in front of the writer's words, in place of an \"On it\" it wrote anyway", () => {
    const resolved = Either.getOrThrow(
      Drafts.resolve(
        [{ name: "rig", here: false, hosts: [], launcher: { start: () => Effect.die(""), catalog: Effect.die("") }, researcher: Research.unavailable("") }],
        [{ machine: "rig", here: false, hosts: [], catalog: Option.some(rig) }],
        decision({ project: "trainer", machine: "rig" }),
      ),
    )
    const started: Started = { thread: "t", project: "trainer", directory: "/home/me/trainer", branch: "main", model: "claude-fable-5-1", worktree: true }
    const lines = { onIt: "Right away, sir.", address: "sir" }
    expect(Drafts.confirmation("On it, sir, in trainer on rig, on Fable, in a worktree.", resolved, started, lines)).toBe(
      "Right away, sir. In trainer on rig, on Fable, in a worktree.",
    )
    // Nor how it addressed him, while the lines don't say how yet.
    expect(Drafts.confirmation("On it, sir, in trainer on rig, on Fable, in a worktree.", resolved, started, { ...lines, address: "" })).toBe(
      "Right away, sir. In trainer on rig, on Fable, in a worktree.",
    )
    // With nothing else, there are no words of its own, so it's the plain facts, which need no line in front.
    expect(Drafts.confirmation("On it, sir.", resolved, started, lines)).toBe("Started in trainer on rig, on Claude Fable 5.1, in a worktree.")
    // Writer's words that read just like the plain facts are still the writer's, so the line goes in front of them.
    expect(Drafts.confirmation("Started in trainer on rig, on Claude Fable 5.1, in a worktree.", resolved, started, lines)).toBe(
      "Right away, sir. Started in trainer on rig, on Claude Fable 5.1, in a worktree.",
    )
    // Whether it says where it is goes by the writer's words alone, never by a line of his that names a worktree.
    expect(Drafts.confirmation("In trainer, on Fable.", resolved, started, { onIt: "I'll get the worktree sorted.", address: "" })).toBe(
      "I'll get the worktree sorted. In trainer, on Fable. That's in a worktree.",
    )
    // Nor are words after an "On it" taken for how it addressed him, while the lines don't say how yet.
    expect(Drafts.confirmation("On it, staging only. In trainer, in a worktree.", resolved, started, { ...lines, address: "" })).toBe(
      "Right away, sir. Staging only. In trainer, in a worktree.",
    )
    // Without lines of his own, it's the written one, much as the writer used to put it.
    expect(Drafts.confirmation("In trainer on rig, on Fable, in a worktree.", resolved, started, Persona.plain)).toBe("On it. In trainer on rig, on Fable, in a worktree.")
  })

  test("always says whether there's a worktree, and when it couldn't tell which the user wanted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, spoken } = yield* drafts(() =>
          decision({ project: "std", evidence: "std", worktreeFrom: "unclear", worktree: false, spoken: "In std, on Fable." }),
        )
        yield* dictate("In std, reply with the single word OK and do nothing else on a work tree.")
        return { worktree: started[0]?.request.worktree, spoken: spoken() }
      }),
    )
    expect(result.worktree).toBe(false)
    expect(result.spoken).toEqual(["On it. In std, on Fable. That's without a worktree. I couldn't tell whether you wanted a worktree, so I went by your rules."])
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
        return said
      }),
    )
    expect(refused).toEqual([{ spoken: "About the loader fix: T3 Code isn't running.", came: "Failed" }])
    const unwritten = await run(
      Effect.gen(function* () {
        const { dictate, spoken, started } = yield* drafts(() => undefined)
        yield* dictate("Fix the loader in yapd.")
        return { spoken: spoken(), started }
      }),
    )
    expect(unwritten).toEqual({ spoken: ["I couldn't write that up, so nothing started. What you said is in my log."], started: [] })
  })

  test("new work asked for twice as the same step of a request is started once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, said } = yield* drafts(() => decision({}), { ledger: true })
        yield* dictate("Fix the loader in yapd.", { utterance: "u1", step: 0 })
        yield* dictate("Fix the loader in yapd.", { utterance: "u1", step: 0 })
        // Another request's step is new work of its own.
        yield* dictate("Fix the loader in yapd.", { utterance: "u2", step: 0 })
        return { started: started.map(({ request }) => request.ids?.command), said }
      }),
    )
    expect(result.started).toEqual(["yapd:u1:0", "yapd:u2:0"])
    expect(result.said[1]).toEqual({ spoken: "I've already asked for that to start.", came: "Said" })
  })

  test("new work read through first, as a step of a request, is written down and asked for under its ids, whether the reading comes to anything or not", async () => {
    const through = (reads: boolean) =>
      run(
        Effect.gen(function* () {
          const { dictate, started, ledger } = yield* drafts(
            ({ research }) => (research ? decision({ action: "research", prompt: "What the loader does.", spoken: "Looking through yapd first." }) : decision({})),
            { ledger: true, ...(reads ? { written: { action: "start", why: "Read the loader.", prompt: "Make the loader stream.", spoken: "" } } : {}) },
          )
          yield* dictate("In yapd, do the streaming thing for the loader.", { utterance: "u1", step: 1 })
          const row = yield* ledger.get("yapd:u1:1")
          return {
            asked: started.map(({ request }) => request.ids?.command),
            row: Option.map(row, ({ kind, state, thread }) => [kind, state, thread === started[0]?.request.ids?.thread]),
          }
        }),
      )
    for (const reads of [true, false]) expect(await through(reads)).toEqual({ asked: ["yapd:u1:1"], row: Option.some(["start", "sent", true]) })
  })

  test("new work written down is asked for even when yapd is turned off just then, never left as if it may have started", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started, ledger, flush, wait } = yield* drafts(() => decision({}), { ledger: "slow" })
        const going = yield* Effect.fork(dictate("Fix the loader in yapd.", { utterance: "u1", step: 0 }))
        yield* flush
        // Turned off as it's written down, before it's asked for.
        yield* Fiber.interruptFork(going)
        yield* wait(1)
        return { started: started.map(({ request }) => request.ids?.command), state: Option.map(yield* ledger.get("yapd:u1:0"), ({ state }) => state) }
      }),
    )
    expect(result).toEqual({ started: ["yapd:u1:0"], state: Option.some("sent") })
  })

  test("new work another machine's T3 Code may have started all the same is left for a restart to look for, never taken as not started", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, said, ledger } = yield* drafts(() => decision({ project: "trainer", machine: "rig", model: "gpt-6-sol" }), { ledger: true, remote: true, lost: true })
        yield* dictate("On rig, fix the loader in trainer.", { utterance: "u1", step: 0 })
        return { said, state: Option.map(yield* ledger.get("yapd:u1:0"), ({ state }) => state), open: (yield* ledger.open(0)).map(({ commandId }) => commandId) }
      }),
    )
    expect(result).toEqual({
      said: [{ spoken: "About the loader fix: T3 Code is taking too long, so I don't know if it started.", came: "Failed" }],
      state: Option.some("unknown"),
      open: ["yapd:u1:0"],
    })
  })

  test("new work on another machine that the connection drops on once yapd there has it is left for a restart to look for, never taken as not started", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, said, ledger, started } = yield* drafts(() => decision({ project: "trainer", machine: "rig", model: "gpt-6-sol" }), {
          ledger: true,
          remote: true,
          dropped: true,
        })
        yield* dictate("On rig, fix the loader in trainer.", { utterance: "u1", step: 0 })
        return {
          started: started.length,
          said,
          state: Option.map(yield* ledger.get("yapd:u1:0"), ({ state }) => state),
          open: (yield* ledger.open(0)).map(({ commandId }) => commandId),
        }
      }),
    )
    expect(result).toEqual({
      started: 1,
      said: [{ spoken: "About the loader fix: rig cut out partway, so I don't know if it started.", came: "Failed" }],
      state: Option.some("unknown"),
      open: ["yapd:u1:0"],
    })
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
