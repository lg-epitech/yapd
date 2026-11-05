import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Option, PubSub, Stream } from "effect"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Audio, PCMPosition, PCMRequest } from "../Audio.ts"
import type { Voice } from "../Voice.ts"
import { createAudioPlayer, createVoiceSynthesizer } from "./AudioBridge.ts"

const deferred = <A = void>() => {
  let resolve!: (value: A | PromiseLike<A>) => void
  const promise = new Promise<A>((yes) => { resolve = yes })
  return { promise, resolve }
}
const until = async (ready: () => boolean) => {
  const start = performance.now()
  while (!ready()) {
    if (performance.now() - start > 1500) throw new Error("The test condition did not arrive.")
    await Bun.sleep(1)
  }
}

describe("V2 scoped native audio bridge", () => {
  test("pins device routing, forwards ordered PCM and progress, and holds its scope until drain", async () => {
    const finish = await Effect.runPromise(Deferred.make<void>())
    const positions = await Effect.runPromise(PubSub.unbounded<PCMPosition>())
    const requests: Array<PCMRequest> = []
    const chunks: Array<Array<number>> = []
    const progress: Array<PCMPosition> = []
    let closed = 0
    let stopCalls = 0
    const audio: Pick<Audio["Type"], "stream"> = { stream: (request) => Effect.gen(function* () {
      requests.push(request)
      yield* Effect.addFinalizer(() => Effect.sync(() => { closed++ }))
      return {
        write: (bytes) => Effect.sync(() => { chunks.push([...bytes]) }),
        end: Deferred.await(finish),
        stop: Effect.sync(() => { stopCalls++; return { samples: 1, rate: request.rate, certainty: "rendered" as const } }),
        progress: Stream.fromPubSub(positions),
      }
    }) }
    const controller = new AbortController()
    const player = createAudioPlayer(audio, { deviceIdFor: () => "fallback" })
    const playback = await player.open({ responseId: "r", generation: 2, rate: 24_000, deviceId: "origin", onProgress: (position) => { progress.push(position) } }, controller.signal)
    expect(requests).toEqual([{ id: "r", generation: 2, rate: 24_000, deviceId: "origin" }])
    await playback.write(new Uint8Array([1, 0, 2, 0])); await playback.write(new Uint8Array([3, 0]))
    expect(chunks).toEqual([[1, 0, 2, 0], [3, 0]])
    await Effect.runPromise(PubSub.publish(positions, { samples: 1, rate: 24_000, certainty: "rendered" as const }))
    await until(() => progress.length === 1)
    let drained = false
    const end = playback.end().then((position) => { drained = true; return position })
    await Bun.sleep(1)
    expect(drained).toBe(false); expect(closed).toBe(0)
    await Effect.runPromise(Deferred.succeed(finish, undefined))
    expect(await end).toEqual({ samples: 3, rate: 24_000, certainty: "rendered" })
    expect(closed).toBe(1)
    expect(stopCalls).toBe(0)
    await Effect.runPromise(PubSub.shutdown(positions))
  })

  test("returns the actual interruption receipt before scope cleanup and stops once on abort", async () => {
    let cleanup = 0
    let stops = 0
    const order: Array<string> = []
    const audio: Pick<Audio["Type"], "stream"> = { stream: (request) => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { cleanup++; order.push("cleanup") }))
      return { write: () => Effect.void, end: Effect.never,
        stop: Effect.sync(() => { stops++; order.push("receipt"); return { samples: 7, rate: request.rate, certainty: "estimated" as const } }), progress: Stream.never }
    }) }
    const controller = new AbortController()
    const playback = await createAudioPlayer(audio).open({ responseId: "r", generation: 0, rate: 16_000, onProgress: () => {} }, controller.signal)
    controller.abort()
    const receipt = await playback.stop()
    expect(receipt).toEqual({ samples: 7, rate: 16_000, certainty: "estimated" })
    expect(order).toEqual(["receipt", "cleanup"])
    expect(stops).toBe(1); expect(cleanup).toBe(1)
    expect(await playback.stop()).toBe(receipt)
    await expect(playback.write(new Uint8Array([1, 0]))).rejects.toThrow("aborted")
  })

  test("missing client support and invalid rates fail explicitly; an aborted open closes its scope", async () => {
    const request = { responseId: "r", generation: 0, rate: 16_000, onProgress: () => {} }
    await expect(createAudioPlayer({}).open(request, new AbortController().signal)).rejects.toThrow("cannot stream")
    await expect(createAudioPlayer({ stream: () => Effect.die("must not run") }).open({ ...request, rate: 22_050 }, new AbortController().signal)).rejects.toThrow("16, 24 or 48")
    let closed = false
    let started = false
    const controller = new AbortController()
    const opening = createAudioPlayer({ stream: () => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))
      started = true
      return yield* Effect.never
    }) }).open(request, controller.signal)
    await until(() => started)
    controller.abort()
    await expect(opening).rejects.toThrow()
    expect(closed).toBe(true)
  })
})

