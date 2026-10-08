import { describe, expect, test } from "bun:test"
import { Effect, Either, Fiber, Option, Redacted, Schema, TestClock, TestContext } from "effect"
import * as Launcher from "./Launcher.ts"
import * as T3CodeLauncher from "./T3CodeLauncher.ts"
import * as Server from "./T3CodeServer.ts"

const project = (overrides: Partial<T3CodeLauncher.Project> = {}): T3CodeLauncher.Project => ({
  id: "project-1",
  title: "free-sound",
  workspaceRoot: "/code/free-sound",
  ...overrides,
})

const same = (path: string) => path

const providers: ReadonlyArray<T3CodeLauncher.Provider> = [
  {
    instanceId: "claudeAgent",
    enabled: true,
    status: "ready",
    models: [
      {
        slug: "claude-fable-5-1",
        name: "Claude Fable 5.1",
        aliases: ["fable"],
        capabilities: { optionDescriptors: [{ id: "effort", options: [{ id: "low" }, { id: "high" }] }, { id: "contextWindow" }] },
      },
    ],
  },
  {
    instanceId: "codex",
    enabled: true,
    status: "ready",
    models: [{ slug: "gpt-6-astra", name: "GPT-6-Astra", capabilities: { optionDescriptors: [{ id: "reasoningEffort", options: [{ id: "high" }] }] } }],
  },
  { instanceId: "grok", enabled: false, status: "disabled", models: [{ slug: "grok-build", name: "Grok Build", capabilities: null }] },
]

const fable: T3CodeLauncher.Selection = {
  instanceId: "claudeAgent",
  model: "claude-fable-5-1",
  options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "1m" }],
}

const refs: T3CodeLauncher.Refs = {
  isRepo: true,
  refs: [
    { name: "feature", current: true, isDefault: false },
    { name: "main", current: false, isDefault: true },
  ],
}

const plan = (overrides: Partial<Parameters<typeof T3CodeLauncher.plan>[0]> = {}) =>
  T3CodeLauncher.plan({
    request: { project: "free-sound", prompt: " Fix the loader. " },
    project: project(),
    settings: {},
    file: undefined,
    latest: fable,
    providers,
    refs,
    named: [],
    ...overrides,
  })

const planned = (overrides: Partial<Parameters<typeof T3CodeLauncher.plan>[0]> = {}) => Either.getOrThrow(plan(overrides))

const fresh: T3CodeLauncher.Fresh = {
  thread: "thread-1",
  message: "message-1",
  command: "yapd:command-1",
  branch: "0a1b2c3d",
  now: "2026-09-29T18:00:00.000Z",
}

