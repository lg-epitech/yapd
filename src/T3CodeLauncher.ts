import { Clock, Duration, Effect, Either, Option, type Redacted, Schema } from "effect"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { type Catalog, type Launcher, LaunchError, type Request, type Started } from "./Launcher.ts"
import { run } from "./Process.ts"
import * as Server from "./T3CodeServer.ts"
import type * as T3Live from "./T3Live.ts"

// Starts a thread the way T3 Code's app does when the user sends the first
// message of a new one: a single launch that creates the thread and has the
// server prepare its workspace, a worktree or the checkout, before the first
// turn. What the request leaves out follows the app's defaults, which the app
// works out itself, so they are worked out again here.

const Selection = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Union(Schema.String, Schema.Boolean) }))),
})
export type Selection = typeof Selection.Type

const Mode = Schema.Literal("local", "worktree")

/** The settings that decide how a thread starts. A project can override each of them. */
const Defaults = Schema.Struct({
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(Mode)),
  newWorktreesStartFromOrigin: Schema.optional(Schema.NullOr(Schema.Boolean)),
  defaultModelSelection: Schema.optional(Schema.NullOr(Selection)),
  defaultRuntimeMode: Schema.optional(Schema.NullOr(Schema.String)),
})

export const Settings = Schema.Struct({
  ...Defaults.fields,
  projectSettingsOverrides: Schema.optional(Schema.Record({ key: Schema.String, value: Defaults })),
  /** Once set, what projects used to carry themselves has moved into the overrides. */
  projectSettingsFolded: Schema.optional(Schema.Boolean),
})
export type Settings = typeof Settings.Type

const Project = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModelSelection: Schema.optional(Schema.NullOr(Selection)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(Mode)),
})
export type Project = typeof Project.Type

const Shell = Schema.Struct({
  projects: Schema.Array(Project),
  threads: Schema.Array(
    Schema.Struct({ projectId: Schema.String, title: Schema.String, modelSelection: Selection, updatedAt: Schema.String }),
  ),
})
export type Shell = typeof Shell.Type

const Provider = Schema.Struct({
  instanceId: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.String,
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      aliases: Schema.optional(Schema.Array(Schema.String)),
      capabilities: Schema.NullOr(
        Schema.Struct({
          optionDescriptors: Schema.optional(
            Schema.Array(
              Schema.Struct({ id: Schema.String, options: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))) }),
            ),
          ),
        }),
      ),
    }),
  ),
})
export type Provider = typeof Provider.Type

const Refs = Schema.Struct({
  isRepo: Schema.Boolean,
  refs: Schema.Array(Schema.Struct({ name: Schema.String, current: Schema.Boolean, isDefault: Schema.Boolean })),
})
export type Refs = typeof Refs.Type

/** `t3.json`, which a repository can carry to say how its threads start. */
const File = Schema.parseJson(Schema.Struct({ defaultThreadEnvMode: Schema.optional(Mode) }))

/** A launched thread, with the run its first message started. */
const Launched = Schema.Struct({
  projection: Schema.Struct({
    thread: Schema.Struct({ branch: Schema.NullOr(Schema.String), worktreePath: Schema.NullOr(Schema.String), modelSelection: Selection }),
    runs: Schema.Array(Schema.Struct({ status: Schema.String })),
  }),
})
type Launched = typeof Launched.Type

const home = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path)

/** The project a request names, by its title, its folder's name, or the path to its checkout. `resolve` canonicalizes paths. */
export const find = (
  projects: ReadonlyArray<Project>,
  wanted: string,
  resolve: (path: string) => string,
): Either.Either<Project, string> => {
  const name = wanted.trim()
  const path = name.startsWith("/") || name.startsWith("~")
  const folder = path ? resolve(home(name)) : name.toLowerCase()
  const matches = projects.filter((project) =>
    path
      ? resolve(project.workspaceRoot) === folder
      : project.title.toLowerCase() === folder || basename(project.workspaceRoot).toLowerCase() === folder,
  )
  const [project, ...others] = matches
  if (project === undefined) {
    return Either.left(`${path ? name : `"${name}"`} isn't a project in T3 Code, so I didn't start anything. Add it there first.`)
  }
  if (others.length > 0) return Either.left(`More than one project in T3 Code is called "${name}". Tell me its path instead.`)
  return Either.right(project)
}

