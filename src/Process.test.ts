import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "./Process.ts"

describe("Process", () => {
  test("fails, rather than dies, when the command can't start", async () => {
    const error = await Effect.runPromise(Effect.flip(run([join(tmpdir(), "yapd-no-such-command")])))
    expect(error).toMatchObject({ _tag: "ProcessError", code: -1 })
  })

  test("runs in the given directory", async () => {
    expect((await Effect.runPromise(run(["pwd"], { cwd: "/" }))).trim()).toBe("/")
  })
})
