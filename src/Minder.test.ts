import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { fstatSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Minder from "./Minder.ts"
import * as Sessions from "./Sessions.ts"

const session: Sessions.Session = {
  launch: "launch-1",
  agent: "claude",
  session: "session-1",
  project: "free-sound",
  directory: "/code/free-sound",
  repository: true,
  model: "claude-fable-5-1",
  prompt: "Fix the loader.",
  resume: false,
  state: "running",
  at: "2026-09-29T18:00:00.000Z",
}

const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "yapd-minder-test-"))),
  use,
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

const open = (fd: number) => {
  try {
    fstatSync(fd)
    return true
  } catch {
    return false
  }
}

describe("Minder", () => {
  test("closes the launching process's log descriptor after every minder starts", async () => {
    const result = await Effect.runPromise(withRoot((root) => Effect.gen(function* () {
      const descriptors: Array<number> = []
      const closed: Array<boolean> = []
      const start = Minder.makeStart(root, (launch, output) => {
        descriptors.push(output)
        writeFileSync(Sessions.record(launch, root), JSON.stringify({ ...session, launch, state: "running" }))
        return { unref: () => {} }
      })
      for (let i = 0; i < 3; i++) {
        yield* start({ ...session, launch: `launch-${i}` })
        closed.push(!open(descriptors.at(-1)!))
      }
      return closed
    })))
    expect(result).toEqual([true, true, true])
  })

  test("records the session and final message while consuming both output streams", async () => {
    const result = await Effect.runPromise(withRoot((root) => Effect.gen(function* () {
      yield* Sessions.write({ ...session, directory: root, state: "starting" }, root)
      yield* Minder.mind(session.launch, root, [process.execPath, "-e", `
        console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "named-session" }));
        console.log(JSON.stringify({ type: "assistant", message: { model: "fake-model" } }));
        process.stderr.write("a diagnostic\\n");
        process.stdout.write(JSON.stringify({ type: "result", result: "Done, café.", is_error: false }));
      `])
      return { record: yield* Sessions.read(session.launch, root), log: yield* Effect.promise(() => Bun.file(Sessions.log(session.launch, root)).text()) }
    })))
    expect(result.record).toMatchObject(Option.some({ ...session, directory: expect.any(String), session: "named-session", state: "idle" }))
    expect(result.log).toContain("a diagnostic")
    expect(result.log).toContain("Done, café.")
  })
})
