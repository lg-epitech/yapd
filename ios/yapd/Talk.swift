import ActivityKit
import AVFoundation
import Security
import UIKit

// The phone as one of yapd's devices: press to talk, as the Mac's shortcut
// does, and hear what yapd says back. yapd says everything through the
// device you last pressed on, so while the phone is connected and was the
// last pressed, updates come out of it too. Once nothing has happened for a
// while with the app in the background, it disconnects, so yapd goes back to
// speaking on the Mac rather than to a phone that's asleep.

/// The token `yapd pair` gave out, kept in the Keychain.
enum Keychain {
  private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.yapd.phone", kSecAttrAccount as String: "token"]

  static var token: String? {
    get {
      var item: CFTypeRef?
      var asked = query
      asked[kSecReturnData as String] = true
      guard SecItemCopyMatching(asked as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
      return String(data: data, encoding: .utf8)
    }
    set {
      SecItemDelete(query as CFDictionary)
      guard let newValue else { return }
      var item = query
      item[kSecValueData as String] = Data(newValue.utf8)
      // So the Action button works with the phone locked, once it's been unlocked since it started.
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemAdd(item as CFDictionary, nil)
    }
  }
}

@MainActor @Observable
final class Talk {
  static let shared = Talk()

  /// Where yapd answers, like http://rig.tailnet.ts.net:4747.
  private(set) var server: URL? = UserDefaults.standard.url(forKey: "server")
  private(set) var connected = false
  /// From the press that starts a dictation until it's sent or dropped, as yapd says.
  private(set) var dictating = false
  private(set) var playing = false
  private(set) var listening = false
  /// What went wrong last, said on the screen until the next press.
  private(set) var trouble: String?
  /// Whether the app is on screen, which keeps it connected.
  private var foreground = false

  @ObservationIgnored private let speaker = Speaker()
  @ObservationIgnored private let connection = Connection()
  @ObservationIgnored private var activity: Activity<TalkAttributes>?
  @ObservationIgnored private var idle: Task<Void, Never>?
  /// The same every time, so yapd knows it again.
  @ObservationIgnored private let id: String = {
    if let id = UserDefaults.standard.string(forKey: "id") { return id }
    let id = "iphone-\(UUID().uuidString.prefix(8).lowercased())"
    UserDefaults.standard.set(id, forKey: "id")
    return id
  }()

  var paired: Bool { server != nil && Keychain.token != nil }

  init() {
    let connection = connection
    let speaker = speaker
    speaker.tell = { connection.send($0) }
    speaker.hear = { connection.send($0) }
    speaker.changed = { [weak self] playing, listening in
      self?.playing = playing
      self?.listening = listening
      self?.update()
    }
    connection.file = { speaker.keep($0, $1) }
    connection.hello = { [id] in
      ["type": "hello", "permission": Speaker.permission, "client": ["id": id, "name": UIDevice.current.name, "hotkeys": false, "opens": true]]
    }
    connection.opened = { speaker.announce() }
    connection.heard = { [weak self] message in
      switch message["type"] as? String {
      case "escape":
        let on = message["on"] as? Bool ?? false
        DispatchQueue.main.async { self?.dictating = on; self?.update() }
      case "open":
        guard let address = message["url"] as? String, let url = URL(string: address), url.scheme == "https" else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url) }
      default:
        speaker.handle(message)
        if message["type"] as? String == "rest" { DispatchQueue.main.async { self?.settle() } }
      }
    }
    connection.changed = { [weak self] connected in
      guard let self else { return }
      self.connected = connected
      if !connected {
        self.dictating = false
        speaker.close()
        // On screen, it stays connected, trying again until yapd is back.
        if self.foreground {
          Task {
            try? await Task.sleep(for: .seconds(3))
            if self.foreground, !self.connected { await self.connect() }
          }
        }
      }
      self.update()
      self.settle()
    }
  }

  /// Keeps where yapd is and its token, from the link `yapd pair` printed or as typed in.
  func pair(server: String, token: String) -> Bool {
    let trimmed = server.trimmingCharacters(in: .whitespaces)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "http://\(trimmed)"), url.host != nil, !token.isEmpty else { return false }
    connection.disconnect()
    UserDefaults.standard.set(url, forKey: "server")
    Keychain.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    self.server = url
    trouble = nil
    Task { await asked() }
    if foreground { Task { await connect() } }
    return true
  }

  /// A `yapd://pair?server=…&token=…` link.
  func open(_ url: URL) {
    guard url.scheme == "yapd", url.host == "pair", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      let server = items.first(where: { $0.name == "server" })?.value, let token = items.first(where: { $0.name == "token" })?.value
    else { return }
    _ = pair(server: server, token: token)
  }

  func unpair() {
    connection.disconnect()
    UserDefaults.standard.removeObject(forKey: "server")
    Keychain.token = nil
    server = nil
  }

  /// Asks for the microphone, which can only be asked with the app on screen.
  func asked() async {
    if AVAudioApplication.shared.recordPermission == .undetermined { _ = await AVAudioApplication.requestRecordPermission() }
  }

  /// The button, the Action button or the Live Activity's: starts dictating, or sends what was said, as the Mac's shortcut does.
  func press() async {
    guard let server, let token = Keychain.token else {
      trouble = "Pair with yapd first: run yapd pair on your server."
      return
    }
    trouble = nil
    idle?.cancel()
    begin()
    // Recording from the press, so it's going while the press is handled, as the Action button needs.
    if !dictating { speaker.open() }
    guard await connection.connect(to: server, token: token) else {
      trouble = "I can't reach yapd at \(server.host ?? "your server"). Is Tailscale on?"
      // Nothing's listening for what it records.
      speaker.close()
      update()
      settle()
      return
    }
    connection.send(["type": "pressed", "key": "shortcut"])
  }

  /// Drops what's being dictated, as Escape does on the Mac.
  func cancel() {
    connection.send(["type": "pressed", "key": "escape"])
  }

  func appeared(_ foreground: Bool) {
    self.foreground = foreground
    if foreground { Task { await connect() } } else { settle() }
  }

  private func connect() async {
    guard let server, let token = Keychain.token else { return }
    idle?.cancel()
    _ = await connection.connect(to: server, token: token)
  }

  /// In the background with nothing going on, it lets go before long, so yapd speaks on the Mac again.
  private func settle() {
    idle?.cancel()
    idle = Task { [weak self] in
      try? await Task.sleep(for: .seconds(20))
      guard let self, !Task.isCancelled else { return }
      if self.dictating || self.playing { return self.settle() }
      if !self.foreground { self.connection.disconnect() }
      self.end()
    }
  }

  // The Live Activity, which the Action button needs for recording in the background, and which shows what yapd is doing.

  private var phase: TalkAttributes.ContentState {
    .init(state: !connected ? "connecting" : dictating ? "listening" : playing ? "speaking" : "ready")
  }

  private func begin() {
    guard activity == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    activity = try? Activity.request(attributes: TalkAttributes(), content: .init(state: phase, staleDate: nil))
  }

  private func update() {
    guard let activity else { return }
    let phase = phase
    Task { await activity.update(.init(state: phase, staleDate: nil)) }
  }

  private func end() {
    guard let activity else { return }
    self.activity = nil
    Task { await activity.end(nil, dismissalPolicy: .immediate) }
  }
}
