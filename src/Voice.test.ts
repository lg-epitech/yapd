import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { RawAudio } from "@huggingface/transformers"
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Scope, TestClock, TestContext } from "effect"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as Path from "node:path"
import * as Config from "./Config.ts"
import { ProcessError } from "./Process.ts"
import {
  early,
  ffmpeg,
  head,
  join,
  KokoroError,
  kokoro,
  opening,
  remembering,
  speaking,
  split,
  startRender,
  type Voice,
  withFallback,
} from "./Voice.ts"

/** Samples at `level`, with `rate` samples a second. */
const tone = (seconds: number, level: number, rate = 100) => Array<number>(Math.round(seconds * rate)).fill(level)

/** Parts as `split` makes them, with Kokoro's token count standing in as a number of characters. */
const parts = (text: string, limit: number) => Effect.runSync(split(text, (part) => Effect.succeed(part.length <= limit)))

describe("split", () => {
  test("keeps text that fits in one part", () => {
    expect(parts("yapd. The tests pass. Nothing needs you.", 250)).toEqual(["yapd. The tests pass. Nothing needs you."])
  })

  test("has nothing to read in blank text", () => {
    expect(parts("  \n ", 250)).toEqual([])
  })

  test("reads a long text in one go when Kokoro can", () => {
    const text = "In std, the split concepts are merged, sir: twenty-one cards are now ten. ".repeat(5).trim()
    expect(parts(text, 1000)).toEqual([text])
  })

  test("breaks long text between sentences, packing as many as fit", () => {
    expect(parts("One two. Three four. Five six.", 20)).toEqual(["One two. Three four.", "Five six."])
  })

  test("breaks a sentence that's too long at clauses, then words", () => {
    expect(parts("Alpha beta, gamma delta epsilon zeta eta.", 20)).toEqual(["Alpha beta,", "gamma delta epsilon", "zeta eta."])
  })

  test("never loses a word", () => {
    const text = "Here's the reply, sir: we found two issues. A contract brought in 536,000 transactions. Fixes are in review."
    for (const limit of [10, 30, 60, 250]) {
      const split = parts(text, limit)
      expect(split.join(" ")).toBe(text)
      for (const part of split) expect(part.length <= limit || !part.includes(" ")).toBe(true)
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

  test("starts the whole exactly as its first part plays on its own", () => {
    const first = new Float32Array([...tone(0.25, 0), ...tone(1, 0.5), ...tone(0.6, 0.01), ...tone(0.25, 0)])
    const rest = new Float32Array([...tone(0.25, 0), ...tone(1, 0.4), ...tone(0.25, 0)])
    const start = head(first, 100)
    const whole = join([first, rest, rest], 100)
    expect(start.length).toBeLessThan(whole.length)
    expect(Array.from(whole.subarray(0, start.length))).toEqual(Array.from(start))
  })
})

/** Where `opening` splits, with Kokoro's token count standing in as a number of characters. */
const open = (text: string, limit = 250) => Effect.runSync(opening(text, (part) => Effect.succeed(part.length <= limit)))

describe("opening", () => {
  test("takes whole sentences from the start, enough to play while the rest renders", () => {
    expect(open("yapd. The tests pass. I merged the fix, and nothing needs you.")).toEqual({
      first: "yapd. The tests pass.",
      rest: "I merged the fix, and nothing needs you.",
    })
    expect(open("Over in yapd, the loader is fixed and its tests pass. I merged it. Nothing needs you.")).toEqual({
      first: "Over in yapd, the loader is fixed and its tests pass.",
      rest: "I merged it. Nothing needs you.",
    })
  })

  test("never ends a first part mid-sentence", () => {
    expect(open("The tests pass, and nothing needs you.")).toBeUndefined()
    // Too long for Kokoro in one go, it would have to break somewhere in the middle.
    expect(open("The loader is fixed, its tests pass, and I merged it. Nothing needs you.", 30)).toBeUndefined()
  })
})

describe("speaking", () => {
  const rate = 24000
  const text = "The tests pass. Nothing needs you."

  /** Speech as Kokoro has it, a third of a second a word between its padding of quiet, pitched by the text so no two sound alike. */
  const speech = (text: string) => {
    const audio = new Float32Array(Math.round((0.2 + text.split(/\s+/).length / 3) * rate))
    for (let i = rate / 10; i < audio.length - rate / 10; i++) {
      audio[i] = 0.3 * Math.sin(i / (2 + text.length / 5)) * Math.sin(i / 1500) + 0.05 * Math.sin(i / 2.3)
    }
    return audio
  }

  /** Renders `text` with a first part, through ffmpeg unless `filter` stands in for it, and says which parts it told of. */
  const render = (dir: string, effect: string, filter = ffmpeg(effect, rate)) =>
    Effect.gen(function* () {
      const told: Array<string> = []
      const path = Path.join(dir, `${crypto.randomUUID()}.wav`)
      const speaker = speaking(
        {
          rate,
          fits: (text) => Effect.succeed(text.length <= 250),
          speak: (text) => Effect.succeed(speech(text)),
          write: (audio, path) => Effect.promise(() => new RawAudio(audio, rate).save(path)),
          filter,
          warn: () => {},
        },
        effect,
      )
      const exit = yield* Effect.exit(speaker({ type: "render", id: 1, text, path, first: `${path}.first.wav` }, (part) => told.push(part), () => false))
      return { exit, told, path }
    })

  /** A WAV file's samples, as the bytes they're stored as. */
  const samples = (path: string) => {
    const file = readFileSync(path)
    for (let at = 12; at < file.length; at += 8 + file.readUInt32LE(at + 4) + (file.readUInt32LE(at + 4) % 2)) {
      if (file.toString("ascii", at, at + 4) === "data") return file.subarray(at + 8, at + 8 + file.readUInt32LE(at + 4))
    }
    throw new Error(`${path} has no samples`)
  }

  /** Whether the whole starts exactly as its first part, sample for sample, and goes on after it. */
  const carriesOn = (first: string, path: string) => {
    const part = samples(first)
    const whole = samples(path)
    return part.length > 0 && part.length < whole.length && whole.subarray(0, part.length).equals(part)
  }

  const run = <A>(test: (dir: string) => Effect.Effect<A, unknown>) => {
    const dir = mkdtempSync(Path.join(tmpdir(), "yapd-speaking-"))
    return Effect.runPromise(test(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  const defaultEffect = Config.effect.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map())))

  test("has a first part early only with an effect sure to start the whole exactly as that part plays", () =>
    run((dir) =>
      Effect.gen(function* () {
        // Unlike the others, loudnorm hears seconds ahead, areverse all of it, and highpass, given a block size, a block.
        const effects = [
          [yield* defaultEffect, true],
          ["highpass=f=120,equalizer=f=3000:t=q:w=1:g=3,chorus=0.7:0.9:25:0.25:0.3:2,aecho=0.8:0.5:40|70:0.25|0.15,volume=9dB", true],
          ["equalizer=frequency=3k:width_type=h:width=200:gain=-3,volume=0.5", true],
          ["none", true],
          ["loudnorm", false],
          ["areverse", false],
          ["highpass=f=120:b=4096", false],
          ["highpass=120:q:0.707:2:1:all:0:di:auto:4096", false],
          // ffmpeg works an expression out anew on each run, so one reading the clock has the first part filtered unlike the whole.
          ["volume=1+0.5*sin(time(0))", false],
          ["highpass=f=300+200*sin(time(0))", false],
          // Or one reading the time in the audio, or worked out again for each frame, which a first part's shorter last frame could change.
          ["volume=1-t", false],
          ["volume=0.5:eval=frame", false],
        ] as const
        for (const [effect, early] of effects) {
          const { exit, told, path } = yield* render(dir, effect)
          expect(Exit.isSuccess(exit)).toBe(true)
          expect([effect, told.length]).toEqual([effect, early ? 1 : 0])
          if (early) expect([effect, carriesOn(told[0]!, path)]).toEqual([effect, true])
        }
      }),
    ))

  test("keeps the whole processed as its first part is, or not at all, when ffmpeg fails on one of them", () =>
    run((dir) =>
      Effect.gen(function* () {
        const effect = yield* defaultEffect
        const broken = new ProcessError({ command: "ffmpeg", code: 1, stderr: "Broken" })
        const failing = (on: "first" | "whole") => (raw: string, path: string, samples?: number) =>
          (samples === undefined ? "whole" : "first") === on ? Effect.fail(broken) : ffmpeg(effect, rate)(raw, path, samples)
        // With the effect on the first part, the whole can't carry on from it without.
        const processed = yield* render(dir, effect, failing("whole"))
        expect(processed.told).toHaveLength(1)
        expect(yield* Effect.flip(processed.exit)).toBe(broken)
        // With the first part as it is, so is the whole.
        const plain = yield* render(dir, effect, failing("first"))
        expect(Exit.isSuccess(plain.exit)).toBe(true)
        expect(plain.told).toHaveLength(1)
        expect(carriesOn(plain.told[0]!, plain.path)).toBe(true)
      }),
    ))
})

describe("early", () => {
  test("fails a render given up on for whoever waits on it elsewhere, even one that never started", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const started of [false, true]) {
          const going = yield* Deferred.make<void>()
          const voice: Voice["Type"] = { render: () => Deferred.succeed(going, undefined).pipe(Effect.zipRight(Effect.never)) }
          const scope = yield* Scope.make()
          const { first, whole } = yield* early(voice, "The tests pass. Nothing needs you.", "/nowhere.wav").pipe(Scope.extend(scope))
          if (started) yield* Deferred.await(going)
          yield* Scope.close(scope, Exit.void)
          // A failure, not an interruption, so the conversation waiting to play it carries on.
          expect(yield* Effect.flip(first).pipe(Effect.timeout("1 second"))).toBeInstanceOf(KokoroError)
          expect(yield* Effect.flip(whole).pipe(Effect.timeout("1 second"))).toBeInstanceOf(KokoroError)
        }
      }),
    ))
})

