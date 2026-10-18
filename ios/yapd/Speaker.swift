import AVFoundation
import UIKit

// The phone's speaker and microphone for yapd, as the Mac's audio helper
// (src/Audio.swift) is for the Mac: it plays what yapd sends and listens
// through one voice-processing engine, so its own voice is cancelled out of
// what it hears. It speaks the helper's protocol, over /audio (docs/api.md).

/// Turns microphone buffers into 32 ms frames of 16 kHz mono, what yapd's voice detector takes. Only the tap's thread touches it.
final class Capture {
  static let rate: Double = 16000
  static let frameLength = 512

  private let send: (Data) -> Void
  private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Capture.rate, channels: 1, interleaved: false)!
  private var converter: AVAudioConverter?
  private var pending: [Float] = []

  init(send: @escaping (Data) -> Void) { self.send = send }

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
      // Kind 3: 16-bit little-endian integers, half the size of the floats.
      var frame = Data([3])
      frame.reserveCapacity(1 + Capture.frameLength * 2)
      for sample in pending.prefix(Capture.frameLength) {
        let value = Int16(max(-1, min(1, sample)) * Float(Int16.max))
        withUnsafeBytes(of: value.littleEndian) { frame.append(contentsOf: $0) }
      }
      pending.removeFirst(Capture.frameLength)
      send(frame)
    }
  }
}

final class Speaker {
  /// Everything but capture runs here.
  let queue = DispatchQueue(label: "yapd.speaker")

  private struct Playing {
    let id: String
    let file: AVAudioFile
    let start: AVAudioFramePosition
    /// Tells this segment's completion apart from an earlier one's, which stopping also calls.
    let generation: Int
    let began: Date
  }

  /// Sends one of the helper's messages to yapd, and a microphone frame.
  var tell: ([String: Any]) -> Void = { _ in }
  var hear: (Data) -> Void = { _ in }
  /// Whether it plays or listens, for the screen and the Live Activity, on the main thread.
  var changed: (_ playing: Bool, _ listening: Bool) -> Void = { _, _ in }

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var playing: Playing?
  private var generation = 0
  /// Whether yapd wants the engine running, which an interruption or a route change doesn't alter.
  private var active = false
  private var tapped = false
  private var listening = false
  /// What yapd sent to play, by its id, in a folder of its own.
  private var files: [String: URL] = [:]
  private let folder: URL