const wave = (samples: ReadonlyArray<number>, options: { readonly bits?: 16 | 32; readonly rate?: number; readonly channels?: number; readonly extensible?: boolean } = {}) => {
  const bits = options.bits ?? 16
  const frame = bits / 8
  const formatLength = options.extensible ? 40 : 16
  const dataOffset = 12 + 8 + formatLength + 8
  const bytes = new Uint8Array(dataOffset + samples.length * frame)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at)
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt "); view.setUint32(16, formatLength, true)
  view.setUint16(20, options.extensible ? 0xfffe : bits === 16 ? 1 : 3, true)
  view.setUint16(22, options.channels ?? 1, true); view.setUint32(24, options.rate ?? 24_000, true)
  view.setUint32(28, (options.rate ?? 24_000) * frame, true); view.setUint16(32, frame, true); view.setUint16(34, bits, true)
  if (options.extensible) {
    view.setUint16(36, 22, true); view.setUint16(38, bits, true)
    bytes.set([bits === 16 ? 1 : 3, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 44)
  }
  text(dataOffset - 8, "data"); view.setUint32(dataOffset - 4, samples.length * frame, true)
  samples.forEach((sample, index) => bits === 16 ? view.setInt16(dataOffset + index * frame, sample, true) : view.setFloat32(dataOffset + index * frame, sample, true))
  return bytes
}

const root = () => mkdtemp(join(tmpdir(), "yapd-v2-bridge-test-"))
const all = async <A>(iterable: AsyncIterable<A>): Promise<Array<A>> => { const values: Array<A> = []; for await (const value of iterable) values.push(value); return values }
const pcmSamples = (frames: ReadonlyArray<{ pcm16: Uint8Array }>) => frames.flatMap(({ pcm16 }) => {
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
  return Array.from({ length: pcm16.length / 2 }, (_, index) => view.getInt16(index * 2, true))
})