describe("startRender", () => {
  const run = <A>(test: (dir: string) => Effect.Effect<A, unknown>) => {
    const dir = mkdtempSync(Path.join(tmpdir(), "yapd-start-render-"))
    return Effect.runPromise(test(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
  }
  const text = "The tests pass. Nothing needs you."

  test("abandons a render whose starter was stopped while it started, as nobody else could", () =>
    run((dir) =>
      Effect.gen(function* () {
        const lifetime = yield* Scope.make()
        const asked = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const givenUp = yield* Deferred.make<void>()
        const voice: Voice["Type"] = {
          render: () => Effect.die("Rendered with no first part"),
          // Slow to start, and with both its files there by the time it has.
          renderFirst: (_, path) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Deferred.succeed(givenUp, undefined))
              yield* Deferred.succeed(asked, undefined)
              yield* Deferred.await(gate)
              yield* Effect.promise(() => Promise.all([Bun.write(`${path}.first.wav`, "part"), Bun.write(path, "audio")]))
              return { first: Effect.succeed(`${path}.first.wav`), whole: Effect.void }
            }),
        }
        const starting = yield* Effect.fork(startRender(voice, text, `${dir}/out.wav`, lifetime))
        yield* Deferred.await(asked)
        const stopping = yield* Effect.fork(Fiber.interrupt(starting))
        yield* Effect.promise(() => Bun.sleep(10))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(stopping)
        expect(yield* Deferred.isDone(givenUp)).toBe(true)
        expect(readdirSync(dir)).toEqual([])
        yield* Scope.close(lifetime, Exit.void)
      }),
    ))

  test("removes a render's files when its lifetime ends before anyone abandoned it", () =>
    run((dir) =>
      Effect.gen(function* () {
        const lifetime = yield* Scope.make()
        const voice: Voice["Type"] = { render: (text, path) => Effect.promise(() => Bun.write(path, text)).pipe(Effect.asVoid) }
        // Like one handed on to play, whose player stopped along with yapd.
        const started = yield* startRender(voice, text, `${dir}/out.wav`, lifetime)
        yield* started.whole
        yield* Scope.close(lifetime, Exit.void)
        expect(readdirSync(dir)).toEqual([])
      }),
    ))
})

