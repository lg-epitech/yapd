import { env } from "@huggingface/transformers"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as Hub from "./Hub.ts"

const dir = mkdtempSync(join(tmpdir(), "yapd-hub-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("download", () => {
  test("gives up on a connection that drops partway, leaving nothing behind", async () => {
    // Promises 40 MB and sends one before hanging up.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data: (socket) => {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 40000000\r\nContent-Type: application/octet-stream\r\n\r\n")
          socket.write(new Uint8Array(1_000_000))
          setTimeout(() => socket.end(), 50)
        },
      },
    })
    const remoteHost = env.remoteHost
    const cacheDir = env.cacheDir
    env.remoteHost = `http://127.0.0.1:${server.port}/`
    env.cacheDir = dir
    try {
      await expect(Hub.download("someone/model", "onnx/model.onnx")).rejects.toThrow()
      expect(readdirSync(dir, { recursive: true }).filter((entry) => String(entry).endsWith(".onnx"))).toEqual([])
    } finally {
      env.remoteHost = remoteHost
      env.cacheDir = cacheDir
      server.stop(true)
    }
  })
})

describe("load", () => {
  test("only loads from files that have downloaded whole, the first time and when it tries again", async () => {
    // A megabyte over a quarter of a second, which is when transformers.js would take what's there for the file.
    const whole = 1_000_000
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        let sent = 0
        return new Response(
          new ReadableStream({
            pull: async (controller) => {
              await Bun.sleep(25)
              controller.enqueue(new Uint8Array(whole / 10))
              if ((sent += whole / 10) === whole) controller.close()
            },
          }),
          { headers: { "content-length": String(whole) } },
        )
      },
    })
    const remoteHost = env.remoteHost
    const cacheDir = env.cacheDir
    env.remoteHost = `http://127.0.0.1:${server.port}/`
    env.cacheDir = dir
    const file = join(dir, "someone/whisper/onnx/model.onnx")
    const size = () => statSync(file, { throwIfNoEntry: false })?.size
    const seen = new Set<number | undefined>()
    const watching = setInterval(() => seen.add(size()), 5)
    try {
      const found: Array<number | undefined> = []
      const load = Hub.load(
        "someone/whisper",
        async () => {
          found.push(size())
          if (found.length === 1) throw new Error("Something else didn't load")
        },
        (get) => get("onnx/model.onnx"),
      )
      await Effect.runPromise(load)
      expect(found).toEqual([whole, whole])
      expect([...seen].filter((size) => size !== undefined)).toEqual([whole])
    } finally {
      clearInterval(watching)
      env.remoteHost = remoteHost
      env.cacheDir = cacheDir
      server.stop(true)
    }
  })
})

interface Hub {
  /** Starts yapd, which does what's given and stops. Whether that went well, unless it's stopped first. */
  readonly start: (does: string) => { readonly done: Promise<boolean>; readonly stop: () => void }
  /** How many files were asked for. */
  readonly asked: () => number
  readonly cache: string
  readonly stop: () => void
}

/**
 * A hub with one model on it, and what yapd does with it from one start to the next, each in a process of its own
 * as they are. Every file holds "whole", unless `serve` answers for it.
 */
const starts = async (run: (hub: Hub) => Promise<void>, serve: (file: string) => Response | undefined = () => undefined) => {
  let asked = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => (asked++, serve(new URL(request.url).pathname.split("/resolve/main/")[1] ?? "") ?? new Response("whole")),
  })
  const cache = mkdtempSync(join(dir, "starts-"))
  const start = (does: string) => {
    const script = `
      import { env } from "@huggingface/transformers"
      import { Effect } from "effect"
      import { readFileSync } from "node:fs"
      import * as Hub from ${JSON.stringify(join(import.meta.dir, "Hub.ts"))}
      import { files as whisper } from ${JSON.stringify(join(import.meta.dir, "Transcriber.ts"))}
      env.remoteHost = "http://127.0.0.1:${server.port}/"
      env.cacheDir = ${JSON.stringify(cache)}
      const names = ["config.json", "onnx/model.onnx"]
      const files = (get) => Promise.all(names.map((name) => get(name)))
      const read = (names) => async () => {
        for (const name of names) if (readFileSync(env.cacheDir + "/someone/whisper/" + name, "utf8") !== "whole") throw new Error("Not whole")
      }
      const exit = await Effect.runPromiseExit(${does})
      process.exit(exit._tag === "Success" ? 0 : 1)`
    const yapd = Bun.spawn([process.execPath, "-e", script], { cwd: dirname(import.meta.dir), stdout: "ignore", stderr: "ignore" })
    return { done: yapd.exited.then((code) => code === 0), stop: () => yapd.kill("SIGKILL") }
  }
  try {
    await run({ start, asked: () => asked, cache: join(cache, "someone/whisper"), stop: () => server.stop(true) })
  } finally {
    server.stop(true)
  }
}