describe("V2 existing local Voice bridge", () => {
  test("emits the actual first prefix before whole synthesis and skips exactly its samples", async () => {
    const directory = await root()
    const release = deferred()
    let cleaned = false
    const voice: Voice["Type"] = { render: () => Effect.die("renderFirst is available"), renderFirst: (_text, path) => Effect.gen(function* () {
      const first = `${path}.first.wav`
      yield* Effect.promise(() => writeFile(first, wave([1, 2, 3])))
      yield* Effect.addFinalizer(() => Effect.sync(() => { cleaned = true }))
      return { first: Effect.succeed(first), words: Effect.succeed(Option.some(2)), done: Effect.succeed(false),
        whole: Effect.promise(() => release.promise).pipe(Effect.zipRight(Effect.promise(() => writeFile(path, wave([1, 2, 3, 4, 5])))), Effect.as(5 / 24_000)) }
    }) }
    try {
      const iterator = createVoiceSynthesizer(voice, { directory, chunkSamples: 2 })("First then rest.", new AbortController().signal)[Symbol.asyncIterator]()
      const first = await iterator.next(); const second = await iterator.next()
      expect(first.done).toBe(false); expect(second.done).toBe(false)
      expect(pcmSamples([first.value!, second.value!])).toEqual([1, 2, 3])
      expect(cleaned).toBe(false)
      let arrived = false
      const next = iterator.next().then((value) => { arrived = true; return value })
      await Bun.sleep(1); expect(arrived).toBe(false)
      release.resolve()
      const rest = await next
      expect(pcmSamples([rest.value!])).toEqual([4, 5])
      expect((await iterator.next()).done).toBe(true)
      expect(cleaned).toBe(true)
      expect(await readdir(directory)).toEqual([])
    } finally { release.resolve(); await rm(directory, { recursive: true, force: true }) }
  })

  test("converts whole Float32 and extensible PCM WAV without duplicating first audio", async () => {
    const directory = await root()
    try {
      for (const [bytes, expected] of [
        [wave([-1.5, -0.5, 0, 0.5, 1.5], { bits: 32 }), [-32768, -16384, 0, 16384, 32767]],
        [wave([-12, 0, 34], { extensible: true, rate: 48_000 }), [-12, 0, 34]],
      ] as const) {
        const voice: Voice["Type"] = { render: (_text, path) => Effect.promise(() => writeFile(path, bytes)) }
        const frames = await all(createVoiceSynthesizer(voice, { directory, chunkSamples: 2 })("Whole.", new AbortController().signal))
        expect(pcmSamples(frames)).toEqual([...expected])
        expect(await readdir(directory)).toEqual([])
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test("rejects changed prefixes, formats, malformed audio and oversize files, always removing owned files", async () => {
    const directory = await root()
    try {
      for (const [first, whole, message] of [
        [wave([1, 2]), wave([1, 9, 3]), "first prefix exactly"],
        [wave([1, 2]), wave([1, 2, 3], { rate: 48_000 }), "changed audio format"],
        [wave([1, 2]), wave([1]), "first prefix exactly"],
      ] as const) {
        const voice: Voice["Type"] = { render: () => Effect.void, renderFirst: (_text, path) => Effect.gen(function* () {
          const part = `${path}.first.wav`
          yield* Effect.promise(() => writeFile(part, first))
          return { first: Effect.succeed(part), words: Effect.succeed(Option.none()), done: Effect.succeed(false), whole: Effect.promise(() => writeFile(path, whole)).pipe(Effect.as(undefined)) }
        }) }
        await expect(all(createVoiceSynthesizer(voice, { directory })("A phrase.", new AbortController().signal))).rejects.toThrow(message)
        expect(await readdir(directory)).toEqual([])
      }
      for (const bytes of [wave([1], { channels: 2 }), wave([NaN], { bits: 32 }), wave([1]).slice(0, 40), wave([1], { rate: 22_050 })]) {
        const voice: Voice["Type"] = { render: (_text, path) => Effect.promise(() => writeFile(path, bytes)) }
        await expect(all(createVoiceSynthesizer(voice, { directory })("A phrase.", new AbortController().signal))).rejects.toThrow()
        expect(await readdir(directory)).toEqual([])
      }
      const voice: Voice["Type"] = { render: (_text, path) => Effect.promise(() => writeFile(path, wave([1, 2]))) }
      await expect(all(createVoiceSynthesizer(voice, { directory, maxWavBytes: 44 })("Too large.", new AbortController().signal))).rejects.toThrow("size limit")
      expect(await readdir(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test("abort while awaiting whole synthesis closes the render and cleans files promptly", async () => {
    const directory = await root()
    let cleaned = false
    const voice: Voice["Type"] = { render: () => Effect.void, renderFirst: (_text, path) => Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(`${path}.first.wav`, wave([1])))
      yield* Effect.addFinalizer(() => Effect.sync(() => { cleaned = true }))
      return { first: Effect.succeed(`${path}.first.wav`), words: Effect.succeed(Option.none()), done: Effect.succeed(false), whole: Effect.never }
    }) }
    try {
      const controller = new AbortController()
      const iterator = createVoiceSynthesizer(voice, { directory })("Interrupted.", controller.signal)[Symbol.asyncIterator]()
      expect((await iterator.next()).done).toBe(false)
      const next = iterator.next()
      controller.abort()
      await expect(next).rejects.toThrow()
      expect(cleaned).toBe(true)
      expect(await readdir(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
