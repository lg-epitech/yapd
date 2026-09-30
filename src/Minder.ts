import { Data, Effect, Option, Schedule, Stream } from "effect"
import { closeSync, openSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import * as Cli from "./Cli.ts"
import * as Config from "./Config.ts"
import { launched, type Origin } from "./Origin.ts"
import { detached, ProcessError, stop } from "./Process.ts"
import * as Project from "./Project.ts"
import * as Sessions from "./Sessions.ts"

// A headless session has nobody watching it. What it may not do is refused
// rather than asked about, and if it fails it does so quietly. So each turn
// runs under `yapd mind`, which outlives the command that started it, keeps
// the output, and tells the daemon when the turn ended on something only the
// user can settle. What the agent says goes through its hooks as always.

/** The session couldn't be started, or didn't say so in time. The reason is read out. */
export class MindError extends Data.TaggedError("MindError")<{ readonly reason: string; readonly cause?: unknown }> {}

const name = { claude: "Claude Code", codex: "Codex" } as const

const listed = (items: ReadonlyArray<string>) => {
  const [...few] = new Set(items)
  const shown = few.slice(0, 3)
  const more = few.length - shown.length
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/** The last few lines it printed, which is where command lines say what went wrong. */
const last = (text: string) => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  const end = lines.slice(-3).join(" ")
  return end === "" ? undefined : end.length <= 300 ? end : `...${end.slice(-300)}`
}

/**
 * What the user should hear about a turn that ended, beyond what the agent
 * said itself: nothing, when it went as it should.
 */
export const report = (
  session: Sessions.Session,
  heard: Cli.Heard,
  ended: { readonly code: number; readonly stderr: string },
): string | undefined => {
  const pickUp =
    session.session === undefined
      ? ""
      : ` To go on from there, pick it up in a terminal with: ${Cli.resume(session.agent, session.session, session.directory)}`
  if (ended.code !== 0 || heard.error !== undefined) {
    const why = heard.error ?? last(ended.stderr) ?? `${name[session.agent]} exited with code ${ended.code}`
    return `It stopped before it was done. ${why}${/[.!?]$/.test(why) ? "" : "."}${pickUp} Everything it printed is in ${Sessions.log(session.launch)}`
  }
  if (heard.denied.length === 0) return undefined
  const said = heard.message === undefined ? "" : `${heard.message}\n\n`
  return `${said}It needs you: it ran with nobody there to approve things, so it was refused when it tried to ${listed(heard.denied.map(Cli.wanted))}.${pickUp}`
}

/**
 * What the daemon is told, in the shape of the hook that ends a turn, so it's
 * read out like any update and takes the place of the one the agent's own hook
 * sent a moment before. `needs_you` says not to skip it, however short the turn.
 */
export const notice = (session: Sessions.Session, message: string) => ({
  hook_event_name: "Stop" as const,
  session_id: session.session ?? session.launch,
  cwd: session.directory,
  last_assistant_message: message,
  needs_you: true,
})

const tell = (session: Sessions.Session, message: string) =>
  Effect.gen(function* () {
    const port = yield* Config.port
    const project = yield* Project.name(session.directory)
    const origin: Origin = { host: hostname(), project, launched: true }
    const query = new URLSearchParams({ agent: session.agent, origin: JSON.stringify(origin) })
    yield* Effect.tryPromise((signal) =>
      fetch(`http://127.0.0.1:${port}/events?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(notice(session, message)),
        signal,
      }),
    ).pipe(Effect.timeout("2 seconds"))
    // Like a hook, it gives up on a daemon that's stopped. The session's record still says how it ended.
  }).pipe(Effect.ignore)

/** Why a session that never got going didn't, to be read out. */
export const stillborn = (session: Sessions.Session, heard: Cli.Heard, ended: { readonly code: number; readonly stderr: string }) => {
  const why = heard.error ?? last(ended.stderr)
  return ended.code === -1
    ? `I couldn't run ${name[session.agent]} here.`
    : `${name[session.agent]} wouldn't start.${why === undefined ? "" : ` ${why}`}`
}

/** `yapd mind`: runs the turn a session's record describes, and stays until it ends. */
export const mind = (launch: string, root: string = Sessions.folder, command?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const found = yield* Sessions.read(launch, root)
    if (Option.isNone(found)) return
    let session = found.value
    const save = (changes: Partial<Sessions.Session>) => Effect.suspend(() => {
      const next = { ...session, ...changes }
      return Sessions.write(next, root).pipe(Effect.tap(() => {
        session = next
      }))
    })
    const argv = command ?? Cli.command({
      agent: session.agent,
      session: session.session,
      resume: session.resume,
      model: session.model,
      effort: session.effort,
      permissions: session.permissions,
      repository: session.repository,
    })
    const log = Sessions.log(launch, root)
    const keep = (text: string) => Effect.promise(() => appendFile(log, text).catch(() => {}))
    yield* keep(`# ${new Date().toISOString()} ${argv.join(" ")}\n`)

    let heard = Cli.silence
    let stderr = ""
    const processError = (cause: unknown) => new ProcessError({ command: argv.join(" "), code: -1, stderr: String(cause) })
    const ended = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => Bun.spawn([...argv], {
          cwd: session.directory,
          stdin: new Response(session.prompt),
          stdout: "pipe",
          stderr: "pipe",
          detached,
          env: { ...process.env, [launched]: "1" },
        }),
        catch: processError,
      }),
      (proc) => Effect.gen(function* () {
        const output = Stream.fromReadableStream({ evaluate: () => proc.stdout, onError: processError }).pipe(
          Stream.decodeText(),
          Stream.tap(keep),
          Stream.splitLines,
          Stream.runForEach((line) => Effect.gen(function* () {
            heard = Cli.hear(session.agent, heard, line)
            if (session.state === "starting" && heard.session !== undefined && heard.began) {
              yield* save({ session: heard.session, state: "running" })
            }
          })),
        )
        const errors = Stream.fromReadableStream({ evaluate: () => proc.stderr, onError: processError }).pipe(
          Stream.decodeText(),
          Stream.runForEach((text) => {
            stderr = `${stderr}${text}`.slice(-4000)
            return keep(text)
          }),
        )
        const [, , code] = yield* Effect.all([output, errors, Effect.promise(() => proc.exited)], { concurrency: "unbounded" })
        return { heard, code, stderr }
      }),
      stop,
    ).pipe(Effect.catchTag("ProcessError", (error) => Effect.succeed({ heard, code: error.code, stderr: error.stderr })))

    const failed = ended.code !== 0 || ended.heard.error !== undefined
    const message = report(session, ended.heard, ended)
    // Whoever started it is still waiting to hear whether it did, and says so itself when it didn't.
    if (session.state === "starting" && failed) {
      return yield* save({ state: "unstarted", error: stillborn(session, ended.heard, ended) })
    }
    const named = ended.heard.session === undefined ? {} : { session: ended.heard.session }
    yield* save(failed ? { state: "failed", ...(message === undefined ? {} : { error: message }) } : { state: "idle", ...named })
    if (message !== undefined) yield* tell(session, message)
  })

