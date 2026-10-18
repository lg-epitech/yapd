import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import * as Home from "./Home.ts"

/** Where an agent runs, as far as its hook's environment tells. Relays use it to reach the agent again. */
export const Origin = Schema.Struct({
  /** Bundle id of the app it runs under, like com.t3tools.t3code. */
  app: Schema.optional(Schema.String),
  /** The repository it works in, named where it runs, since the daemon may be on another machine. */
  project: Schema.optional(Schema.String),
  /** The machine's hostname, which picks the `YAPD_REMOTES` entry follow-ups go through. */
  host: Schema.optional(Schema.String),
  /** Whether yapd started it from the command line, with nobody watching and no terminal to type into. */
  launched: Schema.optional(Schema.Boolean),
})
export type Origin = typeof Origin.Type

/** What a client's hooks call their machine, when it's set in their environment. */
export const machine = "YAPD_MACHINE"

/**
 * What a hook needs of yapd's settings, which it doesn't load: whether this
 * machine uses yapd on another, and what it's called. Read from the file,
 * as Bun reads it, so the hooks' commands stay as they were and Codex keeps
 * trusting them. Nothing when there's no file.
 */
export const settings = (file = Home.settings): Record<string, string> => {
  try {
    const found: Record<string, string> = {}
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?(YAPD_SERVER|YAPD_NAME)\s*=\s*(.*?)\s*$/.exec(line)
      if (match === null) continue
      const value = match[2]!
      found[match[1]!] = /^(["'])(.*)\1$/.exec(value)?.[2] ?? value.replace(/\s+#.*$/, "")
    }
    return found
  } catch {
    return {}
  }
}

/**
 * What a client of yapd on another machine is called there: what the user
 * calls it, or its hostname without its domain, in lowercase, as a name its
 * hooks and the server's settings can both carry.
 */
export const clientName = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  (env.YAPD_NAME?.trim() || (hostname().split(".")[0] ?? hostname()))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")

/**
 * The machine an agent runs on, as yapd's daemon is told: on a client, the
 * name it was set up with, from its hooks' environment or its own settings;
 * elsewhere, its hostname.
 */
export const host = (env: Readonly<Record<string, string | undefined>> = process.env, file = Home.settings) => {
  if (env[machine]?.trim()) return env[machine].trim()
  // A command that read the settings has them already. A hook reads them from the file.
  const known = env.YAPD_SERVER === undefined ? { ...settings(file), ...env } : env
  return known.YAPD_SERVER?.trim() ? clientName(known) : hostname()
}

/** What yapd sets on the sessions it starts, which their hooks inherit. */
export const launched = "YAPD_LAUNCHED"

export const fromEnv = (env: Readonly<Record<string, string | undefined>>): Origin => {
  const app = env.__CFBundleIdentifier
  return { ...(app ? { app } : {}), ...(env[launched] ? { launched: true } : {}) }
}
