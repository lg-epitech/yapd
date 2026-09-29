import { describe, expect, test } from "bun:test"
import { Effect, Either, Option } from "effect"
import type { Exec, Model } from "./Cli.ts"
import * as CliLauncher from "./CliLauncher.ts"
import type { Past } from "./History.ts"
import type { LaunchError, Request } from "./Launcher.ts"
import * as Minder from "./Minder.ts"
import { ProcessError } from "./Process.ts"
import * as Relay from "./Relay.ts"
import type * as Seen from "./Seen.ts"
import * as Sessions from "./Sessions.ts"
import type { Repository } from "./Worktree.ts"

const project: CliLauncher.Project = { name: "free-sound", path: "/code/free-sound" }
const docs: CliLauncher.Project = { name: "docs", path: "/code/docs" }

const same = (path: string) => path

const both = new Set(["claude", "codex"] as const)

const models: ReadonlyArray<Model> = [
  { agent: "claude", name: "claude-fable-5-1", title: "Fable 5.1", aliases: ["fable"], efforts: ["low", "high"] },
  { agent: "claude", name: "claude-haiku-4-5-20251001", title: "Haiku 4.5", aliases: ["haiku"], efforts: [] },
  { agent: "codex", name: "gpt-6-astra", title: "GPT-6-Astra", aliases: [], efforts: ["low", "high"] },
]

const settings: CliLauncher.Settings = { folders: [], worktree: false, permissions: { claude: undefined, codex: undefined } }

const repository: Repository = { repository: true, branch: "main", current: "feature" }

const fable: CliLauncher.Usual = { agent: "claude", model: "claude-fable-5-1", effort: "high" }

const plan = (overrides: Partial<Parameters<typeof CliLauncher.plan>[0]> = {}) =>
  CliLauncher.plan({
    request: { project: "free-sound", prompt: " Fix the loader. " },
    project,
    repository,
    usual: fable,
    models,
    installed: both,
    settings,
    readOnly: true,
    ...overrides,
  })

const planned = (overrides: Partial<Parameters<typeof CliLauncher.plan>[0]> = {}) => Either.getOrThrow(plan(overrides))

const asking = (request: Partial<Request>) => ({ request: { project: "free-sound", prompt: "Fix it.", ...request } })