/** The ways providers name how hard a model thinks. */
const efforts = ["effort", "reasoningEffort"]

const model = (providers: ReadonlyArray<Provider>, wanted: string, instance?: string) => {
  const name = wanted.trim().toLowerCase()
  return providers.flatMap((provider) =>
    (instance === undefined || provider.instanceId === instance) && provider.enabled && provider.status === "ready"
      ? provider.models
          .filter((model) => [model.slug, model.name, ...(model.aliases ?? [])].some((known) => known.toLowerCase() === name))
          .map((model) => ({ provider, model }))
      : [],
  )
}

/** The model a request means, with the options of the selection it builds on when that's the same model. */
export const select = (
  providers: ReadonlyArray<Provider>,
  request: Pick<Request, "model" | "effort">,
  fallback: Selection | undefined,
): Either.Either<Selection, string> => {
  if (request.model === undefined && fallback === undefined) {
    return Either.left("This project has no model to go by yet. Tell me which one to use.")
  }
  const wanted = request.model ?? fallback?.model ?? ""
  const [match, ...others] = model(providers, wanted, request.model === undefined ? fallback?.instanceId : undefined)
  if (match === undefined) return Either.left(`T3 Code has no model called ${wanted} that's ready to use.`)
  if (others.length > 0) return Either.left(`More than one provider in T3 Code has a model called ${wanted}.`)
  const kept =
    fallback?.instanceId === match.provider.instanceId && fallback.model === match.model.slug ? (fallback.options ?? []) : []
  if (request.effort === undefined) {
    return Either.right({ instanceId: match.provider.instanceId, model: match.model.slug, ...(kept.length > 0 ? { options: kept } : {}) })
  }
  const effort = request.effort.trim().toLowerCase()
  const option = match.model.capabilities?.optionDescriptors?.find(({ id }) => efforts.includes(id))
  const value = option?.options?.find(({ id }) => id.toLowerCase() === effort)
  if (option === undefined || value === undefined) return Either.left(`${match.model.name} has no effort called ${request.effort}.`)
  return Either.right({
    instanceId: match.provider.instanceId,
    model: match.model.slug,
    options: [{ id: option.id, value: value.id }, ...kept.filter(({ id }) => id !== option.id)],
  })
}

const effort = (selection: Selection) => {
  const value = selection.options?.find(({ id }) => efforts.includes(id))?.value
  return typeof value === "string" ? value : undefined
}

/** What the app would do in a project when nobody says: its override, then what it carries, then the settings. */
export const defaults = (settings: Settings, project: Project, file: "local" | "worktree" | undefined) => {
  const override = settings.projectSettingsOverrides?.[project.id]
  const own = settings.projectSettingsFolded === true ? undefined : project
  return {
    worktree:
      (override?.defaultThreadEnvMode ?? own?.defaultThreadEnvMode ?? file ?? settings.defaultThreadEnvMode ?? "local") === "worktree",
    fromOrigin: override?.newWorktreesStartFromOrigin ?? settings.newWorktreesStartFromOrigin ?? true,
    selection: override?.defaultModelSelection ?? own?.defaultModelSelection ?? settings.defaultModelSelection ?? undefined,
    runtimeMode: override?.defaultRuntimeMode ?? settings.defaultRuntimeMode ?? "full-access",
  }
}

const newest = (shell: Shell, project: Project) =>
  shell.threads.filter(({ projectId }) => projectId === project.id).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))

