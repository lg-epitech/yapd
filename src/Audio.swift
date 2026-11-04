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
  private let pendingLock = NSLock()
  private var pendingBytes = 0

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
    pendingLock.lock()
    guard pendingBytes + message.count <= 2 * 1024 * 1024 else {
      pendingLock.unlock(); log("The bounded audio connection buffer overflowed"); exit(1)
    }
    pendingBytes += message.count
    pendingLock.unlock()
    writes.async { [self] in
      defer { pendingLock.lock(); pendingBytes -= message.count; pendingLock.unlock() }
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
  let id: String
  private let send: (Data) -> Void
  private var modern: (Data, Int) -> Void
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
    let frame = samples.withUnsafeBufferPointer { Data(buffer: $0) }
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

  /// Switch views while keeping the converter, pending samples and AEC tap intact.
  func route(_ output: @escaping (Data, Int) -> Void, ready: () -> Void) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard !ended else { return false }
    modern = output; armed = true; sequence = 0; before.removeAll(); overflow = false
    ready()
    return true
  }

  func unroute() {
    lock.lock(); defer { lock.unlock() }
    armed = false; sequence = 0; before.removeAll(); overflow = false
    modern = { [send] frame, _ in send(frame) }
  }

  var finished: Bool { lock.lock(); defer { lock.unlock() }; return ended }

  func cancel() {
    lock.lock(); defer { lock.unlock() }
    ended = true; pending.removeAll(); before.removeAll()
  }
}

/// A recording is an exact view of the continuously processed Mac input clock.
final class RollingInput {
  let id: String
  private let lock = NSRecursiveLock()
  private let emit: (String, String, Int, Data?) -> Void
  private var recent: [(Int, Data)] = []
  private var sequence = 0
  private var stopped = false
  private var recording: (id: String, sequence: Int)?
  private var ended: [String] = []

  init(id: String, emit: @escaping (String, String, Int, Data?) -> Void) { self.id = id; self.emit = emit }

  func push(_ frame: Data) {
    lock.lock(); defer { lock.unlock() }
    guard !stopped else { return }
    recent.append((sequence, frame))
    if recent.count > 128 { recent.removeFirst() }
    emit("listen-frame", id, sequence, frame)
    sequence += 1
    if var record = recording {
      emit("capture-frame", record.id, record.sequence, frame)
      record.sequence += 1; recording = record
    }
  }

  func promote(id: String, fromSequence: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard !stopped, recording == nil, !ended.contains(id), fromSequence >= (recent.first?.0 ?? sequence), fromSequence <= sequence else { return false }
    recording = (id, 0)
    emit("capture-ready", id, 0, nil)
    for (at, frame) in recent where at >= fromSequence {
      emit("capture-frame", id, recording!.sequence, frame)
      recording!.sequence += 1
    }
    return true
  }

  func owns(_ id: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return recording?.id == id || ended.contains(id)
  }

  /// The marker follows every frame in this segment, without stopping the AEC clock.
  func seal(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    if recording?.id == id {
      recording = nil; ended.append(id)
      if ended.count > 8 { ended.removeFirst() }
    }
    guard ended.contains(id) else { return }
    emit("capture-finished", id, 0, nil)
  }

