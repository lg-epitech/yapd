import { describe, expect, test } from "bun:test"
import { Effect, Either, Option } from "effect"
import type { Exec, Model } from "./Cli.ts"
import * as CliLauncher from "./CliLauncher.ts"
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
    expect(Either.isLeft(CliLauncher.find([project], "yapd", same))).toBe(true)
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
    expect(Either.isLeft(plan({ usual: undefined }))).toBe(true)
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
    expect(Either.isLeft(plan({ repository: outside, ...asking({ model: "fable", worktree: true }) }))).toBe(true)
    expect(Either.isLeft(plan({ repository: { repository: true, branch: null, current: null }, ...asking({ worktree: true }) }))).toBe(true)
  })
})

const fresh: CliLauncher.Fresh = { launch: "launch-1", name: "0a1b2c3d", now: "2026-09-29T18:00:00.000Z" }

/** Everything the launcher reaches for, with git answering by what each command starts with. */
const world = (overrides: Partial<CliLauncher.World> = {}, calls: Array<string> = []) => {
  const answers: Record<string, string> = {
    "rev-parse --git-dir": ".git\n",
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
    "symbolic-ref --quiet --short HEAD": "feature\n",
    "worktree list": "worktree /code/free-sound\n",
    "rev-parse --verify --quiet refs/heads/main": "0a1b\n",
    "worktree add": "",
    "rev-parse --show-toplevel": "/somewhere\n",
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

/** Runs it, expecting it to fail. */
const fails = <A>(effect: Effect.Effect<A, LaunchError>) => Effect.runPromise(Effect.flip(effect))

describe("CliLauncher's start", () => {
  test("starts nothing when the worktree can't be made, and takes it away again when the session won't start", async () => {
    const { launcher, minded, noted } = world()
    await fails(launcher.start({ project: "free-sound", prompt: "Fix it.", model: "fable", worktree: true, baseBranch: "release" }))
    expect(minded).toEqual([])
    expect(noted).toEqual([])
    const calls: Array<string> = []
    const mind: Minder.Start = () => Effect.fail(new Minder.MindError({ reason: "Claude Code wouldn't start. Not signed in." }))
    const failing = world({ mind }, calls)
    await fails(failing.launcher.start({ project: "free-sound", prompt: "Fix it.", model: "fable", worktree: true }))
    expect(calls.filter((call) => /^(worktree remove|branch -D)/.test(call))).toHaveLength(2)
    expect(failing.noted).toEqual([])
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
  const relay = (found: Sessions.Session | undefined, minded: Array<Sessions.Session>) =>
    CliLauncher.relay(
      (turn) => Effect.sync(() => (minded.push(turn), { ...turn, state: "running" as const })),
      (agent, id) => Effect.succeed(Option.fromNullable(found?.agent === agent && found.session === id ? found : undefined)),
    )
  const reason = (effect: Effect.Effect<void, Relay.Unreachable | Relay.RelayError>) =>
    Effect.runPromise(effect.pipe(Effect.flip, Effect.map((error) => error._tag)))

  test("leaves alone what yapd didn't start headless, and a turn that's still running", async () => {
    const minded: Array<Sessions.Session> = []
    expect(await reason(relay(session, minded).send(thread(false), "Merge it."))).toBe("Unreachable")
    expect(await reason(relay(undefined, minded).send(thread(true), "Merge it."))).toBe("Unreachable")
    expect(await reason(relay(session, minded).send(thread(true, "claude"), "Merge it."))).toBe("Unreachable")
    expect(await reason(relay({ ...session, state: "running" }, minded).send(thread(true), "Merge it."))).toBe("RelayError")
    expect(minded).toEqual([])
  })
})
