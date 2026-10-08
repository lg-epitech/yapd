import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The menu bar app has no test target, so its checks in app/checks are built
// with swiftc, together with the files of the app they check, and run. They
// need a Mac's Foundation, as the app does, so they're skipped only where
// there's no Mac swiftc to build them with.

const app = join(import.meta.dir, "..", "app")

/** A Mac's swiftc, unless it's missing, or only a stand-in that asks to install the developer tools. */
const swiftc = (() => {
  const found = process.platform === "darwin" ? Bun.which("swiftc") : null
  return found !== null && Bun.spawnSync([found, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0 ? found : undefined
})()

/** Builds the checks with the app's files they check, runs them, and gives back what they printed and how they ended. */
const checked = async (files: ReadonlyArray<string>) => {
  const dir = await mkdtemp(join(tmpdir(), "yapd-app-"))
  try {
    const binary = join(dir, "checks")
    const sources = [...files.map((file) => join(app, "yapd", file)), ...new Bun.Glob("*.swift").scanSync({ cwd: join(app, "checks"), absolute: true })]
    const built = Bun.spawn([swiftc!, "-swift-version", "6", "-o", binary, ...sources], { stdout: "pipe", stderr: "pipe" })
    if ((await built.exited) !== 0) return { code: built.exitCode, out: await new Response(built.stderr).text() }
    const ran = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(ran.stdout).text()
    return { code: await ran.exited, out }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("App", () => {
  test.skipIf(swiftc === undefined)(
    "the panel opens only https links from a card, never a file, a script or another app's, and shows code blocks as text that links nowhere",
    async () => {
      expect(await checked(["Cards.swift"])).toEqual({ code: 0, out: "The app's checks pass.\n" })
      // What the checks cover is what the panel uses: every link it's asked to open goes through the same gate, and every block shows as checked.
      const panel = await Bun.file(join(app, "yapd", "Panel.swift")).text()
      expect(panel.match(/OpenURLAction\s*\{[^}]*\}/g)).toEqual(["OpenURLAction { url in opens(url) ? .systemAction : .discarded }"])
      expect(panel).not.toMatch(/AttributedString\(|Text\(verbatim|\.systemAction(?! : \.discarded)/)
    },
    120_000,
  )
})