  func stop() {
    lock.lock(); defer { lock.unlock() }
    guard !stopped else { return }
    stopped = true
    if let record = recording { emit("capture-error", record.id, 0, nil) }
    recording = nil
    emit("listen-finished", id, 0, nil)
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
  /// Whether the daemon wants the engine running, which a device change doesn't alter.
  private var active = false
  private var tapped = false
  private var capture: Capture?
  private var captures: [String: Capture] = [:]
  private var dictating = false
  private var rolling: RollingInput?
  private var processing = false

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
    case "listen-start": startListening(message)
    case "listen-cancel": stopListening(message)
    case "capture-promote": promoteCapture(message)
    case "capture-start": startCapture(message)
    case "capture-finish": endCapture(message, cancel: false)
    case "capture-cancel": endCapture(message, cancel: true)
    case "escape":
      if let id = message["captureId"] as? String, id != capture?.id { return }
      if message["cancelled"] as? Bool == true {
        capture?.cancel(); dictating = false
        restIfIdle()
        return
      }
      let on = message["on"] as? Bool ?? false
      if on && capture?.finished == true { return }
      dictating = on
    case "stream-start": startStream(message)
    case "stream-chunk": chunkStream(message)
    case "stream-end": endStream(message)
    case "stream-cancel": cancelStream(message)
    case "play":
      guard let id = message["id"] as? String, let path = message["path"] as? String else { return }
      play(id: id, path: path, from: message["from"] as? Double ?? 0)
    case "stop": stop()
    case "volume": player.volume = Float(message["value"] as? Double ?? 1)
    case "rest": rest()
    default: log("unknown message \(message)")
    }
  }

  private func makeCapture() -> Capture {
    let id = UUID().uuidString
    return Capture(id: id, send: { [link] frame in link.send(.pcm, frame) }, modern: { [link] frame, sequence in
      link.send(["type": "capture-frame", "id": id, "sequence": sequence, "encoding": "f32le", "audio": frame.base64EncodedString()])
    })
  }

  private func startListening(_ message: [String: Any]) {
    guard let id = message["id"] as? String else { return }
    guard rolling == nil, !dictating else { link.send(["type": "listen-error", "id": id, "message": "The Mac input already has an owner"]); return }
    do {
      try activate()
      guard let capture else { link.send(["type": "listen-error", "id": id, "message": "The Mac microphone is unavailable"]); return }
      let rolling = RollingInput(id: id, emit: { [link] type, id, sequence, frame in
        if let frame { link.send(["type": type, "id": id, "sequence": sequence, "encoding": "f32le", "audio": frame.base64EncodedString()]) }
        else { link.send(["type": type, "id": id, "message": "Listening ended before the recording was sealed"]) }
      })
      self.rolling = rolling
      if !capture.route({ frame, _ in rolling.push(frame) }, ready: { self.link.send(["type": "listen-ready", "id": id]) }) {
        self.rolling = nil; link.send(["type": "listen-error", "id": id, "message": "The Mac input capture has already ended"])
      }
    } catch { link.send(["type": "listen-error", "id": id, "message": "Could not start the Mac microphone"]) }
  }

  private func stopListening(_ message: [String: Any]) {
    guard let id = message["id"] as? String else { return }
    if rolling?.id == id { rolling?.stop(); rolling = nil; capture?.unroute(); restIfIdle() }
    else { link.send(["type": "listen-finished", "id": id]) }
  }

  private func promoteCapture(_ message: [String: Any]) {
    guard let id = message["id"] as? String else { return }
    guard let rolling, message["listenerId"] as? String == rolling.id,
      let from = message["fromSequence"] as? Int, rolling.promote(id: id, fromSequence: from)
    else { link.send(["type": "capture-error", "id": id, "message": "The exact listening prefix is unavailable or another capture owns it"]); return }
  }

  func pressed(_ key: String) {
    if let rolling { rolling.stop(); self.rolling = nil; capture?.unroute() }

    if key == "shortcut" && !dictating {
      stop(silently: true); halt()
      let capture = makeCapture()
      self.capture = capture; captures[capture.id] = capture; dictating = true
      if captures.count > 8, let old = captures.keys.first(where: { $0 != capture.id }) { captures.removeValue(forKey: old) }
      do { try activate() } catch { link.send(["type": "error", "message": "Could not open the microphone"]) }
      link.send(["type": "pressed", "key": key, "captureId": capture.id])
    } else {
      let id = capture?.id
      if key == "escape" { capture?.cancel() } else { _ = capture?.finish() }
      dictating = false; active = false; halt()
      var event: [String: Any] = ["type": "pressed", "key": key]
      if let id { event["captureId"] = id }
      link.send(event)
    }
  }

  private func startCapture(_ message: [String: Any]) {
    guard let id = message["id"] as? String else { return }
    guard let selected = captures[id] else { link.send(["type": "capture-error", "id": id, "message": "That physical capture is no longer available"]); return }
    if !selected.begin({ self.link.send(["type": "capture-ready", "id": id]) }) {
      endCapture(message, cancel: true)
      link.send(["type": "capture-error", "id": id, "message": "The bounded pre-start capture buffer overflowed or conversion failed"])
    }
  }

  private func endCapture(_ message: [String: Any], cancel: Bool) {
    guard let id = message["id"] as? String else { return }
    if rolling?.owns(id) == true { rolling?.seal(id); return }
    guard let selected = captures[id] else { link.send(["type": "capture-error", "id": id, "message": "That physical capture is no longer available"]); return }
    let complete: Bool
    if cancel { selected.cancel(); complete = true } else { complete = selected.finish() }
    if capture === selected { dictating = false; active = false; halt(); capture = nil }
    link.send(complete ? ["type": "capture-finished", "id": id] : ["type": "capture-error", "id": id, "message": "Capture conversion or buffering failed; nothing was sent"])
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
    do {
      try engine.start()
    } catch {
      // Its microphone may still have been on from before, as after a device change: it's off now, and yapd is told so.
      halt()
      link.send(["type": "rested"])
      throw error
    }
    link.send(["type": "active", "listening": listening])
  }

  private func listen() throws {
    let input = engine.inputNode
    // A Mac without a microphone has an empty format, and tapping it raises an exception Swift can't catch.
    let usable = { (format: AVAudioFormat) in format.channelCount > 0 && format.sampleRate > 0 }
    guard usable(input.inputFormat(forBus: 0)) else { throw POSIXError(.ENODEV) }
    if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
    processing = true
    if #available(macOS 14.0, *) {
      // Voice processing ducks other apps' audio hard by default.
      input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: true, duckingLevel: .min)
    }
    guard !tapped else { return }
    let format = input.outputFormat(forBus: 0)
    guard usable(format) else { throw POSIXError(.ENODEV) }
    let capture = self.capture ?? makeCapture()
    self.capture = capture
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
    if let rolling { rolling.stop(); self.rolling = nil; capture?.unroute() }
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
    engine.stop()
    // Stopping leaves other apps ducked by however much it last ducked them, until voice processing is off.
    if processing {
      try? engine.inputNode.setVoiceProcessingEnabled(false)
      processing = false
    }
  }

  /// A late old listener/stream must never stop a newer recording or output.
  private func restIfIdle() {
    guard rolling == nil, !dictating, streaming == nil, playing == nil else { return }
    active = false
    halt()
    capture = nil
    link.send(["type": "rested"])
  }
  /// A PCM stream is never a collection of replacing WAV play commands.
  private func startStream(_ message: [String: Any]) {
    guard let id = message["id"] as? String, let generation = message["generation"] as? Int else {
      link.send(["type": "error", "message": "An audio stream needs an ID and generation"])
      return
    }
    guard !id.isEmpty, id.utf8.count <= 100, generation >= 0,
      let rate = message["rate"] as? Int, [16000, 24000, 48000].contains(rate),
      message["format"] as? String == "pcm16le", message["channels"] as? Int == 1
    else { return streamError(id: id, generation: generation, message: "Unsupported PCM stream format") }

    do {
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
    restIfIdle()
  }

  private func streamReport(_ type: String, _ stream: Streaming, samples: Int, certainty: String) {
    link.send(["type": type, "id": stream.id, "generation": stream.generation, "rate": stream.rate, "samples": samples, "certainty": certainty])
  }

  private func streamError(id: String, generation: Int, message: String) {
    link.send(["type": "stream-error", "id": id, "generation": generation, "message": message])
  }

  private func failStream(_ message: String) {
    guard let stream = streaming else { return }
    streaming = nil
    player.stop()
    streamError(id: stream.id, generation: stream.generation, message: message)
    restIfIdle()
  }

  private func finishStream(_ stream: Streaming) {
    guard streaming === stream else { return }
    streaming = nil
    player.stop()
    streamReport("stream-finished", stream, samples: stream.rendered, certainty: "rendered")
    restIfIdle()
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
      // The player waits five seconds for an engine that doesn't render, then raises an exception Swift can't catch.
      // Voice processing sometimes starts like that, so it rests instead, to start afresh with the next update.
      guard rendering() else {
        rest()
        // Starting said the microphone was on, so it says resting turned it off, before the daemon hears the playback failed.
        link.send(["type": "rested"])
        return link.send(["type": "failed", "id": id, "message": "The audio engine started but didn't play anything"])
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
    stopStream()
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
    if streaming != nil { failStream("The audio device changed during streaming") }
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
  private let onPress: (String) -> Void
  private var shortcut: EventHotKeyRef?
  private var escape: EventHotKeyRef?

  init(link: Link, onPress: @escaping (String) -> Void) {
    self.link = link
    self.onPress = onPress
    var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, event, context in
        var id = EventHotKeyID()
        GetEventParameter(
          event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
          MemoryLayout<EventHotKeyID>.size, nil, &id)
        let hotkeys = Unmanaged<Hotkeys>.fromOpaque(context!).takeUnretainedValue()
        hotkeys.onPress(id.id == Hotkeys.escapeID ? "escape" : "shortcut")
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
link.send(["type": "hello", "permission": Audio.permission, "streaming": true, "captureBoundary": true, "handsFree": wantsMicrophone])
if wantsMicrophone && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
  AVCaptureDevice.requestAccess(for: .audio) { _ in link.send(["type": "permission", "permission": Audio.permission]) }
}
let hotkeys = Hotkeys(link: link, onPress: { key in audio.queue.async { audio.pressed(key) } })
link.receive { message in
  switch message["type"] as? String {
  case "shortcut", "escape":
    DispatchQueue.main.async { hotkeys.handle(message) }
    if message["type"] as? String == "escape" { audio.queue.async { audio.handle(message) } }
  default: audio.queue.async { audio.handle(message) }
  }
}
// Hotkeys come in through the app's event loop, which runs the main queue too.
NSApplication.shared.run()
