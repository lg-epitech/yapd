import { Console, Effect, Option, Schema } from "effect"
import { existsSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import * as CodexServer from "./CodexServer.ts"
import * as Config from "./Config.ts"
import * as Helper from "./Helper.ts"
import * as Home from "./Home.ts"
import { run } from "./Process.ts"
import * as Provider from "./Provider.ts"
import * as Service from "./Service.ts"
import * as Setup from "./Setup.ts"
import * as T3CodeServer from "./T3CodeServer.ts"
import { repo as vadRepo } from "./Vad.ts"
import { kokoroRepo } from "./Voice.ts"

// `yapd doctor`: what yapd needs, checked one at a time, each with what to do
// when it's missing. Apart from main.ts's other commands, since it reads the
// models' modules, which hooks shouldn't load.

export type Status = "ok" | "warn" | "fail"

export interface Finding {
  readonly status: Status
  readonly text: string
}

const ok = (text: string): Finding => ({ status: "ok", text })
const warn = (text: string): Finding => ({ status: "warn", text })
const fail = (text: string): Finding => ({ status: "fail", text })

const mac = process.platform === "darwin" && process.arch === "arm64"

/** Settings and rules in yapd's home, and none left where they're no longer read. */
const settings = (folder: string): Array<Finding> => [
  existsSync(Home.settings)
    ? ok(`Settings in ${Home.settings}`)
    : warn(`There are no settings in ${Home.settings}, so yapd runs on its defaults. yapd setup starts the file.`),
  ...[".env", "preferences.md"]
    .map((name) => join(folder, name))
    .filter((path) => existsSync(path))
    .map((path) => warn(`${path} isn't read any more. Move what's in it to ${join(Home.home, basename(path))}.`)),
]

/** The paths a hook's command runs, unquoted ones only, which is how setup writes them unless they have spaces. */
const paths = (command: string) => command.split(/\s+/).filter((word) => word.startsWith("/"))

const CodexHooks = Schema.Struct({
  data: Schema.Array(Schema.Struct({
    hooks: Schema.Array(Schema.Struct({
      command: Schema.NullOr(Schema.String),
      enabled: Schema.Boolean,
      trustStatus: Schema.String,
    })),
  })),
})

/** Registration alone isn't enough: Codex skips hooks that aren't trusted. */
export const codexTrust = (listed: typeof CodexHooks.Type, main?: string): Array<Finding> => {
  const hooks = listed.data.flatMap(({ hooks }) => hooks.filter((hook) => Setup.ours(hook, main)))
  if (hooks.length === 0) return [warn("Codex didn't list yapd's hooks. Run codex and open /hooks on this machine to inspect them.")]
  const findings: Array<Finding> = []
  if (hooks.some(({ enabled }) => !enabled)) findings.push(fail("Codex has disabled hooks for yapd. Run codex and enable them in /hooks on this machine."))
  if (hooks.some(({ trustStatus }) => trustStatus === "untrusted")) findings.push(fail("Codex hasn't trusted yapd's hooks, so they won't run. Run codex and trust them in /hooks on this machine."))
  if (hooks.some(({ trustStatus }) => trustStatus === "modified")) findings.push(fail("Codex's hooks for yapd changed since they were trusted, so they won't run. Run codex and review and trust them again in /hooks on this machine."))
  if (hooks.some(({ trustStatus }) => !["trusted", "untrusted", "modified"].includes(trustStatus))) findings.push(warn("Codex reported an unknown hook trust status. Run codex and inspect /hooks on this machine."))
  return findings.length === 0 ? [ok("Codex trusts yapd's hooks. Trust survives restarts; changed hook definitions need approval again.")] : findings
}

/** yapd's hooks for the agent, if it's here, and whether they run this copy of yapd. */
export const hooks = (agent: Setup.Agent, command: ReturnType<typeof Setup.command>, main?: string) =>
  Effect.gen(function* () {
    if (!Setup.present(agent)) return []
    const { file, name } = Setup.config(agent)
    const found = Setup.find((yield* Setup.read(file)).hooks ?? {}, main)
    const wanted = (agent === "claude" ? Setup.claude : Setup.codex)(command)
    const events = Object.entries(wanted)
    const missing = events.filter(([event]) => (found[event] ?? []).length === 0).map(([event]) => event)
    // The first of yapd's hooks that runs something other than this yapd.
    const other = events
      .flatMap(([event, hook]) => (found[event] ?? []).some((existing) => JSON.stringify(existing) === JSON.stringify(hook)) ? [] : (found[event] ?? []))
      .map((hook) => String(hook.command))
      .at(0)
    const gone = other === undefined ? undefined : paths(other).find((path) => !existsSync(path))
    const findings: Array<Finding> = []
    if (missing.length > 0) findings.push(fail(`${name} has no ${missing.join(" or ")} hook for yapd. yapd setup adds them.`))
    if (gone !== undefined) findings.push(fail(`${name}'s hooks run ${gone}, which isn't there any more. yapd setup points them here.`))
    else if (other !== undefined) findings.push(warn(`${name}'s hooks run ${other}, not this yapd. yapd setup points them here.`))
    if (agent === "codex" && Object.values(found).some((hooks) => hooks.length > 0)) {
      findings.push(...yield* CodexServer.hooks(process.cwd()).pipe(
        Effect.flatMap(Schema.decodeUnknown(CodexHooks)),
        Effect.map((listed) => codexTrust(listed, main)),
        Effect.orElseSucceed(() => [warn("Couldn't check whether Codex trusts yapd's hooks. Make sure codex is on the PATH, then run codex and inspect /hooks on this machine.")]),
      ))
    }
    return findings.length === 0 ? [ok(`${name}'s hooks, in ${file}`)] : findings
  }).pipe(Effect.catchAll((error) => Effect.succeed([fail(error.message)])))

/** Whether yapd answers where hooks send to: here on the Mac, or through the forwarded port elsewhere. */
const daemon = Effect.gen(function* () {
  const port = yield* Config.port
  const answered = yield* Effect.promise(() =>
    fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok, () => false),
  )
  if (answered) return [ok(mac ? `yapd is answering on port ${port}` : `Hooks reach yapd through port ${port}`)]
  return [
    mac
      ? fail(`yapd isn't answering on port ${port}. Its log is ${Service.logPath}.`)
      : warn(`Hooks can't reach yapd at 127.0.0.1:${port}. Forward that port from the Mac that speaks, as the README says.`),
  ]
})

