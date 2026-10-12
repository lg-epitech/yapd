import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Icons from "./Icons.ts"

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
const checked = ["Cards.swift", "Fading.swift", "Recent.swift", "State.swift"]

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

/** Runs the checks of one name, with `env` beside the environment, and gives back what they printed and how they ended. */
const run = async (checks: string, env: Record<string, string> = {}) => {
  built ??= build()
  const { path, error } = await built
  if (path === undefined) return { code: -1, out: error }
  const ran = Bun.spawn([path, checks], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
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
    "the panel puts up the card yapd points at once it can fetch it, trying again a few times, checks what it shows against it whenever it connects, has yapd take down only the card it means, as it went up the time it follows, and shows the last card again only if nothing newer came while it was fetched, keeping it to ask for again unless yapd says it no longer has it, and having yapd put it back up only at the revision it had followed last",
    async () => {
      expect(await run("following")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      // What the checks cover is what the app uses: the card it shows is the one it follows, at the revision it follows, and the one it has yapd take
      // down is the one it names, as it went up then.
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      expect(yapd).toMatch(/following\.follow\(status\.showing, revision: status\.revision, connecting: connecting\)/)
      expect(yapd).not.toMatch(/panel\.show\(card, talking: (true|false)\)/)
      expect(yapd.match(/send\("DELETE"[^\n]*/g)).toEqual(['send("DELETE", "cards/current", query: down.query, to: api) },'])
      // The last card is shown again, and put back up, only by Following, which checks nothing newer came while it was fetched.
      expect(yapd).toMatch(/func showLast\(\) \{\s*guard let last else \{ return \}\s*following\.showAgain\(last\) \{/)
      expect(yapd.match(/Yapd\.fetch\([^)]*\)/g)).toEqual(["Yapd.fetch(id, from: api)"])
      // yapd's answer is read as the checks read it, so only a 404 has the last card taken for gone.
      expect(yapd).toMatch(
        /async -> Fetched \{\s*guard let \(body, response\) = try\? await URLSession\.shared\.data\(from: api\.appending\(path: "cards\/\\\(id\)"\)\) else \{ return \.failed \}\s*return Fetched\(body, response\)\s*\}/,
      )
      // Put back up with the revision Following asked at, and in the task it shows the card again in, so a card superseded first stops the request
      // unless it's gone already, which yapd then turns away.
      expect(yapd.match(/(send|sent)\("PUT", "cards[^\n]*/g)).toEqual(['sent("PUT", "cards/current", body: try? JSONEncoder().encode(back), to: api) },'])
      expect(yapd).toMatch(/putBack: \{ back in await Yapd\.sent\("PUT"/)
      expect(yapd).toMatch(/func sent\([^)]*\) async \{(?:(?!Task \{)[\s\S])*?_ = try\? await URLSession\.shared\.data\(for: request\)\s*\}/)
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

  test(
    "the menu lists the threads with the latest updates from a yapd that sends them, and the updates it said from one that doesn't, draws each icon or the monogram yapd makes in T3 Code's colours, tells how long ago each ended, and mutes and replays a thread only by its key, on yapd's API",
    async () => {
      // The monograms yapd makes, of names the checks don't have, so the app draws a project with no icon as yapd and T3 Code do.
      const names = ["yapd", "Tezos 2", "integration-connectors", "  spaced out  ", "ﬁle", "日本語", "Straße", "İstanbul", "x1y2", "ⅫRoman", "²squared", "Émile Zola", "🦀 crab", "a-b-c"]
      const monograms = names.map((name) => [name, Icons.monogram(name).text, Icons.monogram(name).color])
      expect(await run("recent", { YAPD_COLORS: Icons.colors.join(","), YAPD_MONOGRAMS: JSON.stringify(monograms) })).toEqual({ code: 0, out: "The app's checks pass.\n" })
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      // A thread is muted, unmuted and heard again only through Muting and Replaying, which encode its key whole, and nothing else is sent of it.
      expect(yapd.match(/(Muting|Replaying)\([^)]*\)/g)).toEqual(["Replaying(row)", "Muting(row, on: on)"])
      expect(yapd).not.toMatch(/threads\//)
      expect(yapd).toMatch(/private func ask\(_ asking: some Asking\) \{\s*guard let url = asking\.url\(at: api\) else \{ return \}/)
      // Rows are replayed and muted from the menu by the row, never by its text, and listed only while yapd sends them, else the updates it said.
      expect(yapd).toMatch(/Button \{ replay\(row\) \} label:/)
      // A row yapd can't say again shows as any other, but hearing it again is turned off, and never asked for; muting it isn't.
      expect(yapd).toMatch(/Button \{ replay\(row\) \} label: \{ label\(row\) \}\s*\.disabled\(!row\.hearable\(on: on\)\)/)
      expect(yapd).toMatch(/func replay\(_ row: Status\.Recent\) \{\s*guard row\.replayable else \{ return \}\s*ask\(Replaying\(row\)\)/)
      expect(yapd).not.toMatch(/Toggle\([^\n]*\n[^\n]*\.disabled/)
      expect(yapd).toMatch(/Toggle\(row\.label, isOn: Binding\(get: \{ row\.muted \}, set: \{ mute\(row, \$0\) \}\)\)/)
      expect(yapd).toMatch(/if let recent = state\.recent \{[\s\S]*\} else if !state\.updates\.isEmpty \{\s*\/\/[^\n]*\n\s*Divider\(\)\s*Section\("Hear Again"\)/)
      // An image is fetched only from yapd's own API, and anything it can't draw is drawn as the icon's monogram.
      const icons = await Bun.file(join(app, "yapd", "Icons.swift")).text()
      expect(icons.match(/URLRequest\(url: [^)]*\)/g)).toEqual(["URLRequest(url: address)"])
      // Kept by revision, never by URLSession's cache under an address that stays the same when the image changes.
      expect(icons).toMatch(/request\.cachePolicy = \.reloadIgnoringLocalCacheData/)
      expect(icons).toMatch(/guard let address = imageAddress\(url, at: api\) else/)
      expect(icons).toMatch(/guard let monogram = row\.monogram else/)
    },
    120_000,
  )

  test(
    "the menu reads the mode, when it ends and how many threads wait from any yapd, shows the moon and the dot as they say, has yapd change only its mode with a PUT /state, and asks who's waiting as he'd say it",
    async () => {
      expect(await run("mode")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      // The icon is what the checks say it is, and the mode is changed only by what they check, never with `on` or a time of the app's own.
      expect(yapd).toMatch(/switch Status\.look\(state\) \{/)
      expect(yapd).toMatch(/case \.on\(let moon, let dot\):[\s\S]*?Mark\.on\(moon: moon, dot: dot\)/)
      expect(yapd).not.toMatch(/Mark\.on\)/)
      expect(yapd).toMatch(/func talk\(in mode: Mode\) \{\s*guard let change = state\?\.change\(to: mode\) else \{ return \}\s*send\("PUT", "state", body: try\? JSONEncoder\(\)\.encode\(change\)\)\s*\}/)
      expect(yapd.match(/send\("PUT", "state"[^\n]*/g)).toEqual(['send("PUT", "state", body: try? JSONEncoder().encode(["on": on]))', 'send("PUT", "state", body: try? JSONEncoder().encode(change))'])
      expect(yapd).not.toMatch(/until:/)
      // The menu offers the modes only to a yapd that has them, each choice through `talk`, and its line while one is on.
      expect(yapd).toMatch(/if let mode = state\.mode \{\s*if let line = state\.modeLine\(now: yapd\.now\) \{ Text\(line\) \}\s*ModeItems\(mode: mode, talk: yapd\.talk\)/)
      expect(yapd).toMatch(/Toggle\(each\.item, isOn: Binding\(get: \{ mode == each \}, set: \{ _ in talk\(each\) \}\)\)/)
      // Who's waiting is asked only with the words the checks check, and only while yapd answers it: on, or off for one that answers then.
      expect(yapd.match(/send\("POST", "utterances"[^\n]*/g)).toEqual([
        'send("POST", "utterances", body: try? JSONEncoder().encode(Utterance.whoNeedsMe))',
        'send("POST", "utterances", body: try? JSONEncoder().encode(Utterance.catchMeUp))',
      ])
      expect(yapd).toMatch(/if let waiting = state\.waitingLine \{[^}]*Button\(waiting\) \{ yapd\.whoNeedsMe\(\) \}\s*\.disabled\(!state\.answers\)/)
    },
    120_000,
  )

  test(
    "the menu reads how much he hasn't heard from any yapd, says it beside a thread that isn't muted, and offers Catch Me Up only while there's something, asking for it as he'd say it, even while yapd is off",
    async () => {
      expect(await run("unheard")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      // Offered under the threads waiting, by the line the checks check, and never turned off while yapd is off: it answers then, as the shortcut does.
      expect(yapd).toMatch(/Button\(waiting\) \{ yapd\.whoNeedsMe\(\) \}\s*\.disabled\(!state\.answers\)\s*\}\s*if let unheard = state\.unheardLine \{\s*\/\/[^\n]*\n\s*Button\(unheard\) \{ yapd\.catchMeUp\(\) \}\s*\}/)
      expect(yapd).toMatch(/func catchMeUp\(\) \{\s*send\("POST", "utterances", body: try\? JSONEncoder\(\)\.encode\(Utterance\.catchMeUp\)\)\s*\}/)
      // Nothing about catching up is sent anywhere but as his words to /utterances: no thread, no replay, no state.
      expect(yapd.match(/catchMeUp/g)?.length).toBe(3)
      // A row is still heard again only as yapd says it can, while it's on, whatever is unheard of it.
      const recent = await Bun.file(join(app, "yapd", "Recent.swift")).text()
      expect(recent).toMatch(/func hearable\(on: Bool\) -> Bool \{\s*on && replayable\s*\}/)
      expect(recent).toMatch(/if unheard > 0 && !muted \{ parts\.append\("\\\(unheard\) unheard"\) \}/)
    },
    120_000,
  )
})
