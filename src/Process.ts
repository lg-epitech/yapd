import type { Subprocess } from "bun"
import { Data, Effect, Exit } from "effect"
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
    let reaped = proc.exitCode !== null || proc.signalCode !== null
    proc.exited.then(() => { reaped = true }, () => { reaped = true })
    // A leader can exit before its tools. Wait for the whole group using wall time, without child fibers in a closing scope.
    const wait = (millis: number) => Effect.promise(() => new Promise<boolean>((resolve) => {
      const deadline = performance.now() + millis
      const check = () => {
        if (reaped && !alive()) return resolve(true)
        const remaining = deadline - performance.now()
        if (remaining <= 0) return resolve(false)
        setTimeout(check, Math.min(10, remaining))
      }
      check()
    }))
    if (alive()) {
      signal("SIGTERM")
      if (!(yield* wait(250))) signal("SIGKILL")
    }
    // Bounded even if the OS cannot finish terminating it, so shutdown can continue.
    yield* wait(1000)
  })

/**
 * A file for a command's output, removed as soon as it's open: only the
 * command and yapd can reach it, and there's nothing to clean up after.
 */
const scratch = Effect.acquireRelease(
  Effect.try(() => {
    const path = join(tmpdir(), `yapd-${process.pid}-${crypto.randomUUID()}`)
    const file = openSync(path, "wx+", 0o600)
    try {
      unlinkSync(path)
    } catch (cause) {
      closeSync(file)
      throw cause
    }
    return file
  }),
  (file) => Effect.sync(() => closeSync(file)),
)

/** What a command wrote to a pipe, once it's closed, or to a scratch file so far. */
const text = (output: ReadableStream<Uint8Array> | number) => {
  if (typeof output !== "number") return new Response(output).text()
  const buffer = Buffer.alloc(fstatSync(output).size)
  return buffer.toString("utf8", 0, readSync(output, buffer, 0, buffer.length, 0))
}

/**
 * Runs a command to completion and returns its stdout. Interrupting kills the
 * process. With `leave`, what it left running in its group is left alone once
 * it succeeds, for a command that puts something in the background on purpose.
 * With `both`, what it wrote to stderr comes back after its stdout, for a
 * command that answers there, like `ssh -O check`.
 */
export const run = (
  command: ReadonlyArray<string>,
  options: {
    readonly stdin?: string
    readonly env?: Record<string, string>
    readonly cwd?: string
    readonly leave?: boolean
    readonly both?: boolean
  } = {},
) => {
  const failed = (cause: unknown) => new ProcessError({ command: command.join(" "), code: -1, stderr: String(cause) })
  return Effect.scoped(
    Effect.gen(function* () {
      // What a command leaves running keeps its stdout and stderr unless it's told otherwise, like the proxy SSH
      // reaches a machine through keeps SSH's stderr. A pipe then only closes once that stops too, so with `leave`
      // the output goes to files instead, read as far as they got once the command itself has exited. What's left
      // running can go on writing there without anything waiting on it, or a closed pipe killing it.
      const files = options.leave === true ? yield* Effect.mapError(Effect.all([scratch, scratch]), failed) : undefined
      return yield* Effect.acquireUseRelease(
        Effect.try({
          try: () =>
            Bun.spawn([...command], {
              stdin: options.stdin === undefined ? "ignore" : new Response(options.stdin),
              stdout: files?.[0] ?? "pipe",
              stderr: files?.[1] ?? "pipe",
              detached,
              env: { ...process.env, ...options.env },
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            }),
          // Bun throws when it can't start the command at all, like when it's missing.
          catch: failed,
        }),
        (proc) =>
          Effect.gen(function* () {
            const [stdout, stderr, code] = yield* Effect.tryPromise({
              try: () =>
                files === undefined
                  ? Promise.all([text(proc.stdout), text(proc.stderr), proc.exited])
                  : proc.exited.then((code) => Promise.all([text(proc.stdout), text(proc.stderr), code])),
              catch: failed,
            })
            if (code !== 0) {
              return yield* new ProcessError({ command: command.join(" "), code, stderr: stderr.trim() })
            }
            return options.both === true ? stdout + stderr : stdout
          }),
        (proc, exit) => (options.leave === true && Exit.isSuccess(exit) ? Effect.void : stop(proc)),
      )
    }),
  )
}
