import { AutoTokenizer, RawAudio, type Tensor } from "@huggingface/transformers"
import { Cause, Effect, Queue } from "effect"
import { type GenerateOptions, KokoroTTS } from "kokoro-js"
import { rename, rm } from "node:fs/promises"
import * as ort from "onnxruntime-node"
import * as Hub from "./Hub.ts"
import { run } from "./Process.ts"
import { type Device, join, type Reply, type Request, split } from "./Voice.ts"

// Kokoro, in a process of its own that the daemon starts. onnxruntime runs a
// model on the thread that asks, and in the daemon that froze everything else
// for a second or two per update: its hooks, the audio helper's events and the
// voice detector. Here it can also run on the GPU, nearly twice as fast.

const [voice = "", effect = "none", device = "GPU"] = process.argv.slice(2) as [string?, string?, Device?]

const send = (reply: Reply) => void process.send?.(reply)

// Nothing will ask once the daemon is gone.
process.on("disconnect", () => process.exit(0))

const repo = "onnx-community/Kokoro-82M-v1.0-ONNX"

const open = (file: string, device: Device) =>
  ort.InferenceSession.create(file, { executionProviders: device === "GPU" ? ["webgpu", "cpu"] : ["cpu"], logSeverityLevel: 3 })

/** On the GPU when there is one, unless the daemon says otherwise. fp32, since the fp16 model only makes noise on the GPU. */
const load = Hub.load(repo, async () => {
  const [file, tokenizer] = await Promise.all([Hub.download(repo, "onnx/model.onnx"), AutoTokenizer.from_pretrained(repo)])
  send({ type: "loading" })
  const gpu = device === "GPU" ? await open(file, "GPU").catch(() => undefined) : undefined
  return { file, tokenizer, device: gpu === undefined ? ("CPU" as Device) : device, session: gpu ?? (await open(file, "CPU")) }
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
  if (!(voice in KokoroTTS.prototype.voices)) return yield* Effect.fail(`Unknown voice "${voice}"`)
  const { file, tokenizer, ...loaded } = yield* load
  let { device, session } = loaded

  /** Kokoro's model, on the CPU from the first time the GPU fails, like when it goes away as the Mac sleeps. */
  const model = async ({ input_ids, style, speed }: Record<"input_ids" | "style" | "speed", Tensor>) => {
    const feeds = {
      input_ids: new ort.Tensor("int64", input_ids.data as BigInt64Array, input_ids.dims),
      style: new ort.Tensor("float32", style.data as Float32Array, style.dims),
      speed: new ort.Tensor("float32", speed.data as Float32Array, speed.dims),
    }
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
  const tts = new KokoroTTS(model as never, tokenizer)
  const speaker = { voice: voice as NonNullable<GenerateOptions["voice"]> }
  // The GPU prepares its programs on the first run, which shouldn't hold up an update.
  yield* Effect.promise(() => tts.generate("Ready.", speaker))

  const requests = yield* Queue.unbounded<Extract<Request, { type: "render" }>>()
  const cancelled = new Set<number>()
  process.on("message", (request: Request) => {
    if (request.type === "cancel") cancelled.add(request.id)
    else Queue.unsafeOffer(requests, request)
  })
  send({ type: "ready", device })

  const render = (text: string, path: string) =>
    Effect.gen(function* () {
      const raw = effect === "none" ? path : `${path}.raw.wav`
      const parts = yield* Effect.forEach(split(text), (part) => Effect.tryPromise(() => tts.generate(part, speaker)))
      const rate = parts[0]?.sampling_rate ?? 24000
      yield* Effect.tryPromise(() => new RawAudio(join(parts.map((part) => part.audio), rate), rate).save(raw))
      if (raw !== path) yield* applyEffect(raw, path)
    })

  // One at a time: they'd only compete for the same GPU or cores.
  return yield* Queue.take(requests).pipe(
    Effect.flatMap(({ id, text, path }) =>
      cancelled.delete(id)
        ? Effect.void
        : render(text, path).pipe(
            Effect.matchCauseEffect({
              onSuccess: () =>
                // Given up on while it rendered, so nobody will remove it.
                cancelled.delete(id)
                  ? Effect.promise(() => rm(path, { force: true }))
                  : Effect.sync(() => send({ type: "rendered", id })),
              onFailure: (cause) => Effect.sync(() => send({ type: "failed", id, reason: Cause.pretty(cause) })),
            }),
          ),
    ),
    Effect.forever,
  )
})

Effect.runFork(
  program.pipe(Effect.catchAllCause((cause) => Effect.sync(() => send({ type: "unavailable", reason: Cause.pretty(cause) })))),
)
