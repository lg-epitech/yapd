import AVFoundation
import AppKit
import Carbon.HIToolbox
import Foundation

// yapd's audio helper. It plays updates and listens to the microphone through
// one voice-processing engine, so its own voice is cancelled out of what it
// hears, and takes the shortcut that starts new work. The daemon launches it as
// an app, which gives it its own microphone permission, and talks to it over a
// Unix socket.

func log(_ message: String) {
  FileHandle.standardError.write(Data("yapd-audio: \(message)\n".utf8))
}

/// Messages are a kind byte, a big-endian UInt32 length and the payload.
final class Link {
  enum Kind: UInt8 { case json = 0, pcm = 1 }

  private let fd: Int32
  private let writes = DispatchQueue(label: "yapd.link.write")

  init(path: String) throws {
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw POSIXError(.ENAMETOOLONG) }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  }

  func send(_ kind: Kind, _ payload: Data) {
    var message = Data([kind.rawValue])
    withUnsafeBytes(of: UInt32(payload.count).bigEndian) { message.append(contentsOf: $0) }
    message.append(payload)
    writes.async { [fd] in
      message.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
          let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
          if written < 0 && errno == EINTR { continue }
          // The daemon is gone.
          if written <= 0 { exit(0) }
          offset += written
        }
      }
    }
  }

  func send(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    send(.json, data)
  }

  /// Reads commands until the daemon hangs up, then exits, so the helper never outlives it.
  func receive(_ handle: @escaping ([String: Any]) -> Void) {
    Thread {
      while let header = self.read(5) {
        let length = header[1...4].reduce(0) { $0 << 8 | Int($1) }
        guard let payload = self.read(length) else { break }
        if header[0] == Kind.json.rawValue,
          let message = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any]
        {
          handle(message)
        }
      }
      exit(0)
    }.start()
  }

  private func read(_ count: Int) -> [UInt8]? {
    var buffer = [UInt8](repeating: 0, count: count)
    var offset = 0
    while offset < count {
      let received = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress! + offset, count - offset) }
      if received < 0 && errno == EINTR { continue }
      if received <= 0 { return nil }
      offset += received
    }
    return buffer
  }
}

/// Turns microphone buffers into 32 ms frames of 16 kHz mono, what the daemon's voice detector takes.
/// Only the tap's thread touches it.
final class Capture {
  static let rate: Double = 16000
  static let frameLength = 512

  private let link: Link
  private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Capture.rate, channels: 1, interleaved: false)!
  private var converter: AVAudioConverter?
  private var pending: [Float] = []

  init(link: Link) { self.link = link }

  func push(_ buffer: AVAudioPCMBuffer) {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    // Voice processing can report every mic in an array; the first channel carries the processed voice.
    let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false)!
    guard let input = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return }
    input.frameLength = buffer.frameLength
    let stride = buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1
    for index in 0..<Int(buffer.frameLength) { input.floatChannelData![0][index] = channels[0][index * stride] }

    if converter?.inputFormat != mono { converter = AVAudioConverter(from: mono, to: target) }
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / mono.sampleRate) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return input
    }
    guard error == nil, let samples = output.floatChannelData?[0] else { return }
    pending.append(contentsOf: UnsafeBufferPointer(start: samples, count: Int(output.frameLength)))
    while pending.count >= Capture.frameLength {
      let frame = Array(pending.prefix(Capture.frameLength))
      pending.removeFirst(Capture.frameLength)
      link.send(.pcm, frame.withUnsafeBufferPointer { Data(buffer: $0) })
    }
  }
}

final class Audio {
  /// Everything but capture runs here.
  let queue = DispatchQueue(label: "yapd.audio")

  private struct Playing {
    let id: String
    let file: AVAudioFile
    let start: AVAudioFramePosition
    /// Tells this segment's completion apart from an earlier one's, which stopping also calls.
    let generation: Int
    let began: Date
  }

