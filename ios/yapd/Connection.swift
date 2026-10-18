import Foundation

// The phone's connection to yapd's /audio, over Tailscale, with the token
// `yapd pair` gave out. Text frames are the helper's JSON messages; binary ones
// start with a byte saying what they are: 2 for a file to play, sent ahead,
// 3 for the microphone (docs/api.md).

final class Connection: NSObject, URLSessionWebSocketDelegate {
  /// What yapd says, on the speaker's side: its messages, and the files it sends ahead.
  var heard: ([String: Any]) -> Void = { _ in }
  var file: (String, Data) -> Void = { _, _ in }
  /// Whether it's connected now, on the main thread.
  var changed: (Bool) -> Void = { _ in }
  /// What it says first each time it connects, as the helper's hello with who this is.
  var hello: () -> [String: Any] = { [:] }
  /// Once it has said hello, each time it connects, for what yapd has to hear again then.
  var opened: () -> Void = {}

  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
  private let lock = NSLock()
  private var task: URLSessionWebSocketTask?
  private var open = false
  private var waiting: [CheckedContinuation<Bool, Never>] = []

  /// Connects, unless it is already, and says once it's open, or that it couldn't be within a few seconds.
  func connect(to server: URL, token: String) async -> Bool {
    if start(server, token) { return true }
    return await withCheckedContinuation { continuation in
      lock.lock()
      if open {
        lock.unlock()
        return continuation.resume(returning: true)
      }
      waiting.append(continuation)
      lock.unlock()
      DispatchQueue.global().asyncAfter(deadline: .now() + 8) { [weak self] in self?.settle(false) }
    }
  }

  /// Opens a connection unless there's one already, and says whether it's open.
  private func start(_ server: URL, _ token: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if open { return true }
    guard task == nil else { return false }
    var components = URLComponents(url: server.appendingPathComponent("audio"), resolvingAgainstBaseURL: false)!
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    var request = URLRequest(url: components.url!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 10
    let task = session.webSocketTask(with: request)
    // Files can be large: a long line is a megabyte.
    task.maximumMessageSize = 64 * 1024 * 1024
    self.task = task
    task.resume()
    receive(task)
    return false
  }

  func disconnect() {
    lock.lock()
    let task = self.task
    lock.unlock()
    task?.cancel(with: .goingAway, reason: nil)
    gone(task)
  }

  var connected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return open
  }

  func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
    current()?.send(.string(text)) { _ in }
  }

  func send(_ data: Data) {
    current()?.send(.data(data)) { _ in }
  }

  private func current() -> URLSessionWebSocketTask? {
    lock.lock()
    defer { lock.unlock() }
    return open ? task : nil
  }

  private func settle(_ result: Bool) {
    lock.lock()
    let resumed = waiting
    waiting = []
    lock.unlock()
    for continuation in resumed { continuation.resume(returning: result) }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure:
        self.gone(task)
      case .success(.string(let text)):
        if let data = text.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          self.heard(message)
        }
        self.receive(task)
      case .success(.data(let data)):
        self.read(data)
        self.receive(task)
      @unknown default:
        self.receive(task)
      }
    }
  }

  /// A file: the kind, a big-endian length, a JSON header naming it, then its bytes.
  private func read(_ data: Data) {
    let bytes = [UInt8](data)
    guard bytes.count >= 5, bytes[0] == 2 else { return }
    let length = bytes[1...4].reduce(0) { $0 << 8 | Int($1) }
    guard length <= 4096, bytes.count >= 5 + length,
      let header = try? JSONSerialization.jsonObject(with: Data(bytes[5..<(5 + length)])) as? [String: Any],
      let id = header["file"] as? String
    else { return }
    file(id, Data(bytes[(5 + length)...]))
  }

  private func gone(_ task: URLSessionWebSocketTask?) {
    lock.lock()
    guard task === self.task, task != nil else {
      lock.unlock()
      return
    }
    self.task = nil
    let was = open
    open = false
    lock.unlock()
    settle(false)
    if was { DispatchQueue.main.async { self.changed(false) } }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    lock.lock()
    guard webSocketTask === task else {
      lock.unlock()
      return
    }
    open = true
    lock.unlock()
    send(hello())
    opened()
    settle(true)
    DispatchQueue.main.async { self.changed(true) }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    gone(webSocketTask)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    gone(task as? URLSessionWebSocketTask)
  }
}
