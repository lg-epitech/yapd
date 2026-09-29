import { Data, Effect } from "effect"
import { basename, join } from "node:path"
import type { Exec } from "./Cli.ts"
import { home } from "./Home.ts"

// Worktrees for work started from the command line, made with plain git and
// laid out like T3 Code's: ~/.yapd/worktrees/<repository>/yapd-<8 hex>, on a
// branch called yapd/<8 hex>. Work that was meant for one must never land in
// the project's checkout instead, so whatever keeps one from being made is a
// refusal, and nothing starts.

export const folder = join(home, "worktrees")

/** No worktree was made. The reason is read out. */
export class WorktreeError extends Data.TaggedError("WorktreeError")<{ readonly reason: string; readonly cause?: unknown }> {}

/** What a project is to git. */
export interface Repository {
  readonly repository: boolean
  /** What origin calls its main branch, or else the one that's checked out. */
  readonly branch: string | null
  /** The branch that's checked out, which work in the checkout happens on. */
  readonly current: string | null
}

const git = (exec: Exec, cwd: string, ...command: ReadonlyArray<string>) => exec(["git", "-C", cwd, ...command])

const quiet = (exec: Exec, cwd: string, ...command: ReadonlyArray<string>) =>
  git(exec, cwd, ...command).pipe(
    Effect.map((stdout) => stdout.trim()),
    Effect.orElseSucceed(() => ""),
  )

export const repository = (exec: Exec, cwd: string) =>
  Effect.all(
    [
      quiet(exec, cwd, "rev-parse", "--git-dir"),
      quiet(exec, cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
      quiet(exec, cwd, "symbolic-ref", "--quiet", "--short", "HEAD"),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(
      ([folder, main, current]): Repository => ({
        repository: folder !== "",
        branch: main.replace(/^origin\//, "") || current || null,
        current: current || null,
      }),
    ),
  )

/** The checkout's own worktrees, itself included, since sessions in any of them are work on the project. */
export const list = (exec: Exec, cwd: string) =>
  quiet(exec, cwd, "worktree", "list", "--porcelain").pipe(
    Effect.map((stdout) => stdout.split("\n").flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []))),
  )

export interface Made {
  readonly path: string
  readonly branch: string
  /** What didn't go as it should, though the worktree was made. */
  readonly warning?: string
}

export const path = (project: string, name: string, root: string = folder) => join(root, basename(project), `yapd-${name}`)

const said = (cause: { readonly stderr: string }) => cause.stderr.trim().split("\n").at(-1)?.replace(/^(fatal|error): /, "") ?? ""

/**
 * A new worktree of the project on a branch of its own, started from the
 * base as origin has it when there's an origin, fetched first so it isn't
 * behind. `name` is eight hex digits, new each time.
 */
export const make = (
  exec: Exec,
  input: { readonly project: { readonly name: string; readonly path: string }; readonly base: string; readonly name: string },
  root: string = folder,
) =>
  Effect.gen(function* () {
    const { project } = input
    const base = input.base.trim().replace(/^origin\//, "")
    // A leading dash would be read as an option.
    if (base === "" || base.startsWith("-")) {
      return yield* new WorktreeError({ reason: `I can't tell which branch of ${project.name} to start from. Tell me which.` })
    }
    const has = (ref: string) => Effect.map(quiet(exec, project.path, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`), (sha) => sha !== "")
    const origin = (yield* quiet(exec, project.path, "remote", "get-url", "origin")) !== ""
    const fetched = origin
      ? yield* git(exec, project.path, "fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`).pipe(
          Effect.timeout("1 minute"),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      : false
    const start = (yield* has(`refs/remotes/origin/${base}`)) ? `origin/${base}` : (yield* has(`refs/heads/${base}`)) ? base : undefined
    if (start === undefined) {
      return yield* new WorktreeError({ reason: `${project.name} has no branch called ${base}, so I didn't start anything.` })
    }
    const made = path(project.path, input.name, root)
    const branch = `yapd/${input.name}`
    // Not tracking the base, or a push from the new branch could be taken for one to it.
    yield* git(exec, project.path, "worktree", "add", "--no-track", "-b", branch, made, start).pipe(
      Effect.timeoutFail({ duration: "5 minutes", onTimeout: () => ({ stderr: "git took too long" }) }),
      Effect.mapError(
        (cause) => new WorktreeError({ reason: `I couldn't make the worktree, so I didn't start anything. Git says: ${said(cause)}.`, cause }),
      ),
    )
    // Git's word that it's there, since an agent started in a folder that isn't one would work somewhere else.
    if ((yield* quiet(exec, made, "rev-parse", "--show-toplevel")) === "") {
      return yield* new WorktreeError({ reason: "The worktree isn't where git said it made it, so I didn't start anything." })
    }
    return {
      path: made,
      branch,
      ...(origin && !fetched && start.startsWith("origin/")
        ? { warning: `I couldn't fetch from origin, so it starts from ${base} as it was when last fetched.` }
        : {}),
    } satisfies Made
  })

/** Takes a worktree away again, with its branch, when nothing started in it. */
export const remove = (exec: Exec, project: string, made: Made) =>
  Effect.zipRight(
    Effect.ignore(git(exec, project, "worktree", "remove", "--force", made.path)),
    Effect.ignore(git(exec, project, "branch", "-D", made.branch)),
  )