  private let link: Link
  private let wantsMicrophone: Bool
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var playing: Playing?
  private var generation = 0
  /// Whether the daemon wants the engine running, which a device change doesn't alter.
  private var active = false
  private var tapped = false

  init(link: Link, wantsMicrophone: Bool) {
    self.link = link
    self.wantsMicrophone = wantsMicrophone
    engine.attach(player)
    // Connecting the mixer also creates the output node, which the engine needs before it can start.
    engine.connect(player, to: engine.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1))
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) {
      [weak self] _ in self?.queue.async { self?.recover() }
    }
  }

  static var permission: String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: "authorized"
    case .denied: "denied"
    case .restricted: "restricted"
    default: "undetermined"
    }
  }

  func handle(_ message: [String: Any]) {
    switch message["type"] as? String {
    case "play":
      guard let id = message["id"] as? String, let path = message["path"] as? String else { return }
      play(id: id, path: path, from: message["from"] as? Double ?? 0)
    case "stop": stop()
    case "volume": player.volume = Float(message["value"] as? Double ?? 1)
    case "rest": rest()
    default: log("unknown message \(message)")
    }
  }

  private func activate() throws {
    active = true
    guard !engine.isRunning else { return }
    // Touching the input node at all opens the microphone, so it's left alone without permission.
    var listening = wantsMicrophone && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    if listening {
      do {
        try listen()
      } catch {
        link.send(["type": "error", "message": "Could not open the microphone: \(error)"])
        listening = false
      }
    }
    engine.prepare()
    try engine.start()
    link.send(["type": "active", "listening": listening])
  }

  private func listen() throws {
    let input = engine.inputNode
    // A Mac without a microphone has an empty format, and tapping it raises an exception Swift can't catch.
    let usable = { (format: AVAudioFormat) in format.channelCount > 0 && format.sampleRate > 0 }
    guard usable(input.inputFormat(forBus: 0)) else { throw POSIXError(.ENODEV) }
    if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
    if #available(macOS 14.0, *) {
      // Voice processing ducks other apps' audio hard by default.
      input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: true, duckingLevel: .min)
    }
    guard !tapped else { return }
    let format = input.outputFormat(forBus: 0)
    guard usable(format) else { throw POSIXError(.ENODEV) }
    let capture = Capture(link: link)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in capture.push(buffer) }
    tapped = true
  }

  /// Stops the engine, which turns the microphone off until the next update.
  private func rest() {
    stop(silently: true)
    active = false
    halt()
  }

  private func halt() {
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
    engine.stop()
  }

  private func play(id: String, path: String, from: Double) {
    do {
      try activate()
      stop(silently: true)
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
      let format = file.processingFormat
      if player.outputFormat(forBus: 0) != format {
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
      }
      let start = min(AVAudioFramePosition(max(0, from) * format.sampleRate), file.length)
      generation += 1
      let current = Playing(id: id, file: file, start: start, generation: generation, began: Date())
      playing = current
      link.send(["type": "playing", "id": id, "duration": Double(file.length) / format.sampleRate])
      let remaining = AVAudioFrameCount(file.length - start)
      guard remaining > 0 else { return finish(id) }
      player.scheduleSegment(file, startingFrame: start, frameCount: remaining, at: nil, completionCallbackType: .dataPlayedBack) {
        [weak self] _ in
        self?.queue.async {
          if self?.playing?.generation == current.generation { self?.finish(id) }
        }
      }
      player.volume = 1
      player.play()
    } catch {
      playing = nil
      link.send(["type": "failed", "id": id, "message": "\(error)"])
    }
  }

  private func finish(_ id: String) {
    playing = nil
    link.send(["type": "finished", "id": id])
  }

  /// From the player while the engine runs, and from the clock once a device change has stopped it.
  private func position(_ playing: Playing) -> Double {
    let rate = playing.file.processingFormat.sampleRate
    let duration = Double(playing.file.length) / rate
    if let now = player.lastRenderTime, now.isSampleTimeValid, let time = player.playerTime(forNodeTime: now) {
      return min(duration, Double(playing.start + max(0, time.sampleTime)) / rate)
    }
    return min(duration, Double(playing.start) / rate + Date().timeIntervalSince(playing.began))
  }

  /// Reports how far it got, or nothing when there was nothing playing, like when it had just finished.
  private func stop(silently: Bool = false) {
    let current = playing
    let at = current.map(position)
    playing = nil
    player.stop()
    guard !silently else { return }
    if let current, let at {
      link.send(["type": "stopped", "id": current.id, "at": at])
    } else {
      link.send(["type": "stopped"])
    }
  }

  /// A device change stops the engine; start it again and carry on where it was.
  private func recover() {
    // Starting the engine can post a change of its own, which needs nothing.
    guard active, !engine.isRunning else { return }
    let current = playing
    let at = current.map(position)
    playing = nil
    player.stop()
    halt()
    if let current, let at {
      play(id: current.id, path: current.file.url.path, from: at)
      return
    }
    do {
      try activate()
    } catch {
      link.send(["type": "error", "message": "Could not restart audio: \(error)"])
    }
  }
}

