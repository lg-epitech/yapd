import { describe, expect, test } from "bun:test"
import { join, split } from "./Voice.ts"

/** Samples at `level`, with `rate` samples a second. */
const tone = (seconds: number, level: number, rate = 100) => Array<number>(Math.round(seconds * rate)).fill(level)

describe("split", () => {
  test("keeps text that fits in one part", () => {
    expect(split("yapd. The tests pass. Nothing needs you.")).toEqual(["yapd. The tests pass. Nothing needs you."])
  })

  test("breaks long text between sentences, packing as many as fit", () => {
    expect(split("One two. Three four. Five six.", 20)).toEqual(["One two. Three four.", "Five six."])
  })

  test("breaks a sentence that's too long at clauses, then words", () => {
    expect(split("Alpha beta, gamma delta epsilon zeta eta.", 20)).toEqual(["Alpha beta,", "gamma delta epsilon", "zeta eta."])
  })

  test("never loses a word", () => {
    const text = "Here's the reply, sir: we found two issues. A contract brought in 536,000 transactions. Fixes are in review."
    for (const limit of [10, 30, 60, 250]) {
      const parts = split(text, limit)
      expect(parts.join(" ")).toBe(text)
      for (const part of parts) expect(part.length <= limit || !part.includes(" ")).toBe(true)
    }
  })
})

describe("join", () => {
  test("cuts the quiet between parts to a sentence pause and drops the next one's padding", () => {
    const first = new Float32Array([...tone(0.25, 0), ...tone(1, 0.5), ...tone(0.6, 0.01), ...tone(0.25, 0)])
    const second = new Float32Array([...tone(0.25, 0), ...tone(1, 0.5), ...tone(0.6, 0.01), ...tone(0.25, 0)])
    const joined = join([first, second], 100)
    // Padding and speech, 0.2 s of quiet after it, 0.01 s before the next sound, then all of the last part.
    expect(joined.length).toBe(25 + 100 + 20 + 1 + 100 + 60 + 25)
    expect(Array.from(joined.subarray(0, 125))).toEqual(Array.from(first.subarray(0, 125)))
    expect(joined[144]).toBe(0)
    expect(Array.from(joined.subarray(145))).toEqual(Array.from(second.subarray(24)))
  })

  test("fades out where it cuts", () => {
    const joined = join([new Float32Array(tone(1, 0.5)), new Float32Array(tone(1, 0.5))], 100)
    const faded = Array.from(joined.subarray(95, 100))
    expect(faded.every((sample, i) => i === 0 || sample < faded[i - 1]!)).toBe(true)
    expect(faded.at(-1)).toBe(0)
  })

  test("leaves a single part alone", () => {
    const part = new Float32Array([...tone(0.25, 0), ...tone(1, 0.5), ...tone(0.25, 0)])
    expect(join([part], 100)).toEqual(part)
  })
})
