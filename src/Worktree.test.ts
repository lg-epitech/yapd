import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Exec } from "./Cli.ts"
import { ProcessError } from "./Process.ts"
import * as Worktree from "./Worktree.ts"

const project = { name: "free-sound", path: "/code/free-sound" }
const made = "/home/worktrees/free-sound/yapd-0a1b2c3d"

/** Git, answering each command by what it starts with. What has no answer fails, as git does on a ref that isn't there. */
const git = (answers: Record<string, string | number>, calls: Array<string> = []): Exec =>
  (command) => {
    const asked = command.slice(3).join(" ")
    calls.push(`${command[2]}: ${asked}`)
    const [, answer] = Object.entries(answers).find(([start]) => asked.startsWith(start)) ?? []
    return typeof answer === "string"
      ? Effect.succeed(answer)
      : Effect.fail(new ProcessError({ command: command.join(" "), code: answer ?? 1, stderr: "fatal: a branch named 'yapd/0a1b2c3d' already exists" }))
  }

const make = (exec: Exec, base = "main") => Worktree.make(exec, { project, base, name: "0a1b2c3d" }, "/home/worktrees")

const why = <A>(effect: Effect.Effect<A, Worktree.WorktreeError>) => Effect.runPromise(effect.pipe(Effect.flip, Effect.map(({ reason }) => reason)))

const withOrigin = {
  "remote get-url origin": "git@example.com:me/free-sound.git\n",
  "fetch origin": "",
  "rev-parse --verify --quiet refs/remotes/origin/main": "0a1b\n",
  "worktree add": "",
  "rev-parse --show-toplevel": `${made}\n`,
}

describe("Worktree", () => {
  test("starts from the base as origin has it, fetched first, on a branch of its own", async () => {
    const calls: Array<string> = []
    expect(await Effect.runPromise(make(git(withOrigin, calls)))).toEqual({ path: made, branch: "yapd/0a1b2c3d" })
    expect(calls).toEqual([
      "/code/free-sound: remote get-url origin",
      "/code/free-sound: fetch origin +refs/heads/main:refs/remotes/origin/main",
      "/code/free-sound: rev-parse --verify --quiet refs/remotes/origin/main^{commit}",
      `/code/free-sound: worktree add --no-track -b yapd/0a1b2c3d ${made} origin/main`,
      `${made}: rev-parse --show-toplevel`,
    ])
  })

  test("starts from the local branch when there's no origin, and from what it last fetched when it can't, saying so", async () => {
    const local = { "rev-parse --verify --quiet refs/heads/main": "0a1b\n", "worktree add": "", "rev-parse --show-toplevel": `${made}\n` }
    const calls: Array<string> = []
    expect(await Effect.runPromise(make(git(local, calls)))).toEqual({ path: made, branch: "yapd/0a1b2c3d" })
    expect(calls).toContain(`/code/free-sound: worktree add --no-track -b yapd/0a1b2c3d ${made} main`)
    const { "fetch origin": _, ...offline } = withOrigin
    expect(await Effect.runPromise(make(git(offline)))).toEqual({
      path: made,
      branch: "yapd/0a1b2c3d",
      warning: "I couldn't fetch from origin, so it starts from main as it was when last fetched.",
    })
  })

  test("refuses a base that isn't there, and makes nothing", async () => {
    const calls: Array<string> = []
    expect(await why(make(git({ "remote get-url origin": "url\n", "fetch origin": "" }, calls), "release"))).toBe(
      "free-sound has no branch called release, so I didn't start anything.",
    )
    expect(await why(make(git(withOrigin, calls), "--force"))).toBe("I can't tell which branch of free-sound to start from. Tell me which.")
    expect(calls.some((call) => call.includes("worktree add"))).toBe(false)
  })

  test("refuses when git won't make it, or it isn't where git said it made it", async () => {
    const { "worktree add": _, ...failing } = withOrigin
    expect(await why(make(git(failing)))).toBe(
      "I couldn't make the worktree, so I didn't start anything. Git says: a branch named 'yapd/0a1b2c3d' already exists.",
    )
    const { "rev-parse --show-toplevel": __, ...missing } = withOrigin
    expect(await why(make(git(missing)))).toBe("The worktree isn't where git said it made it, so I didn't start anything.")
  })
})
