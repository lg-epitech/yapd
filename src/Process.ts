import { Data, Effect } from "effect"

export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly command: string
  readonly code: number
  readonly stderr: string
}> {}

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
          env: { ...process.env, ...options.env },
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        }),
      // Bun throws when it can't start the command at all, like when it's missing.
      catch: (cause) => new ProcessError({ command: command.join(" "), code: -1, stderr: String(cause) }),
    }),
    (proc) =>
      Effect.gen(function* () {
        const [stdout, stderr, code] = yield* Effect.promise(() =>
          Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        )
        if (code !== 0) {
          return yield* new ProcessError({ command: command.join(" "), code, stderr: stderr.trim() })
        }
        return stdout
      }),
    (proc) => Effect.sync(() => proc.kill()),
  )
