import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifacts, downloadVerified, run, serverCommand, verified, type Artifact } from "./AsrServer.ts"

const temporary = async (use: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "yapd-asr-runner-test-"))
  try { await use(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
const specification = (text: string): Artifact => ({ url: "https://example.invalid/test-artifact", size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") })
const fetcher = (request: () => Promise<Response>): typeof fetch => Object.assign(request, { preconnect: () => {} })
const fetched = (response: Response): typeof fetch => fetcher(async () => response)
const until = async (ready: () => Promise<boolean>) => {
  const started = performance.now()
  while (!(await ready())) {
    if (performance.now() - started > 1000) throw new Error("The artifact writer did not reach its expected state.")
    await Bun.sleep(1)
  }
}

describe("V2 pinned self-host ASR runner", () => {
  test("check and missing-cache runs are offline, create nothing, and cannot load a model", async () => {
    await temporary(async (directory) => {
      const logs: Array<string> = []
      let network = 0
      const dependencies = { modelsDirectory: directory, platform: "linux", arch: "x64", log: (line: string) => { logs.push(line) }, fetch: fetcher(async () => { network++; throw new Error("network forbidden") }) }
      expect(await run({ download: false, check: true }, dependencies)).toBe(1)
      expect(await run({ download: false }, dependencies)).toBe(1)
      // Even this combination cannot make --check perform a download.
      expect(await run({ download: true, check: true }, dependencies)).toBe(1)
      expect(network).toBe(0)
      expect(await readdir(directory)).toEqual([])
      expect(logs.every((line) => line.includes("--download"))).toBe(true)
    })
  })

  test("unsupported platforms are refused before filesystem or network setup", async () => {
    await temporary(async (directory) => {
      const logs: Array<string> = []
      const dependencies = { modelsDirectory: directory, log: (line: string) => { logs.push(line) }, fetch: fetcher(async () => { throw new Error("network forbidden") }) }
      expect(await run({ download: true }, { ...dependencies, platform: "darwin", arch: "arm64" })).toBe(1)
      expect(await run({ download: true }, { ...dependencies, platform: "linux", arch: "arm64" })).toBe(1)
      expect(await readdir(directory)).toEqual([])
      expect(logs.every((line) => line.includes("Linux x64 CPU only"))).toBe(true)
    })
  })

  test("offline check rejects tampered caches without modifying them", async () => {
    await temporary(async (directory) => {
      const cache = join(directory, "v2-asr", "nemo-speech-0.3.0")
      await mkdir(cache, { recursive: true })
      await writeFile(join(cache, "runtime.tar.gz"), "a tampered archive")
      await writeFile(join(cache, "model.gguf"), "a tampered model")
      expect(await run({ download: false, check: true }, { modelsDirectory: directory, platform: "linux", arch: "x64", log: () => {} })).toBe(1)
      expect(await readFile(join(cache, "model.gguf"), "utf8")).toBe("a tampered model")
      expect((await readdir(cache)).sort()).toEqual(["model.gguf", "runtime.tar.gz"])
    })
  })

  test("verifies complete regular files by digest and refuses symlink cache entries", async () => {
    await temporary(async (directory) => {
      const path = join(directory, "artifact")
      await writeFile(path, "verified bytes")
      expect(await verified(path, specification("verified bytes"))).toBe(true)
      expect(await verified(path, specification("different text"))).toBe(false)
      const link = join(directory, "linked")
      await symlink(path, link)
      expect(await verified(link, specification("verified bytes"))).toBe(false)
      expect(await verified(join(directory, "missing"), specification("verified bytes"))).toBe(false)
    })
  })

  test("streams multiple chunks to a private partial file and publishes only verified complete bytes", async () => {
    await temporary(async (directory) => {
      const path = join(directory, "artifact")
      let stream!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller } })
      const download = downloadVerified(specification("first second"), path, { fetch: fetched(new Response(body)) })
      stream.enqueue(new TextEncoder().encode("first "))
      await until(async () => (await readdir(directory)).some((name) => name.startsWith("artifact.partial-")))
      expect(await Bun.file(path).exists()).toBe(false)
      stream.enqueue(new TextEncoder().encode("second")); stream.close()
      await download
      expect(await readFile(path, "utf8")).toBe("first second")
      expect(await verified(path, specification("first second"))).toBe(true)
      expect(await readdir(directory)).toEqual(["artifact"])
    })
  })

  test("bad hashes, short or oversized responses preserve prior files and remove all partials", async () => {
    await temporary(async (directory) => {
      const path = join(directory, "artifact")
      await writeFile(path, "previous cache")
      for (const response of [new Response("corrupt bytes"), new Response("short"), new Response("far too many bytes in this response"), new Response("", { status: 503 })]) {
        await expect(downloadVerified(specification("correct bytes"), path, { fetch: fetched(response) })).rejects.toThrow()
        expect(await readFile(path, "utf8")).toBe("previous cache")
        expect(await readdir(directory)).toEqual(["artifact"])
      }
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } })
      await expect(downloadVerified(specification("bytes"), path, { fetch: fetched(new Response(body, { headers: { "content-length": "9999" } })) })).rejects.toThrow("pinned size")
      expect(cancelled).toBe(true)
      expect(await readdir(directory)).toEqual(["artifact"])
    })
  })

  test("abort cancels a pending stream and cleans partial bytes without publishing them", async () => {
    await temporary(async (directory) => {
      const path = join(directory, "artifact")
      let stream!: ReadableStreamDefaultController<Uint8Array>
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller }, cancel: () => { cancelled = true } })
      const controller = new AbortController()
      const download = downloadVerified(specification("complete artifact"), path, { fetch: fetched(new Response(body)), signal: controller.signal })
      stream.enqueue(new TextEncoder().encode("partial"))
      await until(async () => (await readdir(directory)).length === 1)
      controller.abort()
      await expect(download).rejects.toThrow()
      expect(cancelled).toBe(true)
      expect(await readdir(directory)).toEqual([])
    })
  })

  test("pins immutable publisher artifacts and keeps shell characters literal in server arguments", () => {
    expect(artifacts.runtime.size + artifacts.model.size).toBe(751_695_565)
    expect(artifacts.runtime.url).toContain("/v0.3.0/nemo-speech-0.3.0-linux-x86_64-cpu.tar.gz")
    expect(artifacts.model.url).toContain("/resolve/ea30d66debe3740a08b573244286791d423d6b3e/")
    expect(artifacts.sources.runtimeChecksum).toBe(`${artifacts.runtime.url}.sha256`)
    const binary = "/cache with spaces/$(touch nope);runtime"
    const model = "/cache with spaces/;model.gguf"
    const args = serverCommand(binary, model)
    expect(args.slice(0, 5)).toEqual(["nice", "-n", "15", binary, "serve"])
    expect(args[args.indexOf("--asr-model") + 1]).toBe(model)
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1")
    expect(args[args.indexOf("--port") + 1]).toBe("8769")
    expect(args[args.indexOf("--threads") + 1]).toBe("2")
    expect(args[args.indexOf("--asr.endpointing.enable") + 1]).toBe("false")
  })
})
