import ServiceManagement
import SwiftUI

// yapd in the menu bar: whether it's on, what it's doing, the threads with the
// latest updates, to hear again and mute, and the card it's showing, in a
// panel under the icon. It only uses the API in docs/api.md, so another UI can
// do all of this too.

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

  /// yapd's own mark while it's on and quiet, off or not running, and what it's doing otherwise.
  var icon: some View {
    guard let state else { return Image(nsImage: Mark.down).accessibilityLabel("yapd isn't running") }
    guard state.on else { return Image(nsImage: Mark.off).accessibilityLabel("yapd is off") }
    switch state.activity {
    case "speaking": return Image(systemName: "speaker.wave.2.fill").accessibilityLabel("yapd is speaking")
    case "listening": return Image(systemName: "mic.fill").accessibilityLabel("yapd is listening")
    default: return Image(nsImage: Mark.on).accessibilityLabel("yapd is on")
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

  func replay(_ update: Status.Update) {
    send("POST", "updates/\(update.id)/replay")
  }

  /// Says a thread's latest update again, by its key, even a muted one, unless yapd says it can't.
  func replay(_ row: Status.Recent) {
    guard row.replayable else { return }
    ask(Replaying(row))
  }

  /// Mutes a thread, until he takes it off, or takes it off. Only what yapd says changes: nothing is sent to the thread.
  func mute(_ row: Status.Recent, _ on: Bool) {
    ask(Muting(row, on: on))
  }

  /// Asks yapd something about a thread, by its key, encoded as it is. What comes of it shows in the state.
  private func ask(_ asking: some Asking) {
    guard let url = asking.url(at: api) else { return }
    var request = URLRequest(url: url)
    request.httpMethod = asking.method
    Task { _ = try? await URLSession.shared.data(for: request) }
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

@main
struct YapdApp: App {
  @State private var yapd = Yapd()

  init() {
    // Only the first time, so turning it off in System Settings, Login Items, sticks.
    if !UserDefaults.standard.bool(forKey: "registered") {
      do {
        try SMAppService.mainApp.register()
        UserDefaults.standard.set(true, forKey: "registered")
      } catch {
        NSLog("Could not open yapd at login: \(error)")
      }
    }
  }

  var body: some Scene {
    MenuBarExtra {
      if let state = yapd.state {
        Button(state.on ? "Turn Off" : "Turn On") { yapd.turn(on: !state.on) }
        Button("Show Last Card") { yapd.showLast() }
          .disabled(yapd.last == nil)
        if let recent = state.recent {
          if !recent.isEmpty {
            Divider()
            RecentItems(recent: recent, on: state.on, now: yapd.now, icons: yapd.icons, replay: yapd.replay, mute: yapd.mute)
          }
        } else if !state.updates.isEmpty {
          // A yapd from before it listed threads: the updates it said, to hear again.
          Divider()
          Section("Hear Again") {
            ForEach(state.updates) { update in
              Button(update.text.count > 60 ? "\(update.text.prefix(60))…" : update.text) { yapd.replay(update) }
            }
          }
          .disabled(!state.on)
        }
      } else {
        Text("yapd isn't running")
      }
      Divider()
      Button("Quit") { NSApplication.shared.terminate(nil) }
        .keyboardShortcut("q")
    } label: {
      yapd.icon
    }
  }
}

/// The threads with the latest updates, each with its project's icon, how long ago it ended and whether it's muted: clicking
/// one says its latest update again, unless yapd can't reach it, and the Mute menu mutes it or takes the mute off. On macOS 15 and later, holding Option
/// turns each row into muting it, or taking the mute off.
struct RecentItems: View {
  let recent: [Status.Recent]
  /// While yapd is off, it can't say anything again, but threads can still be muted.
  let on: Bool
  /// What the times are told from.
  let now: Date
  let icons: Icons
  let replay: @MainActor (Status.Recent) -> Void
  let mute: @MainActor (Status.Recent, Bool) -> Void

  var body: some View {
    Section("Recent") {
      ForEach(recent) { row in
        Button { replay(row) } label: { label(row) }
          .disabled(!row.hearable(on: on))
          .muting { Button(row.muted ? "Unmute \(row.label)" : "Mute \(row.label)") { mute(row, !row.muted) } }
      }
    }
    Menu("Mute") {
      ForEach(recent) { row in
        Toggle(row.label, isOn: Binding(get: { row.muted }, set: { mute(row, $0) }))
      }
    }
  }

  /// Its icon and name, with how long ago it ended under them, where the menu has room for a second line.
  @ViewBuilder private func label(_ row: Status.Recent) -> some View {
    Image(nsImage: icons.icon(for: row))
    if #available(macOS 14.4, *) {
      Text(row.label)
      Text(row.detail(now: now))
    } else {
      Text("\(row.label) — \(row.detail(now: now))")
    }
  }
}

extension View {
  /// The row's Option-click alternate, on macOS 15 and later, where menus have them.
  @ViewBuilder fileprivate func muting(@ViewBuilder _ alternate: () -> some View) -> some View {
    if #available(macOS 15, *) {
      modifierKeyAlternate(.option, alternate)
    } else {
      self
    }
  }
}