describe("T3CodeLauncher", () => {
  test("finds a project by its title, its folder or its path, and won't guess at one", () => {
    const sounds = project({ id: "project-2", title: "Sounds", workspaceRoot: "/code/sounds-app" })
    const projects = [project(), sounds]
    expect(T3CodeLauncher.find(projects, "Free-Sound", same)).toEqual(Either.right(project()))
    expect(T3CodeLauncher.find(projects, "sounds-app", same)).toEqual(Either.right(sounds))
    expect(T3CodeLauncher.find(projects, "/code/sounds-app", same)).toEqual(Either.right(sounds))
    expect(T3CodeLauncher.find(projects, "yapd", same)).toEqual(
      Either.left(`"yapd" isn't a project in T3 Code, so I didn't start anything. Add it there first.`),
    )
    const twice = [project(), project({ id: "project-2", workspaceRoot: "/work/free-sound" })]
    expect(Either.isLeft(T3CodeLauncher.find(twice, "free-sound", same))).toBe(true)
    expect(Either.isRight(T3CodeLauncher.find(twice, "/work/free-sound", same))).toBe(true)
  })

  test("starts in the checkout unless something says worktree: the request, the project's override, its file, then the settings", () => {
    expect(planned()).toMatchObject({ worktree: false, branch: "feature", fromOrigin: false, runtimeMode: "full-access" })
    expect(planned({ settings: { defaultThreadEnvMode: "worktree" } })).toMatchObject({ worktree: true, branch: "main", fromOrigin: true })
    expect(planned({ settings: { defaultThreadEnvMode: "worktree" }, file: "local" }).worktree).toBe(false)
    const settings = { defaultThreadEnvMode: "local", projectSettingsOverrides: { "project-1": { defaultThreadEnvMode: "worktree" } } } as const
    expect(planned({ settings, file: "local" }).worktree).toBe(true)
    expect(planned({ settings, request: { project: "free-sound", prompt: "Fix it.", worktree: false } }).worktree).toBe(false)
    // What a project carries itself only counts until T3 Code has folded it into the settings.
    const own = project({ defaultThreadEnvMode: "worktree" })
    expect(planned({ project: own }).worktree).toBe(true)
    expect(planned({ project: own, settings: { projectSettingsFolded: true } }).worktree).toBe(false)
  })

  test("has no worktree outside a repository, and says so when one was asked for", () => {
    const outside = { isRepo: false, refs: [] }
    expect(planned({ refs: outside, settings: { defaultThreadEnvMode: "worktree" } })).toMatchObject({ worktree: false, branch: null })
    expect(plan({ refs: outside, request: { project: "free-sound", prompt: "Fix it.", worktree: true } })).toEqual(
      Either.left("free-sound isn't a git repository, so it can't have a worktree. I didn't start anything."),
    )
  })

  test("won't start from a branch that isn't there, which T3 Code would start in the checkout", () => {
    const request = { project: "free-sound", prompt: "Fix it.", worktree: true, baseBranch: "release" }
    expect(planned({ request, named: ["release", "release-2"] })).toMatchObject({ worktree: true, branch: "release" })
    expect(plan({ request, named: ["release-2", "origin/release-2"] })).toEqual(
      Either.left("free-sound has no branch called release, so I didn't start anything."),
    )
    // The defaults can ask for the worktree too.
    expect(Either.isLeft(plan({ request: { ...request, worktree: undefined }, settings: { defaultThreadEnvMode: "worktree" } }))).toBe(true)
    // Only on origin, which is enough when worktrees start from there.
    expect(planned({ request, named: ["origin/release"] })).toMatchObject({ worktree: true, branch: "release", fromOrigin: true })
    expect(Either.isLeft(plan({ request, named: ["origin/release"], settings: { newWorktreesStartFromOrigin: false } }))).toBe(true)
    // Nothing starts from it without a worktree.
    expect(planned({ request: { ...request, worktree: false } })).toMatchObject({ worktree: false, branch: "feature" })
  })

  test("takes the model from the request, then the defaults, then the project's latest thread", () => {
    const astra = { instanceId: "codex", model: "gpt-6-astra" }
    expect(planned().selection).toEqual(fable)
    expect(planned({ settings: { defaultModelSelection: astra } }).selection).toEqual(astra)
    expect(plan({ latest: undefined })).toEqual(Either.left("This project has no model to go by yet. Tell me which one to use."))
    expect(T3CodeLauncher.select(providers, { model: "GPT-6-Astra", effort: "high" }, fable)).toEqual(
      Either.right({ ...astra, options: [{ id: "reasoningEffort", value: "high" }] }),
    )
    // The options of the selection it builds on are kept, for the same model only.
    expect(T3CodeLauncher.select(providers, { model: "fable", effort: "Low" }, fable)).toEqual(
      Either.right({ ...fable, options: [{ id: "effort", value: "low" }, { id: "contextWindow", value: "1m" }] }),
    )
    expect(Either.isLeft(T3CodeLauncher.select(providers, { model: "grok-build" }, undefined))).toBe(true)
    expect(Either.isLeft(T3CodeLauncher.select(providers, { effort: "max" }, fable))).toBe(true)
  })

  test("launches the thread with its first message, in the checkout", () => {
    expect(T3CodeLauncher.launch(planned(), fresh)).toEqual({
      commandId: "yapd:command-1",
      creationSource: "web",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Fix the loader.",
      generateTitle: true,
      modelSelection: fable,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root", branch: "feature" },
      initialMessage: { messageId: "message-1", text: "Fix the loader.", attachments: [] },
    })
  })

  test("has T3 Code prepare the worktree, on a branch it will rename", () => {
    const { workspaceStrategy } = T3CodeLauncher.launch(planned({ settings: { defaultThreadEnvMode: "worktree" } }), fresh)
    expect(workspaceStrategy).toEqual({ type: "worktree", baseRef: "main", branch: "t3code/0a1b2c3d", startFromOrigin: true })
    const local = T3CodeLauncher.launch(planned({ settings: { defaultThreadEnvMode: "worktree", newWorktreesStartFromOrigin: false } }), fresh)
    expect(local.workspaceStrategy).not.toHaveProperty("startFromOrigin")
  })
})