  init() {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("yapd-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    engine.attach(player)
    // Connecting the mixer also creates the output node, which the engine needs before it can start.
    engine.connect(player, to: engine.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1))
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) {
      [weak self] _ in self?.queue.async { self?.recover() }
    }
    NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) {
      [weak self] note in
      let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
      self?.queue.async { if type == .began { self?.interrupted() } else { self?.recover() } }
    }
  }

  /// Without echo cancellation, for trying it in the simulator, where it cancels everything the Mac plays: debug builds only.
  #if DEBUG
    static let raw = ProcessInfo.processInfo.environment["YAPD_RAW_MICROPHONE"] != nil
  #else
    static let raw = false
  #endif

  static var permission: String {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: "authorized"
    case .denied: "denied"
    default: "undetermined"
    }
  }

  /// A file yapd sent ahead of playing it.
  func keep(_ id: String, _ bytes: Data) {
    queue.async {
      let url = self.folder.appendingPathComponent("\(self.files.count)-\(UUID().uuidString).wav")
      do {
        try bytes.write(to: url)
        self.files[id] = url
      } catch {
        self.tell(["type": "error", "message": "Could not keep a file to play: \(error)"])
      }
    }
  }

  func handle(_ message: [String: Any]) {
    queue.async {
      switch message["type"] as? String {
      case "play":
        guard let id = message["id"] as? String else { return }
        guard let file = message["file"] as? String, let url = self.files[file] else {
          return self.tell(["type": "failed", "id": id, "message": "That file never came"])
        }
        self.play(id: id, url: url, from: message["from"] as? Double ?? 0)
      case "stop": self.stop()
      case "volume": self.player.volume = Float(message["value"] as? Double ?? 1)
      case "rest": self.rest()
      case "forget":
        guard let file = message["file"] as? String, let url = self.files.removeValue(forKey: file) else { return }
        try? FileManager.default.removeItem(at: url)
      default: break
      }
    }
  }

  /// Opens the microphone now, as a press does, before yapd's first sound, so it's recording while the press is still being handled.
  func open() {
    queue.async {
      do {
        try self.activate()
      } catch {
        self.tell(["type": "error", "message": "Could not start the audio: \(error)"])
      }
    }
  }

  /// Says again whether the microphone is open, for a connection that came up once it already was.
  func announce() {
    queue.async {
      if self.engine.isRunning { self.tell(["type": "active", "listening": self.listening]) }
    }
  }

  /// Stops and closes everything, as the connection to yapd goes, and lets go of the audio session.
  func close() {
    queue.async {
      self.stop(silently: true)
      self.active = false
      self.halt()
      for url in self.files.values { try? FileManager.default.removeItem(at: url) }
      self.files = [:]
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  /// Whether it's playing, or its engine is running, which keeps the app awake.
  var busy: Bool { queue.sync { playing != nil || engine.isRunning } }

  private func session() throws {
    let session = AVAudioSession.sharedInstance()
    // Voice chat is what turns on the echo cancellation, and the speaker rather than the earpiece, unless headphones are in.
    try session.setCategory(.playAndRecord, mode: Speaker.raw ? .default : .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
    try session.setActive(true)
  }

  private func activate() throws {
    active = true
    guard !engine.isRunning else { return }
    try session()
    // Touching the input node at all opens the microphone, so it's left alone without permission.
    var hearing = AVAudioApplication.shared.recordPermission == .granted
    if hearing {
      do {
        try listen()
      } catch {
        tell(["type": "error", "message": "Could not open the microphone: \(error)"])
        hearing = false
      }
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      halt()
      tell(["type": "rested"])
      throw error
    }
    listening = hearing
    tell(["type": "active", "listening": hearing])
    report()
  }

  private func listen() throws {
    let input = engine.inputNode
    let usable = { (format: AVAudioFormat) in format.channelCount > 0 && format.sampleRate > 0 }
    guard usable(input.inputFormat(forBus: 0)) else { throw POSIXError(.ENODEV) }
    if !input.isVoiceProcessingEnabled && !Speaker.raw { try input.setVoiceProcessingEnabled(true) }
    guard !tapped else { return }
    let format = input.outputFormat(forBus: 0)
    guard usable(format) else { throw POSIXError(.ENODEV) }
    let capture = Capture(send: { [weak self] frame in self?.hear(frame) })
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in capture.push(buffer) }
    tapped = true
  }

  /// Stops the engine, which turns the microphone off until the next line, and lets other apps' audio back up.
  private func rest() {
    stop(silently: true)
    active = false
    halt()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func halt() {
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
    engine.stop()
    listening = false
    report()
  }

  /// A call or Siri took the audio: whatever played is cut off, and the microphone is off until the next line.
  private func interrupted() {
    let current = playing
    playing = nil
    player.stop()
    halt()
    tell(["type": "rested"])
    if let current { tell(["type": "failed", "id": current.id, "message": "Something else took the audio"]) }
  }

  private func play(id: String, url: URL, from: Double) {
    do {
      try activate()
      stop(silently: true)
      let file = try AVAudioFile(forReading: url)
      let format = file.processingFormat
      if player.outputFormat(forBus: 0) != format {
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
      }
      guard rendering() else {
        rest()
        tell(["type": "rested"])
        return tell(["type": "failed", "id": id, "message": "The audio engine started but didn't play anything"])
      }
      let start = min(AVAudioFramePosition(max(0, from) * format.sampleRate), file.length)
      generation += 1
      let current = Playing(id: id, file: file, start: start, generation: generation, began: Date())
      playing = current
      tell(["type": "playing", "id": id, "duration": Double(file.length) / format.sampleRate])
      report()
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
      tell(["type": "failed", "id": id, "message": "\(error)"])
    }
  }

  /// Whether the engine renders, seen as the player's render time moving on within two seconds. It takes milliseconds when it does.
  private func rendering() -> Bool {
    let deadline = Date().addingTimeInterval(2)
    var first: AVAudioFramePosition?
    while engine.isRunning, Date() < deadline {
      if let time = player.lastRenderTime, time.isSampleTimeValid {
        if first == nil { first = time.sampleTime } else if time.sampleTime != first { return true }
      }
      Thread.sleep(forTimeInterval: 0.005)
    }
    return false
  }

  private func finish(_ id: String) {
    playing = nil
    tell(["type": "finished", "id": id])
    report()
  }

  /// From the player while the engine runs, and from the clock once something has stopped it.
  private func position(_ playing: Playing) -> Double {
    let rate = playing.file.processingFormat.sampleRate
    let duration = Double(playing.file.length) / rate
    if let now = player.lastRenderTime, now.isSampleTimeValid, let time = player.playerTime(forNodeTime: now) {
      return min(duration, Double(playing.start + max(0, time.sampleTime)) / rate)
    }
    return min(duration, Double(playing.start) / rate + Date().timeIntervalSince(playing.began))
  }

  /// Says how far it got, or that nothing was playing, like when it had just finished.
  private func stop(silently: Bool = false) {
    let current = playing
    let at = current.map(position)
    playing = nil
    player.stop()
    report()
    guard !silently else { return }
    if let current, let at {
      tell(["type": "stopped", "id": current.id, "at": at])
    } else {
      tell(["type": "stopped"])
    }
  }

  /// A route change, like headphones going in, stops the engine: start it again and carry on where it was.
  private func recover() {
    guard active, !engine.isRunning else { return }
    let current = playing
    let at = current.map(position)
    playing = nil
    player.stop()
    halt()
    if let current, let at {
      play(id: current.id, url: current.file.url, from: at)
      return
    }
    do {
      try activate()
    } catch {
      tell(["type": "error", "message": "Could not restart audio: \(error)"])
    }
  }

  private func report() {
    let state = (playing != nil, listening)
    DispatchQueue.main.async { self.changed(state.0, state.1) }
  }
}
