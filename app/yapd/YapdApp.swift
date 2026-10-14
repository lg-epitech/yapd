import AppKit
import ServiceManagement

// yapd in the menu bar: whether it's on, what it's doing, its mode, the
// threads waiting on him, what he hasn't heard, to be caught up on or cleared,
// his reminders, to cancel, the threads with the latest updates, each with a
// panel beside it to see more of it, hear it again, mute it and have its
// subagents read, and the card it's showing, in a panel under the icon.
// It only uses the API in docs/api.md, so another UI can do all of this too.

@MainActor @Observable
final class Yapd {
  /// None while yapd isn't running.
  private(set) var state: Status?
  /// The last card yapd showed, to show again.
  private(set) var last: String?
  /// The time the menu's times are told from, moved on every minute.
  private(set) var now = Date()
  /// The recent threads' project icons.
  let icons: Icons
  @ObservationIgnored private let panel: Panel
  /// The card the panel shows, as it follows the one yapd points at.
  @ObservationIgnored private let following: Following
  private let api: URL

  init() {
    // `defaults write dev.yapd.menu port 4848` for a yapd on another port.
    let port = UserDefaults.standard.integer(forKey: "port")
    let api = URL(string: "http://127.0.0.1:\(port == 0 ? 4747 : port)")!
    let panel = Panel()
    let following = Following(
      Following.Doing(
        fetch: { id in await Yapd.fetch(id, from: api) },
        show: { card, talking in panel.show(card, talking: talking) },
        hide: { panel.hide() },
        takeDown: { down in Yapd.send("DELETE", "cards/current", query: down.query, to: api) },
        putBack: { back in await Yapd.sent("PUT", "cards/current", body: try? JSONEncoder().encode(back), to: api) },
        wait: { delay in try? await Task.sleep(for: delay) }
      )
    )
    // Closed or faded, the card is no longer on screen, so yapd takes it down too, unless it's put up another since.
    panel.closed = { card in following.closed(card.id) }
    self.api = api
    self.panel = panel
    self.following = following
    icons = Icons(api: api)
    Task { await watch() }
    Task { await tick() }
  }

  /// Moves `now` on every minute, so "3 min ago" doesn't stay that.
  private func tick() async {
    while true {
      try? await Task.sleep(for: .seconds(60))
      now = Date()
    }
  }

  /// Puts the card under the menu bar icon's button, wherever that is.
  func place(under button: NSStatusBarButton) {
    panel.anchor = { [weak button] in
      guard let button, let window = button.window else { return nil }
      return window.convertToScreen(button.convert(button.bounds, to: nil))
    }
  }

  /// Follows the state as it changes, and tries again every couple of seconds while yapd isn't running.
  private func watch() async {
    // Asking for cards, so yapd says "it's on your screen" while the app is here to show them.
    var request = URLRequest(url: api.appending(path: "state/stream").appending(queryItems: [URLQueryItem(name: "cards", value: nil)]))
    // The stream stays quiet for as long as nothing changes.
    request.timeoutInterval = .greatestFiniteMagnitude
    while true {
      do {
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        for try await line in bytes.lines where line.hasPrefix("data: ") {
          let first = state == nil
          let status = try JSONDecoder().decode(Status.self, from: Data(line.dropFirst(6).utf8))
          state = status
          follow(status, connecting: first)
        }
      } catch {}
      // Gone mid-line, its card fades as if yapd had finished, unless it's back first and still talking about it.
      panel.away()
      following.away()
      state = nil
      try? await Task.sleep(for: .seconds(2))
    }
  }

  /// Follows a state as it comes in: the panel, the card yapd points at, and whether yapd is talking about it.
  private func follow(_ status: Status, connecting: Bool) {
    if let showing = status.showing { last = showing.id }
    if let recent = status.recent { icons.keep(only: recent) }
    now = Date()
    following.follow(status.showing, revision: status.revision, connecting: connecting)
    // Kept by the panel even before the card it points at is fetched and up, so one yapd is talking about by then stays up until it's done.
    panel.heard(speaking: status.activity == "speaking")
  }

  /// One of the cards yapd showed lately, unless yapd says it no longer has it or doesn't answer with it.
  private static func fetch(_ id: String, from api: URL) async -> Fetched {
    guard let (body, response) = try? await URLSession.shared.data(from: api.appending(path: "cards/\(id)")) else { return .failed }
    return Fetched(body, response)
  }

  func turn(on: Bool) {
    send("PUT", "state", body: try? JSONEncoder().encode(["on": on]))
  }

  /// Has yapd talk in `mode`, changing nothing else, unless it's too old to have modes or it's back to normal when it's normal
  /// already. Only how yapd talks changes: nothing is sent to any thread.
  func talk(in mode: Mode) {
    guard let change = state?.change(to: mode) else { return }
    send("PUT", "state", body: try? JSONEncoder().encode(change))
  }

  /// Asks yapd who's waiting on him, as if he'd said it, so the answer is said. It only reads his threads.
  func whoNeedsMe() {
    send("POST", "utterances", body: try? JSONEncoder().encode(Utterance.whoNeedsMe))
  }

  /// Asks yapd to catch him up, as if he'd said it, so its model decides what to tell and the answer is said. It only reads
  /// what yapd kept: nothing reaches an agent.
  func catchMeUp() {
    send("POST", "utterances", body: try? JSONEncoder().encode(Utterance.catchMeUp))
  }