/** How the thread starts, once the request and the defaults are put together. */
export interface Plan {
  readonly project: Project
  readonly prompt: string
  readonly selection: Selection
  readonly runtimeMode: string
  /** The branch a worktree starts from, or the one the checkout is on. */
  readonly branch: string | null
  readonly worktree: boolean
  readonly fromOrigin: boolean
}

/**
 * T3 Code only finds out it can't make the worktree once the thread exists,
 * and then leaves it failed. What would make it fail is refused here, so
 * nothing is left behind and the reason is one that can be read out.
 */
export const plan = (input: {
  readonly request: Request
  readonly project: Project
  readonly settings: Settings
  /** The project's `t3.json`, when it has one that says. */
  readonly file: "local" | "worktree" | undefined
  readonly latest: Selection | undefined
  readonly providers: ReadonlyArray<Provider>
  readonly refs: Refs
  /** The refs like the base branch the request names, remote ones too. */
  readonly named: ReadonlyArray<string>
}): Either.Either<Plan, string> => {
  const { request, project, refs } = input
  const usual = defaults(input.settings, project, input.file)
  if (request.worktree === true && !refs.isRepo) {
    return Either.left(`${project.title} isn't a git repository, so it can't have a worktree. I didn't start anything.`)
  }
  const worktree = refs.isRepo && (request.worktree ?? usual.worktree)
  const fromOrigin = worktree && usual.fromOrigin
  const current = refs.refs.find((ref) => ref.current)?.name ?? null
  const asked = request.baseBranch?.trim() || undefined
  const branch = worktree ? (asked ?? refs.refs.find((ref) => ref.isDefault)?.name ?? current) : current
  if (worktree && branch === null) {
    return Either.left(`I can't tell which branch of ${project.title} to start from. Tell me which.`)
  }
  const missing =
    !worktree || asked === undefined || input.named.includes(asked)
      ? undefined
      : !input.named.includes(`origin/${asked}`)
        ? `${project.title} has no branch called ${asked}, so I didn't start anything.`
        : fromOrigin
          ? undefined
          : `${asked} is only on origin, and worktrees in ${project.title} don't start from there. I didn't start anything.`
  if (missing !== undefined) return Either.left(missing)
  return Either.map(select(input.providers, request, usual.selection ?? input.latest), (selection) => ({
    project,
    prompt: request.prompt.trim(),
    selection,
    runtimeMode: usual.runtimeMode,
    branch,
    worktree,
    fromOrigin,
  }))
}

/** T3 Code titles a thread itself as long as the title is still the one it was seeded with. */
export const title = (prompt: string) => (prompt.length <= 50 ? prompt : `${prompt.slice(0, 50)}...`)

/** What only this start has. T3 Code renames a branch of eight hex digits once it knows what the work is. */
export interface Fresh {
  readonly thread: string
  readonly message: string
  readonly command: string
  readonly branch: string
  readonly now: string
}

export const fresh = (): Fresh => ({
  thread: crypto.randomUUID(),
  message: crypto.randomUUID(),
  command: `yapd:${crypto.randomUUID()}`,
  branch: crypto.randomUUID().replaceAll("-", "").slice(0, 8),
  now: new Date().toISOString(),
})

/** A new thread and its first message. T3 Code picks the worktree's path, runs the project's setup there, and puts its own time on it. */
export const launch = (plan: Plan, fresh: Fresh) => ({
  commandId: fresh.command,
  creationSource: "web",
  threadId: fresh.thread,
  projectId: plan.project.id,
  title: title(plan.prompt),
  generateTitle: true,
  modelSelection: plan.selection,
  runtimeMode: plan.runtimeMode,
  interactionMode: "default",
  workspaceStrategy:
    plan.worktree && plan.branch !== null
      ? {
          type: "worktree",
          baseRef: plan.branch,
          branch: `t3code/${fresh.branch}`,
          ...(plan.fromOrigin ? { startFromOrigin: true } : {}),
        }
      : { type: "root", ...(plan.branch === null ? {} : { branch: plan.branch }) },
  initialMessage: { messageId: fresh.message, text: plan.prompt, attachments: [] },
})

