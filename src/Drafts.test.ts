import { describe, expect, test } from "bun:test"
import { Effect, Either, Option, type Scope, TestContext } from "effect"
import * as Drafts from "./Drafts.ts"
import { asking, type Catalog, list, type Request, type Started, serve } from "./Launcher.ts"
import * as Ledger from "./Ledger.ts"
import * as Persona from "./Persona.ts"
import { ProcessError } from "./Process.ts"
import * as Remote from "./Remote.ts"
import * as Store from "./Store.ts"
import { type Decision, type Material, Writer } from "./Writer.ts"

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
    // T3 Code's scratch project, as it calls it.
    { ...project("No project", "/t3/scratch", "gpt-6-sol", "2026-09-29T11:00:00.000Z"), repository: false, worktree: false, scratch: true },
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
 * request in the plain lines.
 */
const drafts = (
  decide: (material: Material) => Decision,
  options: {
    /** Whether rig is reached as it is for real, through `yapd start` and `yapd catalog` there. */
    readonly remote?: boolean
    /** Whether the connection to rig drops once `yapd start` there has what to start, before its answer gets here. */
    readonly dropped?: boolean
    /** Whether what's started is written down first, in a ledger of its own. */
    readonly ledger?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const started: Array<{ readonly machine: string; readonly request: Request }> = []
    const said: Array<string> = []
    const launcher = (machine: string, catalog: Catalog) => ({
      catalog: Effect.succeed(catalog),
      start: (request: Request) =>
        Effect.sync(() => {
          started.push({ machine, request })
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
    /** `yapd start` on rig as SSH brings it back, with what it said on stderr ahead of SSH's own. */
    const there = (command: ReadonlyArray<string>, stdin: string) => {
      let said = ""
      const answered = serve(launcher("rig", rig), stdin, Effect.sync(() => void (said += `${asking}\n`)))
      if (options.dropped !== true) return answered
      return Effect.flatMap(answered, () => Effect.fail(new ProcessError({ command: command.join(" "), code: 255, stderr: `${said}client_loop: send disconnect: Broken pipe` })))
    }
    const ledger = Ledger.fromStore(yield* Store.make(":memory:"))
    const made = yield* Drafts.make({
      machines: [
        { name: "rosie", here: true, hosts: ["Rosie.local"], launcher: launcher("rosie", rosie) },
        {
          name: "rig",
          here: false,
          hosts: ["rig"],
          launcher:
            options.remote === true
              ? Remote.launcher("rig", "rig", (command, stdin) => (command.at(-1)?.endsWith("start") ? there(command, stdin) : list(launcher("rig", rig))))
              : launcher("rig", rig),
        },
      ],
      rules: Effect.succeed(Option.some("Fable on high for hard bugs.")),
      recent: Effect.succeed([]),
      ...(options.ledger === true ? { ledger } : {}),
    }).pipe(
      Effect.provideService(Writer, {
        decide: (material) => Effect.sync(() => decide(material)),
        prepare: Effect.void,
      }),
      Effect.provideService(Persona.Persona, {
        lines: Effect.succeed(Persona.plain),
        onIt: () => Effect.succeed(Persona.plain.onIt),
        said: () => Effect.void,
      }),
    )
    /** Says what came of it, and what came of a launch once that's done. */
    const told = (outcome: Drafts.Outcome): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (outcome._tag) {
          case "Asked":
            said.push(outcome.question)
            return
          case "Started":
          case "Said":
            said.push(outcome.spoken)
            return
          case "Launching":
            return yield* told(yield* outcome.then)
        }
      })
    return {
      /** As a step of a request, when `step` is given. */
      dictate: (heard: string, step?: Drafts.Step) =>
        Effect.gen(function* () {
          const written = yield* made.begin([{ speaker: "user", text: heard }])
          if (Either.isLeft(written)) return said.push(written.left)
          yield* told(yield* made.start(written.right, undefined, step))
        }),
      started,
      ledger,
      spoken: () => [...said],
    }
  })

const run = <A, E>(test: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(test.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

describe("Drafts", () => {
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

  test("says what really started when that's not what was asked", () => {
    const resolved = Either.getOrThrow(
      Drafts.resolve(
        [{ name: "rig", here: false, hosts: [], launcher: { start: () => Effect.die(""), catalog: Effect.die("") } }],
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
    expect((await asked({ settled: "subject", evidence: "Reply with the word OKAY" })).started).toBe(1)
  })

  test("new work asked for twice as the same step of a request is started once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, started } = yield* drafts(() => decision({}), { ledger: true })
        yield* dictate("Fix the loader in yapd.", { utterance: "u1", step: 0 })
        yield* dictate("Fix the loader in yapd.", { utterance: "u1", step: 0 })
        // Another request's step is new work of its own.
        yield* dictate("Fix the loader in yapd.", { utterance: "u2", step: 0 })
        return { started: started.map(({ request }) => request.ids?.command) }
      }),
    )
    expect(result.started).toEqual(["yapd:u1:0", "yapd:u2:0"])
  })

  test("new work on another machine that the connection drops on once yapd there has it is left for a restart to look for, never taken as not started", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { dictate, ledger, started } = yield* drafts(() => decision({ project: "trainer", machine: "rig", model: "gpt-6-sol" }), {
          ledger: true,
          remote: true,
          dropped: true,
        })
        yield* dictate("On rig, fix the loader in trainer.", { utterance: "u1", step: 0 })
        return {
          started: started.length,
          state: Option.map(yield* ledger.get("yapd:u1:0"), ({ state }) => state),
          open: (yield* ledger.open(0)).map(({ commandId }) => commandId),
        }
      }),
    )
    expect(result).toEqual({
      started: 1,
      state: Option.some("unknown"),
      open: ["yapd:u1:0"],
    })
  })
})
