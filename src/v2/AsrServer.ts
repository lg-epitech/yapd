import type { Subprocess } from "bun"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import * as Home from "../Home.ts"

export interface Artifact {
  readonly url: string
  readonly size: number
  readonly sha256: string
}

const release = "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0"
const archiveRoot = "nemo-speech-0.3.0-linux-x86_64-cpu"
export const artifacts = {
  runtime: { url: `${release}/${archiveRoot}.tar.gz`, size: 9_605_101, sha256: "255f12b722ab15b2a38a51cf125d56e3fa97058b528f7e895b39d6a473deb06e" },
  model: {
    url: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/ea30d66debe3740a08b573244286791d423d6b3e/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
    size: 742_090_464,
    sha256: "3fc991d3badad7277c11030a7519832cddaf2057aafed6d4b25147e953a070b1",
  },
  sources: {
    runtimeChecksum: `${release}/${archiveRoot}.tar.gz.sha256`,
    modelMetadata: "https://huggingface.co/api/models/nvidia/nemotron-3.5-asr-streaming-0.6b/revision/ea30d66debe3740a08b573244286791d423d6b3e?blobs=true",
  },
} as const

const checkAbort = (signal?: AbortSignal) => { signal?.throwIfAborted() }

/** Reads only regular files, streaming the digest without loading weights. */
export const verified = async (path: string, artifact: Artifact, signal?: AbortSignal): Promise<boolean> => {
  checkAbort(signal)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size) return false
    const hash = createHash("sha256")
    let bytes = 0
    for await (const chunk of createReadStream(path, { ...(signal === undefined ? {} : { signal }) })) {
      checkAbort(signal)
      bytes += chunk.length
      if (bytes > artifact.size) return false
      hash.update(chunk)
    }
    return bytes === artifact.size && hash.digest("hex") === artifact.sha256
  } catch (error) {
    checkAbort(signal)
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

/** The only published file is a complete, size-checked, digest-checked download. */
export const downloadVerified = async (artifact: Artifact, path: string, options: {
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
} = {}): Promise<void> => {
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Invalid ASR artifact verification metadata.")
  const partial = `${path}.partial-${crypto.randomUUID()}`
  const signal = options.signal === undefined ? AbortSignal.timeout(15 * 60_000) : AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60_000)])
  let file: Awaited<ReturnType<typeof open>> | undefined
  let response: Response | undefined
  let reader: { cancel(reason?: unknown): Promise<void>; releaseLock(): void } | undefined
  const onAbort = () => { void reader?.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    checkAbort(signal)
    response = await (options.fetch ?? fetch)(artifact.url, { signal })
    checkAbort(signal)
    if (!response.ok || response.body === null) throw new Error(`ASR artifact download failed (${response.status}).`)
    const advertised = response.headers.get("content-length")
    if (advertised !== null && Number(advertised) > artifact.size) throw new Error("ASR artifact exceeded its pinned size.")
    file = await open(partial, "wx", 0o600)
    const hash = createHash("sha256")
    let size = 0
    const activeReader = response.body.getReader()
    reader = activeReader
    while (true) {
      checkAbort(signal)
      const item = await activeReader.read()
      checkAbort(signal)
      if (item.done) break
      const chunk = item.value
      size += chunk.length
      if (size > artifact.size) throw new Error("ASR artifact exceeded its pinned size.")
      hash.update(chunk)
      for (let offset = 0; offset < chunk.length;) {
        const written = await file.write(chunk, offset, chunk.length - offset)
        if (written.bytesWritten === 0) throw new Error("ASR artifact download could not be written.")
        offset += written.bytesWritten
      }
    }
    if (size !== artifact.size || hash.digest("hex") !== artifact.sha256) throw new Error("ASR artifact failed its pinned size or SHA256 verification.")
    await file.sync(); await file.close(); file = undefined
    checkAbort(signal)
    await rename(partial, path)
  } finally {
    signal.removeEventListener("abort", onAbort)
    if (reader !== undefined) { await reader.cancel().catch(() => {}); reader.releaseLock() }
    else await response?.body?.cancel().catch(() => {})
    await file?.close()
    await rm(partial, { force: true })
  }
}

/** Argument arrays keep cache paths literal; no shell parses them. */
export const serverCommand = (binary: string, model: string): ReadonlyArray<string> => [
  "nice", "-n", "15", binary, "serve", "--asr-model", model,
  "--backend", "cpu", "--host", "127.0.0.1", "--port", "8769", "--threads", "2", "--no-ui", "--max-upload-mb", "8",
  "--asr.endpointing.enable", "false",
]

export interface RunOptions { readonly download: boolean; readonly check?: boolean }
export interface RunDependencies {
  readonly modelsDirectory?: string
  readonly platform?: string
  readonly arch?: string
  readonly fetch?: typeof fetch
  readonly log?: (message: string) => void
}