describe("CliLauncher", () => {
  test("finds a project by its folder's name or its path, and won't guess at one", () => {
    expect(CliLauncher.find([project, docs], "Free-Sound", same)).toEqual(Either.right(project))
    expect(CliLauncher.find([project, docs], "/code/docs", same)).toEqual(Either.right(docs))
    const resolve = (path: string) => path.replace(/^\/tmp/, "/private/tmp")
    expect(Either.isRight(CliLauncher.find([{ name: "w", path: "/private/tmp/w" }], "/tmp/w", resolve))).toBe(true)
    expect(CliLauncher.find([project], "yapd", same)).toEqual(
      Either.left(`"yapd" isn't a project I know here, so I didn't start anything. Its folder needs adding to YAPD_PROJECTS.`),
    )
    expect(Either.isLeft(CliLauncher.find([project], "/code/free-sound/src", same))).toBe(true)
    expect(Either.isLeft(CliLauncher.find([project, { name: "free-sound", path: "/work/free-sound" }], "free-sound", same))).toBe(true)
  })

  test("lets the request win over what the project last ran with, and refuses a model that isn't there", () => {
    expect(planned()).toMatchObject({ prompt: "Fix the loader.", agent: "claude", model: "claude-fable-5-1", effort: "high" })
    // Its model says which command line runs it.
    expect(planned(asking({ model: "GPT-6-Astra", effort: "Low" }))).toMatchObject({ agent: "codex", model: "gpt-6-astra", effort: "low" })
    // The effort the project last used is kept for the same model only.
    expect(planned(asking({ model: "fable" })).effort).toBe("high")
    expect(planned(asking({ model: "gpt-6-astra" })).effort).toBeUndefined()
    expect(plan({ usual: undefined })).toEqual(Either.left("This project has no model to go by yet. Tell me which one to use."))
    expect(Either.isLeft(plan(asking({ model: "gpt-7" })))).toBe(true)
    expect(Either.isLeft(plan(asking({ model: "haiku", effort: "low" })))).toBe(true)
  })

  test("starts in the checkout unless the request or the setting says worktree, and refuses one outside a repository", () => {
    expect(planned()).toMatchObject({ worktree: false, base: null })
    expect(planned({ settings: { ...settings, worktree: true } })).toMatchObject({ worktree: true, base: "main" })
    expect(planned({ settings: { ...settings, worktree: true }, ...asking({ model: "fable", worktree: false }) }).worktree).toBe(false)
    expect(planned(asking({ model: "fable", worktree: true, baseBranch: " release " }))).toMatchObject({ worktree: true, base: "release" })
    const outside = { repository: false, branch: null, current: null }
    expect(planned({ repository: outside, settings: { ...settings, worktree: true } })).toMatchObject({ worktree: false, base: null })
    expect(plan({ repository: outside, ...asking({ model: "fable", worktree: true }) })).toEqual(
      Either.left("free-sound isn't a git repository, so it can't have a worktree. I didn't start anything."),
    )
    expect(Either.isLeft(plan({ repository: { repository: true, branch: null, current: null }, ...asking({ worktree: true }) }))).toBe(true)
  })

  test("runs with the user's own permissions unless they set others for that command line", () => {
    const chosen = { ...settings, permissions: { claude: "acceptEdits", codex: "workspace-write" } }
    expect(planned().permissions).toBeUndefined()
    expect(planned({ settings: chosen }).permissions).toBe("acceptEdits")
    expect(planned({ settings: chosen, ...asking({ model: "gpt-6-astra" }) }).permissions).toBe("workspace-write")
  })

  test("says so up front when Codex will only be able to read, going by its own config", () => {
    expect(planned(asking({ model: "gpt-6-astra" })).warning).toBe(
      "Codex can look but not change anything there: it's read-only until its config or YAPD_CODEX_SANDBOX says otherwise.",
    )
    expect(planned({ readOnly: false, ...asking({ model: "gpt-6-astra" }) })).not.toHaveProperty("warning")
    expect(planned()).not.toHaveProperty("warning")
    expect(CliLauncher.readOnly('model = "gpt-6-astra"\n')).toBe(true)
    expect(CliLauncher.readOnly('sandbox_mode = "workspace-write"\n')).toBe(false)
  })
})

const fresh: CliLauncher.Fresh = { launch: "launch-1", name: "0a1b2c3d", now: "2026-09-29T18:00:00.000Z" }

/** Everything the launcher reaches for, with git answering by what each command starts with. */
const world = (overrides: Partial<CliLauncher.World> = {}, git: Record<string, string> = {}, calls: Array<string> = []) => {
  const answers: Record<string, string> = {
    "rev-parse --git-dir": ".git\n",
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
    "symbolic-ref --quiet --short HEAD": "feature\n",
    "worktree list": "worktree /code/free-sound\n",
    "rev-parse --verify --quiet refs/heads/main": "0a1b\n",
    "worktree add": "",
    "rev-parse --show-toplevel": "/somewhere\n",
    ...git,
  }
  const exec: Exec = (command) => {
    const asked = command.slice(3).join(" ")
    calls.push(asked)
    const [, answer] = Object.entries(answers).find(([start]) => asked.startsWith(start)) ?? []
    return answer === undefined ? Effect.fail(new ProcessError({ command: command.join(" "), code: 1, stderr: "" })) : Effect.succeed(answer)
  }
  const minded: Array<Sessions.Session> = []
  const noted: Array<Seen.Session> = []
  const given: CliLauncher.World = {
    exec,
    mind: (session) => Effect.sync(() => (minded.push(session), { ...session, session: session.session ?? "thread-1", state: "running" as const })),
    models: Effect.succeed(models),
    installed: both,
    projects: Effect.succeed([project, docs]),
    seen: Effect.succeed({}),
    note: (session) => Effect.sync(() => void noted.push(session)),
    past: () => Effect.succeed([]),
    readOnly: Effect.succeed(false),
    fresh: () => fresh,
    ...overrides,
  }
  return { launcher: CliLauncher.launcher(settings, given), minded, noted, calls }
}

const why = <A>(effect: Effect.Effect<A, LaunchError>) => Effect.runPromise(effect.pipe(Effect.flip, Effect.map(({ reason }) => reason)))