const ahead = `Hub.cache("someone/whisper", files)`
const load = `Hub.load("someone/whisper", read(names), files)`

describe("from one start to the next", () => {
  test("keeps a model that downloaded ahead and was never loaded, and loads it offline", async () => {
    await starts(async ({ start, asked, stop }) => {
      expect(await start(ahead).done).toBe(true)
      expect(await start(ahead).done).toBe(true)
      expect(asked()).toBe(2)
      stop()
      expect(await start(load).done).toBe(true)
    })
  }, 30_000)

  test("downloads again what an older yapd left partway, and what doesn't load, keeping what is whole", async () => {
    await starts(async ({ start, asked, cache }) => {
      // As transformers.js left it when yapd was stopped as it downloaded: part of a file under its name, and no marker.
      mkdirSync(join(cache, "onnx"), { recursive: true })
      writeFileSync(join(cache, "onnx/model.onnx"), "wh")
      expect(await start(load).done).toBe(true)
      expect(asked()).toBe(2)
      // Stopped as it downloaded, by now: what's whole stays, and the rest downloads.
      rmSync(join(cache, "onnx/model.onnx"))
      writeFileSync(join(cache, "onnx/model.onnx.part"), "whole, and what was left of a longer one")
      expect(await start(load).done).toBe(true)
      expect(asked()).toBe(3)
      // Gone bad on the disk since. It can't load this time, but does the next.
      writeFileSync(join(cache, "config.json"), "wh")
      expect(await start(load).done).toBe(false)
      expect(await start(load).done).toBe(true)
      expect(existsSync(join(cache, ".yapd-loaded"))).toBe(true)
    })
  }, 30_000)

  test("keeps the weights a larger Whisper has in a file of their own from being loaded partway", async () => {
    const sent = Promise.withResolvers<void>()
    let stopped = false
    const serve = (file: string) => {
      if (file === "config.json") return Response.json({ "transformers.js_config": { use_external_data_format: { "encoder_model.onnx": true } } })
      if (file !== "onnx/encoder_model.onnx_data" || stopped) return undefined
      // The start of it, and no more for as long as yapd runs.
      return new Response(
        new ReadableStream({
          pull: async (controller) => {
            controller.enqueue(new TextEncoder().encode("wh"))
            sent.resolve()
            await Bun.sleep(20_000)
          },
        }),
        { headers: { "content-length": "5" } },
      )
    }
    await starts(async ({ start, cache }) => {
      const ahead = start(`Hub.cache("someone/whisper", whisper)`)
      await Promise.race([sent.promise, ahead.done])
      ahead.stop()
      stopped = true
      const weights = ["onnx/encoder_model.onnx", "onnx/encoder_model.onnx_data", "onnx/decoder_model_merged.onnx"]
      // transformers.js only loads what's in the cache, where all there is of each of these is whole, or it isn't there.
      expect(await start(`Hub.load("someone/whisper", read(${JSON.stringify(weights)}), whisper)`).done).toBe(true)
      expect(existsSync(join(cache, "onnx/encoder_model.onnx_data.part"))).toBe(false)
    }, serve)
  }, 30_000)

  test("loads a Whisper that has no generation config, offline too", async () => {
    const serve = (file: string) =>
      file === "generation_config.json" ? new Response("Not found", { status: 404 }) : file === "config.json" ? Response.json({}) : undefined
    await starts(async ({ start, stop }) => {
      const load = `Hub.load("someone/whisper", read(["tokenizer.json", "onnx/encoder_model.onnx"]), whisper)`
      expect(await start(load).done).toBe(true)
      stop()
      expect(await start(load).done).toBe(true)
    }, serve)
  }, 30_000)

  test("downloads a config again that couldn't be read, rather than keep to it", async () => {
    let mended = false
    const serve = (file: string) => (file !== "config.json" ? undefined : mended ? Response.json({}) : new Response("<html>Sign in to the network"))
    await starts(async ({ start }) => {
      const load = `Hub.load("someone/whisper", read(["tokenizer.json", "onnx/encoder_model.onnx"]), whisper)`
      expect(await start(load).done).toBe(false)
      mended = true
      expect(await start(load).done).toBe(true)
    }, serve)
  }, 30_000)
})

describe("headers", () => {
  test("give the user's token to Hugging Face, for a repo of their own, and to nobody else", () => {
    const token = process.env.HF_TOKEN
    process.env.HF_TOKEN = "hf_theirs"
    try {
      expect(Hub.headers("https://huggingface.co/someone/whisper/resolve/main/config.json")).toEqual({ Authorization: "Bearer hf_theirs" })
      for (const other of ["http://127.0.0.1:4999/", "https://huggingface.co.example.com/", "https://example.com/huggingface.co/"]) {
        expect(Hub.headers(`${other}someone/whisper/resolve/main/config.json`)).toEqual({})
      }
    } finally {
      if (token === undefined) delete process.env.HF_TOKEN
      else process.env.HF_TOKEN = token
    }
  })
})