  /// Sets aside everything a catch-up would tell him of now, without reading any of it, so it counts as heard, as "clear the
  /// catch-up" by voice does: no asking first, since "scratch that" by voice brings it back. The count drops as the state says
  /// so. It only marks things heard: nothing reaches an agent.
  func clearCatchUp() {
    send("POST", "catchup/clear")
  }

  func replay(_ update: Status.Update) {
    send("POST", "updates/\(update.id)/replay")
  }

  /// Says a thread's latest update again, by its key, even a muted one, unless yapd says it can't.
  func replay(_ row: Status.Recent) {
    guard row.replayable else { return }
    ask(Replaying(row))
  }

  /// Mutes a thread until he takes it off, or for an hour. Only what yapd says changes: nothing is sent to the thread.
  func mute(_ row: Status.Recent, forAnHour: Bool) {
    ask(forAnHour ? Muting.forAnHour(row, from: Date()) : Muting(row, on: true))
  }

  /// Takes a thread's mute off.
  func unmute(_ row: Status.Recent) {
    ask(Muting(row, on: false))
  }

  /// Has a thread's subagents read to him from now on, or kept to yapd again, a subagent's by the thread it's part of. Only what
  /// yapd says changes: nothing is sent to the thread.
  func subagents(_ row: Status.Recent, on: Bool) {
    ask(Subagents(row, on: on))
  }

  /// Cancels one of his reminders by its id, as "cancel the bank reminder" does, with nothing said: "scratch that" by voice keeps
  /// it again. One that went off or was cancelled since is refused, and the list drops it as the state says so.
  func cancel(_ reminder: Status.Reminder) {
    ask(Cancelling(reminder))
  }

  /// What yapd tells of a thread for its panel, by its key, unless it doesn't know it, is too old to tell, or doesn't answer.
  /// It only reads: nothing counts as heard.
  func details(of row: Status.Recent) async -> Details? {
    guard let request = request(Detailing(row)), let (body, response) = try? await URLSession.shared.data(for: request) else { return nil }
    return Details(body, response)
  }

  /// Asks yapd something about a thread, by its key, encoded as it is. What comes of it shows in the state.
  private func ask(_ asking: some Asking) {
    guard let request = request(asking) else { return }
    Task { _ = try? await URLSession.shared.data(for: request) }
  }

  /// The request that asks it of yapd, with its body as JSON when it has one.
  private func request(_ asking: some Asking) -> URLRequest? {
    guard let url = asking.url(at: api) else { return nil }
    var request = URLRequest(url: url)
    request.httpMethod = asking.method
    if let body = asking.body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    return request
  }

  /// Shows the last card again, for a while, with nothing said of it, and has yapd put it back up too, so "hide that" takes it
  /// down, unless yapd shows or hides a card, or one is put away, before it's fetched, or, for yapd, before its request gets there.
  func showLast() {
    guard let last else { return }
    following.showAgain(last) {
      // Gone, with a yapd that restarted since or after twenty more, so there's nothing to show again; one that only failed to
      // come back, as while yapd is slow or restarting, is kept, to ask for again.
      if self.last == last { self.last = nil }
    }
  }

  /// What comes of it shows in the state.
  private func send(_ method: String, _ path: String, body: Data? = nil) {
    Yapd.send(method, path, body: body, to: api)
  }

  /// As `send`, to the API at `api`, for what's wired up before there's a Yapd to send it, with a `query` when there's one.
  private static func send(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, to api: URL) {
    Task { await sent(method, path, query: query, body: body, to: api) }
  }

  /// As `send`, done once yapd answers, so that the task it's sent in, stopped first, stops it too, unless it's gone already.
  private static func sent(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, to api: URL) async {
    let url = api.appending(path: path)
    var request = URLRequest(url: query.isEmpty ? url : url.appending(queryItems: query))
    request.httpMethod = method
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    _ = try? await URLSession.shared.data(for: request)
  }
}

/// The app: yapd's icon in the menu bar, and nothing else on screen but its menu and the card it shows.
@main
@MainActor
final class YapdApp: NSObject, NSApplicationDelegate {
  private var bar: MenuBar?

  static func main() {
    let app = NSApplication.shared
    let delegate = YapdApp()
    app.delegate = delegate
    // The app holds on to its delegate only weakly.
    withExtendedLifetime(delegate) { app.run() }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Only the first time, so turning it off in System Settings, Login Items, sticks.
    if !UserDefaults.standard.bool(forKey: "registered") {
      do {
        try SMAppService.mainApp.register()
        UserDefaults.standard.set(true, forKey: "registered")
      } catch {
        NSLog("Could not open yapd at login: \(error)")
      }
    }
    NSApplication.shared.mainMenu = YapdApp.editing
    bar = MenuBar(Yapd())
  }

  /// The app's own menus, never shown, as it has no menu bar of its own, but where ⌘C and ⌘A are looked for, to copy what he
  /// selects on a card.
  private static var editing: NSMenu {
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    let main = NSMenu()
    for submenu in [NSMenu(title: "yapd"), edit] {
      let item = NSMenuItem(title: submenu.title, action: nil, keyEquivalent: "")
      item.submenu = submenu
      main.addItem(item)
    }
    return main
  }
}
