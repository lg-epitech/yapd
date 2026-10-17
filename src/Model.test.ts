import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Fiber, Schema, TestClock, TestContext } from "effect"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Model, ProviderModel } from "./Model.ts"

describe("Model", () => {
  test("uses codex exec when an initialized app-server stops answering thread requests", async () => {
    const folder = await mkdtemp(join(tmpdir(), "yapd-model-test-"))
    const path = process.env.PATH
    const log = join(folder, "calls")
    const codex = join(folder, "codex")
    await Bun.write(codex, `#!${process.execPath}
      const { appendFileSync } = require("node:fs")
      const record = (message) => appendFileSync(${JSON.stringify(log)}, message + "\\n")
      if (process.argv.includes("mcp")) { console.log("[]"); process.exit(0) }
      if (process.argv.includes("exec")) { record("exec"); console.log(JSON.stringify({ answer: "fallback" })); process.exit(0) }
      for await (const line of console) {
        const message = JSON.parse(line)
        if (message.id === undefined) continue
        record(message.method)
        if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {} }))
      }
    `)
    await chmod(codex, 0o755)
    process.env.PATH = folder
    try {
      const answer = await Effect.runPromise(Effect.gen(function* () {
        const model = yield* Model
        const pending = yield* Effect.fork(model.ask(Schema.Struct({ answer: Schema.String }), "test"))
        while ((yield* Effect.promise(() => readFile(log, "utf8").catch(() => ""))).split("thread/start").length < 4) {
          yield* Effect.promise(() => Bun.sleep(5))
        }
        yield* TestClock.adjust("15 seconds")
        return yield* Fiber.join(pending)
      }).pipe(
        Effect.provide(ProviderModel),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_PROVIDER", "codex"]]))),
        Effect.provide(TestContext.TestContext),
      ))
      expect(answer).toEqual({ answer: "fallback" })
      expect((await readFile(log, "utf8")).split("\n").filter((line) => line === "exec")).toHaveLength(1)
    } finally {
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      await rm(folder, { recursive: true, force: true })
    }
  })
})