describe("withFallback", () => {
  test("uses say only until a first part is out, since its whole wouldn't carry on from that part", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const said: Array<string> = []
        const failing = (afterPart: boolean) =>
          withFallback(
            (_, path, part) =>
              Effect.suspend(() => {
                if (afterPart) part?.(`${path}.first.wav`)
                return Effect.fail(new KokoroError({ cause: "Kokoro's process stopped" }))
              }),
            (_, path) => Effect.sync(() => void said.push(path)),
          )
        const text = "The tests pass. Nothing needs you."
        const before = yield* failing(false).renderFirst!(text, "/before.wav")
        expect(yield* before.first).toBe("/before.wav")
        yield* before.whole
        const after = yield* failing(true).renderFirst!(text, "/after.wav")
        expect(yield* after.first).toBe("/after.wav.first.wav")
        expect(yield* Effect.flip(after.whole)).toBeInstanceOf(KokoroError)
        expect(said).toEqual(["/before.wav"])
      }).pipe(Effect.scoped),
    ))
})

describe("remembering", () => {
  const run = <A>(test: (dir: string) => Effect.Effect<A, unknown, import("effect").Scope.Scope>) => {
    const dir = mkdtempSync(Path.join(tmpdir(), "yapd-remembering-"))
    return Effect.runPromise(Effect.scoped(test(dir))).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  test("renders a short line once, and copies it after", () =>
    run((dir) =>
      Effect.gen(function* () {
        const rendered: Array<string> = []
        const voice = yield* remembering(
          { render: (text, path) => Effect.promise(() => Bun.write(path, text)).pipe(Effect.tap(() => rendered.push(text)), Effect.asVoid) },
          dir,
        )
        yield* voice.render("On it, sir.", `${dir}/one.wav`)
        yield* voice.render("On it, sir.", `${dir}/two.wav`)
        expect(rendered).toEqual(["On it, sir."])
        expect(yield* Effect.promise(() => Bun.file(`${dir}/two.wav`).text())).toBe("On it, sir.")
        // Too long to be said again word for word.
        const long = "The tests pass. ".repeat(20)
        yield* voice.render(long, `${dir}/three.wav`)
        yield* voice.render(long, `${dir}/four.wav`)
        expect(rendered.filter((text) => text === long)).toHaveLength(2)
      }),
    ))

  test("has a short line's first sentence early, unless it's kept and a copy is quicker", () =>
    run((dir) =>
      Effect.gen(function* () {
        const rendered: Array<string> = []
        const render = (text: string, path: string) =>
          Effect.promise(() => Bun.write(path, text)).pipe(Effect.tap(() => rendered.push(text)), Effect.asVoid)
        const voice = yield* remembering(
          { render, renderFirst: (text, path) => Effect.as(render(text, path), { first: Effect.succeed(`${path}.first.wav`), whole: Effect.void }) },
          dir,
        )
        const text = "The tests pass. Nothing needs you."
        expect(yield* (yield* voice.renderFirst(text, `${dir}/out-a.wav`)).first).toBe(`${dir}/out-a.wav.first.wav`)
        yield* voice.warm([text])
        expect(yield* (yield* voice.renderFirst(text, `${dir}/out-b.wav`)).first).toBe(`${dir}/out-b.wav`)
        // With no part to have early, a single sentence is kept for next time, like any short line.
        yield* (yield* voice.renderFirst("On it, sir.", `${dir}/out-c.wav`)).whole
        yield* voice.render("On it, sir.", `${dir}/out-d.wav`)
        expect(rendered).toEqual([text, text, "On it, sir."])
      }),
    ))

  test("keeps only the newest", () =>
    run((dir) =>
      Effect.gen(function* () {
        const rendered: Array<string> = []
        const voice = yield* remembering(
          { render: (text, path) => Effect.promise(() => Bun.write(path, text)).pipe(Effect.tap(() => rendered.push(text)), Effect.asVoid) },
          dir,
          2,
        )
        for (const text of ["one", "two", "one", "three", "one", "two"]) yield* voice.render(text, `${dir}/out.wav`)
        expect(rendered).toEqual(["one", "two", "three", "two"])
      }),
    ))

  test("keeps lines rendered ahead for good, without counting them among the newest", () =>
    run((dir) =>
      Effect.gen(function* () {
        const rendered: Array<string> = []
        const voice = yield* remembering(
          { render: (text, path) => Effect.promise(() => Bun.write(path, text)).pipe(Effect.tap(() => rendered.push(text)), Effect.asVoid) },
          dir,
          2,
        )
        yield* voice.warm(["Right away, sir."])
        for (const text of ["one", "two", "one", "Right away, sir.", "three", "one", "Right away, sir."]) {
          yield* voice.render(text, `${dir}/out.wav`)
        }
        expect(rendered).toEqual(["Right away, sir.", "one", "two", "three"])
      }),
    ))

  test("keeps a line rendered ahead however long, so it's never rendered again", () =>
    run((dir) =>
      Effect.gen(function* () {
        const rendered: Array<string> = []
        const render = (text: string, path: string) =>
          Effect.promise(() => Bun.write(path, text)).pipe(Effect.tap(() => rendered.push(text)), Effect.asVoid)
        const voice = yield* remembering(
          { render, renderFirst: (text, path) => Effect.as(render(text, path), { first: Effect.succeed(`${path}.first.wav`), whole: Effect.void }) },
          dir,
        )
        const text = "Consider it done, sir. I'll see to every last detail of it with all the care you'd expect, and let you know the very moment it's all finished, so you can get on with your day."
        expect(text.length).toBeGreaterThan(160)
        yield* voice.warm([text])
        yield* voice.render(text, `${dir}/one.wav`)
        expect(yield* (yield* voice.renderFirst(text, `${dir}/two.wav`)).first).toBe(`${dir}/two.wav`)
        expect(rendered).toEqual([text])
        expect(yield* Effect.promise(() => Bun.file(`${dir}/two.wav`).text())).toBe(text)
      }),
    ))

  test("forgets a render that failed at once, even when it made room for it", () =>
    run((dir) =>
      Effect.gen(function* () {
        let calls = 0
        const voice = yield* remembering(
          {
            render: (text, path) =>
              text === "Hello." && ++calls === 1
                ? Effect.fail(new ProcessError({ command: "say", code: 1, stderr: "" }))
                : Effect.promise(() => Bun.write(path, text)).pipe(Effect.asVoid),
          },
          dir,
          1,
        )
        yield* voice.render("On it.", `${dir}/a.wav`)
        expect((yield* Effect.either(voice.render("Hello.", `${dir}/b.wav`)))._tag).toBe("Left")
        yield* voice.render("Hello.", `${dir}/c.wav`)
        expect(calls).toBe(2)
      }),
    ))

  test("removes a line it let go of while it was still rendering, once it's rendered", () =>
    run((dir) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const voice = yield* remembering(
          {
            render: (text, path) =>
              (text === "Slow." ? Deferred.await(gate) : Effect.void).pipe(Effect.zipRight(Effect.promise(() => Bun.write(path, text))), Effect.asVoid),
          },
          dir,
          1,
        )
        const slow = yield* Effect.fork(voice.render("Slow.", `${dir}/out-slow.wav`))
        yield* voice.render("Quick.", `${dir}/out-quick.wav`)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(slow)
        yield* Effect.promise(() => Bun.sleep(20))
        const cached = readdirSync(dir).filter((name) => !name.startsWith("out-"))
        expect(cached).toHaveLength(1)
      }),
    ))

  test("leaves nothing behind of a render that failed after writing", () =>
    run((dir) =>
      Effect.gen(function* () {
        const voice = yield* remembering(
          {
            render: (text, path) =>
              Effect.promise(() => Bun.write(path, text)).pipe(Effect.zipRight(Effect.fail(new ProcessError({ command: "say", code: 1, stderr: "" })))),
          },
          dir,
          1,
        )
        for (let tries = 0; tries < 3; tries++) yield* Effect.either(voice.render("Hello.", `${dir}/out-${tries}.wav`))
        yield* Effect.promise(() => Bun.sleep(20))
        expect(readdirSync(dir).filter((name) => !name.startsWith("out-"))).toEqual([])
      }),
    ))

  test("still renders a line whose first caller was stopped as it asked", () =>
    run((dir) =>
      Effect.gen(function* () {
        const voice = yield* remembering({ render: (text, path) => Effect.promise(() => Bun.write(path, text)).pipe(Effect.asVoid) }, dir)
        // Stopped a little later each time, so one of them is stopped right after it's kept and before it renders.
        for (let tries = 0; tries < 40; tries++) {
          const asked = yield* Effect.fork(voice.render(`Line ${tries}.`, `${dir}/out-a.wav`).pipe(Effect.withMaxOpsBeforeYield(10)))
          for (let wait = 0; wait < tries; wait++) yield* Effect.yieldNow()
          yield* Fiber.interrupt(asked)
          const again = yield* voice.render(`Line ${tries}.`, `${dir}/out-b.wav`).pipe(Effect.timeout("2 seconds"), Effect.either)
          expect(again._tag).toBe("Right")
        }
      }),
    ))

  test("lets go at shutdown of a line it let go of that never finished rendering", async () => {
    const dir = mkdtempSync(Path.join(tmpdir(), "yapd-remembering-"))
    try {
      const closed = await Effect.runPromise(
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          const voice = yield* remembering(
            { render: (text, path) => (text === "Stuck." ? Effect.never : Effect.promise(() => Bun.write(path, text)).pipe(Effect.asVoid)) },
            dir,
            1,
          ).pipe(Scope.extend(scope))
          yield* Effect.fork(voice.render("Stuck.", `${dir}/out-a.wav`))
          yield* Effect.promise(() => Bun.sleep(10))
          yield* voice.render("Quick.", `${dir}/out-b.wav`)
          return yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("2 seconds"), Effect.either)
        }),
      )
      expect(closed._tag).toBe("Right")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tries again after a render that failed", () =>
    run((dir) =>
      Effect.gen(function* () {
        let calls = 0
        const voice = yield* remembering(
          {
            render: (text, path) =>
              ++calls === 1
                ? Effect.fail(new ProcessError({ command: "say", code: 1, stderr: "" }))
                : Effect.promise(() => Bun.write(path, text)).pipe(Effect.asVoid),
          },
          dir,
        )
        expect((yield* Effect.either(voice.render("Hello.", `${dir}/a.wav`)))._tag).toBe("Left")
        yield* voice.render("Hello.", `${dir}/b.wav`)
        expect(calls).toBe(2)
      }),
    ))
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
  const cancelled = new Set<number>()
  process.on("message", (request: { type: string; id: number; text: string; path: string; first?: string }) => {
    record({ request })
    if (request.type === "cancel") cancelled.add(request.id)
    if (request.type !== "render") return
    if (mode === "crash") process.exit(1)
    if (mode === "failing") send({ type: "failed", id: request.id, reason: "No voice" })
    const rendered = () => {
      writeFileSync(request.path, "audio")
      record({ rendered: request.id })
      send({ type: "rendered", id: request.id })
    }
    // Its first part comes a moment later, then the rest fails, or the process dies, like on a GPU giving way.
    if (mode === "breaking" || mode === "dying") {
      if (request.first === undefined) return rendered()
      return void setTimeout(() => {
        writeFileSync(request.first!, "part")
        send({ type: "part", id: request.id, path: request.first })
        setTimeout(() => (mode === "dying" ? process.exit(1) : send({ type: "failed", id: request.id, reason: "GPU" })), 50)
      }, 100)
    }
    // Asked for one, the first sentence comes at once when there's more after it.
    if (request.first !== undefined && request.text.includes(". ")) {
      writeFileSync(request.first, "part")
      record({ part: request.id })
      send({ type: "part", id: request.id, path: request.first })
    }
    // Busy rendering, it only hears it was given up on once it's done.
    if (mode === "deaf") setTimeout(rendered, 200)
    if (mode === "slow") {
      setTimeout(() => {
        if (!cancelled.has(request.id)) return rendered()
        record({ cancelled: request.id })
        send({ type: "cancelled", id: request.id })
      }, 200)
    }
    if (mode === "") rendered()
  })
  setTimeout(() => send({ type: "ready", device: "GPU" }), 20)
}

