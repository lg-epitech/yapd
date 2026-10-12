import Foundation

// What the menu shows, in what order, what of it can be chosen and what
// choosing it does, and what the panel beside each recent thread offers,
// apart from AppKit and SwiftUI, so that app/checks can build it with swiftc
// on its own and check it. The menu bar only draws it, and does what's chosen.

/// The menu, as it's built from yapd's state each time it opens.
struct Menu: Equatable {
  /// What choosing an item does.
  enum Action: Equatable {
    case turn(on: Bool)
    case talk(Mode)
    case whoNeedsMe
    case catchMeUp
    case showLast
    /// Says again one of the updates a yapd from before recent threads lists.
    case replay(Status.Update)
    /// Says a recent thread's latest update again.
    case hear(Status.Recent)
    /// Mutes a recent thread until he takes it off, or for an hour.
    case mute(Status.Recent, forAnHour: Bool)
    case unmute(Status.Recent)
    /// Opens a thread's pull request in the browser, only ever an https page.
    case open(URL)
    case quit
  }

  /// One of its items, or of the menus beside it.
  struct Item: Equatable, Identifiable {
    enum Kind: Equatable {
      /// Chosen, it does its action.
      case action(Action)
      /// Only says something, as the mode line does, and is never chosen.
      case line
      /// A section's heading.
      case header
      case separator
      /// Opens the items of a menu of its own beside it, as Mode does.
      case submenu([Item])
      /// A recent thread, which opens its panel beside it, and says its latest update again when it's clicked, if it can.
      case row(Row)
      /// The card at the top of a recent thread's panel, which only shows.
      case card(Row)
    }

    /// What it's known by from one state to the next, so the menu, open, changes it in place.
    let id: String
    let kind: Kind
    let title: String
    let enabled: Bool
    /// Checked, as the mode yapd is in is.
    var checked = false
    /// The key that chooses it with ⌘.
    var key: String?

    fileprivate static func line(_ id: String, _ title: String) -> Item {
      Item(id: id, kind: .line, title: title, enabled: false)
    }

    fileprivate static func header(_ id: String, _ title: String) -> Item {
      Item(id: "\(id) header", kind: .header, title: title, enabled: false)
    }

    fileprivate static func separator(_ id: String) -> Item {
      Item(id: "\(id) separator", kind: .separator, title: "", enabled: false)
    }
  }

  /// A recent thread as its row shows it.
  struct Row: Equatable {
    let recent: Status.Recent
    let label: String
    /// How long ago it ended, whether it waits on him, how many of its updates he hasn't heard, and whether it's muted.
    let detail: String
    /// Whether clicking it says its latest update again. Otherwise its text is dimmed and clicking it does nothing, but it
    /// still opens its panel, since muting it works either way.
    let hearable: Bool

    /// The row while yapd is `on`, with how long ago it ended told from `now`.
    init(_ recent: Status.Recent, on: Bool, now: Date) {
      self.recent = recent
      label = recent.label
      detail = recent.detail(now: now)
      hearable = recent.hearable(on: on)
    }

    /// What VoiceOver says of it: all it shows.
    var told: String {
      detail.isEmpty ? label : "\(label), \(detail)"
    }
  }

  let items: [Item]

  /// The menu for `state`, none while yapd isn't running, with times told from `now`, in his time, offering to show the last
  /// card again once there's a `last` one to show.
  init(_ state: Status?, now: Date, last: Bool, zone: TimeZone = .current, locale: Locale = .current) {
    guard let state else {
      items = [.line("down", "yapd isn't running"), .separator("quit"), Menu.quit]
      return
    }
    var items = [Item(id: "power", kind: .action(.turn(on: !state.on)), title: state.on ? "Turn Off" : "Turn On", enabled: true)]
    if let mode = state.mode {
      if let line = state.modeLine(now: now, zone: zone, locale: locale) { items.append(.line("mode line", line)) }
      // While yapd is off, its mode still changes, for when it's back on; focus or quiet chosen again starts its time again.
      let modes = Mode.allCases.map { each in
        Item(id: "mode \(each.rawValue)", kind: .action(.talk(each)), title: each.item, enabled: true, checked: mode == each)
      }
      items.append(Item(id: "mode", kind: .submenu(modes), title: "Mode", enabled: true))
    }
    if let waiting = state.waitingLine {
      // yapd answers it aloud, which a yapd from before it answered while off can't do while it's off.
      items.append(Item(id: "waiting", kind: .action(.whoNeedsMe), title: waiting, enabled: state.answers))
    }
    if let unheard = state.unheardLine {
      // Answered aloud even while yapd is off, as the shortcut is, and then it's quiet again.
      items.append(Item(id: "unheard", kind: .action(.catchMeUp), title: unheard, enabled: true))
    }
    items.append(Item(id: "show last", kind: .action(.showLast), title: "Show Last Card", enabled: last))
    if let recent = state.recent {
      if !recent.isEmpty {
        items += [.separator("recent"), .header("recent", "Recent")]
        // Each enabled, so it opens its panel even when clicking it can't do anything.
        items += recent.map { row in Item(id: "row \(row.key)", kind: .row(Row(row, on: state.on, now: now)), title: row.label, enabled: true) }
      }
    } else if !state.updates.isEmpty {
      // A yapd from before it listed threads: the updates it said, to hear again, only while it's on.
      items += [.separator("hear again"), .header("hear again", "Hear Again")]
      items += state.updates.map { update in
        let title = update.text.count > 60 ? "\(update.text.prefix(60))…" : update.text
        return Item(id: "update \(update.id)", kind: .action(.replay(update)), title: title, enabled: state.on)
      }
    }
    items += [.separator("quit"), Menu.quit]
    self.items = items
  }

  private static var quit: Item { Item(id: "quit", kind: .action(.quit), title: "Quit", enabled: true, key: "q") }

  /// Every item, and those of the menus beside them, in order.
  var all: [Item] {
    items.flatMap { item in
      if case .submenu(let items) = item.kind { [item] + items } else { [item] }
    }
  }

  /// The rows of the recent threads, in order.
  var rows: [Row] {
    items.compactMap { item in
      if case .row(let row) = item.kind { row } else { nil }
    }
  }

  /// What the panel beside a recent row offers: its card, then hearing it again, the same as clicking the row, muting it until
  /// he takes it off or for an hour, or taking the mute off, and opening its pull request, when yapd's `details` of it have one
  /// with an https address. Muting it works while yapd is off, and for a row it can't say again.
  static func panel(for row: Row, details: Details?) -> [Item] {
    let key = row.recent.key
    var items = [
      Item(id: "\(key) card", kind: .card(row), title: row.recent.title, enabled: false),
      .separator(key),
      Item(id: "\(key) hear", kind: .action(.hear(row.recent)), title: "Hear Again", enabled: row.hearable),
    ]
    if row.recent.muted {
      items.append(Item(id: "\(key) unmute", kind: .action(.unmute(row.recent)), title: "Unmute", enabled: true))
    } else {
      items.append(Item(id: "\(key) mute", kind: .action(.mute(row.recent, forAnHour: false)), title: "Mute", enabled: true))
      items.append(Item(id: "\(key) mute for an hour", kind: .action(.mute(row.recent, forAnHour: true)), title: "Mute for an Hour", enabled: true))
    }
    if let pr = details?.pr, let address = pr.address {
      items.append(Item(id: "\(key) pull request", kind: .action(.open(address)), title: "Open Pull Request #\(pr.number)", enabled: true))
    }
    return items
  }
}