/** Hands a turn to a minder of its own, and hears back once the session has a name. */
export type Start = (session: Sessions.Session) => Effect.Effect<Sessions.Session, MindError>

/** Command lines name their session within a second or two. This allows for a slow start, like a first run after an update. */
const patience = "20 seconds"

/** Starts the minder with its own group, so it outlives the launching command and SSH session. */
const spawnMinder = (launch: string, output: number) => Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "mind", launch], {
  cwd: dirname(import.meta.dir),
  detached: true,
  stdin: "ignore",
  stdout: output,
  stderr: output,
})

export const makeStart = (
  root: string = Sessions.folder,
  spawn: (launch: string, output: number) => { readonly unref: () => void } = spawnMinder,
): Start => (session) =>
  Effect.gen(function* () {
    yield* Sessions.write({ ...session, state: "starting" }, root)
    const log = Sessions.log(session.launch, root)
    yield* Effect.try({
      try: () => {
        const output = openSync(log, "a", 0o600)
        try {
          spawn(session.launch, output).unref()
        } finally {
          // Bun duplicates this for the child; the launching process owns and closes this copy.
          closeSync(output)
        }
      },
      catch: (cause) => new MindError({ reason: "I couldn't start anything to mind the session.", cause }),
    })
    const named = Sessions.read(session.launch, root).pipe(
      Effect.flatMap(Option.filter((found) => found.state !== "starting")),
      // Until it says, which the timeout puts an end to.
      Effect.retry(Schedule.spaced("100 millis")),
      Effect.orDie,
      Effect.timeoutFail({
        duration: patience,
        onTimeout: () => new MindError({ reason: `It's taking long to start, so I don't know if it did. What it prints goes to ${log}` }),
      }),
    )
    const found = yield* named
    if (found.state === "unstarted") return yield* new MindError({ reason: found.error ?? "It stopped before it started." })
    return found
  }).pipe(
    Effect.catchTag("StorageError", (cause) => Effect.fail(new MindError({ reason: `I couldn't save the session record at ${cause.path}.`, cause }))),
  )

export const start: Start = makeStart()
