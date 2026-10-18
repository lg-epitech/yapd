import { describe, expect, test } from "bun:test"
import * as Wire from "./Wire.ts"

describe("Wire", () => {
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
