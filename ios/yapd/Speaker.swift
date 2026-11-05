import AVFoundation
import UIKit

// The phone's speaker and microphone for yapd, as the Mac's audio helper
// (src/Audio.swift) is for the Mac: it plays what yapd sends, and while you
// dictate, listens through one voice-processing engine, so its own voice is
// cancelled out of what it hears. Its microphone is only ever open for a
// dictation, never while yapd just speaks, so nobody around talks over it.
// It speaks the helper's protocol, over /audio (docs/api.md).

/// Turns microphone buffers into 32 ms frames of 16 kHz mono, what yapd's voice detector takes. Only the tap's thread touches it.
final class Capture {
  static let rate: Double = 16000
  static let frameLength = 512
  let id: String
  private let send: (Data) -> Void
  private let modern: (Data, Int) -> Void
  private var sequence = 0
  private let lock = NSRecursiveLock()
  private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Capture.rate, channels: 1, interleaved: false)!
  private var converter: AVAudioConverter?
  private var pending: [Float] = []
  private var before: [Data] = []
  private var armed = false
  private var ended = false
  private var overflow = false

  init(id: String = UUID().uuidString, send: @escaping (Data) -> Void, modern: ((Data, Int) -> Void)? = nil) {
    self.id = id; self.send = send; self.modern = modern ?? { frame, _ in send(frame) }
  }

  /// Legacy delivery continues before V2 subscribes. V2 starts at ready, then receives this exact FIFO once.
  func begin(_ ready: () -> Void) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard !overflow else { return false }
    guard !armed else { ready(); return true }
    armed = true
    ready()
    for frame in before { modern(frame, sequence); sequence += 1 }
    before.removeAll()
    return true
  }

  private func emit(_ samples: [Float]) {
    var frame = Data([3])
    for sample in samples {
      let value = Int16(max(-1, min(1, sample)) * Float(Int16.max))
      withUnsafeBytes(of: value.littleEndian) { frame.append(contentsOf: $0) }
    }
    if armed { modern(frame, sequence); sequence += 1 }
    else {
      if before.count < 512 { before.append(frame) } else { overflow = true }
      send(frame)
    }
  }

  private func append(_ buffer: AVAudioPCMBuffer) {
    guard let samples = buffer.floatChannelData?[0] else { overflow = true; return }
    pending.append(contentsOf: UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength)))
    while pending.count >= Capture.frameLength {
      emit(Array(pending.prefix(Capture.frameLength)))
      pending.removeFirst(Capture.frameLength)
    }
  }

  func push(_ buffer: AVAudioPCMBuffer) {
    lock.lock(); defer { lock.unlock() }
    guard !ended, let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false)!
    guard let input = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { overflow = true; return }
    input.frameLength = buffer.frameLength
    let stride = buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1
    for index in 0..<Int(buffer.frameLength) { input.floatChannelData![0][index] = channels[0][index * stride] }
    if converter?.inputFormat != mono { converter = AVAudioConverter(from: mono, to: target) }
    guard let converter else { overflow = true; return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / mono.sampleRate) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { overflow = true; return }
    var supplied = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true; status.pointee = .haveData; return input
    }
    guard error == nil else { overflow = true; return }
    append(output)
  }

  /// Flush the resampler and the final incomplete frame before the ordered boundary.
  func finish() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if ended { return !overflow }
    ended = true
    if let converter {
      for attempt in 0..<16 {
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 512) else { overflow = true; break }
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in state.pointee = .endOfStream; return nil }
        if error != nil { overflow = true; break }
        append(output)
        if status == .endOfStream || status == .inputRanDry { break }
        if attempt == 15 { overflow = true }
      }
    }
    if !pending.isEmpty {
      pending.append(contentsOf: repeatElement(0, count: Capture.frameLength - pending.count))
      emit(pending); pending.removeAll()
    }
    return !overflow
  }

  var finished: Bool { lock.lock(); defer { lock.unlock() }; return ended }

  func cancel() {
    lock.lock(); defer { lock.unlock() }
    ended = true; pending.removeAll(); before.removeAll()
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

  /// Made again to play without the microphone, since one whose input has been touched records whenever it runs.
  private var engine = AVAudioEngine()
  private var player = AVAudioPlayerNode()
  private var changes: NSObjectProtocol?
  private var playing: Playing?
  private var generation = 0

  /// Device-local streaming state. Only the audio queue mutates it.
  private final class Streaming {
    let id: String
    let generation: Int
    let rate: Int
    var sequence = 0
    var scheduled = 0
    var rendered = 0
    var ended = false
    var began = false
    init(id: String, generation: Int, rate: Int) {
      self.id = id
      self.generation = generation
      self.rate = rate
    }
  }
  private var streaming: Streaming?
  /// Whether yapd wants the engine running, which an interruption or a route change doesn't alter.
  private var active = false
  /// Whether this engine has touched its input node, so it records whenever it runs.
  private var touched = false
  private var tapped = false
  private var capture: Capture?
  private var captures: [String: Capture] = [:]
  private var pendingPresses: [[String: Any]] = []
  private var connected = false
  private var listening = false
  /// From a press that starts a dictation until yapd answers it, and while yapd says he's dictating on this phone: the microphone is open only then.
  private var pressed = false
  private var dictation = false
  /// Presses so far, so an unanswered one closing the microphone leaves a later one's alone.
  private var presses = 0
  /// How long a press waits for yapd to start dictating, which it does at once unless it's off.
  private static let unanswered: TimeInterval = 5
  /// What yapd sent to play, by its id, in a folder of its own.
  private var files: [String: URL] = [:]
  private let folder: URL

  init() {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("yapd-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    build()
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
      case "capture-start": self.startCapture(message)
      case "capture-finish": self.endCapture(message, cancel: false)
      case "capture-cancel": self.endCapture(message, cancel: true)
      case "stream-start": self.startStream(message)
      case "stream-chunk": self.chunkStream(message)
      case "stream-end": self.endStream(message)
      case "stream-cancel": self.cancelStream(message)
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

  /// A button stops output locally before its network event reaches the server.
  func stopLocally() {
    queue.async { self.stop() }
  }

  private func makeCapture() -> Capture {
    let id = UUID().uuidString
    return Capture(id: id, send: { [weak self] frame in self?.hear(frame) }, modern: { [weak self] frame, sequence in
      self?.tell(["type": "capture-frame", "id": id, "sequence": sequence, "encoding": "pcm16le", "audio": Data(frame.dropFirst()).base64EncodedString()])
    })
  }

  /// Owns pending presses locally, before a round trip can update the screen.
  func press() {
    queue.async {
      if self.pressed || self.dictation {
        let id = self.capture?.id
        if let capture = self.capture { _ = capture.finish() }
        self.pressed = false; self.dictation = false
        self.closeMicrophone(announceRested: false)
        self.enqueuePress(["type": "pressed", "key": "shortcut", "onPause": false, "captureId": id ?? ""])
      } else {
        self.stop(silently: true); self.halt()
        let capture = self.makeCapture()
        self.capture = capture; self.captures[capture.id] = capture
        if self.captures.count > 8, let old = self.captures.keys.first(where: { $0 != capture.id }) { self.captures.removeValue(forKey: old) }
        self.pressed = true; self.presses += 1
        self.openMicrophone()
        self.enqueuePress(["type": "pressed", "key": "shortcut", "onPause": false, "captureId": capture.id])
      }
    }
  }

  func cancelPress() {
    queue.async {
      let recording = self.pressed || self.dictation
      let id = self.capture?.id
      self.capture?.cancel()
      self.pressed = false; self.dictation = false
      self.closeMicrophone(announceRested: false); self.stop()
      var event: [String: Any] = ["type": "pressed", "key": recording ? "escape" : "stop"]
      if let id { event["captureId"] = id }
      self.enqueuePress(event)
    }
  }

  private func enqueuePress(_ event: [String: Any]) {
    guard pendingPresses.count < 16 else { closeMicrophone(); tell(["type": "error", "message": "Too many pending capture presses"]); return }
    pendingPresses.append(event)
    if connected { for event in pendingPresses { tell(event) }; pendingPresses.removeAll() }
  }

  private func startCapture(_ message: [String: Any]) {
    guard let id = message["id"] as? String else { return }
    guard let selected = captures[id] else { tell(["type": "capture-error", "id": id, "message": "That physical capture is no longer available"]); return }
    if !selected.begin({ self.tell(["type": "capture-ready", "id": id]) }) {
      endCapture(message, cancel: true)
      tell(["type": "capture-error", "id": id, "message": "The bounded pre-start capture buffer overflowed or conversion failed"])
    }
  }

  private func endCapture(_ message: [String: Any], cancel: Bool) {
    guard let id = message["id"] as? String else { return }
    guard let selected = captures[id] else { tell(["type": "capture-error", "id": id, "message": "That physical capture is no longer available"]); return }
    let complete: Bool
    if cancel { selected.cancel(); complete = true } else { complete = selected.finish() }
    if capture === selected {
      pressed = false; dictation = false; closeMicrophone(announceRested: false)
      capture = nil
    }
    tell(complete ? ["type": "capture-finished", "id": id] : ["type": "capture-error", "id": id, "message": "Capture conversion or buffering failed; nothing was sent"])
  }

  /// Opens the microphone now, as a press that starts a dictation does, before yapd's first sound, so it's recording while the press is still being handled.
  func open() {
    queue.async {
      self.pressed = true
      self.presses += 1
      self.openMicrophone()
    }
  }

  /// The press reached yapd: should it start no dictation, as while yapd is off, the microphone closes again before long.
  func sent() {
    queue.async {
      self.connected = true
      for event in self.pendingPresses { self.tell(event) }; self.pendingPresses.removeAll()
      let press = self.presses
      self.queue.asyncAfter(deadline: .now() + Speaker.unanswered) {
        guard self.presses == press, self.pressed, !self.dictation else { return }
        self.pressed = false
        self.closeMicrophone()
      }
    }
  }

  /**
   * Whether he's dictating, as yapd says to every device, from the press that
   * starts it until it's sent or dropped. For a dictation pressed for here, the
   * microphone stays open all that while, and opens again with the next line
   * should yapd rest it, as it does once it has stopped what it was saying.
   * One started on a Mac leaves it closed. Once it's over, yapd rests it.
   */
  func dictating(_ on: Bool, captureId: String? = nil, cancelled: Bool = false) {
    queue.async {
      if let captureId, captureId != self.capture?.id { return }
      if cancelled {
        self.capture?.cancel()
        self.pressed = false; self.dictation = false
        self.closeMicrophone(announceRested: false)
        return
      }
      self.dictation = on && (self.pressed || self.dictation)
      self.pressed = false
      if self.dictation { self.openMicrophone() }
    }
  }

  /// Says again whether the microphone is open, for a connection that came up once it already was.
  func announce() {
    queue.async {
      self.connected = true
      for event in self.pendingPresses { self.tell(event) }; self.pendingPresses.removeAll()
      if self.engine.isRunning { self.tell(["type": "active", "listening": self.listening]) }
    }
  }

  /// Stops and closes everything, as the connection to yapd goes, and lets go of the audio session.
  func close() {
    queue.async {
      self.stop(silently: true)
      self.active = false
      self.connected = false
      self.capture?.cancel(); self.capture = nil; self.captures.removeAll(); self.pendingPresses.removeAll()
      self.pressed = false
      self.dictation = false
      self.halt()
      for url in self.files.values { try? FileManager.default.removeItem(at: url) }
      self.files = [:]
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  /// Whether it's playing, or its engine is running, which keeps the app awake.
  var busy: Bool { queue.sync { playing != nil || streaming != nil || engine.isRunning } }

  /// A new engine, its input untouched, to play through: the player goes with it.
  private func build() {
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
    engine.stop()
    if let changes { NotificationCenter.default.removeObserver(changes) }
    engine = AVAudioEngine()
    player = AVAudioPlayerNode()
    touched = false
    engine.attach(player)
    // Connecting the mixer also creates the output node, which the engine needs before it can start.
    engine.connect(player, to: engine.mainMixerNode, format: AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1))
    changes = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) {
      [weak self] _ in self?.queue.async { self?.recover() }
    }
  }

  /// Whether the microphone is to be open: for a dictation, with permission, since touching the input node at all opens it.
  private var hearing: Bool { (pressed || dictation) && AVAudioApplication.shared.recordPermission == .granted }

  /// Opens the microphone, starting the engine again should it be playing without it, carrying on with what it plays.
  private func openMicrophone() {
    do {
      if !engine.isRunning {
        try activate()
      } else if touched != hearing {
        try restart()
      }
    } catch {
      tell(["type": "error", "message": "Could not start the audio: \(error)"])
    }
  }

  /// Closes the microphone, with nothing dictated: carrying on with what it plays without it, or resting, as yapd hears.
  private func closeMicrophone(announceRested: Bool = true) {
    guard engine.isRunning, touched else { return }
    guard playing == nil else {
      do { try restart() } catch { tell(["type": "error", "message": "Could not restart audio: \(error)"]) }
      return
    }
    active = false
    halt()
    // Keep already delivered legacy frames available until its Sent is consumed.
    // Physical input is off either way; active(false) does not destroy that queue.
    tell(announceRested ? ["type": "rested"] : ["type": "active", "listening": false])
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func session(_ hearing: Bool) throws {
    let session = AVAudioSession.sharedInstance()
    if hearing {
      // Voice chat is what turns on the echo cancellation, and the speaker rather than the earpiece, unless headphones are in.
      try session.setCategory(.playAndRecord, mode: Speaker.raw ? .default : .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
    } else {
      // Only playing, which records nothing, not even through headphones, and plays through them at their best.
      try session.setCategory(.playback, mode: .default, options: [.duckOthers])
    }
    try session.setActive(true)
  }

  private func activate() throws {
    active = true
    guard !engine.isRunning else { return }
    let hearing = hearing
    if touched != hearing { build() }
    try session(hearing)
    var heard = hearing
    if hearing {
      do {
        try listen()
      } catch {
        tell(["type": "error", "message": "Could not open the microphone: \(error)"])
        heard = false
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
    listening = heard
    tell(["type": "active", "listening": heard])
    report()
  }

  private func listen() throws {
    touched = true
    let input = engine.inputNode
    let usable = { (format: AVAudioFormat) in format.channelCount > 0 && format.sampleRate > 0 }
    guard usable(input.inputFormat(forBus: 0)) else { throw POSIXError(.ENODEV) }
    if !input.isVoiceProcessingEnabled && !Speaker.raw { try input.setVoiceProcessingEnabled(true) }
    guard !tapped else { return }
    let format = input.outputFormat(forBus: 0)
    guard usable(format) else { throw POSIXError(.ENODEV) }
    let capture = self.capture ?? makeCapture()
    self.capture = capture
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in capture.push(buffer) }
    tapped = true
  }

  /**
   * Stops the engine, which turns the microphone off until the next line, and
   * lets other apps' audio back up. A press yapd hasn't answered yet stays
   * pending, since this may have been sent before it: yapd starting that
   * dictation opens the microphone again, and not starting it lets it go.
   */
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
    if streaming != nil { failStream("Something else took the audio") }
    let current = playing
    playing = nil
    player.stop()
    halt()
    tell(["type": "rested"])
    if let current { tell(["type": "failed", "id": current.id, "message": "Something else took the audio"]) }
  }
  /// A PCM stream is never a collection of replacing WAV play commands.
  private func startStream(_ message: [String: Any]) {
    guard let id = message["id"] as? String, let generation = message["generation"] as? Int else {
      tell(["type": "error", "message": "An audio stream needs an ID and generation"])
      return
    }
    guard !id.isEmpty, id.utf8.count <= 100, generation >= 0,
      let rate = message["rate"] as? Int, [16000, 24000, 48000].contains(rate),
      message["format"] as? String == "pcm16le", message["channels"] as? Int == 1
    else { return streamError(id: id, generation: generation, message: "Unsupported PCM stream format") }
    guard !hearing else {
      return streamError(id: id, generation: generation, message: "The phone is still recording; end capture before playback")
    }
    do {
      // An engine whose input was touched keeps recording even when no tap is
      // installed. Rebuild it before playback, preserving PR59's physical release.
      if touched {
        stop(silently: true)
        halt()
        build()
      }
      try activate()
      stop(silently: true)
      let format = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1)!
      if player.outputFormat(forBus: 0) != format {
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
      }
      guard rendering() else {
        rest()
        return streamError(id: id, generation: generation, message: "The audio engine is not rendering")
      }
      let stream = Streaming(id: id, generation: generation, rate: rate)
      streaming = stream
      streamReport("stream-ready", stream, samples: 0, certainty: "rendered")
      report()
    } catch {
      rest()
      streamError(id: id, generation: generation, message: "Could not start streamed audio: \(error)")
    }
  }

  private func chunkStream(_ message: [String: Any]) {
    guard let stream = streaming,
      message["id"] as? String == stream.id, message["generation"] as? Int == stream.generation
    else { return } // Chunks from stopped/disconnected generations never start playback.
    let pcm = (message["pcm"] as? Data) ?? (message["audio"] as? String).flatMap { Data(base64Encoded: $0) }
    guard !stream.ended, message["sequence"] as? Int == stream.sequence,
      let pcm, !pcm.isEmpty, pcm.count <= 32768, pcm.count % 2 == 0
    else { return failStream("Invalid or out-of-order PCM stream chunk") }
    let count = pcm.count / 2
    guard stream.scheduled - stream.rendered + count <= stream.rate * 4 else {
      return failStream("The bounded PCM playback buffer overflowed")
    }
    let format = AVAudioFormat(standardFormatWithSampleRate: Double(stream.rate), channels: 1)!
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
      let samples = buffer.floatChannelData?[0]
    else { return failStream("Could not allocate a PCM playback chunk") }
    buffer.frameLength = AVAudioFrameCount(count)
    pcm.withUnsafeBytes { raw in
      let bytes = raw.bindMemory(to: UInt8.self)
      for i in 0..<count {
        let word = UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8
        samples[i] = Float(Int16(bitPattern: word)) / 32768
      }
    }
    stream.sequence += 1
    stream.scheduled += count
    let through = stream.scheduled
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self, weak stream] _ in
      guard let self, let stream else { return }
      self.queue.async {
        guard self.streaming === stream else { return }
        stream.rendered = max(stream.rendered, through)
        self.streamReport("stream-progress", stream, samples: stream.rendered, certainty: "rendered")
        if stream.ended && stream.rendered == stream.scheduled { self.finishStream(stream) }
      }
    }
    if !stream.began {
      stream.began = true
      player.volume = 1
      player.play()
      streamReport("stream-playing", stream, samples: stream.rendered, certainty: "rendered")
      report()
    }
  }

  private func endStream(_ message: [String: Any]) {
    guard let stream = streaming,
      message["id"] as? String == stream.id, message["generation"] as? Int == stream.generation
    else { return }
    guard message["sequence"] as? Int == stream.sequence else { return failStream("The stream ended with missing chunks") }
    stream.ended = true
    if stream.rendered == stream.scheduled { finishStream(stream) }
  }

  private func cancelStream(_ message: [String: Any]) {
    guard let stream = streaming,
      message["id"] as? String == stream.id, message["generation"] as? Int == stream.generation
    else { return }
    stopStream()
  }

  private func streamReport(_ type: String, _ stream: Streaming, samples: Int, certainty: String) {
    tell(["type": type, "id": stream.id, "generation": stream.generation, "rate": stream.rate, "samples": samples, "certainty": certainty])
  }

  private func streamError(id: String, generation: Int, message: String) {
    tell(["type": "stream-error", "id": id, "generation": generation, "message": message])
  }

  private func failStream(_ message: String) {
    guard let stream = streaming else { return }
    streaming = nil
    player.stop()
    streamError(id: stream.id, generation: stream.generation, message: message)
    report()
  }

  private func finishStream(_ stream: Streaming) {
    guard streaming === stream else { return }
    streaming = nil
    player.stop()
    streamReport("stream-finished", stream, samples: stream.rendered, certainty: "rendered")
    report()
  }

  private func stopStream() {
    guard let stream = streaming else { return }
    // Completed dataPlayedBack callbacks establish a lower bound. Node time can
    // include output still in flight, so a finer stopped position is estimated.
    var samples = stream.rendered
    var certainty = "rendered"
    if let now = player.lastRenderTime, now.isSampleTimeValid, let time = player.playerTime(forNodeTime: now) {
      samples = max(samples, min(stream.scheduled, Int(max(0, time.sampleTime))))
      certainty = "estimated"
    }
    streaming = nil
    player.stop()
    streamReport("stream-stopped", stream, samples: samples, certainty: certainty)
    report()
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
    stopStream()
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
    if streaming != nil { failStream("The audio device changed during streaming") }
    do {
      try restart()
    } catch {
      tell(["type": "error", "message": "Could not restart audio: \(error)"])
    }
  }

  /// Starts the engine again, with the microphone or without it as it's wanted now, carrying on with what it played from where it got to.
  private func restart() throws {
    let current = playing
    let at = current.map(position)
    playing = nil
    player.stop()
    halt()
    if let current, let at {
      play(id: current.id, url: current.file.url, from: at)
      return
    }
    try activate()
  }

  private func report() {
    let state = (playing != nil || streaming?.began == true, listening)
    DispatchQueue.main.async { self.changed(state.0, state.1) }
  }
}
