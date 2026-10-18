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

/// What the phone shows of yapd's state, from /state.
struct Status: Decodable {
  let on: Bool
  let mode: String?
  let waiting: Int?
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
  /// yapd's own state, as the menu bar shows it, followed while the app is on screen: none until it's heard from.
  private(set) var status: Status?
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
    connection.file = { [weak self] id, bytes in
      speaker.keep(id, bytes)
      // Something's about to be said.
      DispatchQueue.main.async { self?.stirred() }
    }
    connection.hello = { [id] in
      ["type": "hello", "permission": Speaker.permission, "client": ["id": id, "name": UIDevice.current.name, "hotkeys": false, "opens": true]]
    }
    connection.opened = { speaker.announce() }
    connection.heard = { [weak self] message in
      // yapd is at work, so it isn't time to let go: it may have more to say, like the answer after "one moment".
      DispatchQueue.main.async { self?.stirred() }
      switch message["type"] as? String {
      case "escape":
        let on = message["on"] as? Bool ?? false
        DispatchQueue.main.async { self?.dictating = on; self?.update() }
      case "open":
        guard let address = message["url"] as? String, let url = URL(string: address), url.scheme == "https" else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url) }
      default:
        speaker.handle(message)
      }
    }
    #if DEBUG
      trying()
    #endif
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
            await self.connect()
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
    if foreground {
      watching?.cancel()
      watching = nil
      watch()
      Task { await connect() }
    }
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
    watching?.cancel()
    watching = nil
    status = nil
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
      // Nothing's listening for what it records, nor will be.
      connection.disconnect()
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
    if foreground {
      Task { await connect() }
      watch()
    } else {
      watching?.cancel()
      watching = nil
      settle()
    }
  }

  @ObservationIgnored private var watching: Task<Void, Never>?

  /// Follows /state/stream while the app is on screen, for whether yapd is on, its mode and who waits on him.
  private func watch() {
    guard watching == nil, let server, let token = Keychain.token else { return }
    watching = Task { [weak self] in
      while !Task.isCancelled {
        var request = URLRequest(url: server.appendingPathComponent("state/stream"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // It says something only when something changes.
        request.timeoutInterval = 3600
        do {
          let (bytes, response) = try await URLSession.shared.bytes(for: request)
          guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
          for try await line in bytes.lines {
            guard line.hasPrefix("data: "), let status = try? JSONDecoder().decode(Status.self, from: Data(line.dropFirst(6).utf8)) else { continue }
            self?.status = status
          }
        } catch {}
        self?.status = nil
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  @ObservationIgnored private var connecting = false

  /// On screen, it keeps trying every few seconds until yapd answers, one try at a time.
  private func connect() async {
    guard !connecting else { return }
    connecting = true
    defer { connecting = false }
    idle?.cancel()
    while foreground, !connected, let server, let token = Keychain.token {
      if await connection.connect(to: server, token: token) { return }
      try? await Task.sleep(for: .seconds(3))
    }
  }

  /**
   * In the background with nothing going on, it lets go before long, so yapd
   * speaks on the Mac again: kept awake meanwhile, since once its audio rests
   * iOS would otherwise suspend it still connected, and yapd would go on
   * speaking to a phone that's asleep. Should iOS end that early, it lets go then.
   */
  private func settle() {
    idle?.cancel()
    hold()
    idle = Task { [weak self] in
      try? await Task.sleep(for: .seconds(20))
      guard let self, !Task.isCancelled else { return }
      if self.dictating || self.playing || self.listening { return self.settle() }
      self.letGo()
    }
  }

  /// yapd said something, so the time to let go counts from now.
  private func stirred() {
    settle()
  }

  @ObservationIgnored private var holding: UIBackgroundTaskIdentifier = .invalid

  private func hold() {
    guard holding == .invalid else { return }
    holding = UIApplication.shared.beginBackgroundTask(withName: "yapd") { [weak self] in
      MainActor.assumeIsolated { self?.letGo() }
    }
  }

  /// Done for now: off the connection when it's in the background, with the microphone and the Live Activity gone either way.
  private func letGo() {
    idle?.cancel()
    idle = nil
    if !foreground {
      connection.disconnect()
      speaker.close()
    }
    end()
    if holding != .invalid {
      UIApplication.shared.endBackgroundTask(holding)
      holding = .invalid
    }
  }

  // The Live Activity, which the Action button needs for recording in the background, and which shows what yapd is doing.

  private var phase: TalkAttributes.ContentState {
    .init(state: !connected ? "connecting" : dictating ? "listening" : playing ? "speaking" : "ready")
  }

  private func begin() {
    guard activity == nil else { return }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      trouble = "Turn on Live Activities for yapd in Settings, or the Action button can't record."
      return
    }
    do {
      activity = try Activity.request(attributes: TalkAttributes(), content: .init(state: phase, staleDate: nil))
    } catch {
      trouble = "I couldn't show that I'm listening: \(error.localizedDescription)"
    }
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

#if DEBUG
  extension Talk {
    /**
     * For trying it without a finger, in a debug build only: paired from
     * YAPD_PAIR, a `yapd://pair` link, given as it's launched, then pressed
     * by writing "talk" or "drop" to `yapd-command` in its Documents.
     */
    fileprivate func trying() {
      if let link = ProcessInfo.processInfo.environment["YAPD_PAIR"], let url = URL(string: link) { open(url) }
      let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("yapd-command")
      Task { [weak self] in
        while true {
          try? await Task.sleep(for: .milliseconds(300))
          guard let self, let command = try? String(contentsOf: file, encoding: .utf8) else { continue }
          try? FileManager.default.removeItem(at: file)
          switch command.trimmingCharacters(in: .whitespacesAndNewlines) {
          case "talk": await self.press()
          case "drop": self.cancel()
          default: break
          }
        }
      }
    }
  }
#endif
