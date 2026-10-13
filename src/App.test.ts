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
const checked = ["Cards.swift", "Details.swift", "Fading.swift", "Menu.swift", "Recent.swift", "State.swift"]

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
    "the menu lists the threads with the latest updates from a yapd that sends them, and the updates it said from one that doesn't, draws each icon or the monogram yapd makes in T3 Code's colours, tells how long ago each ended, and mutes and replays a thread and has its subagents read only by its key, a subagent's by its thread's, on yapd's API",
    async () => {
      // The monograms yapd makes, of names the checks don't have, so the app draws a project with no icon as yapd and T3 Code do.
      const names = ["yapd", "Tezos 2", "integration-connectors", "  spaced out  ", "ﬁle", "日本語", "Straße", "İstanbul", "x1y2", "ⅫRoman", "²squared", "Émile Zola", "🦀 crab", "a-b-c"]
      const monograms = names.map((name) => [name, Icons.monogram(name).text, Icons.monogram(name).color])
      expect(await run("recent", { YAPD_COLORS: Icons.colors.join(","), YAPD_MONOGRAMS: JSON.stringify(monograms) })).toEqual({ code: 0, out: "The app's checks pass.\n" })
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      // A thread is muted, unmuted, heard again, has its subagents read or not and is asked about only through Muting, Replaying, Subagents and
      // Detailing, which encode its key whole, and nothing else is sent of it.
      expect(yapd.match(/(Muting|Replaying|Subagents|Detailing)(\.\w+)?\([^)]*\)/g)).toEqual([
        "Replaying(row)",
        "Muting.forAnHour(row, from: Date()",
        "Muting(row, on: true)",
        "Muting(row, on: false)",
        "Subagents(row, on: on)",
        "Detailing(row)",
      ])
      expect(yapd).not.toMatch(/threads\//)
      expect(yapd).toMatch(/private func ask\(_ asking: some Asking\) \{\s*guard let request = request\(asking\) else \{ return \}/)
      expect(yapd).toMatch(/private func request\(_ asking: some Asking\) -> URLRequest\? \{\s*guard let url = asking\.url\(at: api\) else \{ return nil \}/)
      // A row yapd can't say again shows as any other, but hearing it again does nothing, and is never asked for; muting it isn't.
      expect(yapd).toMatch(/func replay\(_ row: Status\.Recent\) \{\s*guard row\.replayable else \{ return \}\s*ask\(Replaying\(row\)\)/)
      // Rows are replayed and muted from the menu by the row, never by its text, as the menu's checks check what each item does.
      const bar = await Bun.file(join(app, "yapd", "MenuBar.swift")).text()
      expect(bar).toMatch(/case \.hear\(let row\): yapd\.replay\(row\)/)
      expect(bar).toMatch(/case \.mute\(let row, let forAnHour\): yapd\.mute\(row, forAnHour: forAnHour\)/)
      expect(bar).toMatch(/case \.unmute\(let row\): yapd\.unmute\(row\)/)
      expect(bar).toMatch(/case \.subagents\(let row, let on\): yapd\.subagents\(row, on: on\)/)
      // A subagent's are read by the thread it's part of, never by its own key, which yapd turns away.
      const recent = await Bun.file(join(app, "yapd", "Recent.swift")).text()
      expect(recent).toMatch(/struct Subagents: Asking, Equatable \{[\s\S]*?key = row\.head\?\.key \?\? row\.key/)
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
      const bar = await Bun.file(join(app, "yapd", "MenuBar.swift")).text()
      // The icon is what the checks say it is, and tells VoiceOver what they check, and the mode is changed only by what they check, never with
      // `on` or a time of the app's own.
      expect(bar).toMatch(/switch Status\.look\(state\) \{/)
      expect(bar).toMatch(/case \.on\(let moon, let dot\):[\s\S]*?Mark\.on\(moon: moon, dot: dot\)/)
      expect(bar).not.toMatch(/Mark\.on\)/)
      expect(bar).toMatch(/button\.setAccessibilityLabel\(Status\.told\(state, now: yapd\.now\)\)/)
      expect(yapd).toMatch(/func talk\(in mode: Mode\) \{\s*guard let change = state\?\.change\(to: mode\) else \{ return \}\s*send\("PUT", "state", body: try\? JSONEncoder\(\)\.encode\(change\)\)\s*\}/)
      expect(yapd.match(/send\("PUT", "state"[^\n]*/g)).toEqual(['send("PUT", "state", body: try? JSONEncoder().encode(["on": on]))', 'send("PUT", "state", body: try? JSONEncoder().encode(change))'])
      expect(yapd).not.toMatch(/until:/)
      // The menu offers the modes as its checks check, each choice through `talk`, checked as the item has it.
      expect(bar).toMatch(/case \.talk\(let mode\): yapd\.talk\(in: mode\)/)
      expect(bar).toMatch(/made\.state = item\.checked \? \.on : \.off/)
      // Who's waiting is asked only with the words the checks check, and only while yapd answers it: on, or off for one that answers then.
      expect(yapd.match(/send\("POST", "utterances"[^\n]*/g)).toEqual([
        'send("POST", "utterances", body: try? JSONEncoder().encode(Utterance.whoNeedsMe))',
        'send("POST", "utterances", body: try? JSONEncoder().encode(Utterance.catchMeUp))',
      ])
      expect(bar).toMatch(/case \.whoNeedsMe: yapd\.whoNeedsMe\(\)/)
    },
    120_000,
  )

  test(
    "the menu reads how much he hasn't heard from any yapd, says it beside a thread that isn't muted, and offers Catch Me Up and Clear Catch-Up only while there's something, asking for the one as he'd say it and clearing the other with a POST /catchup/clear and nothing else, even while yapd is off",
    async () => {
      expect(await run("unheard")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      // Offered under the threads waiting, by the line the checks check, and never turned off while yapd is off: it answers then, as the shortcut
      // does. Choosing it only asks for it.
      const bar = await Bun.file(join(app, "yapd", "MenuBar.swift")).text()
      expect(bar.match(/catchMeUp/g)).toEqual(["catchMeUp", "catchMeUp"])
      expect(bar).toMatch(/case \.catchMeUp: yapd\.catchMeUp\(\)/)
      expect(yapd).toMatch(/func catchMeUp\(\) \{\s*send\("POST", "utterances", body: try\? JSONEncoder\(\)\.encode\(Utterance\.catchMeUp\)\)\s*\}/)
      // Nothing about catching up is sent anywhere but as his words to /utterances: no thread, no replay, no state.
      expect(yapd.match(/catchMeUp/g)?.length).toBe(2)
      // Clearing it is only ever asked of yapd as the API has it, with nothing sent, and choosing it only asks for it, with no asking him
      // first: "scratch that" by voice brings it back.
      expect(yapd).toMatch(/func clearCatchUp\(\) \{\s*send\("POST", "catchup\/clear"\)\s*\}/)
      expect(yapd.match(/catchup\//g)).toEqual(["catchup/"])
      expect(bar.match(/clearCatchUp/g)).toEqual(["clearCatchUp", "clearCatchUp"])
      expect(bar).toMatch(/case \.clearCatchUp: yapd\.clearCatchUp\(\)/)
      expect(bar).not.toMatch(/NSAlert/)
      // A row is still heard again only as yapd says it can, while it's on, whatever is unheard of it.
      const recent = await Bun.file(join(app, "yapd", "Recent.swift")).text()
      expect(recent).toMatch(/func hearable\(on: Bool\) -> Bool \{\s*on && replayable\s*\}/)
      expect(recent).toMatch(/if unheard > 0 && !muted \{ parts\.append\("\\\(unheard\) unheard"\) \}/)
    },
    120_000,
  )

  test(
    "the menu shows everything it did, in the same order and turned on and off by the same rules, with a panel beside each recent thread instead of the Mute menu, to hear it again, mute it, for an hour too, or take the mute off, and have its subagents read, and keeps each item by an id, so the open menu changes in place",
    async () => {
      expect(await run("menu")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      // What the checks cover is what the menu bar draws: the menu and each panel are only ever built from Menu, and what's chosen does what the
      // item says.
      const bar = await Bun.file(join(app, "yapd", "MenuBar.swift")).text()
      expect(bar.match(/\bMenu\([^)]*\)/g)).toEqual(["Menu(state, now: yapd.now, last: yapd.last != nil)", "Menu(yapd.state, now: yapd.now, last: yapd.last != nil)"])
      expect(bar.match(/Menu\.panel\([^)]*\)/g)).toEqual(["Menu.panel(for: row, details: details[key])", "Menu.panel(for: row, details: details[key])"])
      expect(bar).toMatch(/@objc private func choose\(_ item: NSMenuItem\) \{\s*guard let action = item\.representedObject as\? Menu\.Action else \{ return \}\s*perform\(action\)\s*\}/)
      expect(bar.match(/made\.isEnabled = [^\n]*/g)).toEqual(["made.isEnabled = item.enabled"])
      expect(bar).toMatch(/case \.turn\(let on\): yapd\.turn\(on: on\)/)
      expect(bar).toMatch(/case \.showLast: yapd\.showLast\(\)/)
      expect(bar).toMatch(/case \.replay\(let update\): yapd\.replay\(update\)/)
      expect(bar).toMatch(/case \.quit: NSApplication\.shared\.terminate\(nil\)/)
      // A row clicked is heard again only when it can be, and closes the menu then; otherwise the menu stays open, and its panel still opens.
      expect(bar).toMatch(/private func click\(_ key: String\) \{\s*guard let row = rows\[key\], row\.hearable else \{ return \}\s*menu\.cancelTracking\(\)\s*perform\(\.hear\(row\.recent\)\)\s*\}/)
      // Open, the menu changes only what it shows already, in place, what isn't offered hidden; built again as it opens, and as yapd stops or
      // starts, which leaves nothing in common with what's shown but Quit, and no rows on one side to move.
      expect(bar).toMatch(/guard open else \{ return \}(\s*\/\/[^\n]*)*\s*if \(state != nil\) != running \{\s*build\(\)\s*fetch\(\)\s*\} else \{\s*change\(menu\)\s*\}/)
      expect(bar).toMatch(/let model = Menu\(yapd\.state, now: yapd\.now, last: yapd\.last != nil\)\s*running = yapd\.state != nil/)
      expect(bar).toMatch(/for item in model\.all \{\s*if let made = made\[item\.id\] \{ apply\(item, to: made\) \}\s*\}/)
      expect(bar).toMatch(/made\.isHidden = item\.hidden/)
      expect(bar).toMatch(/func menuNeedsUpdate\(_ menu: NSMenu\) \{\s*if menu === self\.menu \{\s*build\(\)/)
      // A row follows its own click from the mouse-down, since its panel's menu takes the mouse-up, and is one menu item to VoiceOver, told by all
      // it shows, which pressing clicks.
      const row = await Bun.file(join(app, "yapd", "RecentRow.swift")).text()
      expect(row).toMatch(/override func mouseDown\(with event: NSEvent\) \{[\s\S]*window\.trackEvents\(matching: \[\.leftMouseDragged, \.leftMouseUp\]/)
      // Let go over it after a press elsewhere, as dragging down from the icon, it's clicked too.
      expect(row).toMatch(
        /override func mouseUp\(with event: NSEvent\) \{\s*guard event\.type == \.leftMouseUp, bounds\.contains\(convert\(event\.locationInWindow, from: nil\)\) else \{ return super\.mouseUp\(with: event\) \}\s*clicked\(\)\s*\}/,
      )
      expect(row).toMatch(/setAccessibilityLabel\(row\.told\)/)
      expect(row).toMatch(/accessibilityRole\(\) -> NSAccessibility\.Role\? \{\s*\.menuItem\s*\}/)
      expect(row).toMatch(/accessibilityPerformPress\(\) -> Bool \{\s*guard hearable else \{ return false \}\s*clicked\(\)/)
      expect(row).toMatch(/hearable = row\.hearable/)
    },
    120_000,
  )

  test(
    "a recent thread's panel reads what yapd tells of it from any yapd, asks for it only by its key, mutes it for an hour as yapd reads it, and its card says what the thread is doing, its pull request, whether it's muted and the latest told of it, from the row alone until yapd tells more, or when it can't",
    async () => {
      expect(await run("details")).toEqual({ code: 0, out: "The app's checks pass.\n" })
      // What the checks cover is what the app uses: details are asked for as the menu opens, read as the checks read them, and shown through Glance.
      const yapd = await Bun.file(join(app, "yapd", "YapdApp.swift")).text()
      expect(yapd).toMatch(/func details\(of row: Status\.Recent\) async -> Details\? \{\s*guard let request = request\(Detailing\(row\)\)[^\n]*\n\s*return Details\(body, response\)\s*\}/)
      expect(yapd).toMatch(/func mute\(_ row: Status\.Recent, forAnHour: Bool\) \{\s*ask\(forAnHour \? Muting\.forAnHour\(row, from: Date\(\)\) : Muting\(row, on: true\)\)\s*\}/)
      // Sent with the body the checks check, as JSON.
      expect(yapd).toMatch(/if let body = asking\.body \{\s*request\.setValue\("application\/json", forHTTPHeaderField: "Content-Type"\)\s*request\.httpBody = body/)
      const bar = await Bun.file(join(app, "yapd", "MenuBar.swift")).text()
      expect(bar).toMatch(/func menuWillOpen\(_ menu: NSMenu\) \{\s*if menu === self\.menu \{\s*open = true\s*fetch\(\)/)
      // An open panel asks again as it opens and every few seconds while it's open, as what its thread is doing changes with nothing of its row.
      expect(bar).toMatch(/while !Task\.isCancelled \{\s*self\?\.fetch\(key\)\s*try\? await Task\.sleep\(for: \.seconds\(5\)\)/)
      expect(bar).toMatch(/func menuDidClose\(_ menu: NSMenu\) \{\s*watching\.removeValue\(forKey: ObjectIdentifier\(menu\)\)\?\.cancel\(\)/)
      // Shown as they come, only the last asked for, and asked for again once anything of the row changes, as a new update coming.
      expect(bar).toMatch(/let told = await yapd\.details\(of: row\.recent\)\s*guard asked\[key\] == asking else \{ return \}\s*details\[key\] = told\s*change\(panel: key\)/)
      expect(bar).toMatch(/if before\[key\]\?\.recent != row\.recent \{ fetch\(key\) \}/)
      expect(bar.match(/Glance\([^)]*\)/g)).toEqual(["Glance(row.recent, details: details[key], now: yapd.now)"])
      // A pull request is opened only at an https address, as a card's links are.
      expect(bar.match(/NSWorkspace\.shared\.open\([^)]*\)/g)).toEqual(["NSWorkspace.shared.open(address)"])
      expect(bar).toMatch(/case \.open\(let address\): if opens\(address\) \{ NSWorkspace\.shared\.open\(address\) \}/)
      // The card only shows: nothing on it can be clicked, and none of its text is read as markdown or opened.
      const card = await Bun.file(join(app, "yapd", "GlanceCard.swift")).text()
      expect(card).not.toMatch(/Button|Link\(|openURL|onTapGesture|AttributedString/)
      // What he selects on a card copies with ⌘C, which the app's own menus, never shown, have.
      expect(yapd).toMatch(/NSApplication\.shared\.mainMenu = YapdApp\.editing/)
      expect(yapd).toMatch(/addItem\(withTitle: "Copy", action: #selector\(NSText\.copy\(_:\)\), keyEquivalent: "c"\)/)
    },
    120_000,
  )
})