/** How long T3 Code has to get new work ready, from when it's asked for: fetching and checking out a worktree can take minutes. */
export const preparation = "6 minutes"

/** Whether T3 Code is still getting a run's workspace ready, before its turn can start. */
const preparing = (status: string | null | undefined) => status === "preparing"

/** Whether a run ended short, which as its workspace is got ready means its turn never began, like when the worktree couldn't be made. */
const short = (status: string | null | undefined) => ["failed", "cancelled", "interrupted"].includes(status ?? "")

/** How a launched thread's first turn is getting on, its only run so far. */
const first = ({ projection }: Launched) => projection.runs.at(-1)?.status

/** How long after new work is asked for T3 Code can take to put it in the thread it made, a step of its own that it can be slow to get to. */
const handing = "1 minute"

/**
 * How new work is getting on, as T3 Code shows its thread, by the checks a
 * launch waits on: with no run, which T3 Code shows as idle, so the work isn't
 * in it yet; its workspace still being got ready; ended before its turn
 * began; or begun. Looked at later than a launch would, a turn that began and
 * ended since is begun all the same.
 */
export const progress = (thread: Pick<T3Live.Thread, "status" | "latestRunStartedAt">): "empty" | "preparing" | "unstarted" | "begun" =>
  thread.status === "idle"
    ? "empty"
    : preparing(thread.status)
      ? "preparing"
      : short(thread.status) && thread.latestRunStartedAt === null
        ? "unstarted"
        : "begun"

/**
 * New work's thread as `look` shows it once it's no longer being got ready,
 * or as it last did when a launch would have given up, looked at every second
 * meanwhile, as a launch looks: none if there's no thread for it. With no run,
 * it's waited for only as long after it was asked for, at `asked`, in ms, as
 * T3 Code can take to put the work in; still without it then, it's as good as
 * none, since the work may yet go in, so there's no saying it didn't start.
 */
export const readied = (look: Effect.Effect<Option.Option<T3Live.Thread>>, asked: number) =>
  Effect.gen(function* () {
    const until = asked + Duration.toMillis(preparation)
    const filled = Math.min(until, asked + Duration.toMillis(handing))
    /** Until when it's waited for, as it is now. */
    const waited = (thread: Option.Option<T3Live.Thread>) =>
      Option.match(Option.map(thread, progress), { onNone: () => 0, onSome: (now) => (now === "preparing" ? until : now === "empty" ? filled : 0) })
    let now = yield* look
    while ((yield* Clock.currentTimeMillis) < waited(now)) {
      yield* Effect.sleep("1 second")
      const next = yield* look
      if (Option.isSome(next)) now = next
    }
    return Option.filter(now, (thread) => progress(thread) !== "empty")
  })

/** Why new work T3 Code made a thread for didn't start: it couldn't get its workspace ready. */
export const unready = (worktree: boolean, project = "the project") =>
  `T3 Code ${worktree ? "couldn't make the worktree" : `couldn't get ${project} ready`}, so the thread it made didn't start.`

/**
 * Why new work didn't start, as T3 Code shows the thread it made for it once
 * it's been waited for, if it's known not to have: its workspace couldn't be
 * got ready. Begun, still being got ready, or with the work not in it yet,
 * which T3 Code may still put in, there's no saying it didn't.
 */
export const unstarted = (thread: Pick<T3Live.Thread, "status" | "latestRunStartedAt">, worktree: boolean, project?: string) =>
  progress(thread) === "unstarted" ? Option.some(unready(worktree, project)) : Option.none()

/** Why T3 Code wouldn't start it, to be read out. */
export const reason = (error: Server.Trouble | Server.Refusal) =>
  error._tag === "Trouble"
    ? error.reason
    : error.tag === "EnvironmentAuthorizationError"
      ? "My T3 Code token isn't allowed to start threads."
      : `T3 Code couldn't start it. ${error.message}`

