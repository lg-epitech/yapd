import { AutoTokenizer, RawAudio } from "@huggingface/transformers"
import { Cause, Effect, Queue } from "effect"
import { rename, rm } from "node:fs/promises"
import * as ort from "onnxruntime-node"
import * as Hub from "./Hub.ts"
import { run } from "./Process.ts"
import { phonemize } from "./vendor/kokoro/phonemize.js"
import { type Device, join, kokoroRepo as repo, type Reply, type Request, split, voices } from "./Voice.ts"

// Kokoro, in a process of its own that the daemon starts. onnxruntime runs a
// model on the thread that asks, and in the daemon that froze everything else
// for a second or two per update: its hooks, the audio helper's events and the
// voice detector. Here it can also run on the GPU, nearly twice as fast.

const [voice = "", effect = "none", device = "GPU"] = process.argv.slice(2) as [string?, string?, Device?]

const send = (reply: Reply) => void process.send?.(reply)

// Nothing will ask once the daemon is gone.
process.on("disconnect", () => process.exit(0))

const open = (file: string, device: Device) =>
  ort.InferenceSession.create(file, { executionProviders: device === "GPU" ? ["webgpu", "cpu"] : ["cpu"], logSeverityLevel: 3 })

/** How many numbers make up the voice's style for one length of input. */
const styleSize = 256

/** Kokoro reads at most this many tokens, and silently drops the rest. */
const longest = 510

/** The rate Kokoro renders at. */
const rate = 24000

/** On the GPU when there is one, unless the daemon says otherwise. fp32, since the fp16 model only makes noise on the GPU. */
const load = Hub.load(repo, async () => {
  const [file, styles, tokenizer] = await Promise.all([
    Hub.download(repo, "onnx/model.onnx"),
    Hub.download(repo, `voices/${voice}.bin`).then(async (path) => new Float32Array(await Bun.file(path).arrayBuffer())),
    AutoTokenizer.from_pretrained(repo),
  ])
  send({ type: "loading" })
  const gpu = device === "GPU" ? await open(file, "GPU").catch(() => undefined) : undefined
  return { file, styles, tokenizer, device: gpu === undefined ? ("CPU" as Device) : device, session: gpu ?? (await open(file, "CPU")) }
})

const applyEffect = (raw: string, path: string) =>
  run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-af", effect, path]).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => send({ type: "warning", message: `Could not apply the effect, playing it unprocessed: ${error.stderr}` })).pipe(
        Effect.zipRight(Effect.promise(() => rename(raw, path))),
      ),
    ),
    Effect.ensuring(Effect.promise(() => rm(raw, { force: true }))),
  )

const program = Effect.gen(function* () {
  // Its voices don't need the model.
  if (!voices.has(voice)) return yield* Effect.fail(`Unknown voice "${voice}"`)
  const { file, styles, tokenizer, ...loaded } = yield* load
  let { device, session } = loaded

  /** Kokoro's model, on the CPU from the first time the GPU fails, like when it goes away as the Mac sleeps. */
  const model = async (feeds: Record<string, ort.Tensor>) => {
    try {
      return await session.run(feeds)
    } catch (error) {
      if (device === "CPU") throw error
      // Should that fail too, the next render tries again.
      const cpu = await open(file, "CPU")
      const gpu = session
      session = cpu
      device = "CPU"
      send({ type: "warning", message: `Kokoro's GPU failed, so it runs on the CPU from now on: ${error}` })
      await gpu.release().catch(() => {})
      return await session.run(feeds)
    }
  }

  /** What Kokoro reads for the text, as the voice's accent says it. The count stops at 510, like Kokoro. */
  const tokens = async (text: string) => {
    const { input_ids } = tokenizer(await phonemize(text, voice.startsWith("b") ? "b" : "a"), { truncation: true })
    return { ids: input_ids.data as BigInt64Array, dims: input_ids.dims, count: input_ids.dims.at(-1)! - 2 }
  }

  /** Only a count under 510 shows the whole text fits, since a longer text counts 510 too. */
  const fits = (text: string) => Effect.tryPromise(() => tokens(text)).pipe(Effect.map(({ count }) => count < longest))

  /** The voice has a style for each length of input, up to what Kokoro reads. */
  const speak = async (text: string) => {
    const { ids, dims, count } = await tokens(text)
    const offset = Math.min(Math.max(count, 0), longest - 1) * styleSize
    const { waveform } = await model({
      input_ids: new ort.Tensor("int64", ids, dims),
      style: new ort.Tensor("float32", styles.slice(offset, offset + styleSize), [1, styleSize]),
      speed: new ort.Tensor("float32", new Float32Array([1]), [1]),
    })
    return waveform!.data as Float32Array
  }
  // The GPU prepares its programs on the first run, which shouldn't hold up an update.
  yield* Effect.promise(() => speak("Ready."))

  const requests = yield* Queue.unbounded<Extract<Request, { type: "render" }>>()
  const cancelled = new Set<number>()
  /** The last request it's done with: a cancel for one of those came too late to matter. */
  let handled = 0
  process.on("message", (request: Request) => {
    if (request.type !== "cancel") Queue.unsafeOffer(requests, request)
    else if (request.id > handled) cancelled.add(request.id)
  })
  send({ type: "ready", device })

  const render = (text: string, path: string) =>
    Effect.gen(function* () {
      const raw = effect === "none" ? path : `${path}.raw.wav`
      const parts = yield* Effect.forEach(yield* split(text, fits), (part) => Effect.tryPromise(() => speak(part)))
      yield* Effect.tryPromise(() => new RawAudio(join(parts, rate), rate).save(raw))
      if (raw !== path) yield* applyEffect(raw, path)
    })

  /** Answers every request, even one given up on, since the daemon holds the next back until this one is done. */
  const answer = ({ id, text, path }: Extract<Request, { type: "render" }>) =>
    cancelled.delete(id)
      ? Effect.sync(() => send({ type: "cancelled", id }))
      : render(text, path).pipe(
          Effect.matchCauseEffect({
            onSuccess: () =>
              // Given up on while it rendered, so nobody will remove it.
              cancelled.delete(id)
                ? Effect.promise(() => rm(path, { force: true })).pipe(
                    Effect.zipRight(Effect.sync(() => send({ type: "cancelled", id }))),
                  )
                : Effect.sync(() => send({ type: "rendered", id })),
            onFailure: (cause) => Effect.sync(() => send({ type: "failed", id, reason: Cause.pretty(cause) })),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              handled = id
              cancelled.delete(id)
            }),
          ),
        )

  // One at a time: they'd only compete for the same GPU or cores.
  return yield* Queue.take(requests).pipe(Effect.flatMap(answer), Effect.forever)
})

Effect.runFork(
  program.pipe(Effect.catchAllCause((cause) => Effect.sync(() => send({ type: "unavailable", reason: Cause.pretty(cause) })))),
)