describe("CliLauncher's start", () => {
  test("starts Claude Code in the checkout, under an id it chose, and says how to pick it up", async () => {
    const { launcher, minded, noted, calls } = world()
    const started = await Effect.runPromise(launcher.start({ project: "free-sound", prompt: " Fix the loader. ", model: "fable", effort: "low" }))
    expect(started).toEqual({
      thread: "launch-1",
      project: "free-sound",
      directory: "/code/free-sound",
      branch: "feature",
      model: "claude-fable-5-1",
      effort: "low",
      worktree: false,
      resume: "cd /code/free-sound && claude --resume launch-1",
      log: Sessions.log("launch-1"),
    })
    expect(minded).toEqual([
      {
        launch: "launch-1",
        agent: "claude",
        session: "launch-1",
        project: "free-sound",
        directory: "/code/free-sound",
        repository: true,
        model: "claude-fable-5-1",
        effort: "low",
        prompt: "Fix the loader.",
        resume: false,
        state: "starting",
        at: "2026-09-29T18:00:00.000Z",
      },
    ])
    expect(noted).toEqual([{ directory: "/code/free-sound", agent: "claude", model: "claude-fable-5-1", effort: "low" }])
    expect(calls.some((call) => call.startsWith("worktree add"))).toBe(false)
  })

  test("starts Codex in a new worktree, under the id Codex gave it", async () => {
    const { launcher, minded, noted } = world()
    const started = await Effect.runPromise(launcher.start({ project: "free-sound", prompt: "Fix it.", model: "gpt-6-astra", worktree: true }))
    const directory = `${Sessions.folder.replace(/sessions$/, "worktrees")}/free-sound/yapd-0a1b2c3d`
    expect(started).toMatchObject({
      thread: "thread-1",
      directory,
      branch: "yapd/0a1b2c3d",
      worktree: true,
      resume: `cd ${directory} && codex resume thread-1`,
    })
    expect(minded[0]).toMatchObject({ agent: "codex", directory })
    expect(minded[0]).not.toHaveProperty("session")
    // What the project last used is kept under its checkout, wherever the work happens.
    expect(noted).toEqual([{ directory: "/code/free-sound", agent: "codex", model: "gpt-6-astra", effort: undefined }])
  })

  test("starts nothing when the worktree can't be made, and takes it away again when the session won't start", async () => {
    const { launcher, minded, noted } = world()
    expect(await why(launcher.start({ project: "free-sound", prompt: "Fix it.", model: "fable", worktree: true, baseBranch: "release" }))).toBe(
      "free-sound has no branch called release, so I didn't start anything.",
    )
    expect(minded).toEqual([])
    expect(noted).toEqual([])
    const calls: Array<string> = []
    const mind: Minder.Start = () => Effect.fail(new Minder.MindError({ reason: "Claude Code wouldn't start. Not signed in." }))
    const failing = world({ mind }, {}, calls)
    expect(await why(failing.launcher.start({ project: "free-sound", prompt: "Fix it.", model: "fable", worktree: true }))).toBe(
      "Claude Code wouldn't start. Not signed in.",
    )
    expect(calls.filter((call) => /^(worktree remove|branch -D)/.test(call))).toHaveLength(2)
    expect(failing.noted).toEqual([])
  })

  test("goes by what ran in the project and its worktrees when the request names no model", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const past = (directories: ReadonlyArray<string>) =>
      Effect.sync((): ReadonlyArray<Past> => {
        asked.push(directories)
        return [{ agent: "codex", directory: "/worktrees/free-sound/yapd-1", title: "Earlier", date: "2026-09-28T10:00:00.000Z", model: "gpt-6-astra", effort: "high" }]
      })
    const { launcher } = world({ past }, { "worktree list": "worktree /code/free-sound\n\nworktree /worktrees/free-sound/yapd-1\n" })
    expect(await Effect.runPromise(launcher.start({ project: "free-sound", prompt: "Fix it." }))).toMatchObject({ model: "gpt-6-astra", effort: "high" })
    expect(asked).toEqual([["/code/free-sound", "/worktrees/free-sound/yapd-1"]])
    expect(await why(world().launcher.start({ project: "free-sound", prompt: "Fix it." }))).toBe(
      "This project has no model to go by yet. Tell me which one to use.",
    )
  })
})

