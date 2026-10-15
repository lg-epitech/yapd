import { describe, expect, test } from "bun:test"
import { RawAudio } from "@huggingface/transformers"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as Path from "node:path"
import { duration, slice } from "./Wav.ts"

/** How long CoreAudio, which afplay plays with, takes a file to be. */
const afinfo = (path: string) => {
  const { stdout } = Bun.spawnSync(["afinfo", path])
  return Number(/estimated duration: ([\d.]+) sec/.exec(stdout.toString())?.[1])
}

/** A file's samples, as bytes, by its chunks. */
const samples = (path: string) => {
  const file = readFileSync(path)
  for (let at = 12; at < file.length; at += 8 + file.readUInt32LE(at + 4) + (file.readUInt32LE(at + 4) % 2)) {
    if (file.toString("ascii", at, at + 4) === "data") return file.subarray(at + 8, at + 8 + file.readUInt32LE(at + 4))
  }
  throw new Error(`${path} has no samples`)
}

// afplay, and say and afinfo that check what it plays, are macOS's own.
describe.skipIf(Bun.which("afinfo") === null)("Wav", () => {
  test("a slice plays from where it's asked, and the length read from each kind of file afplay may play is its true length", async () => {
    const dir = mkdtempSync(Path.join(tmpdir(), "yapd-wav-"))
    try {
      const rate = 24000
      const audio = Float32Array.from({ length: Math.round(1.5 * rate) }, (_, i) => 0.3 * Math.sin(i / 7) * Math.sin(i / 1500))
      // Kokoro's, as it saves it; ffmpeg's, with its effect, 16-bit with a LIST chunk; say's, 16-bit with chunks of its own first.
      const kokoro = Path.join(dir, "kokoro.wav")
      await new RawAudio(audio, rate).save(kokoro)
      const ffmpeg = Path.join(dir, "ffmpeg.wav")
      expect(Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-i", kokoro, "-af", "volume=0.5", ffmpeg]).exitCode).toBe(0)
      const say = Path.join(dir, "say.wav")
      expect(Bun.spawnSync(["say", "--data-format=LEI16@24000", "-o", say, "The tests pass, and nothing needs you."]).exitCode).toBe(0)
      for (const [kind, path, bytes] of [["kokoro", kokoro, 4], ["ffmpeg", ffmpeg, 2], ["say", say, 2]] as const) {
        const length = await Effect.runPromise(duration(path))
        expect([kind, length]).toEqual([kind, expect.closeTo(afinfo(path), 3)])
        const from = 0.4
        const sliced = Path.join(dir, `${kind}-sliced.wav`)
        await Effect.runPromise(slice(path, from, sliced))
        expect([kind, await Effect.runPromise(duration(sliced))]).toEqual([kind, expect.closeTo(length - from, 3)])
        expect([kind, afinfo(sliced)]).toEqual([kind, expect.closeTo(length - from, 3)])
        // Sample for sample, from there.
        expect([kind, samples(sliced).equals(samples(path).subarray(Math.round(from * rate) * bytes))]).toEqual([kind, true])
      }
      expect(await Effect.runPromise(duration(kokoro))).toBe(1.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
