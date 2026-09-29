import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Fiber, TestClock, TestContext } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as Path from "node:path"
import { join, KokoroError, kokoro, split } from "./Voice.ts"

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

// These start real processes.
setDefaultTimeout(15_000)

/** Stands in for src/Kokoro.ts, run as a script. It records how it was started and what it was asked. */
const fakeKokoro = () => {
  const [log = "", mode = "", ...args] = process.argv.slice(2)
  const { appendFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
  const record = (entry: object) => appendFileSync(log, `${JSON.stringify(entry)}\n`)
  const send = (reply: object) => process.send?.(reply)
  record({ launched: args, pid: process.pid })
  process.on("disconnect", () => process.exit(0))
  if (mode === "unavailable") {
    send({ type: "unavailable", reason: "Unknown voice" })
    setInterval(() => {}, 1000)
    return
  }
  // Like onnxruntime crashing as it sets up the GPU.
  if (mode === "crash-loading") return void setTimeout(() => process.exit(1), 20)
  if (mode === "never-ready" || mode === "stuck-loading") {
    if (mode === "stuck-loading") send({ type: "loading" })
    setInterval(() => {}, 1000)
    return
  }
  process.on("message", (request: { type: string; id: number; path: string }) => {
    record({ request })
    if (request.type !== "render") return
    if (mode === "crash") process.exit(1)
    if (mode === "failing") send({ type: "failed", id: request.id, reason: "No voice" })
    if (mode !== "") return
    writeFileSync(request.path, "audio")
    send({ type: "rendered", id: request.id })
  })
  setTimeout(() => send({ type: "ready", device: "GPU" }), 20)
}

const dir = mkdtempSync(Path.join(tmpdir(), "yapd-voice-test-"))
const script = Path.join(dir, "kokoro.js")
await Bun.write(script, `(${fakeKokoro.toString()})()`)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Entry = { readonly launched?: ReadonlyArray<string>; readonly pid?: number; readonly request?: any }

const entries = (log: string) =>
  Effect.promise(async () =>
    (await Bun.file(log).exists())
      ? (await Bun.file(log).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry)
      : [],
  )

/** Waits, in real time, for the fake to have recorded what the test expects. */
const until = (log: string, done: (entries: ReadonlyArray<Entry>) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries++) {
      const recorded = yield* entries(log)
      if (done(recorded)) return recorded
      yield* Effect.promise(() => Bun.sleep(10))
    }
    return yield* Effect.die(`The fake never got there: ${JSON.stringify(yield* entries(log))}`)
  })

const launches = (recorded: ReadonlyArray<Entry>) => recorded.filter((entry) => entry.launched !== undefined)
const requests = (type: string) => (recorded: ReadonlyArray<Entry>) => recorded.filter((entry) => entry.request?.type === type)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let runs = 0
const withKokoro = <A>(
  mode: string,
  body: (voice: Effect.Effect.Success<ReturnType<typeof kokoro>>, log: string, file: string) => Effect.Effect<A, unknown, never>,
) => {
  const log = Path.join(dir, `${++runs}.log`)
  return Effect.runPromise(
    kokoro([process.execPath, script, log, mode], "bm_fable", "none").pipe(
      Effect.flatMap((voice) => body(voice, log, Path.join(dir, `${runs}.wav`))),
      Effect.scoped,
      Effect.provide(TestContext.TestContext),
    ),
  ).then(async (result) => {
    // Nothing is left running once the daemon's scope has closed.
    const pids = launches(await Effect.runPromise(entries(log))).map((entry) => entry.pid!)
    for (let tries = 0; tries < 100 && pids.some(alive); tries++) await Bun.sleep(10)
    expect(pids.filter(alive)).toEqual([])
    return result
  })
}

