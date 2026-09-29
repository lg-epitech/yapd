import { env } from "@huggingface/transformers"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
