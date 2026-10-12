import AppKit

// yapd's icon in the menu bar, and its menu. The icon shows what yapd is
// doing as it changes. The menu is built from yapd's state each time it
// opens, as Menu has it: whether it's on, its mode, the threads waiting on
// him, what he hasn't heard, the last card, and the threads with the latest
// updates, each opening a panel beside it on hover, as CodexBar's do, with
// what the thread is doing and the latest told of it, to hear it again, mute
// it or open its pull request. While the menu is open, what changes is
// changed in place, and what comes or goes waits for the next time it opens,
// so nothing moves under his pointer.

@MainActor
final class MenuBar: NSObject, NSMenuDelegate {
  private let yapd: Yapd
  private let item: NSStatusItem
  private let menu = NSMenu()
  /// Whether the menu is open.
  private var open = false
  /// Each item made of the menu and of the panels beside it, by its id, to change in place.
  private var made: [String: NSMenuItem] = [:]
  /// Each recent row as it's shown now, by its key.
  private var rows: [String: Menu.Row] = [:]
  /// The key of the row each panel is beside.
  private var panels: [ObjectIdentifier: String] = [:]
  /// What yapd told of each row's thread, by its key, as it said last since the menu opened.
  private var details: [String: Details] = [:]
  /// The row drawn highlighted.
  private weak var highlighted: RecentRow?

  init(_ yapd: Yapd) {
    self.yapd = yapd
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    super.init()
    menu.autoenablesItems = false
    menu.delegate = self
    item.menu = menu
    if let button = item.button {
      button.imagePosition = .imageOnly
      yapd.place(under: button)
    }
    watch()
  }

  /// Shows yapd's state as it changes: on the icon, and in the menu while it's open.
  private func watch() {
    withObservationTracking {
      show()
    } onChange: { [weak self] in
      Task { @MainActor in self?.watch() }
    }
  }

  /// The icon as the state has it now, and the menu, changed in place, while it's open.
  private func show() {
    let state = yapd.state
    icon(state)
    let menu = Menu(state, now: yapd.now, last: yapd.last != nil)
    // Each row's icon is looked at even while the menu is closed, so one fetched while it's open is drawn once it's in.
    for row in menu.rows { _ = yapd.icons.icon(for: row.recent) }
    if open { change(menu) }
  }