describe("kokoro", () => {
  test("renders in its own process, started with the voice and effect", () =>
    withKokoro("", (voice, log, file) =>
      Effect.gen(function* () {
        yield* voice.render("The tests pass.", file)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("audio")
        const recorded = yield* entries(log)
        expect(launches(recorded).map((entry) => entry.launched)).toEqual([["bm_fable", "none", "GPU"]])
        expect(requests("render")(recorded).map((entry) => entry.request)).toEqual([
          { type: "render", id: 1, text: "The tests pass.", path: file },
        ])
      }),
    ))

  test("fails a render the process couldn't do, and keeps the process", () =>
    withKokoro("failing", (voice, log, file) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        expect(launches(yield* entries(log))).toHaveLength(1)
      }),
    ))

  test("starts another process after one stops", () =>
    withKokoro("crash", (voice, log, file) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        yield* until(log, (recorded) => !alive(launches(recorded)[0]!.pid!))
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        expect(launches(yield* entries(log))).toHaveLength(2)
      }),
    ))

  test("replaces a process that stops answering", () =>
    withKokoro("hang", (voice, log, file) =>
      Effect.gen(function* () {
        const rendering = yield* Effect.fork(voice.render("The tests pass.", file))
        const recorded = yield* until(log, (recorded) => requests("render")(recorded).length === 1)
        yield* TestClock.adjust("60 seconds")
        expect(yield* Effect.flip(Fiber.join(rendering))).toBeInstanceOf(KokoroError)
        yield* until(log, () => !alive(launches(recorded)[0]!.pid!))
        yield* Effect.fork(voice.render("The tests pass.", file))
        // Most likely stuck on the GPU, so the next one leaves it alone.
        const relaunched = yield* until(log, (recorded) => launches(recorded).length === 2)
        expect(launches(relaunched)[1]?.launched).toEqual(["bm_fable", "none", "CPU"])
      }),
    ))

  test("falls back for now while Kokoro loads, and lets it carry on", () =>
    withKokoro("never-ready", (voice, log, file) =>
      Effect.gen(function* () {
        const rendering = yield* Effect.fork(voice.render("The tests pass.", file))
        const [launched] = launches(yield* until(log, (recorded) => launches(recorded).length === 1))
        yield* TestClock.adjust("20 seconds")
        expect(yield* Effect.flip(Fiber.join(rendering))).toBeInstanceOf(KokoroError)
        expect(alive(launched!.pid!)).toBe(true)
      }),
    ))

  test("replaces a process that never finishes setting the model up, on the CPU", () =>
    withKokoro("stuck-loading", (voice, log, file) =>
      Effect.gen(function* () {
        const [launched] = launches(yield* until(log, (recorded) => launches(recorded).length === 1))
        yield* TestClock.adjust("60 seconds")
        yield* until(log, () => !alive(launched!.pid!))
        yield* TestClock.adjust("1 minute")
        yield* Effect.fork(voice.render("The tests pass.", file))
        const relaunched = yield* until(log, (recorded) => launches(recorded).length === 2)
        expect(launches(relaunched)[1]?.launched).toEqual(["bm_fable", "none", "CPU"])
      }),
    ))

  test("waits a minute after a process crashed while loading, then starts one on the CPU", () =>
    withKokoro("crash-loading", (voice, log, file) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        expect(launches(yield* entries(log))).toHaveLength(1)
        yield* TestClock.adjust("1 minute")
        yield* Effect.flip(voice.render("The tests pass.", file))
        expect(launches(yield* entries(log))[1]?.launched).toEqual(["bm_fable", "none", "CPU"])
      }),
    ))

  test("the real process turns down a voice Kokoro doesn't have, before loading anything", () =>
    Effect.runPromise(
      kokoro([process.execPath, Path.join(import.meta.dir, "Kokoro.ts")], "nobody", "none").pipe(
        Effect.flatMap((voice) => Effect.flip(voice.render("The tests pass.", Path.join(dir, "real.wav")))),
        Effect.scoped,
      ),
    ).then((error) => expect(String(error.cause)).toContain(`Unknown voice "nobody"`)))

  test("tells the process when a render is no longer needed", () =>
    withKokoro("hang", (voice, log, file) =>
      Effect.gen(function* () {
        const rendering = yield* Effect.fork(voice.render("The tests pass.", file))
        yield* until(log, (recorded) => requests("render")(recorded).length === 1)
        yield* Fiber.interrupt(rendering)
        const recorded = yield* until(log, (recorded) => requests("cancel")(recorded).length === 1)
        expect(requests("cancel")(recorded)[0]?.request).toEqual({ type: "cancel", id: 1 })
      }),
    ))

  test("leaves Kokoro alone for a minute after it couldn't load", () =>
    withKokoro("unavailable", (voice, log, file) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        yield* until(log, (recorded) => !alive(launches(recorded)[0]!.pid!))
        expect(yield* Effect.flip(voice.render("The tests pass.", file))).toBeInstanceOf(KokoroError)
        expect(launches(yield* entries(log))).toHaveLength(1)
        yield* TestClock.adjust("1 minute")
        yield* Effect.flip(voice.render("The tests pass.", file))
        expect(launches(yield* entries(log))).toHaveLength(2)
      }),
    ))
})
