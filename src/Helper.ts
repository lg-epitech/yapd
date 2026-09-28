import { Data, Effect } from "effect"
import { mkdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { run } from "./Process.ts"

// The native audio helper: src/Audio.swift, built into an app on first start.

export class HelperError extends Data.TaggedError("HelperError")<{ readonly message: string; readonly cause?: unknown }> {}

/** Kinds of message, in the byte that starts each one. */
export const Kind = { json: 0, pcm: 1 } as const

/** A kind byte, a big-endian UInt32 length, then the payload. */
export const encode = (message: object) => {
  const payload = new TextEncoder().encode(JSON.stringify(message))
  const framed = new Uint8Array(5 + payload.length)
  framed[0] = Kind.json
  new DataView(framed.buffer).setUint32(1, payload.length)
  framed.set(payload, 5)
  return framed
}

export interface Message {
  readonly kind: number
  readonly payload: Uint8Array
}

/** Splits a byte stream back into messages, however it was chunked. */
export class Decoder {
  private buffered = new Uint8Array(0)

  push(chunk: Uint8Array): Array<Message> {
    const joined = new Uint8Array(this.buffered.length + chunk.length)
    joined.set(this.buffered)
    joined.set(chunk, this.buffered.length)
    const messages: Array<Message> = []
    let offset = 0
    while (joined.length - offset >= 5) {
      const length = new DataView(joined.buffer, offset + 1, 4).getUint32(0)
      if (joined.length - offset - 5 < length) break
      // slice copies, so the payload is aligned for a Float32Array.
      messages.push({ kind: joined[offset]!, payload: joined.slice(offset + 5, offset + 5 + length) })
      offset += 5 + length
    }
    this.buffered = joined.slice(offset)
    return messages
  }
}

const source = join(import.meta.dir, "Audio.swift")

/** Outside the checkout, so every checkout shares one app and one microphone permission. */
export const app = join(homedir(), "Library", "Application Support", "yapd", "yapd.app")

const info = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.yapd.audio</string>
  <key>CFBundleName</key><string>yapd</string>
  <key>CFBundleExecutable</key><string>yapd-audio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSMicrophoneUsageDescription</key><string>yapd listens while it talks, so you can interrupt it.</string>
  <key>YapdSource</key><string>${version}</string>
</dict>
</plist>
`

/**
 * Builds the app unless it's up to date. Rebuilding changes its signature, and
 * macOS asks for the microphone again, so it only happens when the source does.
 */
export const build = Effect.gen(function* () {
  const version = yield* Effect.promise(async () =>
    new Bun.CryptoHasher("sha256")
      .update(await Bun.file(source).text())
      .update(info(""))
      .digest("hex"),
  )
  const plist = Bun.file(join(app, "Contents", "Info.plist"))
  const built = yield* Effect.promise(async () => (await plist.exists()) && (await plist.text()).includes(version))
  if (built) return app

  // Without the command line tools, swiftc is a stub that opens an installer instead.
  yield* run(["xcode-select", "-p"]).pipe(
    Effect.mapError(
      () => new HelperError({ message: "Building the audio helper needs Xcode's command line tools: xcode-select --install" }),
    ),
  )
  yield* Effect.logInfo("Building the audio helper")
  const staging = `${app}.${crypto.randomUUID()}`
  const binary = join(staging, "Contents", "MacOS", "yapd-audio")
  yield* Effect.acquireUseRelease(
    Effect.promise(() => mkdir(dirname(binary), { recursive: true })),
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(join(staging, "Contents", "Info.plist"), info(version)))
        yield* run(["swiftc", "-O", "-swift-version", "5", "-o", binary, source])
        // Ad hoc, which is enough for macOS to remember the microphone permission.
        yield* run(["codesign", "--force", "--sign", "-", staging])
        yield* Effect.promise(async () => {
          await rm(app, { recursive: true, force: true })
          await rename(staging, app)
        })
      }).pipe(Effect.mapError((cause) => new HelperError({ message: "Could not build the audio helper", cause }))),
    () => Effect.promise(() => rm(staging, { recursive: true, force: true })),
  )
  return app
})

/**
 * Opening it as an app, rather than spawning it, makes it responsible for itself,
 * so macOS asks for the microphone on its behalf instead of bun's.
 */
export const launch = (socket: string, microphone: boolean) =>
  run(["open", "-g", "-j", "-n", app, "--args", "--socket", socket, ...(microphone ? [] : ["--no-microphone"])]).pipe(
    Effect.mapError((cause) => new HelperError({ message: "Could not start the audio helper", cause })),
  )