/** What a project is to git, which says without T3 Code, and faster: it looks each one up in turn. */
export interface Repository {
  readonly repository: boolean
  /** What origin calls its main branch, or else the one that's checked out. */
  readonly branch: string | null
}

const git = (cwd: string, ...command: ReadonlyArray<string>) =>
  run(["git", "-C", cwd, ...command]).pipe(
    Effect.map((stdout) => stdout.trim()),
    Effect.orElseSucceed(() => ""),
  )

const repository = (cwd: string) =>
  Effect.all(
    [
      git(cwd, "rev-parse", "--git-dir"),
      git(cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
      git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD"),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(
      ([folder, main, current]): Repository => ({
        repository: folder !== "",
        branch: main.replace(/^origin\//, "") || current || null,
      }),
    ),
  )

/** How many of a project's threads the catalog names. */
const few = 5

export const catalog = (input: {
  readonly shell: Shell
  readonly settings: Settings
  readonly providers: ReadonlyArray<Provider>
  /** By project id. */
  readonly files: ReadonlyMap<string, "local" | "worktree" | undefined>
  readonly repositories: ReadonlyMap<string, Repository>
}): Catalog => ({
  projects: input.shell.projects.map((project) => {
    const usual = defaults(input.settings, project, input.files.get(project.id))
    const threads = newest(input.shell, project)
    // One that has since gone would be refused at the start, so whoever writes the request has to pick.
    const selection = [usual.selection ?? threads[0]?.modelSelection].find(
      (selection) => selection !== undefined && model(input.providers, selection.model, selection.instanceId).length > 0,
    )
    const level = selection === undefined ? undefined : effort(selection)
    const { repository = false, branch = null } = input.repositories.get(project.id) ?? {}
    return {
      name: project.title,
      path: project.workspaceRoot,
      repository,
      branch,
      worktree: repository && usual.worktree,
      ...(selection === undefined ? {} : { model: { name: selection.model, ...(level === undefined ? {} : { effort: level }) } }),
      recent: threads.slice(0, few).map(({ title, updatedAt }) => ({ title, date: updatedAt })),
    }
  }),
  models: input.providers.flatMap((provider) =>
    provider.enabled && provider.status === "ready"
      ? provider.models.map((model) => ({
          name: model.slug,
          title: model.name,
          aliases: [...(model.aliases ?? [])],
          efforts: (model.capabilities?.optionDescriptors?.find(({ id }) => efforts.includes(id))?.options ?? []).map(({ id }) => id),
        }))
      : [],
  ),
})

const canonical = (path: string) => realpath(path).catch(() => path)

const file = (project: Project) =>
  Effect.tryPromise(() => Bun.file(join(project.workspaceRoot, "t3.json")).text()).pipe(
    Effect.flatMap(Schema.decodeUnknown(File)),
    Effect.map(({ defaultThreadEnvMode }) => defaultThreadEnvMode),
    Effect.orElseSucceed(() => undefined),
  )

const Providers = Schema.Struct({ providers: Schema.Array(Provider) })

const heard = <A, R>(effect: Effect.Effect<A, LaunchError | Server.Trouble | Server.Refusal, R>) =>
  effect.pipe(
    Effect.catchTags({
      Trouble: (error) =>
        Effect.fail(new LaunchError({ reason: reason(error), cause: error.cause, ...(error.sent === true ? { sent: true } : {}) })),
      Refusal: (error) => Effect.fail(new LaunchError({ reason: reason(error), cause: error })),
    }),
  )

export const launcher = (
  token: Redacted.Redacted,
  reach: Effect.Effect<Server.Transport, Server.Trouble> = Server.connect(token),
  ids: () => Fresh = fresh,
): Launcher => ({
  start: (request) =>
    Effect.gen(function* () {
      const refuse = (reason: string) => new LaunchError({ reason })
      const { api, call } = yield* reach

      const shell = yield* api("/api/orchestration/shell", Shell)
      const paths = [home(request.project.trim()), ...shell.projects.map(({ workspaceRoot }) => workspaceRoot)]
      const resolved = new Map(yield* Effect.promise(() => Promise.all(paths.map(async (path) => [path, await canonical(path)] as const))))
      const project = yield* Either.mapLeft(find(shell.projects, request.project, (path) => resolved.get(path) ?? path), refuse)

      const base = request.baseBranch?.trim() || undefined
      const [settings, { providers }, refs, named, mode] = yield* Effect.all(
        [
          call("server.getSettings", {}, Settings),
          call("server.getConfig", {}, Providers),
          call("vcs.listRefs", { cwd: project.workspaceRoot, refKind: "local", limit: 200 }, Refs),
          base === undefined
            ? Effect.succeed([])
            : call(
                "vcs.listRefs",
                { cwd: project.workspaceRoot, query: base, refKind: "all", includeMatchingRemoteRefs: true, limit: 200 },
                Refs,
              ).pipe(Effect.map(({ refs }) => refs.map(({ name }) => name))),
          file(project),
        ],
        { concurrency: "unbounded" },
      )
      const latest = newest(shell, project)[0]?.modelSelection
      const decided = yield* Either.mapLeft(plan({ request, project, settings, file: mode, latest, providers, refs, named }), refuse)

      // Under the ids yapd wrote down before asking, when it did, so asking again starts it once.
      const started = request.ids === undefined ? ids() : { ...ids(), ...request.ids }
      /** Whether T3 Code took the launch, after which whatever goes wrong may have left it started. */
      let asked = false
      const prepared = yield* Effect.gen(function* () {
        let launched = yield* call("orchestration.launchThread", launch(decided, started), Launched, "30 seconds")
        asked = true
        // T3 Code gets the workspace ready after answering. Fetching and checking out can take minutes.
        while (preparing(first(launched))) {
          yield* Effect.sleep("1 second")
          launched = yield* api(`/api/orchestration/threads/${encodeURIComponent(started.thread)}/bounded`, Launched)
        }
        return launched
      }).pipe(
        Effect.timeoutFail({ duration: preparation, onTimeout: () => new Server.Trouble({ reason: "T3 Code is taking too long." }) }),
        Effect.mapError((error) =>
          error._tag !== "Trouble"
            ? error
            : error.reason === "T3 Code is taking too long."
              ? new Server.Trouble({ reason: "T3 Code is taking too long, so I don't know if it started.", sent: true })
              : asked
                ? new Server.Trouble({ ...error, sent: true })
                : error,
        ),
      )
      if (short(first(prepared))) return yield* new LaunchError({ reason: unready(decided.worktree, project.title) })
      const { thread } = prepared.projection
      const level = effort(thread.modelSelection)
      return {
        thread: started.thread,
        project: project.title,
        directory: thread.worktreePath ?? project.workspaceRoot,
        branch: thread.branch,
        model: thread.modelSelection.model,
        ...(level === undefined ? {} : { effort: level }),
        worktree: thread.worktreePath !== null,
      } satisfies Started
    }).pipe(heard),

  catalog: Effect.gen(function* () {
    const { api, call } = yield* reach
    const [shell, settings, { providers }] = yield* Effect.all(
      [
        api("/api/orchestration/shell", Shell),
        call("server.getSettings", {}, Settings),
        call("server.getConfig", {}, Providers),
      ],
      { concurrency: "unbounded" },
    )
    const each = <A>(look: (project: Project) => Effect.Effect<A>) =>
      Effect.forEach(shell.projects, (project) => Effect.map(look(project), (found) => [project.id, found] as const), {
        concurrency: "unbounded",
      }).pipe(Effect.map((found) => new Map(found)))
    const [files, repositories] = yield* Effect.all([each(file), each(({ workspaceRoot }) => repository(workspaceRoot))], {
      concurrency: "unbounded",
    })
    return catalog({ shell, settings, providers, files, repositories })
  }).pipe(heard),
})
