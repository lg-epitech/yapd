import { describe, expect, spyOn, test } from "bun:test"
import { ConfigProvider, Effect, Fiber, Schema, TestClock, TestContext } from "effect"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Model, ProviderModel, talking, writing } from "./Model.ts"

const chosen = (settings: Record<string, string>) =>
  Effect.runPromise(
    Effect.all({ talking, writing }).pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(settings))))),
  )

describe("Model", () => {
  test("writes prompts with what writes summaries, unless told otherwise", async () => {
    const usual = { name: "codex", model: "gpt-6-luna", effort: "high", tier: "priority" } as const
    expect(await chosen({})).toEqual({ talking: usual, writing: usual })
    const set = { name: "codex", model: "gpt-6-sol", effort: "low", tier: "priority" } as const
    expect(await chosen({ YAPD_MODEL: "gpt-6-sol", YAPD_EFFORT: "low", YAPD_TIER: "priority" })).toEqual({ talking: set, writing: set })
    // A model of its own leaves the effort and tier of summaries behind.
    const { talking, writing } = await chosen({ YAPD_EFFORT: "low", YAPD_WRITER_MODEL: "gpt-6-astra", YAPD_WRITER_EFFORT: "medium" })
    expect(talking).toEqual({ name: "codex", model: "gpt-6-luna", effort: "low", tier: "priority" })
    expect(writing).toEqual({ name: "codex", model: "gpt-6-astra", effort: "medium", tier: undefined })
  })

  test("reports a temporary-schema write failure as ModelError before starting a provider", async () => {
    const cause = new Error("schema disk unavailable")
    const original = Bun.write
    let file: string | undefined
    const write = spyOn(Bun, "write").mockImplementationOnce(async (...args) => {
      file = String(args[0])
      await original(file, String(args[1]))
      throw cause
    })
    try {
      const error = await Effect.runPromise(Effect.gen(function* () {
        const model = yield* Model
        return yield* Effect.flip(model.ask(Schema.Struct({ answer: Schema.String }), "test"))
      }).pipe(
        Effect.provide(ProviderModel),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_PROVIDER", "claude"]]))),
      ))
      expect(error).toMatchObject({ _tag: "ModelError", cause: { _tag: "UnknownException", error: cause } })
      expect(file === undefined ? undefined : await Bun.file(file).exists()).toBe(false)
    } finally {
      write.mockRestore()
    }
  })

  test("runs the CLI with what its provider adds to the environment", async () => {
    const folder = await mkdtemp(join(tmpdir(), "yapd-model-test-"))
    const path = process.env.PATH
    const claude = join(folder, "claude")
    await Bun.write(claude, `#!${process.execPath}
      const seen = { traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, internal: process.env.YAPD_INTERNAL }
      console.log(JSON.stringify({ structured_output: { answer: JSON.stringify(seen) } }))
    `)
    await chmod(claude, 0o755)
    process.env.PATH = folder
    try {
      const { answer } = await Effect.runPromise(Effect.gen(function* () {
        const model = yield* Model
        return yield* model.ask(Schema.Struct({ answer: Schema.String }), "test")
      }).pipe(
        Effect.provide(ProviderModel),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["YAPD_PROVIDER", "claude"]]))),
      ))
      expect(JSON.parse(answer)).toEqual({ traffic: "1", internal: "1" })
    } finally {
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      await rm(folder, { recursive: true, force: true })
    }
  })

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
