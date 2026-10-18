import { Schema } from "effect"
import { hostname } from "node:os"

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

/** What a client's hooks call their machine, set by `yapd setup client`, since hooks don't read yapd's settings. */
export const machine = "YAPD_MACHINE"

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
export const host = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env[machine]?.trim() || (env.YAPD_SERVER?.trim() ? clientName(env) : hostname())

/** What yapd sets on the sessions it starts, which their hooks inherit. */
export const launched = "YAPD_LAUNCHED"

export const fromEnv = (env: Readonly<Record<string, string | undefined>>): Origin => {
  const app = env.__CFBundleIdentifier
  return { ...(app ? { app } : {}), ...(env[launched] ? { launched: true } : {}) }
}
