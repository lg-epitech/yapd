import { Console, Data, Effect } from "effect"
import { existsSync } from "node:fs"
import { rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import * as Home from "./Home.ts"

// `yapd setup`: the hooks that tell yapd when an agent's turn ends, written
// into each agent's own config, then the service on a Mac that speaks.

export class SetupError extends Data.TaggedError("SetupError")<{ readonly message: string; readonly cause?: unknown }> {}

export type Agent = "claude" | "codex"

/** One hook, as both agents write them: `{ type: "command", command, ... }`. */
export type Hook = { readonly [key: string]: unknown }

/** Hooks for one event, grouped as both agents group them: `{ matcher?, hooks: [...] }`. */
export type Group = { readonly hooks?: ReadonlyArray<Hook>; readonly [key: string]: unknown }

export type Hooks = { readonly [event: string]: ReadonlyArray<Group> }

/** Whether a hook runs yapd's, however it was set up: `yapd hook claude`, or `bun …/src/main.ts hook codex`. */
export const ours = (hook: Hook) =>
  typeof hook.command === "string" && /(?:^|[\s/'"])(?:yapd|main\.ts)['"]?\s+hook\s+(?:claude|codex)\b/.test(hook.command)

/** Quoted for the shell the agent runs hooks with, when it has to be. */
const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

/**
 * What an agent runs to reach yapd. By full paths, since agents don't run
 * hooks with the PATH of the shell yapd was installed from, and with the
 * settings they need when yapd is set up differently, since hooks run where
 * the agent does and don't read yapd's.
 */
export const command =
  (bun: string, main: string, env: Readonly<Record<string, string>> = {}) =>
  (agent: Agent, wait: boolean) =>
    [
      ...Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`),
      ...[bun, main, "hook", agent, ...(wait ? ["--wait"] : [])].map(quote),
    ].join(" ")

/** The settings hooks need, when they're set: the port yapd listens on, and where its home is. */
export const environment = (): Record<string, string> => ({
  ...(process.env.YAPD_PORT === undefined ? {} : { YAPD_PORT: process.env.YAPD_PORT }),
  ...(process.env.YAPD_HOME === undefined ? {} : { YAPD_HOME: Home.home }),
})

/**
 * Claude Code's Stop hook runs in the background and waits while yapd reads
 * the update, so it can wake the session with the user's reply.
 */
export const claude = (run: ReturnType<typeof command>): Record<string, Hook> => ({
  Stop: { type: "command", command: run("claude", true), async: true, asyncRewake: true },
  UserPromptSubmit: { type: "command", command: run("claude", false), timeout: 5 },
})

/** Codex has no waiting hook: replies go through `codex queue`. */
export const codex = (run: ReturnType<typeof command>): Record<string, Hook> => ({
  Stop: { type: "command", command: run("codex", false), timeout: 5 },
  UserPromptSubmit: { type: "command", command: run("codex", false), timeout: 5 },
})

/**
 * yapd's hook for each event, in place of the one it had, so the user's own
 * stay where they are, and Codex, which trusts hooks by where they are,
 * doesn't ask again about any but those that changed. At the end when there
 * was none. Any more of yapd's go, so it never runs twice.
 */
export const merge = (hooks: Hooks, wanted: Record<string, Hook>): Hooks => {
  const merged: Record<string, ReadonlyArray<Group>> = { ...hooks }
  for (const [event, hook] of Object.entries(wanted)) {
    let placed = false
    const groups = (merged[event] ?? []).flatMap((group): Array<Group> => {
      if (!Array.isArray(group.hooks)) return [group]
      const kept = group.hooks.flatMap((existing: Hook) => {
        if (!ours(existing)) return [existing]
        if (placed) return []
        placed = true
        return [hook]
      })
      return kept.length === 0 ? [] : [{ ...group, hooks: kept }]
    })
    merged[event] = placed ? groups : [...groups, { hooks: [hook] }]
  }
  return merged
}

/** yapd's hook for each event there is one for. */
export const find = (hooks: Hooks): Record<string, ReadonlyArray<Hook>> =>
  Object.fromEntries(
    Object.entries(hooks).map(([event, groups]) => [event, groups.flatMap((group) => (Array.isArray(group.hooks) ? group.hooks.filter(ours) : []))]),
  )

/** Where each agent keeps its hooks, and where in that file. */
export const config = (agent: Agent) =>
  agent === "claude"
    ? { file: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"), name: "Claude Code" }
    : { file: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json"), name: "Codex" }

/** Whether the agent is here: its CLI on the PATH, or its config folder, like where the desktop app keeps it. */
export const present = (agent: Agent) => Bun.which(agent) !== null || existsSync(join(config(agent).file, ".."))

/** The file as an object, or an empty one when there's no file. Anything else is left alone. */
export const read = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      const handle = Bun.file(file)
      if (!(await handle.exists())) return {}
      const value: unknown = JSON.parse(await handle.text())
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a JSON object")
      return value as { readonly hooks?: Hooks; readonly [key: string]: unknown }
    },
    catch: (cause) => new SetupError({ message: `I couldn't read ${file} as JSON, so I left it alone`, cause }),
  })

/**
 * Writes the agent's hooks, and says what it did. Nothing is written when
 * they're already as they should be. The file as it was before yapd first
 * changed it is kept next to it.
 */
export const install = (agent: Agent, run: ReturnType<typeof command>) =>
  Effect.gen(function* () {
    const { file, name } = config(agent)
    const settings = yield* read(file)
    const hooks = merge(settings.hooks ?? {}, (agent === "claude" ? claude : codex)(run))
    const before = JSON.stringify(settings.hooks ?? {})
    if (JSON.stringify(hooks) === before) return `${name}'s hooks were already set up, in ${file}`
    yield* Effect.tryPromise({
      try: async () => {
        const backup = `${file}.before-yapd`
        if ((await Bun.file(file).exists()) && !(await Bun.file(backup).exists())) await Bun.write(backup, Bun.file(file))
        // Whole or not at all, since the agent may read it at any time.
        const staging = `${file}.${crypto.randomUUID()}`
        await Bun.write(staging, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`)
        await rename(staging, file)
      },
      catch: (cause) => new SetupError({ message: `I couldn't write ${file}`, cause }),
    })
    return `${name}'s hooks are set up, in ${file}${agent === "codex" ? ". Codex asks you to trust them on its next start" : ""}`
  })

/** Starts the user's settings, so there's a file to find and edit. */
const settings = Effect.tryPromise({
  try: async () => {
    if (await Bun.file(Home.settings).exists()) return false
    await Bun.write(
      Home.settings,
      "# yapd's settings, like YAPD_PROVIDER=claude, one per line. They're all in\n# https://github.com/lg-epitech/yapd#readme\n",
    )
    return true
  },
  catch: (cause) => new SetupError({ message: `I couldn't write ${Home.settings}`, cause }),
})

/** The hooks for each agent that's here, and the settings file. */
export const setup = (bun: string, main: string) =>
  Effect.gen(function* () {
    if (yield* settings) yield* Console.log(`Your settings go in ${Home.settings}`)
    const agents = (["claude", "codex"] as const).filter(present)
    if (agents.length === 0) yield* Console.log("Neither Claude Code nor Codex is here, so there are no hooks to set up.")
    for (const agent of agents) {
      yield* install(agent, command(bun, main, environment())).pipe(
        Effect.flatMap(Console.log),
        Effect.catchAll((error) => Console.error(`${error.message}. Its hooks are in the README.`)),
      )
    }
  })
