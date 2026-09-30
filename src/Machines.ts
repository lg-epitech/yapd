import { Effect, Option } from "effect"
import { hostname } from "node:os"
import * as CliLauncher from "./CliLauncher.ts"
import * as Config from "./Config.ts"
import type { Machine } from "./Drafts.ts"
import type { Launcher } from "./Launcher.ts"
import { researcher } from "./Model.ts"
import * as Remote from "./Remote.ts"
import * as T3CodeLauncher from "./T3CodeLauncher.ts"
import * as T3CodeThreads from "./T3CodeThreads.ts"

// Where new work can start: this machine and the ones it reaches over SSH,
// each with what starts agents there, what reads through its projects, and
// the threads T3 Code already has there.

/**
 * What starts agents on this machine: T3 Code when there's a token for it, and
 * the agents' own command lines when there isn't.
 */
export const own = Effect.gen(function* () {
  const settings: CliLauncher.Settings = {
    folders: yield* Config.projects,
    worktree: yield* Config.worktree,
    permissions: {
      claude: Option.getOrUndefined(yield* Config.claudePermissions),
      codex: Option.getOrUndefined(yield* Config.codexSandbox),
    },
  }
  return Option.match(yield* Config.t3codeToken, {
    onNone: (): Launcher => CliLauncher.launcher(settings),
    onSome: T3CodeLauncher.launcher,
  })
})

/** What the user would call a machine that reports this hostname, which can carry a domain, like `.local`. */
export const short = (host: string) => host.split(".")[0] ?? host

/**
 * This machine first, by the name the user gave it, then the ones in
 * `YAPD_REMOTES`. Its hostname is read each time, since a Mac's changes with
 * the network.
 */
export const machines = Effect.gen(function* () {
  const remotes = yield* Config.remotes
  const called = Option.getOrUndefined(yield* Config.name)
  const launchers = Remote.launchers(remotes, hostname, yield* own, undefined, called)
  const researchers = Remote.researchers(remotes, hostname, yield* researcher, undefined, called)
  const threads = Remote.threadsOn(remotes, hostname, T3CodeThreads.threads(yield* Config.t3codeToken), undefined, called)
  const here: Machine = {
    get name() {
      return called ?? short(hostname())
    },
    here: true,
    get hosts() {
      return [hostname()]
    },
    launcher: launchers(),
    researcher: researchers(),
    threads: threads(),
  }
  return [
    here,
    ...[...remotes.keys()].map(
      (remote): Machine => ({
        name: remote,
        here: false,
        hosts: [remote],
        launcher: launchers(remote),
        researcher: researchers(remote),
        threads: threads(remote),
      }),
    ),
  ]
})
