import { Console, Effect, Schedule } from "effect"
import { mkdir, rm } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import * as Config from "./Config.ts"
import { home } from "./Home.ts"
import { run } from "./Process.ts"

export const label = "dev.yapd"

export const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
export const logPath = join(homedir(), "Library", "Logs", "yapd.log")
const domain = `gui/${userInfo().uid}`

export interface Options {
  readonly bun: string
  readonly main: string
  readonly workingDirectory: string
  /** launchd starts agents with a bare PATH, so the provider CLIs and ffmpeg wouldn't be found. */
  readonly path: string
  /** Where yapd's home is, when YAPD_HOME moved it, since the daemon can't read that from the .env inside it. */
  readonly home?: string | undefined
  readonly log: string
}

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const string = (value: string) => `<string>${escape(value)}</string>`

/** Starts at login and restarts whenever it exits. */
export const plist = (options: Options) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key>
  <array>
    ${string(options.bun)}
    ${string(options.main)}
    ${string("serve")}
  </array>
  <key>WorkingDirectory</key>${string(options.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${string(options.path)}${options.home === undefined ? "" : `
    <key>YAPD_HOME</key>${string(options.home)}`}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${string(options.log)}
  <key>StandardErrorPath</key>${string(options.log)}
</dict>
</plist>
`

/** Fails when the service isn't loaded, which is fine to ignore. */
const bootout = run(["launchctl", "bootout", `${domain}/${label}`]).pipe(Effect.ignore)

const healthy = Effect.gen(function* () {
  const port = yield* Config.port
  yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}/health`)).pipe(
    Effect.filterOrFail((response) => response.ok),
  )
})

/** This copy of yapd, which the service and hooks run. */
export const main = join(import.meta.dir, "main.ts")

/** The bun on the PATH. execPath resolves symlinks, which would pin a versioned install that an upgrade removes. */
export const bun = () => Bun.which("bun") ?? process.execPath

/** Writes the LaunchAgent and (re)starts it, so config changes apply too. */
export const install = Effect.gen(function* () {
  const options: Options = {
    bun: bun(),
    main,
    // The daemon reads .env from here.
    workingDirectory: home,
    path: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    home: process.env.YAPD_HOME === undefined ? undefined : home,
    log: logPath,
  }
  yield* Effect.tryPromise(async () => {
    await mkdir(dirname(plistPath), { recursive: true })
    await mkdir(dirname(logPath), { recursive: true })
    await Bun.write(plistPath, plist(options))
  })
  yield* bootout
  // launchd can take a moment to let go of the old instance.
  yield* run(["launchctl", "bootstrap", domain, plistPath]).pipe(
    Effect.retry({ times: 5, schedule: Schedule.spaced("500 millis") }),
  )
  yield* healthy.pipe(
    Effect.retry({ times: 20, schedule: Schedule.spaced("500 millis") }),
    Effect.matchEffect({
      onSuccess: () => Console.log(`yapd is running and starts at login. Logs: ${logPath}`),
      onFailure: () => Console.error(`yapd is installed but not answering yet. Check ${logPath}`),
    }),
  )
})

export const uninstall = Effect.gen(function* () {
  yield* bootout
  yield* Effect.tryPromise(() => rm(plistPath, { force: true }))
  yield* Console.log("yapd is stopped and won't start at login.")
})
