import { Context, Deferred, Effect, Exit, Layer } from "effect"
import { key } from "./Payload.ts"
import { type Relay, Unreachable } from "./Relay.ts"

// Claude Code wakes an idle session when a background hook exits with code 2,
// with the hook's output for Claude to act on, in whatever terminal, editor or
// app the session runs. So yapd's Stop hook waits in the background while the
// update is read out, and hands the session the user's reply if there is one.

/** A Stop hook waiting to hear whether the user replied. */
export interface Ticket {
  readonly session: string
  readonly answer: Deferred.Deferred<string | undefined>
}

export class Waiting extends Context.Tag("yapd/Waiting")<
  Waiting,
  {
    /** Registers the session's hook, letting go of any older one. */
    readonly open: (session: string) => Effect.Effect<Ticket>
    /** Lets the hook go without a reply. */
    readonly close: (ticket: Ticket) => Effect.Effect<void>
    /** Lets whichever hook the session has go, like when the user has typed something since. */
    readonly drop: (session: string) => Effect.Effect<void>
    /** Hands the reply to the session's hook. False when none is waiting. */
    readonly deliver: (session: string, text: string) => Effect.Effect<boolean>
    /** The reply for the hook, once there's an answer. */
    readonly reply: (ticket: Ticket) => Effect.Effect<string | undefined>
  }
>() {}

/** Under Claude Code's ten minute default timeout for the hook, so it hears back before it's killed. */
const patience = "9 minutes"

export const WaitingLive = Layer.scoped(
  Waiting,
  Effect.gen(function* () {
    const hooks = new Map<string, Ticket>()
    const settle = (ticket: Ticket, answer: string | undefined) => {
      if (hooks.get(ticket.session) === ticket) hooks.delete(ticket.session)
      Deferred.unsafeDone(ticket.answer, Exit.succeed(answer))
    }
    // Hooks still waiting when yapd stops just exit.
    yield* Effect.addFinalizer(() => Effect.sync(() => [...hooks.values()].forEach((ticket) => settle(ticket, undefined))))

    return {
      open: (session) =>
        Effect.gen(function* () {
          const older = hooks.get(session)
          if (older !== undefined) settle(older, undefined)
          const ticket = { session, answer: yield* Deferred.make<string | undefined>() }
          hooks.set(session, ticket)
          return ticket
        }),
      close: (ticket) => Effect.sync(() => settle(ticket, undefined)),
      drop: (session) =>
        Effect.sync(() => {
          const ticket = hooks.get(session)
          if (ticket !== undefined) settle(ticket, undefined)
        }),
      deliver: (session, text) =>
        Effect.sync(() => {
          const ticket = hooks.get(session)
          if (ticket === undefined) return false
          settle(ticket, text)
          return true
        }),
      reply: (ticket) =>
        Deferred.await(ticket.answer).pipe(
          Effect.timeout(patience),
          Effect.orElseSucceed(() => undefined),
          // However it ends, like the hook hanging up, nothing is handed to a hook that stopped listening.
          Effect.ensuring(Effect.sync(() => settle(ticket, undefined))),
        ),
    }
  }),
)

/** What Claude reads when the hook wakes it. */
export const wake = (text: string) => `The user replied by voice, relayed by yapd:\n\n${text}`

export const relay = Effect.map(
  Waiting,
  (waiting): Relay => ({
    send: (thread, text) =>
      thread.agent !== "claude"
        ? Effect.fail(new Unreachable())
        : waiting
            .deliver(key(thread.agent, thread.session), text)
            .pipe(Effect.flatMap((taken) => (taken ? Effect.void : Effect.fail(new Unreachable())))),
  }),
)
