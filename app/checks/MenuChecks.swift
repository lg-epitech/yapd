import Foundation

/// The menu as he sees it, an item a line: "---" a separator, "## " a heading, a line in brackets that's never chosen, "[off]"
/// after an item he can't choose, "✓" after the mode yapd is in, "⌘Q" after Quit, a submenu's items after "▸", a recent row's
/// line under it after "—", "[dimmed]" when clicking it does nothing, and its panel after "▸". What's hidden isn't there.
@MainActor func drawn(_ items: [Menu.Item]) -> [String] {
  items.filter { !$0.hidden }.map { item in
    switch item.kind {
    case .separator: return "---"
    case .header: return "## \(item.title)"
    case .line: return "(\(item.title))"
    case .card: return "[card \(item.title)]"
    case .action:
      return item.title + (item.enabled ? "" : " [off]") + (item.checked ? " ✓" : "") + (item.key.map { " ⌘\($0.uppercased())" } ?? "")
    case .submenu(let items): return "\(item.title) ▸ \(drawn(items).joined(separator: " | "))" + (item.enabled ? "" : " [off]")
    case .row(let row): return "\(row.label) — \(row.detail)" + (row.hearable ? "" : " [dimmed]") + " ▸" + (item.enabled ? "" : " [off]")
    }
  }
}

/// What choosing each item does, by its title, for those that do something.
@MainActor func actions(_ menu: Menu) -> [String: Menu.Action] {
  Dictionary(menu.all.compactMap { item in
    if case .action(let action) = item.kind { (item.title, action) } else { nil }
  }, uniquingKeysWith: { first, _ in first })
}

