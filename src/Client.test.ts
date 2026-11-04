import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Client from "./Client.ts"
import * as Home from "./Home.ts"
import * as Wire from "./Wire.ts"

describe("Client", () => {
  test.skipIf(process.platform !== "darwin" || Bun.which("swiftc") === null)("the real Mac audio lifecycle rests idle input and preserves newer owners on late completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yapd-native-lifecycle-"))
    try {
      const source = await Bun.file(join(import.meta.dir, "Audio.swift")).text()
      const classes = source.slice(source.indexOf("final class Capture {"), source.indexOf("\nfinal class Hotkeys {"))
      const swift = join(directory, "main.swift"), binary = join(directory, "check")
      await Bun.write(swift, `import AVFoundation\nimport Foundation\nfunc log(_ message: String) {}\nfinal class Link { enum Kind { case pcm }; var events: [[String: Any]] = []; func send(_ value: [String: Any]) { events.append(value) }; func send(_ kind: Kind, _ data: Data) {} }\n` + classes + `
extension Audio {
  func checkOwnership() {
    let first = Streaming(id: "first", generation: 1, rate: 24000)
    active = true; streaming = first; finishStream(first)
    precondition(!active && !tapped && capture == nil)
    let listener = RollingInput(id: "listener", emit: { _,_,_,_ in })
    rolling = listener; active = true
    let second = Streaming(id: "second", generation: 2, rate: 24000)
    streaming = second; finishStream(second)
    precondition(active && rolling === listener)
    stopListening(["id": "listener"])
    precondition(!active && rolling == nil)
    let pending = makeCapture(); capture = pending; dictating = true; active = true
    stopListening(["id": "stale-listener"])
    precondition(active && dictating && capture === pending)
    handle(["type": "escape", "on": false, "captureId": pending.id, "cancelled": true])
    precondition(!active && !dictating && capture == nil)
    let newest = Streaming(id: "newest", generation: 3, rate: 24000)
    streaming = newest; active = true; finishStream(second)
    precondition(streaming === newest && active)
    streaming = nil; restIfIdle()
    precondition(!active)
  }
}
let link = Link(); let audio = Audio(link: link, wantsMicrophone: false)
audio.queue.sync { audio.checkOwnership() }
precondition(link.events.filter { $0["type"] as? String == "rested" }.count == 4)
print("Native ownership passed.")
`)
      const compile = Bun.spawn(["nice", "-n", "15", "swiftc", "-o", binary, swift], { stdout: "pipe", stderr: "pipe" })
      const errors = await new Response(compile.stderr).text()
      expect(await compile.exited, errors).toBe(0)
      const ran = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
      const output = await new Response(ran.stdout).text(), failure = await new Response(ran.stderr).text()
      expect(await ran.exited, failure).toBe(0)
      expect(output).toBe("Native ownership passed.\n")
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30_000)
  test.skipIf(process.platform !== "darwin" || Bun.which("swiftc") === null)("the native rolling input promotes exact pre-roll, keeps its AEC clock across sealed captures and rejects evicted prefixes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yapd-rolling-native-"))
    try {
      const source = await Bun.file(join(import.meta.dir, "Audio.swift")).text()
      const start = source.indexOf("final class RollingInput {")
      const end = source.indexOf("\nfinal class Audio {", start)
      const check = `
var events: [(String, String, Int, Data?)] = []
let rolling = RollingInput(id: "live", emit: { events.append(($0, $1, $2, $3)) })
for i in 0..<4 { rolling.push(Data([UInt8(i)])) }
precondition(rolling.promote(id: "first", fromSequence: 1))
let replay = events.filter { $0.0 == "capture-frame" && $0.1 == "first" }
precondition(replay.map { $0.2 } == [0, 1, 2] && replay.map { $0.3! } == [Data([1]), Data([2]), Data([3])])
rolling.push(Data([4])); rolling.seal("first"); rolling.push(Data([5]))
precondition(rolling.promote(id: "second", fromSequence: 4))
rolling.seal("first") // A late old boundary cannot seal the newer recording.
rolling.push(Data([6]))
precondition(events.last!.0 == "capture-frame" && events.last!.1 == "second" && events.last!.2 == 2)
rolling.seal("second")
precondition(events.filter { $0.0 == "listen-frame" }.map { $0.2 } == [0, 1, 2, 3, 4, 5, 6])
for _ in 0..<140 { rolling.push(Data([0])) }
precondition(!rolling.promote(id: "evicted", fromSequence: 0))
rolling.stop(); let count = events.count; rolling.push(Data([9])); precondition(events.count == count)
print("Rolling promotion passed.")
`
      const swift = join(directory, "main.swift"), binary = join(directory, "check")
      await Bun.write(swift, "import Foundation\n" + source.slice(start, end) + check)
      const compile = Bun.spawn(["nice", "-n", "15", "swiftc", "-o", binary, swift], { stdout: "pipe", stderr: "pipe" })
      const errors = await new Response(compile.stderr).text()
      expect(await compile.exited, errors).toBe(0)
      const ran = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
      expect(await new Response(ran.stdout).text()).toBe("Rolling promotion passed.\n")
      expect(await ran.exited).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30_000)

  test.skipIf(process.platform !== "darwin" || Bun.which("swiftc") === null)("both real native converters preserve a pending capture and its final partial frame, and reject pre-start overflow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yapd-native-capture-"))
    try {
      for (const [name, path, pcm16] of [["phone", "../ios/yapd/Speaker.swift", true], ["mac", "Audio.swift", false]] as const) {
        const source = await Bun.file(join(import.meta.dir, path)).text()
        const start = source.indexOf("final class Capture {")
        const end = source.indexOf("\nfinal class ", start + 20)
        const decode = pcm16 ? `let bytes = [UInt8](frame.dropFirst())
  for i in stride(from: 0, to: bytes.count, by: 2) { values.append(Float(Int16(bitPattern: UInt16(bytes[i]) | UInt16(bytes[i+1]) << 8)) / 32767) }` : `frame.withUnsafeBytes { bytes in
    for i in stride(from: 0, to: bytes.count, by: 4) { values.append(bytes.loadUnaligned(fromByteOffset: i, as: Float.self)) }
  }`
        const check = `
var delivered: [Data] = []
let input = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!, frameCapacity: 600)!
input.frameLength = 600
for i in 0..<600 { input.floatChannelData![0][i] = i == 599 ? -0.75 : 0.25 }
let capture = Capture(id: "physical", send: { delivered.append($0) })
capture.push(input)
let legacy = delivered
var readyAt = -1
precondition(capture.begin { readyAt = delivered.count })
precondition(readyAt == legacy.count && Array(delivered.dropFirst(readyAt)) == legacy)
precondition(capture.finish() && capture.finished)
var values: [Float] = []
for frame in delivered.dropFirst(readyAt) { ${decode} }
precondition(values.count >= 600 && values.count % 512 == 0 && abs(values[599] + 0.75) < 0.001)
let after = delivered.count
capture.push(input); precondition(capture.finish() && delivered.count == after)
var pendingFrames: [Data] = []
let pending = Capture(id: "pending", send: { pendingFrames.append($0) })
pending.push(input); precondition(pending.finish())
let all = pendingFrames
precondition(pending.begin {} && Array(pendingFrames.dropFirst(all.count)) == all)
let cancelled = Capture(id: "cancelled", send: { _ in })
cancelled.push(input); cancelled.cancel(); precondition(cancelled.finished && cancelled.begin {})
let overflow = Capture(id: "overflow", send: { _ in })
for _ in 0..<514 { overflow.push(input) }
precondition(!overflow.begin {})
print("Capture boundaries passed.")
`
        const swift = join(directory, `${name}.swift`), binary = join(directory, name)
        await Bun.write(swift, "import AVFoundation\nimport Foundation\n" + source.slice(start, end) + check)
        const compile = Bun.spawn(["nice", "-n", "15", "swiftc", "-o", binary, swift], { stdout: "pipe", stderr: "pipe" })
        const errors = await new Response(compile.stderr).text()
        expect(await compile.exited, errors).toBe(0)
        const ran = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
        expect(await new Response(ran.stdout).text()).toBe("Capture boundaries passed.\n")
        expect(await ran.exited).toBe(0)
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30_000)

  test.skipIf(process.platform !== "darwin" || Bun.which("swiftc") === null)("the real phone connection decodes bounded PCM stream frames and keeps legacy files separate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yapd-stream-phone-"))
    try {
      const pcm = new Uint8Array([0, 128, 255, 127])
      const valid = Wire.stream({ id: "voice", generation: 4, sequence: 3, pcm })
      const file = Wire.file("old-file", pcm)
      const encoded = (frame: Uint8Array) => `Data(base64Encoded: "${Buffer.from(frame).toString("base64")}")!`
      const source = await Bun.file(join(import.meta.dir, "..", "ios", "yapd", "Connection.swift")).text()
      const check = `
extension Connection {
  func checkFrame(_ data: Data) { read(data) }
}
let connection = Connection()
var chunks = 0
var files = 0
connection.heard = { message in
  precondition(message["type"] as? String == "stream-chunk")
  precondition(message["id"] as? String == "voice")
  precondition(message["generation"] as? Int == 4)
  precondition(message["sequence"] as? Int == 3)
  precondition(message["pcm"] as? Data == Data([0, 128, 255, 127]))
  chunks += 1
}
connection.file = { id, data in
  precondition(id == "old-file")
  precondition(data == Data([0, 128, 255, 127]))
  files += 1
}
connection.checkFrame(${encoded(valid)})
connection.checkFrame(${encoded(valid.subarray(0, valid.length - 1))})
connection.checkFrame(${encoded(new Uint8Array([4, 255, 255, 255, 255]))})
connection.checkFrame(${encoded(file)})
precondition(chunks == 1 && files == 1)
print("Phone PCM framing passed.")
`
      const swift = join(directory, "main.swift")
      const binary = join(directory, "checks")
      await Bun.write(swift, source + check)
      const compile = Bun.spawn(["nice", "-n", "15", "swiftc", "-o", binary, swift], { stdout: "pipe", stderr: "pipe" })
      const errors = await new Response(compile.stderr).text()
      expect(await compile.exited, errors).toBe(0)
      const ran = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
      expect(await new Response(ran.stdout).text()).toBe("Phone PCM framing passed.\n")
      expect(await ran.exited).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
  test("the server it uses goes in the settings in place of the one before, or at the end, leaving the rest as they were", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "yapd-client-")), ".env")
    await Bun.write(file, "# yapd's settings\nYAPD_STYLE=\"Call me sir.\"\nexport YAPD_SERVER=old@box\nYAPD_NAME=Rosie")
    Home.set("YAPD_SERVER", "laurent@rig", file)
    expect(readFileSync(file, "utf8")).toBe("# yapd's settings\nYAPD_STYLE=\"Call me sir.\"\nYAPD_SERVER=laurent@rig\nYAPD_NAME=Rosie")
    await Bun.write(file, "YAPD_NAME=Rosie")
    Home.set("YAPD_SERVER", "laurent@rig", file)
    expect(readFileSync(file, "utf8")).toBe("YAPD_NAME=Rosie\nYAPD_SERVER=laurent@rig\n")
  })

  test("the server's key only counts as let in from here on a line that doesn't keep it to other addresses", () => {
    const key = "ssh-ed25519 AAAAC3rig"
    expect(Client.lets(`from="100.64.0.0/10,fd7a:115c:a1e0::/48" ${key} fleet-rig\n`, [key])).toBe(false)
    expect(Client.lets(`from="100.64.0.0/10" ${key} fleet-rig\nfrom="127.0.0.1,::1" ${key} yapd on rig\n`, [key])).toBe(true)
    expect(Client.lets(`${key} rig\n`, [key])).toBe(true)
    expect(Client.lets(`# ${key}\n`, [key])).toBe(false)
  })
})