  /// yapd's own mark while it's on and quiet, with a moon in focus or quiet and a dot while a thread waits on him, off or not
  /// running, and what it's doing otherwise, told to VoiceOver too.
  private func icon(_ state: Status?) {
    guard let button = item.button else { return }
    switch Status.look(state) {
    case .down: button.image = Mark.down
    case .off: button.image = Mark.off
    case .speaking: button.image = NSImage(systemSymbolName: "speaker.wave.2.fill", accessibilityDescription: nil)
    case .listening: button.image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: nil)
    case .on(let moon, let dot): button.image = Mark.on(moon: moon, dot: dot)
    }
    button.setAccessibilityLabel(Status.told(state, now: yapd.now))
  }

  /// The menu, and a row's panel, are built afresh each time they open.
  func menuNeedsUpdate(_ menu: NSMenu) {
    if menu === self.menu {
      build()
    } else if let key = panels[ObjectIdentifier(menu)] {
      build(menu, beside: key)
    }
  }

  /// Open, the menu changes in place as the state does, and asks yapd what it tells of each row's thread.
  func menuWillOpen(_ menu: NSMenu) {
    guard menu === self.menu else { return }
    open = true
    fetch()
  }

  func menuDidClose(_ menu: NSMenu) {
    guard menu === self.menu else { return }
    open = false
    highlighted?.highlight(false)
    highlighted = nil
  }

  /// A row draws its own highlight, as the pointer or the keyboard moves onto it or off it; it stays highlighted while its
  /// panel is open.
  func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
    guard menu === self.menu else { return }
    let row = item?.view as? RecentRow
    if highlighted !== row { highlighted?.highlight(false) }
    row?.highlight(true)
    highlighted = row
  }

  /// The menu afresh, from yapd's state as it opens.
  private func build() {
    let model = Menu(yapd.state, now: yapd.now, last: yapd.last != nil)
    menu.removeAllItems()
    made = [:]
    rows = [:]
    panels = [:]
    highlighted = nil
    for item in model.items { menu.addItem(make(item)) }
    // What yapd told of a thread no longer listed isn't shown again.
    details = details.filter { rows[$0.key] != nil }
  }

  /// A row's panel afresh, as it opens: its card, from what the row has and what yapd told of it, and what can be done with it.
  private func build(_ panel: NSMenu, beside key: String) {
    guard let row = rows[key] else { return }
    panel.removeAllItems()
    for item in Menu.panel(for: row, details: details[key]) { panel.addItem(make(item)) }
  }

  /// An item as `item` has it, kept by its id to change in place.
  private func make(_ item: Menu.Item) -> NSMenuItem {
    let made: NSMenuItem
    switch item.kind {
    case .separator:
      made = .separator()
    case .header:
      made = .sectionHeader(title: item.title)
    case .action, .line, .card:
      made = NSMenuItem(title: item.title, action: nil, keyEquivalent: item.key ?? "")
    case .submenu(let items):
      made = NSMenuItem(title: item.title, action: nil, keyEquivalent: "")
      let submenu = NSMenu(title: item.title)
      submenu.autoenablesItems = false
      for each in items { submenu.addItem(make(each)) }
      made.submenu = submenu
    case .row(let row):
      made = NSMenuItem(title: item.title, action: nil, keyEquivalent: "")
      let view = RecentRow()
      let key = row.recent.key
      view.clicked = { [weak self] in self?.click(key) }
      made.view = view
      // Built as it opens, so it has what yapd told of the thread by then.
      let panel = NSMenu(title: item.title)
      panel.autoenablesItems = false
      panel.delegate = self
      panels[ObjectIdentifier(panel)] = key
      made.submenu = panel
    }
    self.made[item.id] = made
    apply(item, to: made)
    return made
  }

  /// Changes an item made before to what `item` has now, in place.
  private func apply(_ item: Menu.Item, to made: NSMenuItem) {
    if case .separator = item.kind { return }
    made.title = item.title
    made.isEnabled = item.enabled
    made.state = item.checked ? .on : .off
    switch item.kind {
    case .action(let action):
      made.target = self
      made.action = #selector(choose(_:))
      made.representedObject = action
    case .row(let row):
      rows[row.recent.key] = row
      (made.view as? RecentRow)?.show(row, image: yapd.icons.icon(for: row.recent))
    case .card(let row):
      let key = row.recent.key
      let card = GlanceCard(glance: Glance(row.recent, details: details[key], now: yapd.now), icon: yapd.icons.icon(for: row.recent))
      if let shown = made.view as? GlanceItem {
        // Resized as it's swapped, so the panel, open, fits it.
        if shown.show(card) { made.menu?.itemChanged(made) }
      } else {
        made.view = GlanceItem(card)
      }
    case .line, .header, .separator, .submenu:
      break
    }
  }

  /// Changes what's shown in place, as yapd's state has it now: every item still there, and every row's panel. What came or
  /// went since the menu opened waits for the next time it opens.
  private func change(_ model: Menu) {
    for item in model.all {
      if let made = made[item.id] { apply(item, to: made) }
    }
    for key in rows.keys { change(panel: key) }
  }

  /// Changes what's shown in a row's panel in place: its card, resized to fit, and what can be done with it. An item that
  /// comes or goes, as its pull request once yapd tells of it, waits for the next time the panel opens.
  private func change(panel key: String) {
    guard let row = rows[key] else { return }
    for item in Menu.panel(for: row, details: details[key]) {
      if let made = made[item.id] { apply(item, to: made) }
    }
  }

  /// Asks yapd what it tells of each row's thread as the menu opens, each shown in its panel as it comes, even while that's
  /// open. A thread yapd doesn't know, or a yapd too old to tell, or one that doesn't answer, leaves the card with what the
  /// row has.
  private func fetch() {
    for (key, row) in rows {
      Task {
        details[key] = await yapd.details(of: row.recent)
        change(panel: key)
      }
    }
  }

  /// A row clicked says its latest update again, as Hear Again in its panel does, and closes the menu, when he can hear it
  /// again. Otherwise nothing happens, and the menu stays open.
  private func click(_ key: String) {
    guard let row = rows[key], row.hearable else { return }
    menu.cancelTracking()
    perform(.hear(row.recent))
  }

  /// An item chosen does what the menu says it does.
  @objc private func choose(_ item: NSMenuItem) {
    guard let action = item.representedObject as? Menu.Action else { return }
    perform(action)
  }

  /// Does what's chosen, through what Yapd asks of yapd, apart from opening a pull request and quitting.
  private func perform(_ action: Menu.Action) {
    switch action {
    case .turn(let on): yapd.turn(on: on)
    case .talk(let mode): yapd.talk(in: mode)
    case .whoNeedsMe: yapd.whoNeedsMe()
    case .catchMeUp: yapd.catchMeUp()
    case .showLast: yapd.showLast()
    case .replay(let update): yapd.replay(update)
    case .hear(let row): yapd.replay(row)
    case .mute(let row, let forAnHour): yapd.mute(row, forAnHour: forAnHour)
    case .unmute(let row): yapd.unmute(row)
    // Only ever an https page, as a card's links are.
    case .open(let address): if opens(address) { NSWorkspace.shared.open(address) }
    case .quit: NSApplication.shared.terminate(nil)
    }
  }
}