describe("CliLauncher's catalog", () => {
  const past: ReadonlyArray<Past> = [
    { agent: "claude", directory: "/worktrees/free-sound/yapd-1", title: "Fix latency", date: "2026-09-28T10:00:00.000Z", model: "claude-fable-5-1", effort: "high" },
    { agent: "codex", directory: "/code/free-sound/app", title: "Older", date: "2026-09-27T10:00:00.000Z", model: "gpt-6-astra" },
    { agent: "codex", directory: "/code/free-sound-2", title: "Another project's", date: "2026-09-29T10:00:00.000Z", model: "gpt-6-astra" },
  ]

  test("says where each project's work would start, with what, and what was done there lately", async () => {
    const { launcher } = world(
      { past: () => Effect.succeed(past), seen: Effect.succeed({ "/code/docs": { agent: "codex", model: "gpt-6-astra", effort: "low", at: "2026-09-29T18:00:00.000Z" } }) },
      { "worktree list": "worktree /code/free-sound\n\nworktree /worktrees/free-sound/yapd-1\n" },
    )
    const { projects, models: listed } = await Effect.runPromise(launcher.catalog)
    expect(projects[0]).toEqual({
      name: "free-sound",
      path: "/code/free-sound",
      repository: true,
      branch: "main",
      worktree: false,
      model: { name: "claude-fable-5-1", effort: "high" },
      recent: [
        { title: "Fix latency", date: "2026-09-28T10:00:00.000Z" },
        { title: "Older", date: "2026-09-27T10:00:00.000Z" },
      ],
    })
    expect(projects[1]).toMatchObject({ name: "docs", model: { name: "gpt-6-astra", effort: "low" } })
    expect(listed[0]).toEqual({ name: "claude-fable-5-1", title: "Fable 5.1", aliases: ["fable"], efforts: ["low", "high"] })
    expect(listed).toHaveLength(3)
  })
})

describe("CliLauncher's relay", () => {
  const session: Sessions.Session = {
    launch: "launch-1",
    agent: "codex",
    session: "thread-1",
    project: "free-sound",
    directory: "/worktrees/free-sound/yapd-0a1b2c3d",
    repository: true,
    model: "gpt-6-astra",
    effort: "high",
    permissions: "workspace-write",
    prompt: "Fix the loader.",
    resume: false,
    state: "idle",
    at: "2026-09-29T18:00:00.000Z",
  }
  const thread = (launched: boolean, agent: "claude" | "codex" = "codex"): Relay.Thread => ({
    agent,
    session: "thread-1",
    cwd: "/worktrees/free-sound/yapd-0a1b2c3d",
    message: "Done.",
    origin: launched ? { launched: true } : {},
  })
  const relay = (found: Sessions.Session | undefined, minded: Array<Sessions.Session>, mind?: Minder.Start) =>
    CliLauncher.relay(
      mind ?? ((turn) => Effect.sync(() => (minded.push(turn), { ...turn, state: "running" as const }))),
      (agent, id) => Effect.succeed(Option.fromNullable(found?.agent === agent && found.session === id ? found : undefined)),
    )
  const reason = (effect: Effect.Effect<void, Relay.Unreachable | Relay.RelayError>) =>
    Effect.runPromise(effect.pipe(Effect.flip, Effect.map((error) => (error._tag === "RelayError" ? error.reason : error._tag))))

  test("picks the session up for one more turn, with what it was started with", async () => {
    const minded: Array<Sessions.Session> = []
    await Effect.runPromise(relay({ ...session, state: "failed", error: "It stopped." }, minded).send(thread(true), "Merge it."))
    expect(minded).toHaveLength(1)
    expect(minded[0]).toMatchObject({ ...session, prompt: "Merge it.", resume: true, state: "starting", at: expect.any(String) })
    expect(minded[0]).not.toHaveProperty("error")
  })

  test("leaves alone what yapd didn't start headless, and a turn that's still running", async () => {
    const minded: Array<Sessions.Session> = []
    expect(await reason(relay(session, minded).send(thread(false), "Merge it."))).toBe("Unreachable")
    expect(await reason(relay(undefined, minded).send(thread(true), "Merge it."))).toBe("Unreachable")
    expect(await reason(relay(session, minded).send(thread(true, "claude"), "Merge it."))).toBe("Unreachable")
    expect(await reason(relay({ ...session, state: "running" }, minded).send(thread(true), "Merge it."))).toBe(
      "It's in the middle of another turn, so I didn't send it.",
    )
    expect(minded).toEqual([])
  })
})
