import { Effect } from "effect"
import { basename, dirname } from "node:path"
import { run } from "./Process.ts"

/**
 * The repository's name, from git's shared directory: `/repo/.git`, or `/repo.git` when bare.
 * Worktrees all point back to it, so one checked out as `t3code-cb8fc788` still says `repo`.
 */
export const fromCommonDir = (commonDir: string) => {
  const dir = commonDir.replace(/\/+$/, "")
  return basename(dir) === ".git" ? basename(dirname(dir)) : basename(dir).replace(/\.git$/, "")
}

/** What to call the project in `cwd`: its repository, or just the directory outside of one. */
export const name = (cwd: string) =>
  run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.map((stdout) => fromCommonDir(stdout.trim())),
    Effect.filterOrFail((project) => project !== ""),
    Effect.orElseSucceed(() => basename(cwd)),
  )
