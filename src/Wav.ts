import { Data, Effect } from "effect"
import { readFile, writeFile } from "node:fs/promises"

// WAV files as yapd has them: Kokoro's, float samples with the plainest
// header, ffmpeg's, 16-bit with a LIST chunk before the samples, and say's,
// 16-bit. Read by their chunks, whatever comes between the format and the
// samples, so how long one is, and where in it a moment falls, is never
// guessed from a header's usual size.

export class WavError extends Data.TaggedError("WavError")<{ readonly path: string; readonly cause: unknown }> {}

/** Where a file's samples are, and how they're laid out. */
interface Layout {
  /** The format chunk, as it is, to start a slice with. */
  readonly format: Uint8Array
  /** Samples a second, and bytes for each, all channels together. */
  readonly rate: number
  readonly frame: number
  /** The samples, as bytes. */
  readonly data: Uint8Array
}

const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))

/** A file's chunks, read up to its samples: what's past them, like a chunk ffmpeg adds at the end, isn't needed. */
const layout = (bytes: Uint8Array): Layout => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") throw new Error("Not a WAV file")
  let format: Uint8Array | undefined
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true)
    const id = tag(bytes, at)
    if (id === "fmt ") format = bytes.subarray(at, at + 8 + size)
    if (id === "data") {
      if (format === undefined) throw new Error("Its samples come before their format")
      const formatView = new DataView(format.buffer, format.byteOffset, format.byteLength)
      const rate = formatView.getUint32(12, true)
      const frame = formatView.getUint16(20, true)
      if (rate === 0 || frame === 0) throw new Error("Its format has no rate or frame size")
      // A file still being written may say it holds more than it does.
      return { format, rate, frame, data: bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)) }
    }
    // Chunks keep to even sizes, padded when they're odd.
    at += 8 + size + (size % 2)
  }
  throw new Error("It has no samples")
}

const read = (path: string) =>
  Effect.tryPromise({ try: () => readFile(path), catch: (cause) => new WavError({ path, cause }) }).pipe(
    Effect.flatMap((bytes) => Effect.try({ try: () => layout(bytes), catch: (cause) => new WavError({ path, cause }) })),
  )

/** How long a file plays, in seconds. */
export const duration = (path: string) => Effect.map(read(path), ({ rate, frame, data }) => data.length / frame / rate)

/** Writes the file at `path` from `from` seconds in to `to`, its format as it is, so it plays from there. */
export const slice = (path: string, from: number, to: string) =>
  Effect.gen(function* () {
    const { format, rate, frame, data } = yield* read(path)
    const samples = data.subarray(Math.min(data.length, Math.max(0, Math.round(from * rate)) * frame))
    const bytes = new Uint8Array(12 + format.length + 8 + samples.length + (samples.length % 2))
    const view = new DataView(bytes.buffer)
    bytes.set(new TextEncoder().encode("RIFF"), 0)
    view.setUint32(4, bytes.length - 8, true)
    bytes.set(new TextEncoder().encode("WAVE"), 8)
    bytes.set(format, 12)
    bytes.set(new TextEncoder().encode("data"), 12 + format.length)
    view.setUint32(16 + format.length, samples.length, true)
    bytes.set(samples, 20 + format.length)
    yield* Effect.tryPromise({ try: () => writeFile(to, bytes), catch: (cause) => new WavError({ path: to, cause }) })
  })