/** What launchd runs, as `yapd install` wrote it. */
const Plist = Schema.parseJson(
  Schema.Struct({
    ProgramArguments: Schema.Array(Schema.String),
    EnvironmentVariables: Schema.optional(Schema.Struct({ PATH: Schema.optional(Schema.String) })),
  }),
)

/** The CLI that runs a provider. */
const cli = (name: Provider.Name) =>
  Provider.providers[name].command({ prompt: "", model: undefined, effort: undefined, tier: undefined, schema: { json: "{}", path: "" } }).argv[0]!

/** The service, and what it finds on the PATH it was installed with. */
const service = (main: string) =>
  Effect.gen(function* () {
    if (!existsSync(Service.plistPath)) return [fail("The service isn't installed. yapd install starts yapd, and at every login.")]
    const plist = yield* run(["plutil", "-convert", "json", "-o", "-", Service.plistPath]).pipe(
      Effect.flatMap(Schema.decodeUnknown(Plist)),
      Effect.option,
    )
    if (Option.isNone(plist)) return [fail(`I couldn't read ${Service.plistPath}. yapd install writes it again.`)]
    const { ProgramArguments: argv, EnvironmentVariables: environment } = plist.value
    const findings: Array<Finding> = []
    if (argv[1] !== main) findings.push(warn(`The service runs ${argv[1]}, not this yapd. yapd install switches it.`))
    const path = environment?.PATH ?? ""
    const on = (command: string) => Bun.which(command, { PATH: path }) !== null
    const providers = [yield* Config.provider, ...Option.toArray(yield* Config.writerProvider)]
    for (const command of new Set(providers.map(cli))) {
      findings.push(
        on(command)
          ? ok(`The service finds ${command}`)
          : fail(`The service can't find ${command}, which writes what yapd says. Run yapd install from a shell where it's on the PATH.`),
      )
    }
    if ((yield* Config.effect) !== "none" && !on("ffmpeg")) {
      findings.push(warn("The service can't find ffmpeg, so the voice plays without its effect."))
    }
    return findings
  })