const dir = mkdtempSync(Path.join(tmpdir(), "yapd-voice-test-"))
const script = Path.join(dir, "kokoro.js")
await Bun.write(script, `(${fakeKokoro.toString()})()`)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Entry = {
  readonly launched?: ReadonlyArray<string>
  readonly pid?: number
  readonly request?: any
  readonly part?: number
  readonly rendered?: number
  readonly cancelled?: number
}

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

  test("hands the process one render at a time, so waiting its turn doesn't count against a render", () =>
    withKokoro("slow", (voice, log, file) =>
      Effect.gen(function* () {
        yield* Effect.all([voice.render("One.", `${file}.1`), voice.render("Two.", `${file}.2`)], { concurrency: "unbounded" })
        const order = (yield* entries(log)).flatMap((entry) =>
          entry.request?.type === "render" ? [`asked ${entry.request.id}`] : entry.rendered !== undefined ? [`rendered ${entry.rendered}`] : [],
        )
        expect(order).toEqual(["asked 1", "rendered 1", "asked 2", "rendered 2"])
      }),
    ))

  test("holds the next render back until the process is done with one given up on", () =>
    withKokoro("slow", (voice, log, file) =>
      Effect.gen(function* () {
        const first = yield* Effect.fork(voice.render("One.", `${file}.1`))
        yield* until(log, (recorded) => requests("render")(recorded).length === 1)
        yield* Fiber.interrupt(first)
        yield* voice.render("Two.", `${file}.2`)
        const order = (yield* entries(log)).flatMap((entry) =>
          entry.request?.type === "render"
            ? [`asked ${entry.request.id}`]
            : entry.rendered !== undefined
              ? [`rendered ${entry.rendered}`]
              : entry.cancelled !== undefined
                ? [`cancelled ${entry.cancelled}`]
                : [],
        )
        expect(order).toEqual(["asked 1", "cancelled 1", "asked 2", "rendered 2"])
      }),
    ))

  test("removes the file of a render given up on that the process finished anyway", () =>
    withKokoro("deaf", (voice, log, file) =>
      Effect.gen(function* () {
        const first = yield* Effect.fork(voice.render("One.", `${file}.1`))
        yield* until(log, (recorded) => requests("render")(recorded).length === 1)
        yield* Fiber.interrupt(first)
        yield* voice.render("Two.", `${file}.2`)
        expect(yield* Effect.promise(() => Bun.file(`${file}.1`).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(`${file}.2`).exists())).toBe(true)
      }),
    ))

  test("has the first sentence ready early, in the same render, so no other render slips in before the rest", () =>
    withKokoro("slow", (voice, log, file) =>
      Effect.gen(function* () {
        const text = "The tests pass. Nothing needs you."
        const { first, whole } = yield* voice.renderFirst(text, file)
        yield* until(log, (recorded) => requests("render")(recorded).length === 1)
        const other = yield* Effect.fork(voice.render("Two.", `${file}.2`))
        const part = yield* first
        expect(part).toBe(`${file}.first.wav`)
        expect(yield* Effect.promise(() => Bun.file(part).text())).toBe("part")
        yield* whole
        yield* Fiber.join(other)
        const recorded = yield* entries(log)
        expect(requests("render")(recorded)[0]?.request).toEqual({ type: "render", id: 1, text, path: file, first: part })
        const order = recorded.flatMap((entry) =>
          entry.request?.type === "render"
            ? [`asked ${entry.request.id}`]
            : entry.part !== undefined
              ? [`part ${entry.part}`]
              : entry.rendered !== undefined
                ? [`rendered ${entry.rendered}`]
                : [],
        )
        expect(order).toEqual(["asked 1", "part 1", "rendered 1", "asked 2", "rendered 2"])
      }).pipe(Effect.scoped),
    ))

  test("plays a single sentence whole, as there's nothing to have early", () =>
    withKokoro("", (voice, log, file) =>
      Effect.gen(function* () {
        const { first } = yield* voice.renderFirst("The tests pass.", file)
        expect(yield* first).toBe(file)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("audio")
        expect((yield* entries(log)).some((entry) => entry.part !== undefined)).toBe(false)
      }).pipe(Effect.scoped),
    ))

  test("removes both files of a render given up on after its first part", () =>
    withKokoro("deaf", (voice, log, file) =>
      Effect.gen(function* () {
        const part = yield* Effect.gen(function* () {
          const { first } = yield* voice.renderFirst("The tests pass. Nothing needs you.", file)
          return yield* first
        }).pipe(Effect.scoped)
        yield* voice.render("Two.", `${file}.2`)
        expect(yield* Effect.promise(() => Bun.file(part).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
        expect(requests("cancel")(yield* entries(log)).map((entry) => entry.request)).toEqual([{ type: "cancel", id: 1 }])
      }),
    ))

  test("abandons a started render nobody took, freeing Kokoro for the next and removing both its files", () =>
    withKokoro("slow", (voice, log, file) =>
      Effect.gen(function* () {
        const lifetime = yield* Effect.scope
        const plain: Voice["Type"] = { render: () => Effect.die("Rendered with no first part"), renderFirst: voice.renderFirst }
        const text = "The tests pass. Nothing needs you."
        // Like an update yapd was turned off for once its first part was there, and one only refused once it was all rendered.
        const refused = yield* startRender(plain, text, file, lifetime)
        const part = yield* refused.first
        yield* refused.abandon
        const rendered = yield* startRender(plain, text, `${file}.2`, lifetime)
        yield* rendered.whole
        yield* rendered.abandon
        for (const left of [part, file, `${file}.2.first.wav`, `${file}.2`])
          expect(yield* Effect.promise(() => Bun.file(left).exists())).toBe(false)
        expect(requests("cancel")(yield* entries(log)).map((entry) => entry.request)).toEqual([{ type: "cancel", id: 1 }])
      }).pipe(Effect.scoped),
    ))

  test("leaves no first part behind of a render given up on before it was heard of, whose rest then failed", async () => {
    for (const mode of ["breaking", "dying"])
      await withKokoro(mode, (voice, log, file) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          yield* voice.renderFirst("The tests pass. Nothing needs you.", file).pipe(Scope.extend(scope))
          yield* until(log, (recorded) => requests("render")(recorded).length === 1)
          yield* Scope.close(scope, Exit.void)
          // Its turn only ends once the process is done with the one given up on.
          yield* Effect.either(voice.render("Two.", `${file}.2`))
          expect(yield* Effect.promise(() => Bun.file(`${file}.first.wav`).exists())).toBe(false)
        }),
      )
  })

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
