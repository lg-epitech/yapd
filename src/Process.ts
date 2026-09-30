import type { Subprocess } from "bun"
import { Data, Effect } from "effect"

export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly command: string
  readonly code: number
  readonly stderr: string
}> {}

/** Processes we own start in a separate group, so canceling also stops their tools. */
export const detached = process.platform !== "win32"

/** Gives the command time to stop, then kills and reaps whatever is still running. */
export const stop = (proc: Subprocess) =>
  Effect.gen(function* () {
    const alive = () => {
      if (!detached) return proc.exitCode === null && proc.signalCode === null
      try {
        process.kill(-proc.pid, 0)
        return true
      } catch {
        return false
      }
    }
    const signal = (signal: NodeJS.Signals) => {
      try {
        if (detached) process.kill(-proc.pid, signal)
        else proc.kill(signal)
      } catch {
        // It may have exited between checking and signaling it.
      }
    }
    // OS cleanup uses wall time even under a test clock, and creates no child fibers in a closing scope.
    const wait = (millis: number) => Effect.promise(() => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), millis)
      proc.exited.then(
        () => { clearTimeout(timer); resolve(true) },
        () => { clearTimeout(timer); resolve(false) },
      )
    }))
    if (!alive()) return
    signal("SIGTERM")
    const exited = yield* wait(250)
    if (!exited || alive()) signal("SIGKILL")
    // Bounded even if the OS cannot finish terminating it, so shutdown can continue.
    yield* wait(1000)
  })

/** Runs a command to completion and returns its stdout. Interrupting kills the process. */
export const run = (
  command: ReadonlyArray<string>,
  options: { readonly stdin?: string; readonly env?: Record<string, string>; readonly cwd?: string } = {},
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn([...command], {
          stdin: options.stdin === undefined ? "ignore" : new Response(options.stdin),
          stdout: "pipe",
          stderr: "pipe",
          detached,
          env: { ...process.env, ...options.env },
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        }),
      // Bun throws when it can't start the command at all, like when it's missing.
      catch: (cause) => new ProcessError({ command: command.join(" "), code: -1, stderr: String(cause) }),
    }),
    (proc) =>
      Effect.gen(function* () {
        const [stdout, stderr, code] = yield* Effect.tryPromise({
          try: () => Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
          catch: (cause) => new ProcessError({ command: command.join(" "), code: -1, stderr: String(cause) }),
        })
        if (code !== 0) {
          return yield* new ProcessError({ command: command.join(" "), code, stderr: stderr.trim() })
        }
        return stdout
      }),
    stop,
  )