/** What building the audio helper needs, and whether it's built. It's rebuilt when an update changes it. */
const helper = Effect.gen(function* () {
  const tools = yield* run(["xcode-select", "-p"]).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  const built = existsSync(join(Helper.app, "Contents", "MacOS", "yapd-audio"))
  if (tools) return [ok(built ? "The audio helper is built" : "The audio helper builds when yapd next starts")]
  return [
    built
      ? warn("Rebuilding the audio helper after an update needs Xcode's command line tools: xcode-select --install")
      : fail("Building the audio helper needs Xcode's command line tools: xcode-select --install"),
  ]
})

/** The speech models that have downloaded, by the mark yapd leaves on each. */
const models = Effect.gen(function* () {
  const repos = [...new Set([kokoroRepo, vadRepo, yield* Config.whisper, yield* Config.dictationWhisper])]
  const missing = repos.filter((repo) => !existsSync(join(Home.models, repo, ".yapd-loaded")))
  return [
    missing.length === 0
      ? ok(`The speech models are in ${Home.models}`)
      : warn(`${missing.join(", ")} ${missing.length === 1 ? "downloads" : "download"} when yapd next starts, into ${Home.models}`),
  ]
})

/** Whether T3 Code takes yapd's token, when there is one. */
const t3code = Effect.gen(function* () {
  const token = yield* Config.t3codeToken
  if (Option.isNone(token)) return []
  return yield* T3CodeServer.locate.pipe(
    Effect.flatMap((server) => T3CodeServer.api(server, token.value)("/api/orchestration/shell", Schema.Unknown)),
    Effect.as([ok("T3 Code takes yapd's token")]),
    Effect.catchAll(({ reason }) =>
      Effect.succeed([
        reason.includes("token")
          ? fail(`${reason} Issue a new one as the README says, and put it in ${Home.settings}.`)
          : warn(`${reason} yapd reaches its threads once it is.`),
      ]),
    ),
  )
})

/** Each machine in YAPD_REMOTES, over SSH as follow-ups reach it. yapd with no command prints its usage. */
const remotes = Effect.gen(function* () {
  const machines = [...(yield* Config.remotes)]
  return yield* Effect.forEach(
    machines,
    ([host, destination]) =>
      run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", destination, "cd / && yapd"]).pipe(
        Effect.timeout("10 seconds"),
        Effect.as(warn(`yapd on ${host} answered oddly. Updating it there may help.`)),
        Effect.catchAll((error) =>
          Effect.succeed(
            error._tag === "TimeoutException"
              ? fail(`${host} didn't answer over SSH as ${destination}.`)
              : error.code === 255
                ? fail(`I can't reach ${host} over SSH as ${destination}. yapd needs a key that works without a password.`)
                : error.code === 127
                  ? fail(`yapd isn't on ${host}'s PATH for SSH commands. The README says how to add it.`)
                  : error.stderr.includes("usage: yapd")
                    ? ok(`${host} runs yapd over SSH`)
                    : warn(`yapd on ${host} answered oddly: ${error.stderr.split("\n").at(-1)}`),
          ),
        ),
      ),
    { concurrency: "unbounded" },
  )
})

/** What SSH commands from the Mac need here, to send follow-ups on. */
const reachable = Effect.sync(() => [
  Bun.which("yapd") === null
    ? warn("yapd isn't on the PATH, so the Mac can't send follow-ups here. Add ~/.bun/bin to PATH in ~/.zshenv, or at the top of ~/.bashrc.")
    : ok("yapd is on the PATH, for follow-ups from the Mac"),
])

const marks: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" }

/** Checks everything, says what it found, and fails when anything is broken. */
export const doctor = (bun: string, main: string) =>
  Effect.gen(function* () {
    const command = Setup.command(bun, main, Setup.environment())
    const checks = [
      Effect.sync(() => settings(dirname(dirname(main)))),
      hooks("claude", command, main),
      hooks("codex", command, main),
      daemon,
      ...(mac ? [service(main), helper, models] : [reachable]),
      t3code,
      remotes,
    ]
    const findings = (yield* Effect.all(checks, { concurrency: "unbounded" })).flat()
    for (const { status, text } of findings) yield* Console.log(`${marks[status]} ${text}`)
    return findings.some(({ status }) => status === "fail")
  })