/** Foreground local runner. --check never downloads, extracts or loads a model. */
export const run = async (options: RunOptions, dependencies: RunDependencies = {}): Promise<number> => {
  const log = dependencies.log ?? console.error
  if ((dependencies.platform ?? process.platform) !== "linux" || (dependencies.arch ?? process.arch) !== "x64") {
    log("The bundled V2 ASR runner supports Linux x64 CPU only. Run it on a supported server and configure its self-hosted WebSocket endpoint.")
    return 1
  }
  const directory = join(dependencies.modelsDirectory ?? Home.models, "v2-asr", "nemo-speech-0.3.0")
  const runtime = join(directory, "runtime.tar.gz")
  const model = join(directory, "model.gguf")
  const abort = new AbortController()
  let interrupted: "SIGINT" | "SIGTERM" | undefined
  let current: Subprocess | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let extracted: string | undefined
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    interrupted = signal
    abort.abort(new DOMException("ASR setup or server was interrupted.", "AbortError"))
    const child = current
    if (child !== undefined) {
      try { child.kill(signal) } catch { /* It may have exited already. */ }
      killTimer ??= setTimeout(() => { try { child.kill("SIGKILL") } catch { /* Already reaped. */ } }, 2000)
    }
  }
  const onInt = () => stop("SIGINT")
  const onTerm = () => stop("SIGTERM")
  process.once("SIGINT", onInt); process.once("SIGTERM", onTerm)
  const command = async (args: ReadonlyArray<string>, capture = false): Promise<string> => {
    checkAbort(abort.signal)
    const child = Bun.spawn([...args], { stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: capture ? "pipe" : "inherit" })
    current = child
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited,
        capture ? new Response(child.stdout).text() : Promise.resolve(""),
        capture ? new Response(child.stderr).text() : Promise.resolve(""),
      ])
      checkAbort(abort.signal)
      if (code !== 0) throw new Error(`ASR command failed (${code})${capture && stderr.trim() !== "" ? `: ${stderr.trim()}` : "."}`)
      return stdout
    } finally {
      if (killTimer !== undefined) clearTimeout(killTimer)
      killTimer = undefined
      if (current === child) current = undefined
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await child.exited }
    }
  }
  try {
    const cached = new Map<string, boolean>()
    for (const [path, artifact] of [[runtime, artifacts.runtime], [model, artifacts.model]] as const) cached.set(path, await verified(path, artifact, abort.signal))
    if (options.check === true) {
      const ready = [...cached.values()].every(Boolean)
      log(ready ? `Verified ASR cache ready at ${directory}. No model was loaded.` : `ASR cache is missing or unverified at ${directory}. Run yapd v2-asr --download on Linux x64 to set it up.`)
      return ready ? 0 : 1
    }
    if (![...cached.values()].every(Boolean)) {
      if (!options.download) {
        log(`ASR cache is missing or unverified at ${directory}. Run yapd v2-asr --download to download the pinned 0.3.0 CPU runtime and Nemotron 3.5 Q8 model (751,695,565 bytes total).`)
        return 1
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      for (const [path, artifact] of [[runtime, artifacts.runtime], [model, artifacts.model]] as const) if (!cached.get(path)) {
        log(`Downloading and verifying ${path === runtime ? "ASR CPU runtime" : "Nemotron 3.5 Q8 model"} (${artifact.size} bytes).`)
        await downloadVerified(artifact, path, { ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }), signal: abort.signal })
      }
    }
    // The archive is verified on every start. Extracting it privately avoids
    // trusting an executable modified between separate foreground sessions.
    extracted = await mkdtemp(join(directory, ".runtime-"))
    const listing = await command(["tar", "-tzf", runtime], true)
    for (const entry of listing.split("\n").filter(Boolean)) {
      const name = entry.replace(/^\.\//, "").replace(/\/$/, "")
      if (name === "" || name === ".") continue
      if ((name !== archiveRoot && !name.startsWith(`${archiveRoot}/`)) || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error("The pinned ASR archive contains an unsafe path.")
    }
    await command(["tar", "-xzf", runtime, "--no-same-owner", "--no-same-permissions", "-C", extracted], true)
    const binary = join(extracted, archiveRoot, "bin", "nemo-speech")
    if (!(await lstat(binary)).isFile()) throw new Error("The pinned ASR runtime has no regular executable.")
    log("Starting native ASR on ws://127.0.0.1:8769/v1/audio/transcriptions/realtime (CPU, manual commit). Stop with Ctrl-C.")
    await command(serverCommand(binary, model))
    return 0
  } catch (error) {
    if (interrupted !== undefined) return interrupted === "SIGINT" ? 130 : 143
    log(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm)
    if (killTimer !== undefined) clearTimeout(killTimer)
    if (current !== undefined && current.exitCode === null && current.signalCode === null) { current.kill("SIGKILL"); await current.exited }
    if (extracted !== undefined) await rm(extracted, { recursive: true, force: true })
  }
}
