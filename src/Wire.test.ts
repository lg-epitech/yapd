import { describe, expect, test } from "bun:test"
import * as Wire from "./Wire.ts"

describe("Wire", () => {
  test("stream chunks preserve response generation, ordering and PCM without accepting malformed or oversized frames", () => {
    const pcm = new Uint8Array([0, 128, 255, 127, 0, 0])
    const frame = Wire.stream({ id: "answer-1", generation: 7, sequence: 2, pcm })
    const unaligned = new Uint8Array(frame.length + 1)
    unaligned.set(frame, 1)
    expect(Wire.readStream(unaligned.subarray(1))).toEqual({ id: "answer-1", generation: 7, sequence: 2, pcm })
    expect(Wire.readFile(frame)).toBeUndefined()
    expect(Wire.microphone(frame)).toBeUndefined()
    expect(Wire.readStream(frame.subarray(0, frame.length - 1))).toBeUndefined()
    const hugeHeader = frame.slice()
    new DataView(hugeHeader.buffer).setUint32(1, 4097)
    expect(Wire.readStream(hugeHeader)).toBeUndefined()
    expect(() => Wire.stream({ id: "a", generation: 0, sequence: 0, pcm: new Uint8Array(Wire.streamSamples * 2 + 2) })).toThrow()
    expect(() => Wire.stream({ id: "a", generation: -1, sequence: 0, pcm })).toThrow()
    expect(() => Wire.stream({ id: "a", generation: 0, sequence: 0.5, pcm })).toThrow()
    expect(() => Wire.stream({ id: "a", generation: 0, sequence: 0, pcm: new Uint8Array([0]) })).toThrow()
    // A JSON header must have numbers, not lookalike strings or incomplete fields.
    const invalid = new TextEncoder().encode(JSON.stringify({ id: "a", generation: "1", sequence: 0 }))
    const forged = new Uint8Array(5 + invalid.length + 2)
    forged[0] = Wire.Kind.stream
    new DataView(forged.buffer).setUint32(1, invalid.length)
    forged.set(invalid, 5)
    expect(Wire.readStream(forged)).toBeUndefined()
  })
  test("a file sent ahead reads back as it was sent, and anything else reads as no file", () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3])
    const read = Wire.readFile(Wire.file("f-1", bytes))
    expect(read?.id).toBe("f-1")
    expect([...(read?.bytes ?? [])]).toEqual([...bytes])
    expect(Wire.readFile(Wire.pcm16(new Float32Array(Wire.samples)))).toBeUndefined()
    // A header claiming more than the frame holds.
    const short = Wire.file("f-2", bytes).subarray(0, 8)
    expect(Wire.readFile(short)).toBeUndefined()
  })

  test("microphone frames come in as floats either way, and only a whole frame counts", () => {
    const samples = Float32Array.from({ length: Wire.samples }, (_, i) => Math.sin(i / 10) * 0.8)
    const halved = Wire.microphone(Wire.pcm16(samples))
    expect(halved?.length).toBe(Wire.samples)
    halved?.forEach((sample, i) => expect(Math.abs(sample - samples[i]!)).toBeLessThan(1e-4))
    const floats = new Uint8Array(1 + samples.byteLength)
    floats[0] = Wire.Kind.pcm
    floats.set(new Uint8Array(samples.buffer), 1)
    expect(Wire.microphone(floats)).toEqual(samples)
    expect(Wire.microphone(Wire.pcm16(new Float32Array(100)))).toBeUndefined()
  })
})