describe("T3CodeLauncher's start", () => {
  const thread = (worktreePath: string | null, status: string) => ({
    projection: { thread: { branch: worktreePath === null ? "main" : "t3code/0a1b2c3d", worktreePath, modelSelection: fable }, runs: [{ status }] },
  })
  /** T3 Code as the launcher reaches it, answering a launch and then each look at the thread in turn. */
  const reached = (launched: unknown, looks: Array<unknown>, calls: Array<{ method: string; payload: unknown }> = []) => {
    const answers: Record<string, unknown> = {
      "/api/orchestration/shell": { projects: [project()], threads: [] },
      "server.getSettings": { defaultThreadEnvMode: "worktree" },
      "server.getConfig": { providers },
      "vcs.listRefs": refs,
      "orchestration.launchThread": launched,
    }
    const answer = <A, I>(value: unknown, schema: Schema.Schema<A, I>) => Effect.orDie(Schema.decodeUnknown(schema)(value))
    const transport: Server.Transport = {
      api: (path, schema) => answer(path === "/api/orchestration/threads/thread-1/bounded" ? looks.shift() : answers[path], schema),
      call: (method, payload, schema) => {
        calls.push({ method, payload })
        return answer(answers[method], schema)
      },
    }
    return T3CodeLauncher.launcher(Redacted.make("token"), Effect.succeed(transport), () => fresh)
  }
  const request = { project: "free-sound", prompt: "Fix the loader.", model: "fable" }
  /** Starts it, letting time pass while T3 Code gets the workspace ready. */
  const start = (launcher: Launcher.Launcher, wanted: Launcher.Request = request) =>
    Effect.runPromise(Effect.gen(function* () {
      const starting = yield* Effect.fork(Effect.either(launcher.start(wanted)))
      while (Option.isNone(yield* Fiber.poll(starting))) yield* TestClock.adjust("1 second")
      return yield* Fiber.join(starting)
    }).pipe(Effect.provide(TestContext.TestContext)))

  test("says where it started once T3 Code has the worktree ready", async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const looks = [thread(null, "preparing"), thread("/worktrees/free-sound/t3code-0a1b2c3d", "running")]
    const started = Either.getOrThrow(await start(reached(thread(null, "preparing"), looks, calls)))
    expect(started).toEqual({
      thread: "thread-1",
      project: "free-sound",
      directory: "/worktrees/free-sound/t3code-0a1b2c3d",
      branch: "t3code/0a1b2c3d",
      model: "claude-fable-5-1",
      effort: "high",
      worktree: true,
    })
    expect(looks).toEqual([])
    expect(calls.filter(({ method }) => method === "orchestration.launchThread")).toEqual([
      { method: "orchestration.launchThread", payload: expect.objectContaining({ threadId: "thread-1", workspaceStrategy: expect.objectContaining({ type: "worktree" }) }) },
    ])
  })

  test("doesn't wait on a checkout that's ready at once", async () => {
    const started = Either.getOrThrow(await start(reached(thread(null, "starting"), []), { ...request, worktree: false }))
    expect(started).toMatchObject({ directory: "/code/free-sound", branch: "main", worktree: false })
  })

  test("says nothing started when T3 Code couldn't make the worktree", async () => {
    const failed = await start(reached(thread(null, "preparing"), [thread(null, "failed")]))
    expect(failed).toEqual(Either.left(new Launcher.LaunchError({ reason: "T3 Code couldn't make the worktree, so the thread it made didn't start." })))
  })
})

