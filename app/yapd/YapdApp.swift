import ServiceManagement
import SwiftUI

// yapd in the menu bar: whether it's on, what it's doing, and the updates it
// said lately, to hear again. It only uses the API in docs/api.md, so another
// UI can do all of this too.

/// What `GET /state` returns.
struct State: Decodable {
  struct Update: Decodable, Identifiable {
    let id: String
    let text: String
  }

  let on: Bool
  let activity: String
  let updates: [Update]
}

@MainActor @Observable
final class Yapd {
  /// None while yapd isn't running.
  private(set) var state: State?
  private let api: URL

  init() {
    // `defaults write dev.yapd.menu port 4848` for a yapd on another port.
    let port = UserDefaults.standard.integer(forKey: "port")
    api = URL(string: "http://127.0.0.1:\(port == 0 ? 4747 : port)")!
    Task { await watch() }
  }

  var symbol: String {
    guard let state else { return "waveform.badge.exclamationmark" }
    guard state.on else { return "waveform.slash" }
    switch state.activity {
    case "speaking": return "speaker.wave.2.fill"
    case "listening": return "mic.fill"
    default: return "waveform"
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
          state = try JSONDecoder().decode(State.self, from: Data(line.dropFirst(6).utf8))
        }
      } catch {}
      state = nil
      try? await Task.sleep(for: .seconds(2))
    }
  }

  func turn(on: Bool) {
    send("PUT", "state", body: try? JSONEncoder().encode(["on": on]))
  }

  func replay(_ update: State.Update) {
    send("POST", "updates/\(update.id)/replay")
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
      Image(systemName: yapd.symbol)
    }
  }
}
