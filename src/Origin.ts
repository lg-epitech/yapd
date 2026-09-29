import { Schema } from "effect"

/** Where an agent runs, as far as its hook's environment tells. Relays use it to reach the agent again. */
export const Origin = Schema.Struct({
  /** Bundle id of the app it runs under, like com.t3tools.t3code. */
  app: Schema.optional(Schema.String),
  /** The repository it works in, named where it runs, since the daemon may be on another machine. */
  project: Schema.optional(Schema.String),
})
export type Origin = typeof Origin.Type

export const fromEnv = (env: Readonly<Record<string, string | undefined>>): Origin => {
  const app = env.__CFBundleIdentifier
  return app ? { app } : {}
}
