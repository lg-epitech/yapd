// What goes over `/audio`, between yapd and a client's speaker and microphone,
// documented in docs/api.md. It's the audio helper's own protocol (Helper.ts,
// Audio.swift): its JSON messages as text frames, and binary frames that start
// with a byte saying what they are. What the helper is told to play by its path
// here, a client is sent first, since it can't read this machine's files.

/** What a binary frame holds, by its first byte. */
export const Kind = {
  /** The microphone as the helper sends it: 32-bit floats. */
  pcm: 1,
  /** A file to play, sent ahead: see `file`. */
  file: 2,
  /** The microphone as 16-bit integers, half the size, as clients send it. */
  pcm16: 3,
} as const

/** Each microphone frame is this many samples of 16 kHz mono, 32 ms, which is what the voice detector takes. */
export const samples = 512

/** The most a header can be, so a frame that isn't one is never read as a huge one. */
const largest = 4096

/**
 * A file sent ahead of playing it: the kind, a big-endian UInt32 length, a
 * JSON header naming it, then the file's bytes. `play` then names it by `file`.
 */
export const file = (id: string, bytes: Uint8Array): Uint8Array => {
  const header = new TextEncoder().encode(JSON.stringify({ file: id }))
  const framed = new Uint8Array(5 + header.length + bytes.length)
  framed[0] = Kind.file
  new DataView(framed.buffer).setUint32(1, header.length)
  framed.set(header, 5)
  framed.set(bytes, 5 + header.length)
  return framed
}

/** A file as `file` sends it, or nothing when the frame isn't one. */
export const readFile = (frame: Uint8Array): { readonly id: string; readonly bytes: Uint8Array } | undefined => {
  if (frame.length < 5 || frame[0] !== Kind.file) return undefined
  const length = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0)
  if (length > largest || frame.length < 5 + length) return undefined
  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(frame.subarray(5, 5 + length)))
    const id = typeof header === "object" && header !== null && "file" in header ? header.file : undefined
    return typeof id === "string" && id !== "" ? { id, bytes: frame.subarray(5 + length) } : undefined
  } catch {
    return undefined
  }
}

/** A microphone frame of floats as 16-bit little-endian integers, kind and all. */
export const pcm16 = (frame: Float32Array): Uint8Array => {
  const framed = new Uint8Array(1 + frame.length * 2)
  framed[0] = Kind.pcm16
  const view = new DataView(framed.buffer)
  frame.forEach((sample, i) => view.setInt16(1 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), true))
  return framed
}

/**
 * A binary frame from the microphone, either kind, as the floats the voice
 * detector and Whisper take: nothing when it isn't one, or isn't a frame's length.
 */
export const microphone = (frame: Uint8Array): Float32Array | undefined => {
  const kind = frame[0]
  const payload = frame.subarray(1)
  if (kind === Kind.pcm && payload.length === samples * 4) {
    // Copied, so the floats are aligned whatever the frame's offset.
    return new Float32Array(payload.slice().buffer)
  }
  if (kind === Kind.pcm16 && payload.length === samples * 2) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.length)
    return Float32Array.from({ length: samples }, (_, i) => view.getInt16(i * 2, true) / 0x7fff)
  }
  return undefined
}
