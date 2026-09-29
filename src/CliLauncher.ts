import { Effect, Either, Option } from "effect"
import { readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import * as Cli from "./Cli.ts"
import * as History from "./History.ts"
import { expand } from "./Home.ts"
import { type Catalog, type Launcher, LaunchError, type Request, type Started } from "./Launcher.ts"
import * as Minder from "./Minder.ts"
import type { Agent } from "./Payload.ts"
import { type Relay, RelayError, Unreachable } from "./Relay.ts"
import * as Seen from "./Seen.ts"
import * as Sessions from "./Sessions.ts"
import * as Worktree from "./Worktree.ts"

// Starts sessions with the agents' own command lines, for whoever doesn't use
// T3 Code. There's no app to ask what the projects are or what they default
// to, so the projects are the repositories in the folders the user lists and
// the ones agents have been seen in, and the defaults are what each last ran
// with. The sessions are headless: a turn is a process that ends with it, and
// a follow-up picks the session up again for one more.

/** What the user set for the sessions yapd starts. */
export interface Settings {
  /** Folders whose repositories are projects. */
  readonly folders: ReadonlyArray<string>
  /** Whether work gets a worktree when the request doesn't say. */
  readonly worktree: boolean
  /** Claude Code's permission mode and Codex's sandbox. Unset, each runs as the user set it up. */
  readonly permissions: { readonly claude: string | undefined; readonly codex: string | undefined }
}

export interface Project {
  readonly name: string
  readonly path: string
}

/** What a project last ran with. */
export interface Usual {
  readonly agent: Agent
  readonly model: string
  readonly effort?: string | undefined
}

/** The project a request names, by its folder's name or the path to its checkout. `resolve` canonicalizes paths. */
export const find = (projects: ReadonlyArray<Project>, wanted: string, resolve: (path: string) => string): Either.Either<Project, string> => {
  const name = wanted.trim()
  const path = name.startsWith("/") || name.startsWith("~")
  const folder = path ? resolve(expand(name)) : name.toLowerCase()
  const [project, ...others] = projects.filter((project) =>
    path ? resolve(project.path) === folder : project.name.toLowerCase() === folder,
  )
  if (project === undefined) {
    return Either.left(
      `${path ? name : `"${name}"`} isn't a project I know here, so I didn't start anything. Its folder needs adding to YAPD_PROJECTS.`,
    )
  }
  if (others.length > 0) return Either.left(`More than one project here is called "${name}". Tell me its path instead.`)
  return Either.right(project)
}

/** How the session starts, once the request and what the project last ran with are put together. */
export interface Plan {
  readonly project: Project
  readonly prompt: string
  readonly agent: Agent
  readonly model: string
  readonly effort: string | undefined
  readonly permissions: string | undefined
  readonly worktree: boolean
  /** The branch a worktree starts from. */
  readonly base: string | null
  readonly warning?: string
}

const model = (input: {
  readonly request: Pick<Request, "model" | "effort">
  readonly usual: Usual | undefined
  readonly models: ReadonlyArray<Cli.Model>
  readonly installed: ReadonlySet<Agent>
}): Either.Either<{ readonly model: Cli.Model; readonly effort: string | undefined }, string> => {
  const { request, usual, models, installed } = input
  if (request.model === undefined && usual === undefined) {
    return Either.left("This project has no model to go by yet. Tell me which one to use.")
  }
  const picked =
    request.model !== undefined
      ? Cli.pick(models, request.model, installed)
      : usual === undefined || !installed.has(usual.agent)
        ? Either.left(`${usual?.agent === "codex" ? "Codex" : "Claude Code"}, which this project last used, isn't installed here. Tell me which model to use.`)
        : Either.orElse(
            Cli.pick(models.filter(({ agent }) => agent === usual.agent), usual.model, new Set()),
            // The project really ran with it, which says more than a list that may be behind.
            () => Either.right<Cli.Model>({ agent: usual.agent, name: usual.model, title: usual.model, aliases: [], efforts: [] }),
          )
  return Either.flatMap(picked, (model) => {
    // A model that isn't on the list has no efforts to check against.
    const listed = models.includes(model)
    if (request.effort === undefined) {
      const kept = usual?.agent === model.agent && usual.model === model.name ? usual.effort : undefined
      return Either.right({ model, effort: kept !== undefined && (!listed || model.efforts.includes(kept)) ? kept : undefined })
    }
    const asked = request.effort.trim().toLowerCase()
    const effort = listed ? model.efforts.find((effort) => effort.toLowerCase() === asked) : asked
    return effort === undefined ? Either.left(`${model.title} has no effort called ${request.effort}.`) : Either.right({ model, effort })
  })
}

export const plan = (input: {
  readonly request: Request
  readonly project: Project
  readonly repository: Worktree.Repository
  readonly usual: Usual | undefined
  readonly models: ReadonlyArray<Cli.Model>
  readonly installed: ReadonlySet<Agent>
  readonly settings: Settings
  /** Whether Codex, left to the user's own config, may only read. */
  readonly readOnly: boolean
}): Either.Either<Plan, string> => {
  const { request, project, repository, settings } = input
  if (request.worktree === true && !repository.repository) {
    return Either.left(`${project.name} isn't a git repository, so it can't have a worktree. I didn't start anything.`)
  }
  const worktree = repository.repository && (request.worktree ?? settings.worktree)
  const base = worktree ? (request.baseBranch?.trim() || repository.branch) : null
  if (worktree && base === null) return Either.left(`I can't tell which branch of ${project.name} to start from. Tell me which.`)
  return Either.map(model(input), ({ model, effort }) => {
    const permissions = settings.permissions[model.agent]
    return {
      project,
      prompt: request.prompt.trim(),
      agent: model.agent,
      model: model.name,
      effort,
      permissions,
      worktree,
      base,
      ...(model.agent === "codex" && permissions === undefined && input.readOnly
        ? { warning: "Codex can look but not change anything there: it's read-only until its config or YAPD_CODEX_SANDBOX says otherwise." }
        : {}),
    }
  })
}

/** What only this start has. */
export interface Fresh {
  /** Names the session's files, and the session itself for Claude Code, which takes its id. */
  readonly launch: string
  /** Names the worktree and its branch. */
  readonly name: string
  readonly now: string
}

export const fresh = (): Fresh => ({
  launch: crypto.randomUUID(),
  name: crypto.randomUUID().replaceAll("-", "").slice(0, 8),
  now: new Date().toISOString(),
})

/** How many of a project's sessions the catalog names. */
const few = 5

const inside = (directory: string, folder: string) => directory === folder || directory.startsWith(`${folder}/`)

/** What a project last ran with: what yapd saw, or else what the command lines remember. */
export const usual = (seen: Seen.Entry | undefined, past: ReadonlyArray<History.Past>): Usual | undefined => {
  if (seen?.model !== undefined) return { agent: seen.agent, model: seen.model, effort: seen.effort }
  // Seen with an agent but no model, the agent is still what to go by.
  const latest = past.find((session) => session.model !== undefined && (seen === undefined || session.agent === seen.agent))
  return latest?.model === undefined ? undefined : { agent: latest.agent, model: latest.model, effort: latest.effort }
}

export const catalog = (input: {
  readonly projects: ReadonlyArray<Project>
  readonly settings: Settings
  readonly models: ReadonlyArray<Cli.Model>
  readonly installed: ReadonlySet<Agent>
  /** By the project's path. */
  readonly repositories: ReadonlyMap<string, Worktree.Repository>
  readonly seen: Seen.Seen
  /** Each project's sessions, newest first. */
  readonly past: ReadonlyMap<string, ReadonlyArray<History.Past>>
}): Catalog => ({
  projects: input.projects.map((project) => {
    const { repository = false, branch = null } = input.repositories.get(project.path) ?? {}
    const past = input.past.get(project.path) ?? []
    const last = usual(input.seen[project.path], past)
    // One whose command line has since gone would be refused at the start, so whoever writes the request has to pick.
    const model = last !== undefined && input.installed.has(last.agent) ? last : undefined
    return {
      name: project.name,
      path: project.path,
      repository,
      branch,
      worktree: repository && input.settings.worktree,
      ...(model === undefined ? {} : { model: { name: model.model, ...(model.effort === undefined ? {} : { effort: model.effort }) } }),
      recent: past.slice(0, few).map(({ title, date }) => ({ title, date })),
    }
  }),
  models: input.models.map(({ name, title, aliases, efforts }) => ({ name, title, aliases: [...aliases], efforts: [...efforts] })),
})

/** What the launcher reaches outside itself for, so tests can stand in for it. */
export interface World {
  readonly exec: Cli.Exec
  readonly mind: Minder.Start
  readonly models: Effect.Effect<ReadonlyArray<Cli.Model>>
  readonly installed: ReadonlySet<Agent>
  readonly projects: Effect.Effect<ReadonlyArray<Project>>
  readonly seen: Effect.Effect<Seen.Seen>
  readonly note: (session: Seen.Session) => Effect.Effect<void>
  /** The sessions that ran in any of the directories, newest first. */
  readonly past: (directories: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<History.Past>>
  readonly readOnly: Effect.Effect<boolean>
  readonly fresh: () => Fresh
}

const canonical = (path: string) => realpath(path).catch(() => path)

/** The repositories directly inside the folders, and the projects agents were seen in that are still there. */
export const known = (folders: ReadonlyArray<string>, seen: Effect.Effect<Seen.Seen>) =>
  Effect.gen(function* () {
    const noted = Object.keys(yield* seen)
    return yield* Effect.promise(async () => {
      const listed = await Promise.all(
        folders.map(async (folder) => {
          const root = expand(folder)
          const children = await readdir(root).catch(() => [])
          // A file rather than a folder in a worktree, which is a checkout all the same.
          const found = await Promise.all(children.map(async (child) => ((await exists(join(root, child, ".git"))) ? [join(root, child)] : [])))
          return found.flat()
        }),
      )
      const there = await Promise.all(noted.map(async (path) => ((await isFolder(path)) ? [path] : [])))
      const paths = await Promise.all([...listed.flat(), ...there.flat()].map(canonical))
      return [...new Set(paths)].map((path): Project => ({ name: basename(path), path }))
    })
  })

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

const isFolder = (path: string) =>
  stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  )

/** Whether Codex's own config leaves `codex exec` with its default sandbox, which only reads. */
export const readOnly = (config: string) => {
  try {
    const mode = (Bun.TOML.parse(config) as { readonly sandbox_mode?: unknown }).sandbox_mode
    return mode === undefined || mode === "read-only"
  } catch {
    return true
  }
}

const past = (directories: ReadonlyArray<string>) =>
  Effect.all(
    [History.codex, Effect.forEach(directories, (directory) => History.claude(directory, few), { concurrency: 8 })],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([codex, claude]) =>
      [...codex.filter(({ directory }) => directories.some((folder) => inside(directory, folder))), ...claude.flat()].toSorted((a, b) =>
        b.date.localeCompare(a.date),
      ),
    ),
  )