describe("T3CodeLauncher's catalog", () => {
  const thread = (title: string, updatedAt: string, modelSelection = fable) => ({ projectId: "project-1", title, modelSelection, updatedAt })
  const docs = project({ id: "project-2", title: "docs", workspaceRoot: "/code/docs" })
  const listed = (overrides: Partial<Parameters<typeof T3CodeLauncher.catalog>[0]> = {}) =>
    T3CodeLauncher.catalog({
      shell: {
        projects: [project(), docs],
        threads: [
          thread("Older", "2026-09-27T10:00:00.000Z", { instanceId: "codex", model: "gpt-6-astra" }),
          thread("Fix latency", "2026-09-28T10:00:00.000Z"),
        ],
      },
      settings: { defaultThreadEnvMode: "worktree" },
      providers,
      files: new Map(),
      repositories: new Map([["project-1", { repository: true, branch: "main" }]]),
      ...overrides,
    })

  test("says where each project's work would start, and with what", () => {
    expect(listed()).toEqual({
      projects: [
        {
          name: "free-sound",
          path: "/code/free-sound",
          repository: true,
          branch: "main",
          worktree: true,
          model: { name: "claude-fable-5-1", effort: "high" },
          recent: [
            { title: "Fix latency", date: "2026-09-28T10:00:00.000Z" },
            { title: "Older", date: "2026-09-27T10:00:00.000Z" },
          ],
        },
        // Not a repository, so no worktree whatever the settings say, and no thread to take a model from.
        { name: "docs", path: "/code/docs", repository: false, branch: null, worktree: false, recent: [] },
      ],
      // Those that are ready.
      models: [
        { name: "claude-fable-5-1", title: "Claude Fable 5.1", aliases: ["fable"], efforts: ["low", "high"] },
        { name: "gpt-6-astra", title: "GPT-6-Astra", aliases: [], efforts: ["high"] },
      ],
    })
  })
})

describe("T3CodeServer", () => {
  const failure = (...cause: ReadonlyArray<unknown>) => ({ _tag: "Failure", cause })
  const reason = (exit: unknown) => Either.match(Server.outcome(exit), { onLeft: T3CodeLauncher.reason, onRight: () => undefined })

  test("hands back what a request succeeded with, or why T3 Code refused", () => {
    expect(Server.outcome({ _tag: "Success", value: { sequence: 7 } })).toEqual(Either.right({ sequence: 7 }))
    const error = { _tag: "OrchestrationV2ThreadLaunchError", commandId: "yapd:command-1", projectId: "project-1", message: "git worktree add failed" }
    expect(Server.outcome(failure({ _tag: "Fail", error }))).toEqual(
      Either.left(new Server.Refusal({ tag: "OrchestrationV2ThreadLaunchError", message: "git worktree add failed" })),
    )
    expect(reason(failure({ _tag: "Fail", error }))).toBe("T3 Code couldn't start it. git worktree add failed")
    // A command T3 Code couldn't read.
    expect(reason(failure({ _tag: "Die", defect: 'Missing key\n  at ["threadId"]' }))).toBe(
      "T3 Code didn't understand me. One of us needs updating.",
    )
  })
})

describe("Launcher", () => {
  const started: Launcher.Started = {
    thread: "thread-1",
    project: "free-sound",
    directory: "/code/free-sound",
    branch: "main",
    model: "claude-fable-5-1",
    worktree: false,
  }
  const recording = (requests: Array<Launcher.Request>): Launcher.Launcher => ({
    start: (request) => Effect.sync(() => (requests.push(request), started)),
    catalog: Effect.succeed({ projects: [], models: [] }),
  })
  const serve = async (launcher: Launcher.Launcher, input: string) => JSON.parse(await Effect.runPromise(Launcher.serve(launcher, input)))

  test("starts what stdin describes and says what started, or why nothing did", async () => {
    const requests: Array<Launcher.Request> = []
    const request = { project: "free-sound", prompt: "Fix the loader.", worktree: true }
    expect(await serve(recording(requests), JSON.stringify(request))).toEqual({ started })
    const failed = Effect.fail(new Launcher.LaunchError({ reason: "T3 Code isn't running." }))
    expect(await serve({ start: () => failed, catalog: failed }, JSON.stringify(request))).toEqual({ reason: "T3 Code isn't running." })
    // Nothing, or what it can't read.
    expect(await serve(recording(requests), JSON.stringify({ project: "free-sound", prompt: "  " }))).toEqual({
      reason: "I didn't catch what to start.",
    })
    expect(await serve(recording(requests), "{}")).toHaveProperty("reason")
    expect(requests).toEqual([request])
  })
})
