import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Sessions from "./Sessions.ts"

const session: Sessions.Session = {
  launch: "launch-1", agent: "codex", project: "yapd", directory: "/code/yapd",
  repository: true, model: "example", prompt: "Fix it.", resume: false,
  state: "starting", at: "2026-09-29T18:00:00.000Z",
}

describe("Sessions", () => {
  test("atomically replaces private records and leaves no temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "yapd-sessions-"))
    try {
      await Effect.runPromise(Sessions.write(session, root))
      await Effect.runPromise(Sessions.write({ ...session, state: "idle" }, root))
      expect(Option.getOrThrow(await Effect.runPromise(Sessions.read(session.launch, root))).state).toBe("idle")
      expect((await stat(Sessions.record(session.launch, root))).mode & 0o777).toBe(0o600)
      expect(await readdir(root)).toEqual(["launch-1.json"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports storage failures in the error channel and cleans failed replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "yapd-sessions-"))
    try {
      const blocked = join(root, "blocked")
      await writeFile(blocked, "not a directory")
      const exit = await Effect.runPromiseExit(Sessions.write(session, blocked))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Array.from(Cause.defects(exit.cause))).toEqual([])
        expect(Array.from(Cause.failures(exit.cause))[0]).toBeInstanceOf(Sessions.StorageError)
      }
      await mkdir(Sessions.record(session.launch, root))
      await expect(Effect.runPromise(Sessions.write(session, root))).rejects.toThrow()
      expect((await readdir(root)).sort()).toEqual(["blocked", "launch-1.json"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
