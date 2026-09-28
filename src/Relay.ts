import { Context, Data, Effect } from "effect"
import type { Origin } from "./Origin.ts"
import type { Agent } from "./Payload.ts"

/** The session an update came from, to send follow-ups back to. */
export interface Thread {
  readonly agent: Agent
  readonly session: string
  readonly cwd: string
  /** The agent's last message: the one yapd read out. */
  readonly message: string
  readonly origin: Origin
}

/** This relay can't reach the thread, so the next one tries. */
export class Unreachable extends Data.TaggedError("Unreachable") {}

/** It can, but it didn't send. The reason is read out. */
export class RelayError extends Data.TaggedError("RelayError")<{ readonly reason: string; readonly cause?: unknown }> {}

/** One way of reaching agents, like T3 Code's API or Codex's queue. */
export interface Relay {
  readonly send: (thread: Thread, text: string) => Effect.Effect<void, Unreachable | RelayError>
}

export class Relays extends Context.Tag("yapd/Relays")<
  Relays,
  {
    /** Sends a message as if the user typed it, through the first relay that reaches the thread. */
    readonly send: (thread: Thread, text: string) => Effect.Effect<void, RelayError>
  }
>() {}

/** A leading slash would run as a command, like /compact, and a leading ! as a shell command. */
export const plain = (text: string) => text.replace(/^[\s/!]+/, "").trim()

export const make = (relays: ReadonlyArray<Relay>): Relays["Type"] => ({
  send: (thread, text) =>
    Effect.gen(function* () {
      const message = plain(text)
      if (message === "") return yield* new RelayError({ reason: "I didn't catch what to send." })
      for (const relay of relays) {
        const reached = yield* relay.send(thread, message).pipe(
          Effect.as(true),
          Effect.catchTag("Unreachable", () => Effect.succeed(false)),
        )
        if (reached) return
      }
      return yield* new RelayError({ reason: "I can't reach that session from here." })
    }),
})
