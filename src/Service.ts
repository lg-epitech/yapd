import { Console, Effect, Option, Schedule } from "effect"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import * as Config from "./Config.ts"
import { home } from "./Home.ts"
import { environment } from "./Setup.ts"
import { run } from "./Process.ts"

// What keeps yapd running: launchd on a Mac, systemd's user instance on Linux.
// A server runs `yapd serve`, the daemon itself. A client of yapd on another
// machine runs `yapd client`, which only connects to it.

export type Role = "server" | "client"

const mac = process.platform === "darwin"

export const label = "dev.yapd"
const labels: Record<Role, string> = { server: label, client: `${label}.client` }
const units: Record<Role, string> = { server: "yapd.service", client: "yapd-client.service" }
const commands: Record<Role, string> = { server: "serve", client: "client" }

const agent = (role: Role) => join(homedir(), "Library", "LaunchAgents", `${labels[role]}.plist`)
export const plistPath = agent("server")
export const unitPath = (role: Role) => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", units[role])
const macLog = (role: Role) => join(homedir(), "Library", "Logs", role === "server" ? "yapd.log" : "yapd-client.log")

/** Where its log is, or how to read it, as said to the user. */
export const log = (role: Role = "server") => (mac ? macLog(role) : `journalctl --user -u ${units[role]}`)
export const logPath = log("server")

const domain = `gui/${userInfo().uid}`

export interface Options {
  readonly bun: string
  readonly main: string
  readonly workingDirectory: string
  /** launchd starts agents with a bare PATH, so the provider CLIs and ffmpeg wouldn't be found. */
  readonly path: string
  /** The settings hooks carry too, like YAPD_HOME, which the daemon can't read from the .env inside it. */
  readonly environment?: Readonly<Record<string, string>>
  readonly log: string
  /** What it runs: `serve`, or `client`. */
  readonly command?: string
  readonly label?: string
}

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const string = (value: string) => `<string>${escape(value)}</string>`

/** Starts at login and restarts whenever it exits. */
export const plist = (options: Options) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(options.label ?? label)}
  <key>ProgramArguments</key>
  <array>
    ${string(options.bun)}
    ${string(options.main)}
    ${string(options.command ?? "serve")}
  </array>
  <key>WorkingDirectory</key>${string(options.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${string(options.path)}${Object.entries(options.environment ?? {})
      .map(([name, value]) => `
    <key>${escape(name)}</key>${string(value)}`)
      .join("")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${string(options.log)}
  <key>StandardErrorPath</key>${string(options.log)}
</dict>
</plist>
`

/** A value as systemd reads it inside double quotes, with its own `%` specifiers kept literal. WorkingDirectory takes no quotes, only the rest of its line. */
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`

/** Starts with the user's systemd, which lingering keeps up while they're logged out, and restarts whenever it exits. */
export const unit = (options: Options) => `[Unit]
Description=yapd${options.command === "client" ? " client" : ""}
After=network-online.target

[Service]
ExecStart=${[options.bun, options.main, options.command ?? "serve"].map(quoted).join(" ")}
WorkingDirectory=${options.workingDirectory.replaceAll("%", "%%")}
Environment=${quoted(`PATH=${options.path}`)}${Object.entries(options.environment ?? {})
  .map(([name, value]) => `
Environment=${quoted(`${name}=${value}`)}`)
  .join("")}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`

/** Fails when the service isn't loaded, which is fine to ignore. */
const bootout = (role: Role) => run(["launchctl", "bootout", `${domain}/${labels[role]}`]).pipe(Effect.ignore)

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

/** Whether systemd keeps the user's services up while they're logged out. */
const lingering = run(["loginctl", "show-user", userInfo().username, "--property=Linger", "--value"]).pipe(
  Effect.map((said) => said.trim() === "yes"),
  Effect.orElseSucceed(() => true),
)

/** Writes the service and (re)starts it, so config changes apply too. */
export const install = (role: Role = "server") =>
  Effect.gen(function* () {
    const options: Options = {
      bun: bun(),
      main,
      // The daemon reads .env from here.
      workingDirectory: home,
      path: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      // The same as the hooks get, so they reach the port it listens on, even one set only for this command.
      environment: environment(),
      log: mac ? macLog(role) : "",
      command: commands[role],
      label: labels[role],
    }
    // One or the other: a machine that uses yapd on another doesn't run its own, which would hold the port.
    const other: Role = role === "server" ? "client" : "server"
    if (mac) {
      yield* Effect.tryPromise(async () => {
        await mkdir(dirname(agent(role)), { recursive: true })
        await mkdir(dirname(options.log), { recursive: true })
        await Bun.write(agent(role), plist(options))
      })
      yield* bootout(other)
      yield* Effect.tryPromise(() => rm(agent(other), { force: true }))
      yield* bootout(role)
      // launchd can take a moment to let go of the old instance.
      yield* run(["launchctl", "bootstrap", domain, agent(role)]).pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced("500 millis") }),
      )
    } else {
      yield* Effect.tryPromise(async () => {
        await mkdir(dirname(unitPath(role)), { recursive: true })
        await Bun.write(unitPath(role), unit(options))
      })
      yield* run(["systemctl", "--user", "disable", "--now", units[other]]).pipe(Effect.ignore)
      yield* Effect.tryPromise(() => rm(unitPath(other), { force: true }))
      yield* run(["systemctl", "--user", "daemon-reload"])
      yield* run(["systemctl", "--user", "enable", units[role]])
      yield* run(["systemctl", "--user", "restart", units[role]])
      if (!(yield* lingering)) {
        yield* Console.log(`To keep yapd running while you're logged out: sudo loginctl enable-linger ${userInfo().username}`)
      }
    }
    // A client answers once it has reached its server, which takes a moment longer.
    const where = role === "server" ? "yapd is running and starts at login." : `yapd reaches ${Option.getOrElse(yield* Config.server, () => "its server")} and starts at login.`
    yield* healthy.pipe(
      Effect.retry({ times: role === "server" ? 20 : 60, schedule: Schedule.spaced("500 millis") }),
      Effect.matchEffect({
        onSuccess: () => Console.log(`${where} Logs: ${log(role)}`),
        onFailure: () => Console.error(`yapd is installed but not answering yet. Check ${log(role)}`),
      }),
    )
  })

/** Whether that service is set up here. */
export const installed = (role: Role) => existsSync(mac ? agent(role) : unitPath(role))

/** Restarts the daemon if it's running, so it takes in what changed, like a new client. */
export const restart = mac
  ? run(["launchctl", "kickstart", "-k", `${domain}/${label}`]).pipe(Effect.ignore)
  : run(["systemctl", "--user", "try-restart", units.server]).pipe(Effect.ignore)

export const uninstall = Effect.gen(function* () {
  for (const role of ["server", "client"] as const) {
    if (mac) {
      yield* bootout(role)
      yield* Effect.tryPromise(() => rm(agent(role), { force: true }))
    } else {
      yield* run(["systemctl", "--user", "disable", "--now", units[role]]).pipe(Effect.ignore)
      yield* Effect.tryPromise(() => rm(unitPath(role), { force: true }))
    }
  }
  if (!mac) yield* run(["systemctl", "--user", "daemon-reload"]).pipe(Effect.ignore)
  yield* Console.log("yapd is stopped and won't start at login.")
})
