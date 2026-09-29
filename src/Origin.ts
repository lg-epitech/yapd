import { Schema } from "effect"

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

/** What yapd sets on the sessions it starts, which their hooks inherit. */
export const launched = "YAPD_LAUNCHED"

export const fromEnv = (env: Readonly<Record<string, string | undefined>>): Origin => {
  const app = env.__CFBundleIdentifier
  return { ...(app ? { app } : {}), ...(env[launched] ? { launched: true } : {}) }
}
