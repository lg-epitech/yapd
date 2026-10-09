import { afterAll, describe, expect, test } from "bun:test"
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

/** The app's files the checks check, which need neither AppKit nor SwiftUI. */
const checked = ["Cards.swift", "Fading.swift", "State.swift"]

/** Where the checks are built, once, and removed after. */
const dir = mkdtemp(join(tmpdir(), "yapd-app-"))

/** The checks, built the first time they're run: their path, or what swiftc said when they didn't build. */
let built: Promise<{ readonly path?: string; readonly error?: string }> | undefined

const build = async () => {
  const path = join(await dir, "checks")
  const sources = [...checked.map((file) => join(app, "yapd", file)), ...new Bun.Glob("*.swift").scanSync({ cwd: join(app, "checks"), absolute: true })]
  const swift = Bun.spawn([swiftc!, "-swift-version", "6", "-o", path, ...sources], { stdout: "pipe", stderr: "pipe" })
  return (await swift.exited) === 0 ? { path } : { error: await new Response(swift.stderr).text() }
}

/** Runs the checks of one name, and gives back what they printed and how they ended. */
const run = async (checks: string) => {
  built ??= build()
  const { path, error } = await built
  if (path === undefined) return { code: -1, out: error }
  const ran = Bun.spawn([path, checks], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(ran.stdout).text()
  return { code: await ran.exited, out }
}

afterAll(async () => {
  await rm(await dir, { recursive: true, force: true })
})

describe.skipIf(swiftc === undefined)("App", () => {
  test(
    "the panel opens only https links from a card, never a file, a script or another app's, and shows code blocks as text that links nowhere",
    async () => {
      expect(await run("cards")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      // What the checks cover is what the panel uses: every link it's asked to open goes through the same gate, and every block shows as checked.
      const panel = await Bun.file(join(app, "yapd", "Panel.swift")).text()
      expect(panel.match(/OpenURLAction\s*\{[^}]*\}/g)).toEqual(["OpenURLAction { url in opens(url) ? .systemAction : .discarded }"])
      expect(panel).not.toMatch(/AttributedString\(|Text\(verbatim|\.systemAction(?! : \.discarded)/)
    },
    120_000,
  )

  test(
    "the panel puts up the card yapd points at once it can fetch it, trying again a few times, checks what it shows against it whenever it connects, has yapd take down only the card it means, and shows the last card again only if nothing newer came while it was fetched",
    async () => {
      expect(await run("following")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      // What the checks cover is what the app uses: the card it shows is the one it follows, and the one it has yapd take down is the one it names.
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      expect(yapd).toMatch(/following\.follow\(status\.showing, connecting: connecting\)/)
      expect(yapd).not.toMatch(/panel\.show\(card, talking: (true|false)\)/)
      expect(yapd.match(/send\("DELETE"[^\n]*/g)).toEqual(['send("DELETE", "cards/current", query: [URLQueryItem(name: "id", value: id)], to: api) },'])
      // The last card is shown again, and put back up, only by Following, which checks nothing newer came while it was fetched.
      expect(yapd).toMatch(/func showLast\(\) \{\s*guard let last else \{ return \}\s*following\.showAgain\(last\) \{/)
      expect(yapd.match(/Yapd\.fetch\([^)]*\)/g)).toEqual(["Yapd.fetch(id, from: api)"])
      expect(yapd.match(/send\("PUT", "cards[^\n]*/g)).toEqual(['send("PUT", "cards/current", body: try? JSONEncoder().encode(["id": id]), to: api) },'])
    },
    120_000,
  )

  test(
    "the panel keeps a card up while yapd talks about it, even one fetched after it started, and fades it a while after, or a while after it's shown with nothing said",
    async () => {
      expect(await run("fading")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      // What the checks cover is what the panel uses: it fades a card only as it's told, with no timer of its own, and is told whether yapd is
      // speaking with every state, card or not.
      const panel = await Bun.file(join(app, "yapd", "Panel.swift")).text()
      expect(panel).toMatch(/func heard\(speaking: Bool\) \{\s*fading\.heard\(speaking: speaking\)\s*\}/)
      expect(panel).toMatch(/panel\.orderFrontRegardless\(\)\s*fading\.shown\(talking: talking\)\s*\}/)
      expect(panel).toMatch(/func hide\(\) \{\s*fading\.hidden\(\)/)
      expect(panel).toMatch(/func away\(\) \{\s*fading\.away\(\)\s*\}/)
      expect(panel).not.toMatch(/Task\s*\{/)
      // Kept up after all, or shown afresh, the card stops fading and shows in full, and a fade that ends late puts away only its own card.
      expect(panel).toMatch(/keep: \{ \[weak self\] in self\?\.keep\(\) \}/)
      expect(panel).toMatch(/shown \+= 1\s/)
      expect(panel).toMatch(/keep\(\)\s*panel\.orderFrontRegardless\(\)/)
      expect(panel).toMatch(/let showing = shown\s*await NSAnimationContext\.runAnimationGroup/)
      expect(panel).toMatch(/guard !Task\.isCancelled, showing == shown else \{ return \}\s*close\(\)/)
      expect(panel.match(/alphaValue = \d/g)).toEqual(["alphaValue = 0", "alphaValue = 1"])
      expect(panel).toMatch(/context\.duration = 0\s*panel\.animator\(\)\.alphaValue = 1/)
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      // Gone, the panel is told it's away, not that yapd stopped speaking, so a card still being talked about once it's back stays up.
      expect(yapd.match(/panel\.heard\([^)]*\)/g)).toEqual(['panel.heard(speaking: status.activity == "speaking")'])
      expect(yapd).toMatch(/panel\.away\(\)\s*following\.away\(\)/)
    },
    120_000,
  )
})