export const world = (settings: Settings): World => ({
  exec: Cli.exec,
  mind: Minder.start,
  models: Cli.models(),
  installed: Cli.installed(),
  projects: known(settings.folders, Seen.read()),
  seen: Seen.read(),
  note: (session) => Seen.note(session),
  past,
  readOnly: Effect.promise(() =>
    Bun.file(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"))
      .text()
      .then(readOnly, () => true),
  ),
  fresh,
})

/** A project's checkout and worktrees, which is everywhere work on it happens. */
const places = (world: World, project: Project) =>
  Effect.gen(function* () {
    const listed = yield* Worktree.list(world.exec, project.path)
    const paths = yield* Effect.promise(() => Promise.all([project.path, ...listed].map(canonical)))
    return [...new Set(paths)]
  })

export const launcher = (settings: Settings, given: World = world(settings)): Launcher => ({
  start: (request) =>
    Effect.gen(function* () {
      const refuse = (reason: string) => new LaunchError({ reason })
      const projects = yield* given.projects
      // Projects are listed by their canonical paths, so only what the request names needs resolving.
      const named = expand(request.project.trim())
      const wanted = yield* Effect.promise(() => canonical(named))
      const project = yield* Either.mapLeft(find(projects, request.project, (path) => (path === named ? wanted : path)), refuse)
      const [repository, models, seen, readOnly, sessions] = yield* Effect.all(
        [
          Worktree.repository(given.exec, project.path),
          given.models,
          given.seen,
          given.readOnly,
          // Only a request that names no model has to go by what ran before.
          request.model === undefined ? Effect.flatMap(places(given, project), given.past) : Effect.succeed([]),
        ],
        { concurrency: "unbounded" },
      )
      const decided = yield* Either.mapLeft(
        plan({
          request,
          project,
          repository,
          usual: usual(seen[project.path], sessions),
          models,
          installed: given.installed,
          settings,
          readOnly,
        }),
        refuse,
      )

      const ids = given.fresh()
      const made =
        decided.worktree && decided.base !== null
          ? yield* Worktree.make(given.exec, { project, base: decided.base, name: ids.name })
          : undefined
      const directory = made?.path ?? project.path
      const session = yield* given
        .mind({
          launch: ids.launch,
          agent: decided.agent,
          ...(decided.agent === "claude" ? { session: ids.launch } : {}),
          project: project.name,
          directory,
          repository: repository.repository,
          model: decided.model,
          ...(decided.effort === undefined ? {} : { effort: decided.effort }),
          ...(decided.permissions === undefined ? {} : { permissions: decided.permissions }),
          prompt: decided.prompt,
          resume: false,
          state: "starting",
          at: ids.now,
        })
        // Nothing started in it, so it's taken away again rather than left for the user to find.
        .pipe(Effect.tapError(() => (made === undefined ? Effect.void : Worktree.remove(given.exec, project.path, made))))
      yield* given.note({ directory: project.path, agent: decided.agent, model: decided.model, effort: decided.effort })

      const thread = session.session ?? ids.launch
      const warnings = [made?.warning, decided.warning].filter((warning) => warning !== undefined)
      return {
        thread,
        project: project.name,
        directory,
        branch: made?.branch ?? repository.current,
        model: decided.model,
        ...(decided.effort === undefined ? {} : { effort: decided.effort }),
        worktree: made !== undefined,
        resume: Cli.resume(decided.agent, thread, directory),
        log: Sessions.log(ids.launch),
        ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }),
      } satisfies Started
    }).pipe(
      Effect.catchTags({
        MindError: ({ reason }) => Effect.fail(new LaunchError({ reason })),
        WorktreeError: ({ reason, cause }) => Effect.fail(new LaunchError({ reason, cause })),
      }),
    ),

  catalog: Effect.gen(function* () {
    const [projects, models, seen] = yield* Effect.all([given.projects, given.models, given.seen], { concurrency: "unbounded" })
    const each = yield* Effect.forEach(
      projects,
      (project) =>
        Effect.all([Worktree.repository(given.exec, project.path), places(given, project)], { concurrency: "unbounded" }).pipe(
          Effect.map(([repository, directories]) => ({ project, repository, directories })),
        ),
      { concurrency: 8 },
    )
    // Asked once for every project's directories, since Codex's threads are read whole each time.
    const sessions = yield* given.past(each.flatMap(({ directories }) => directories))
    return catalog({
      projects,
      settings,
      models,
      installed: given.installed,
      repositories: new Map(each.map(({ project, repository }) => [project.path, repository])),
      seen,
      past: new Map(
        each.map(({ project, directories }) => [
          project.path,
          sessions.filter(({ directory }) => directories.some((folder) => inside(directory, folder))),
        ]),
      ),
    })
  }),
})

/**
 * Follow-ups to the sessions yapd started, which have no terminal to type
 * into and no hook that waits: the session is picked up for one more turn,
 * with what it was started with. Only a turn that ran headless is answered
 * this way, since picking up a session the user has open in a terminal would
 * fork it behind their back.
 */
export const relay = (mind: Minder.Start = Minder.start, find: typeof Sessions.find = Sessions.find): Relay => ({
  send: (thread, text) =>
    thread.origin.launched !== true
      ? Effect.fail(new Unreachable())
      : Effect.gen(function* () {
          const found = yield* find(thread.agent, thread.session)
          if (Option.isNone(found)) return yield* new Unreachable()
          const session = found.value
          if (session.state === "starting" || session.state === "running") {
            return yield* new RelayError({ reason: "It's in the middle of another turn, so I didn't send it." })
          }
          const { error: _, ...rest } = session
          yield* mind({ ...rest, prompt: text, resume: true, state: "starting", at: new Date().toISOString() }).pipe(
            Effect.mapError(({ reason }) => new RelayError({ reason })),
          )
        }),
})
