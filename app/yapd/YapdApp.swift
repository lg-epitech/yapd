import ServiceManagement
import SwiftUI

// yapd in the menu bar: whether it's on, what it's doing, the updates it said
// lately, to hear again, and the card it's showing, in a panel under the icon.
// It only uses the API in docs/api.md, so another UI can do all of this too.

/// What `GET /state` returns.
struct Status: Decodable {
  struct Update: Decodable, Identifiable {
    let id: String
    let text: String
  }

  /// The card yapd is showing, as `/state` points at it.
  struct Showing: Decodable, Equatable {
    let id: String
    /// ISO 8601, when yapd put it up.
    let at: String

    /// Whether it went up a moment ago, rather than before the app was watching.
    var fresh: Bool {
      let format = ISO8601DateFormatter()
      format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      guard let at = format.date(from: at) else { return false }
      return Date().timeIntervalSince(at) < 30
    }
  }

  let on: Bool
  let activity: String
  let updates: [Update]
  /// None when no card is up, and from a yapd too old to show cards.
  let showing: Showing?

  private enum CodingKeys: String, CodingKey { case on, activity, updates, showing }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    on = try container.decode(Bool.self, forKey: .on)
    activity = try container.decode(String.self, forKey: .activity)
    updates = try container.decode([Update].self, forKey: .updates)
    // An older yapd doesn't send it at all.
    showing = try container.decodeIfPresent(Showing.self, forKey: .showing)
  }
}

@MainActor @Observable
final class Yapd {
  /// None while yapd isn't running.
  private(set) var state: Status?
  /// The last card yapd showed, to show again.
  private(set) var last: String?
  /// The card the panel follows, so it's put up once.
  @ObservationIgnored private var shown: String?
  @ObservationIgnored private let panel = Panel()
  private let api: URL

  init() {
    // `defaults write dev.yapd.menu port 4848` for a yapd on another port.
    let port = UserDefaults.standard.integer(forKey: "port")
    api = URL(string: "http://127.0.0.1:\(port == 0 ? 4747 : port)")!
    // Closed or faded, the card is no longer on screen, so yapd takes it down too, unless it's put up another since.
    panel.closed = { [weak self] card in
      guard let self, self.state?.showing?.id == card.id else { return }
      self.send("DELETE", "cards/current")
    }
    Task { await watch() }
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
    var request = URLRequest(url: api.appending(path: "state/stream"))
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
          await follow(status, connecting: first)
        }
      } catch {}
      state = nil
      try? await Task.sleep(for: .seconds(2))
    }
  }

  /// Puts up a card as yapd starts showing it and takes it away when yapd does. On connecting, only a card put up a moment ago is news.
  private func follow(_ status: Status, connecting: Bool) async {
    if status.showing?.id != shown {
      shown = status.showing?.id
      if let showing = status.showing {
        last = showing.id
        if connecting && !showing.fresh {
          // Put up while the app wasn't there to show it, so it isn't on screen: yapd takes it down too, and it's kept to show again.
          panel.hide()
          send("DELETE", "cards/current")
        } else if let card = await fetch(showing.id), shown == card.id {
          panel.show(card, talking: true)
        }
      } else {
        panel.hide()
      }
    }
    panel.heard(speaking: status.activity == "speaking")
  }

  /// One of the cards yapd showed lately.
  private func fetch(_ id: String) async -> Card? {
    guard let fetched = try? await URLSession.shared.data(from: api.appending(path: "cards/\(id)")),
          (fetched.1 as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? JSONDecoder().decode(Card.self, from: fetched.0)
  }

  func turn(on: Bool) {
    send("PUT", "state", body: try? JSONEncoder().encode(["on": on]))
  }

  func replay(_ update: Status.Update) {
    send("POST", "updates/\(update.id)/replay")
  }

  /// Shows the last card again, for a while, with nothing said of it.
  func showLast() {
    guard let last else { return }
    Task {
      if let card = await fetch(last) { panel.show(card, talking: false) }
    }
  }

  /// What comes of it shows in the state.
  private func send(_ method: String, _ path: String, body: Data? = nil) {
    var request = URLRequest(url: api.appending(path: path))
    request.httpMethod = method
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    Task { _ = try? await URLSession.shared.data(for: request) }
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
        if !state.updates.isEmpty {
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
