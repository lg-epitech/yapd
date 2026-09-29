import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { providers } from "./Provider.ts"
import * as Remote from "./Remote.ts"
import * as Research from "./Research.ts"

const request: Research.Request = { directory: "/home/me/yapd", prompt: "What does the loader do?; rm -rf ~", schema: { type: "object" } }

const reading = (reply: unknown): Research.Researcher => ({ available: true, research: () => Effect.succeed(reply) })

describe("Research", () => {
  test("answers yapd research with what the model wrote, or why there's nothing", async () => {
    const served = await Effect.runPromise(Research.serve(reading({ prompt: "Fix it." }), JSON.stringify(request)))
    expect(JSON.parse(served)).toEqual({ reply: { prompt: "Fix it." } })
    expect(served).not.toContain("\n")
    const refused = await Effect.runPromise(Research.serve(Research.unavailable("opencode can't be kept from changing a project."), JSON.stringify(request)))
    expect(JSON.parse(refused)).toEqual({ reason: "opencode can't be kept from changing a project." })
    expect(JSON.parse(await Effect.runPromise(Research.serve(reading({}), "{}")))).toEqual({
      reason: "yapd here and on the machine that speaks don't match. Update both.",
    })
  })

  test("runs yapd research on the machine the project is on, with the request on stdin", async () => {
    const calls: Array<{ command: ReadonlyArray<string>; stdin: string }> = []
    const researcher = Remote.researcher("rig", "me@rig.example.com", (command, stdin) =>
      Effect.sync(() => {
        calls.push({ command, stdin })
        return `welcome to rig\n${JSON.stringify({ reply: { prompt: "Fix it." } })}\n`
      }),
    )
    expect(await Effect.runPromise(researcher.research(request))).toEqual({ prompt: "Fix it." })
    expect(calls[0]?.command).toEqual([
      "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "me@rig.example.com", "cd / && yapd research",
    ])
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual(request)
  })
})

describe("Read-only", () => {
  const call = { prompt: "hi", model: undefined, effort: undefined, tier: undefined, schema: { json: "{}", path: "/tmp/schema.json" } }

  test("keeps the CLI that reads through a project from changing it", () => {
    const codex = providers.codex.research!(call).argv
    expect(codex.slice(codex.indexOf("--sandbox"), codex.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"])
    expect(codex).toContain("--ignore-user-config")
    expect(codex.slice(codex.indexOf("--disable"), codex.indexOf("--disable") + 2)).toEqual(["--disable", "hooks"])
    const claude = providers.claude.research!(call).argv
    expect(claude.slice(claude.indexOf("--tools"), claude.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Glob,Grep"])
    expect(claude).toContain("--strict-mcp-config")
    expect(claude.slice(claude.indexOf("--setting-sources"), claude.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", ""])
  })

  test("doesn't read through projects with a CLI that can't be kept from writing", () => {
    for (const name of ["grok", "antigravity", "opencode", "cursor", "gemini"] as const) expect(providers[name].research).toBeUndefined()
  })
})