/// The shortcut, and Escape while the user dictates, registered as hotkeys, which
/// need no permission, unlike watching the keyboard. A hotkey is kept from every
/// other app, so the daemon says when to hold Escape. Only the main thread touches
/// it, as Carbon and the keyboard layout need.
final class Hotkeys {
  private static let signature: FourCharCode = 0x7961_7064  // "yapd"
  private static let shortcutID: UInt32 = 1
  private static let escapeID: UInt32 = 2

  /// Keys that type nothing, by the names the daemon uses.
  private static let named: [String: Int] = [
    "space": kVK_Space, "return": kVK_Return, "tab": kVK_Tab,
    "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7,
    "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12, "f13": kVK_F13,
    "f14": kVK_F14, "f15": kVK_F15, "f16": kVK_F16, "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19, "f20": kVK_F20,
  ]
  private static let modifiers = ["ctrl": controlKey, "option": optionKey, "cmd": cmdKey, "shift": shiftKey]

  private let link: Link
  private var shortcut: EventHotKeyRef?
  private var escape: EventHotKeyRef?

  init(link: Link) {
    self.link = link
    var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, event, context in
        var id = EventHotKeyID()
        GetEventParameter(
          event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
          MemoryLayout<EventHotKeyID>.size, nil, &id)
        let hotkeys = Unmanaged<Hotkeys>.fromOpaque(context!).takeUnretainedValue()
        hotkeys.link.send(["type": "pressed", "key": id.id == Hotkeys.escapeID ? "escape" : "shortcut"])
        return noErr
      }, 1, &pressed, Unmanaged.passUnretained(self).toOpaque(), nil)
  }

  func handle(_ message: [String: Any]) {
    switch message["type"] as? String {
    case "shortcut":
      if let shortcut { UnregisterEventHotKey(shortcut) }
      shortcut = nil
      guard let key = message["key"] as? String, let names = message["modifiers"] as? [String] else { return }
      let modifiers = names.reduce(0) { $0 | (Hotkeys.modifiers[$1] ?? 0) }
      guard let code = Hotkeys.named[key] ?? Hotkeys.code(typing: key) else {
        return link.send(["type": "shortcut", "registered": false, "message": "no key types \"\(key)\" on this keyboard"])
      }
      if Hotkeys.system(code, modifiers) {
        return link.send([
          "type": "shortcut", "registered": false,
          "message": "macOS uses it, in System Settings, Keyboard, Keyboard Shortcuts",
        ])
      }
      let status = register(code, modifiers, Hotkeys.shortcutID, into: &shortcut)
      link.send(
        status == noErr
          ? ["type": "shortcut", "registered": true]
          : ["type": "shortcut", "registered": false, "message": Hotkeys.describe(status)])
    case "escape":
      let on = message["on"] as? Bool ?? false
      if on, escape == nil {
        let status = register(kVK_Escape, 0, Hotkeys.escapeID, into: &escape)
        if status != noErr {
          link.send(["type": "error", "message": "Could not take Escape to cancel: \(Hotkeys.describe(status))"])
        }
      } else if !on, let escape {
        UnregisterEventHotKey(escape)
        self.escape = nil
      }
    default: log("unknown message \(message)")
    }
  }

  /// Exclusive, so it fails rather than share a key another app registered.
  private func register(_ code: Int, _ modifiers: Int, _ id: UInt32, into ref: inout EventHotKeyRef?) -> OSStatus {
    let status = RegisterEventHotKey(
      UInt32(code), UInt32(modifiers), EventHotKeyID(signature: Hotkeys.signature, id: id), GetApplicationEventTarget(),
      OptionBits(kEventHotKeyExclusive), &ref)
    if status != noErr { ref = nil }
    return status
  }

  private static func describe(_ status: OSStatus) -> String {
    status == eventHotKeyExistsErr ? "another app has it" : "macOS turned it down (\(status))"
  }

  /// macOS's own shortcuts, like switching input source, don't count as registered, so they're looked up.
  private static func system(_ code: Int, _ modifiers: Int) -> Bool {
    var hotkeys: Unmanaged<CFArray>?
    guard CopySymbolicHotKeys(&hotkeys) == noErr, let list = hotkeys?.takeRetainedValue() as? [[String: Any]] else {
      return false
    }
    let mask = controlKey | optionKey | cmdKey | shiftKey
    return list.contains { hotkey in
      hotkey[kHISymbolicHotKeyEnabled] as? Bool == true && hotkey[kHISymbolicHotKeyCode] as? Int == code
        && (hotkey[kHISymbolicHotKeyModifiers] as? Int ?? 0) & mask == modifiers
    }
  }

  /// The key that types this character on the current layout, so `a` is A on an AZERTY keyboard too,
  /// and with shift, for digits there.
  private static func code(typing character: String) -> Int? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue() as Data
    return data.withUnsafeBytes { raw -> Int? in
      guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
      for state in [0, shiftKey >> 8] {
        for code in 0..<128 {
          var dead: UInt32 = 0
          var length = 0
          var typed = [UniChar](repeating: 0, count: 4)
          let status = UCKeyTranslate(
            layout, UInt16(code), UInt16(kUCKeyActionDisplay), UInt32(state), UInt32(LMGetKbdType()),
            OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, typed.count, &length, &typed)
          if status == noErr, String(utf16CodeUnits: typed, count: length).lowercased() == character { return code }
        }
      }
      return nil
    }
  }
}

let arguments = CommandLine.arguments
guard let flag = arguments.firstIndex(of: "--socket"), flag + 1 < arguments.count else {
  log("usage: yapd-audio --socket <path> [--no-microphone]")
  exit(1)
}

let link: Link
do {
  link = try Link(path: arguments[flag + 1])
} catch {
  log("could not connect: \(error)")
  exit(1)
}

let wantsMicrophone = !arguments.contains("--no-microphone")
let audio = Audio(link: link, wantsMicrophone: wantsMicrophone)
link.send(["type": "hello", "permission": Audio.permission])
if wantsMicrophone && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
  AVCaptureDevice.requestAccess(for: .audio) { _ in link.send(["type": "permission", "permission": Audio.permission]) }
}
let hotkeys = Hotkeys(link: link)
link.receive { message in
  switch message["type"] as? String {
  case "shortcut", "escape": DispatchQueue.main.async { hotkeys.handle(message) }
  default: audio.queue.async { audio.handle(message) }
  }
}
// Hotkeys come in through the app's event loop, which runs the main queue too.
NSApplication.shared.run()