/// The menu shows everything the menu bar has shown, in the same order, each item turned on and off by the same rules, with the
/// recent rows opening a panel each instead of the Mute menu, which offers hearing the thread again, muting it, for an hour
/// too, or taking the mute off, and its pull request when it has an https one; and it keeps each item by an id from one state
/// to the next, so the open menu changes in place.
@MainActor func checkMenu() {
  let decoded = { (json: String) in try? JSONDecoder().decode(Status.self, from: Data(json.utf8)) }
  let utc = TimeZone(identifier: "UTC")!
  let english = Locale(identifier: "en_US")
  let plain = { (lines: [String]) in lines.map { $0.replacingOccurrences(of: "\u{202F}", with: " ") } }
  let now = Date(timeIntervalSince1970: 1_790_949_700 + 180)
  let menu = { (state: Status?, last: Bool) in Menu(state, now: now, last: last, zone: utc, locale: english) }
  let row = { (key: String, title: String, fields: String) in
    #"{"key": "\#(key)", "machine": "Rosie", "thread": "850299f8", "title": "\#(title)", "project": {"name": "integration"}, "text": "integration. The migration is done.", "at": "2026-10-02T14:01:40.000Z"\#(fields)}"#
  }
  let rows = [
    row("t3:Rosie:1", "Migrate the Tezos integration", #", "muted": false, "waiting": true, "unheard": 2"#),
    row("t3:Rosie:2", "Distribox migration", #", "muted": true, "until": "2026-10-02T15:00:00.000Z", "replayable": false, "unheard": 4"#),
  ].joined(separator: ", ")

  // yapd isn't running: only that, and Quit.
  check(drawn(menu(nil, true).items) == ["(yapd isn't running)", "---", "Quit ⌘Q"], "says yapd isn't running, not \(drawn(menu(nil, true).items))")

  // Everything at once, in the menu bar's order.
  let full = decoded(#"{"on": true, "activity": "idle", "mode": "focus", "until": "2026-10-02T15:00:00.000Z", "waiting": 2, "unheard": 3, "recent": [\#(rows)]}"#)
  let shown = plain(drawn(menu(full, true).items))
  check(shown == [
    "Turn Off", "(Focus until 3:00 PM)", "Mode ▸ Normal | Focus for an Hour ✓ | Quiet until Morning", "2 Threads Waiting on You", "Catch Me Up (3)",
    "Show Last Card", "---", "## Recent", "integration · Migrate the Tezos integration — 3 min ago · waiting on you · 2 unheard ▸",
    "integration · Distribox migration — 3 min ago · muted [dimmed] ▸", "---", "Quit ⌘Q",
  ], "shows everything in order, not \(shown)")
  check(!shown.contains { $0.contains("Mute") }, "has no Mute menu, nor a row muting a thread, in the menu itself")
  let chosen = actions(menu(full, true))
  check(chosen["Turn Off"] == .turn(on: false), "turns yapd off")
  check(Mode.allCases.allSatisfy { chosen[$0.item] == .talk($0) }, "has yapd talk in the mode chosen")
  check(chosen["2 Threads Waiting on You"] == .whoNeedsMe && chosen["Catch Me Up (3)"] == .catchMeUp, "asks who's waiting, and to catch him up")
  check(chosen["Show Last Card"] == .showLast && chosen["Quit"] == .quit, "shows the last card again, and quits")
  let ids = menu(full, true).all.map(\.id)
  check(Set(ids).count == ids.count, "names each item once, not \(ids)")

  // Off: turning on, and who's waiting asked only of a yapd that answers while it's off, Catch Me Up always; no row heard again.
  let off = decoded(#"{"on": false, "activity": "idle", "mode": "normal", "waiting": 1, "unheard": 1, "recent": [\#(rows)]}"#)
  check(Array(plain(drawn(menu(off, false).items)).prefix(5)) == ["Turn On", "Mode ▸ Normal ✓ | Focus for an Hour | Quiet until Morning", "1 Thread Waiting on You", "Catch Me Up (1)", "Show Last Card [off]"], "turns yapd on while it's off, with no mode line in normal, not \(drawn(menu(off, false).items))")
  check(actions(menu(off, false))["Turn On"] == .turn(on: true), "turns yapd on")
  check(menu(off, false).rows.allSatisfy { !$0.hearable }, "lets him hear no row again while yapd is off")
  check(menu(off, false).items.allSatisfy { item in if case .row = item.kind { item.enabled } else { true } }, "still opens each row's panel while yapd is off, to mute it")
  let before = decoded(#"{"on": false, "activity": "idle", "mode": "quiet", "until": "2026-10-03T08:00:00Z", "waiting": 1, "recent": []}"#)
  check(plain(drawn(menu(before, true).items)) == ["Turn On", "(Quiet until 8:00 AM tomorrow)", "Mode ▸ Normal | Focus for an Hour | Quiet until Morning ✓", "1 Thread Waiting on You [off]", "Show Last Card", "---", "Quit ⌘Q"], "asks nothing of a yapd from before it answered while off, and shows no Recent with no rows, not \(drawn(menu(before, true).items))")

  // A yapd from before modes and recent threads: the updates it said, cut short, heard again only while it's on.
  let update = { (id: String, text: String) in #"{"id": "\#(id)", "project": "yapd", "text": "\#(text)", "at": "2026-10-02T14:03:11.000Z"}"# }
  let long = String(repeating: "The tests pass. ", count: 6)
  let old = { (on: Bool) in decoded(#"{"on": \#(on), "activity": "idle", "updates": [\#(update("4b9f", "yapd. The tests pass.")), \#(update("4ba0", long))]}"#) }
  check(drawn(menu(old(true), false).items) == ["Turn Off", "Show Last Card [off]", "---", "## Hear Again", "yapd. The tests pass.", "\(long.prefix(60))…", "---", "Quit ⌘Q"], "lists the updates an older yapd said, not \(drawn(menu(old(true), false).items))")
  check(Array(drawn(menu(old(false), false).items)[4...5]) == ["yapd. The tests pass. [off]", "\(long.prefix(60))… [off]"], "hears none of them again while it's off")
  check(actions(menu(old(true), false))["yapd. The tests pass."] == old(true).map { Menu.Action.replay($0.updates[0]) }, "hears an update again by its id")
  check(drawn(menu(decoded(#"{"on": true, "activity": "idle", "updates": []}"#), false).items) == ["Turn Off", "Show Last Card [off]", "---", "Quit ⌘Q"], "lists nothing to hear again when there's nothing")

  // Each item keeps its id from one state to the next, so the open menu changes it in place; a row by its thread's key.
  let id = { (state: Status?, title: String) in menu(state, true).all.first { $0.title == title }?.id }
  check(id(full, "Turn Off") != nil && id(full, "Turn Off") == id(off, "Turn On"), "keeps turning yapd on and off as one item")
  check(id(full, "Catch Me Up (3)") == id(off, "Catch Me Up (1)") && id(full, "2 Threads Waiting on You") == id(off, "1 Thread Waiting on You"), "keeps the counted lines as one item each")
  check(menu(full, true).items.compactMap { item in if case .row = item.kind { item.id } else { nil } } == menu(off, true).items.compactMap { item in if case .row = item.kind { item.id } else { nil } }, "keeps each row as one item, by its key")
  check(menu(full, true).all.filter { $0.title == "Normal" }.map(\.id) == menu(off, true).all.filter { $0.title == "Normal" }.map(\.id), "keeps each mode as one item")

  // A row: what VoiceOver says of it, all it shows.
  guard let first = menu(full, true).rows.first, let second = menu(full, true).rows.last else { return check(false, "lists the recent rows") }
  check(first.told == "integration · Migrate the Tezos integration, 3 min ago · waiting on you · 2 unheard", "tells VoiceOver all a row shows, not \(first.told)")
  check(first.hearable && !second.hearable, "lets him hear again only a row yapd can say again")

  // The panel beside a row: its card, then hearing it again, as clicking the row does, and muting it, or taking the mute off.
  let pr = { (url: String?) in Details(key: "t3:Rosie:1", machine: "Rosie", pr: Details.PullRequest(number: 412, url: url, state: "open")) }
  check(drawn(Menu.panel(for: first, details: nil)) == ["[card Migrate the Tezos integration]", "---", "Hear Again", "Mute", "Mute for an Hour"], "offers to hear a thread again and mute it, not \(drawn(Menu.panel(for: first, details: nil)))")
  check(drawn(Menu.panel(for: second, details: nil)) == ["[card Distribox migration]", "---", "Hear Again [off]", "Unmute"], "offers to take a mute off, and to hear again only what can be, not \(drawn(Menu.panel(for: second, details: nil)))")
  let offered = Dictionary(Menu.panel(for: first, details: pr("https://github.com/lg-epitech/integration/pull/412")).compactMap { item in
    if case .action(let action) = item.kind { (item.title, action) } else { nil }
  }, uniquingKeysWith: { first, _ in first })
  check(offered["Hear Again"] == .hear(first.recent), "hears the thread again by its row")
  check(offered["Mute"] == .mute(first.recent, forAnHour: false) && offered["Mute for an Hour"] == .mute(first.recent, forAnHour: true), "mutes it until he takes it off, or for an hour")
  check(Dictionary(Menu.panel(for: second, details: nil).map { ($0.title, $0.kind) }, uniquingKeysWith: { first, _ in first })["Unmute"] == .action(.unmute(second.recent)), "takes its mute off")
  check(offered["Open Pull Request #412"] == .open(URL(string: "https://github.com/lg-epitech/integration/pull/412")!), "opens its pull request")
  for url in [nil, "http://github.com/lg-epitech/integration/pull/412", "file:///etc/passwd", "javascript:alert(1)"] {
    check(!drawn(Menu.panel(for: first, details: pr(url))).contains { $0.hasPrefix("Open Pull Request") }, "never offers to open a pull request at \(url ?? "no address")")
  }
  let panelIds = Menu.panel(for: first, details: pr("https://github.com/lg-epitech/integration/pull/412")).map(\.id) + Menu.panel(for: second, details: nil).map(\.id)
  check(Set(panelIds).count == panelIds.count && Set(panelIds).isDisjoint(with: ids), "names each panel's items apart from the menu's and each other's")

  // Its items keep their ids, muted or not, with a pull request or not, so the open panel follows a mute that ends or one set by
  // voice, and a pull request yapd tells of, in place: Mute turns into Unmute, and what isn't offered is hidden.
  let recent = first.recent
  let quieted = Menu.Row(
    Status.Recent(key: recent.key, machine: recent.machine, thread: recent.thread, title: recent.title, project: recent.project, text: recent.text, at: recent.at, muted: true),
    on: true, now: now
  )
  let loud = Menu.panel(for: first, details: nil)
  let quiet = Menu.panel(for: quieted, details: pr("https://github.com/lg-epitech/integration/pull/412"))
  check(loud.map(\.id) == quiet.map(\.id), "keeps a panel's items by the same ids, muted or not, with a pull request or not, not \(loud.map(\.id)) and \(quiet.map(\.id))")
  check(drawn(quiet) == ["[card Migrate the Tezos integration]", "---", "Hear Again", "Unmute", "Open Pull Request #412"], "offers to take the mute off in Mute's place, not \(drawn(quiet))")
  check(loud.filter(\.hidden).map(\.title) == ["Open Pull Request"] && quiet.filter(\.hidden).map(\.title) == ["Mute for an Hour"], "hides only what isn't offered")
  check(quiet.first { $0.title == "Unmute" }?.kind == .action(.unmute(quieted.recent)), "takes the mute off by the same item that muted it")

  // What the icon tells VoiceOver.
  let told: [(Status?, String)] = [
    (nil, "yapd isn't running"), (off, "yapd is off"), (decoded(#"{"on": true, "activity": "speaking"}"#), "yapd is speaking"),
    (decoded(#"{"on": true, "activity": "listening"}"#), "yapd is listening"), (decoded(#"{"on": true, "activity": "idle", "mode": "normal"}"#), "yapd is on"),
    (decoded(#"{"on": true, "activity": "idle", "mode": "focus", "waiting": 1}"#), "yapd is on, Focus, 1 Thread Waiting on You"),
  ]
  for (state, said) in told {
    check(Status.told(state, now: now) == said, "tells VoiceOver \(said), not \(Status.told(state, now: now))")
  }
}
