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

/// The menu shows everything the menu bar has shown, in the same order, each item turned on and off by the same rules, with
/// Clear Catch-Up under Catch Me Up, and the recent rows opening a panel each instead of the Mute menu, which offers hearing the
/// thread again, muting it, for an hour too, or taking the mute off, a subagent's its own, or saying it's muted with the thread
/// it's part of, having its subagents read, checked while they are, on a T3 Code thread's, a subagent's by the thread it's part
/// of, and its pull request when it has an https one; and it keeps each item by an id from one state to the next, so the open
/// menu changes in place.
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
    "Clear Catch-Up", "Show Last Card", "---", "## Recent", "integration · Migrate the Tezos integration — 3 min ago · waiting on you · 2 unheard ▸",
    "integration · Distribox migration — 3 min ago · muted [dimmed] ▸", "---", "Quit ⌘Q",
  ], "shows everything in order, not \(shown)")
  check(!shown.contains { $0.contains("Mute") }, "has no Mute menu, nor a row muting a thread, in the menu itself")
  let chosen = actions(menu(full, true))
  check(chosen["Turn Off"] == .turn(on: false), "turns yapd off")
  check(Mode.allCases.allSatisfy { chosen[$0.item] == .talk($0) }, "has yapd talk in the mode chosen")
  check(chosen["2 Threads Waiting on You"] == .whoNeedsMe && chosen["Catch Me Up (3)"] == .catchMeUp, "asks who's waiting, and to catch him up")
  check(chosen["Clear Catch-Up"] == .clearCatchUp, "clears the catch-up")
  check(chosen["Show Last Card"] == .showLast && chosen["Quit"] == .quit, "shows the last card again, and quits")
  let ids = menu(full, true).all.map(\.id)
  check(Set(ids).count == ids.count, "names each item once, not \(ids)")

  // Off: turning on, and who's waiting asked only of a yapd that answers while it's off, Catch Me Up and Clear Catch-Up always;
  // no row heard again.
  let off = decoded(#"{"on": false, "activity": "idle", "mode": "normal", "waiting": 1, "unheard": 1, "recent": [\#(rows)]}"#)
  check(Array(plain(drawn(menu(off, false).items)).prefix(6)) == ["Turn On", "Mode ▸ Normal ✓ | Focus for an Hour | Quiet until Morning", "1 Thread Waiting on You", "Catch Me Up (1)", "Clear Catch-Up", "Show Last Card [off]"], "turns yapd on while it's off, with no mode line in normal, not \(drawn(menu(off, false).items))")
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
  // With nothing to say, the mode line, who's waiting, Catch Me Up and Clear Catch-Up are still there, hidden, so the open menu
  // hides them, or shows them again, in place, as when the catch-up is cleared.
  let still = decoded(#"{"on": true, "activity": "idle", "mode": "normal", "waiting": 0, "unheard": 0, "recent": [\#(rows)]}"#)
  check(menu(still, true).items.map(\.id) == menu(full, true).items.map(\.id), "keeps the same items with nothing waiting, unheard or timed, not \(menu(still, true).items.map(\.id))")
  check(menu(still, true).items.filter(\.hidden).map(\.id) == ["mode line", "waiting", "unheard", "clear catch-up"], "hides what has nothing to say, not \(menu(still, true).items.filter(\.hidden).map(\.id))")
  check(menu(still, true).items.filter(\.hidden).allSatisfy { !$0.enabled }, "can't choose what's hidden")
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
  check(loud.filter(\.hidden).map(\.title) == ["Read Subagents", "Open Pull Request"] && quiet.filter(\.hidden).map(\.title) == ["Mute for an Hour", "Read Subagents"], "hides only what isn't offered, not \(loud.filter(\.hidden).map(\.title)) and \(quiet.filter(\.hidden).map(\.title))")
  check(quiet.first { $0.title == "Unmute" }?.kind == .action(.unmute(quieted.recent)), "takes the mute off by the same item that muted it")

  // A T3 Code thread's panel offers to have its subagents read, whether it has any yet or not, checked while they are, and to keep
  // them to yapd again; a subagent's row, listed while they're read, is muted on its own, and never offers to stop reading them,
  // which would stop every subagent of its thread.
  let thread = { (reading: String) in
    row("t3:Rosie:1", "Migrate the Tezos integration", #", "muted": false, "unheard": 1, "subagents": \#(reading)"#)
  }
  let subagent = row("t3:Rosie:7", "Sol review: release blockers", #", "muted": false, "replayable": false, "subagents": true, "head": {"key": "t3:Rosie:1", "title": "Migrate the Tezos integration"}"#)
  let reading = decoded(#"{"on": true, "activity": "idle", "unheard": 1, "recent": [\#(subagent), \#(thread("true"))]}"#)
  let kept = decoded(#"{"on": true, "activity": "idle", "unheard": 1, "recent": [\#(thread("false"))]}"#)
  guard let part = menu(reading, true).rows.first, let head = menu(reading, true).rows.last, let alone = menu(kept, true).rows.first else {
    return check(false, "lists a thread and one of its subagents")
  }
  check(drawn(Menu.panel(for: alone, details: nil)) == ["[card Migrate the Tezos integration]", "---", "Hear Again", "Mute", "Mute for an Hour", "Read Subagents"], "offers to read a thread's subagents, not \(drawn(Menu.panel(for: alone, details: nil)))")
  check(drawn(Menu.panel(for: head, details: nil)) == ["[card Migrate the Tezos integration]", "---", "Hear Again", "Mute", "Mute for an Hour", "Read Subagents ✓"], "checks Read Subagents while they're read, not \(drawn(Menu.panel(for: head, details: nil)))")
  check(drawn(Menu.panel(for: part, details: nil)) == ["[card Sol review: release blockers]", "---", "Hear Again [off]", "Mute", "Mute for an Hour"], "offers to mute a subagent, never to stop reading its thread's subagents, not \(drawn(Menu.panel(for: part, details: nil)))")
  let does = { (row: Menu.Row) in
    Dictionary(Menu.panel(for: row, details: nil).compactMap { item in if case .action(let action) = item.kind { (item.title, action) } else { nil } }, uniquingKeysWith: { first, _ in first })
  }
  check(does(alone)["Read Subagents"] == .subagents(alone.recent, on: true) && does(head)["Read Subagents"] == .subagents(head.recent, on: false), "reads a thread's subagents, or stops, as the item is checked")
  check(Menu.panel(for: part, details: nil).first { $0.id == "t3:Rosie:7 subagents" }.map { $0.title == "Read Subagents" && !$0.enabled && $0.hidden } == true, "never lets him choose Read Subagents on a subagent's panel, keeping it hidden by its id")
  check(does(part)["Mute"] == .mute(part.recent, forAnHour: false) && does(part)["Mute for an Hour"] == .mute(part.recent, forAnHour: true), "mutes a subagent by its own row, until he takes it off or for an hour")
  check(Menu.panel(for: alone, details: nil).map(\.id) == loud.map(\.id) && Menu.panel(for: head, details: nil).map(\.id) == loud.map(\.id), "keeps a panel's items by the same ids, its subagents read or not, or not to be")
  check(Menu.panel(for: head, details: nil).first { $0.title == "Read Subagents" }.map { $0.enabled && !$0.hidden } == true, "lets him choose Read Subagents on a thread's panel")
  check(Menu.panel(for: second, details: nil).first { $0.title == "Read Subagents" }?.hidden == true, "never offers to read a session's subagents, nor a yapd's from before it")

  // A subagent muted with the thread it's part of only says so where Unmute was, by the same id, since taking its own mute off
  // would leave it muted, and Mute for an Hour stays hidden; muted on its own, it offers Unmute, which takes that off; and from a
  // yapd that doesn't say whether the thread is muted, it's as before.
  let mutedPart = { (head: String) in
    let subagent = row("t3:Rosie:7", "Sol review: release blockers", #", "muted": true, "replayable": false, "subagents": true, "head": \#(head)"#)
    return decoded(#"{"on": true, "activity": "idle", "recent": [\#(subagent)]}"#).flatMap { menu($0, true).rows.first }
  }
  let ofTezos = { (muted: String) in #"{"key": "t3:Rosie:1", "title": "Migrate the Tezos integration"\#(muted)}"# }
  guard let withHead = mutedPart(ofTezos(#", "muted": true"#)), let onItsOwn = mutedPart(ofTezos(#", "muted": false"#)), let unsaid = mutedPart(ofTezos("")),
    let longHead = mutedPart(#"{"key": "t3:Rosie:1", "title": "Reimagine Yapd as a Jarvis Companion, with subagents read aloud", "muted": true}"#)
  else {
    return check(false, "lists a muted subagent")
  }
  let withHeadPanel = Menu.panel(for: withHead, details: nil)
  check(drawn(withHeadPanel) == ["[card Sol review: release blockers]", "---", "Hear Again [off]", "(Muted with Migrate the Tezos integration)"], "says a subagent is muted with its thread rather than offer Unmute, not \(drawn(withHeadPanel))")
  check(withHeadPanel.first { $0.id == "t3:Rosie:7 mute" }.map { $0.kind == .line && !$0.enabled } == true, "can't choose it")
  check(withHeadPanel.map(\.id) == Menu.panel(for: part, details: nil).map(\.id) && withHeadPanel.map(\.id) == Menu.panel(for: onItsOwn, details: nil).map(\.id), "keeps the same ids, so the open panel follows its thread's mute in place")
  check(withHeadPanel.first { $0.title == "Mute for an Hour" }?.hidden == true, "offers no Mute for an Hour while it's muted with its thread")
  check(drawn(Menu.panel(for: onItsOwn, details: nil)) == ["[card Sol review: release blockers]", "---", "Hear Again [off]", "Unmute"] && does(onItsOwn)["Unmute"] == .unmute(onItsOwn.recent), "takes off a subagent's own mute, not \(drawn(Menu.panel(for: onItsOwn, details: nil)))")
  check(does(unsaid)["Unmute"] == .unmute(unsaid.recent), "offers Unmute as before from a yapd that doesn't say whether its thread is muted")
  let cut = Menu.panel(for: longHead, details: nil).first { $0.id == "t3:Rosie:7 mute" }?.title ?? ""
  check(cut == "Muted with Reimagine Yapd as a Jarvis Companion, with subag…" && cut.count == 60, "cuts a long thread's title short, as a row's label, not \(cut)")

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
