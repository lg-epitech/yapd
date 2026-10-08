import { describe, expect, test } from "bun:test"
import { json, providers } from "./Provider.ts"

const call = { prompt: "hi", model: undefined, effort: undefined, tier: undefined, schema: { json: "{}", path: "/tmp/schema.json" } }
const summary = { priority: "done", spoken: "All good." }

describe("Provider", () => {
  test("leaves the model and effort to the CLI when unset", () => {
    expect(providers.claude.command(call).argv).not.toContain("--model")
    expect(providers.claude.command(call).argv).not.toContain("--effort")
  })

  test("passes the model and effort through", () => {
    const { argv } = providers.opencode.command({ ...call, model: "anthropic/claude-sonnet-5", effort: "high" })
    expect(argv).toContain("anthropic/claude-sonnet-5")
    expect(argv.slice(argv.indexOf("--variant"), argv.indexOf("--variant") + 2)).toEqual(["--variant", "high"])
  })

  test("finds the reply in a code fence", () => {
    expect(json(`Here you go:\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toEqual(summary)
  })

  test("finds the reply after prose with braces in it", () => {
    expect(json(`The {config} loader is fixed. ${JSON.stringify(summary)} Done.`)).toEqual(summary)
  })

  test("puts Codex's effort in its config", () => {
    const { argv } = providers.codex.command({ ...call, effort: "high" })
    expect(argv).toContain("model_reasoning_effort=high")
    expect(providers.codex.command(call).argv).not.toContain("model_reasoning_effort=undefined")
  })

  test("puts Codex's tier in its config", () => {
    expect(providers.codex.command({ ...call, tier: "priority" }).argv).toContain("service_tier=priority")
    expect(providers.codex.command(call).argv.join(" ")).not.toContain("service_tier")
  })

  test("keeps Claude Code to the call itself, also when it reads through a project", () => {
    const env = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" }
    expect(providers.claude.command(call).env).toEqual(env)
    expect(providers.claude.research?.(call).env).toEqual(env)
  })

  test("points Claude's JSON reply at its structured output tool", () => {
    for (const { argv } of [providers.claude.command(call), providers.claude.research!(call)]) {
      expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("StructuredOutput")
    }
  })

  test("reads replies wrapped in a JSON envelope", () => {
    expect(providers.claude.reply?.(JSON.stringify({ result: "", structured_output: summary }))).toEqual(summary)
    expect(providers.gemini.reply?.(JSON.stringify({ response: JSON.stringify(summary) }))).toEqual(summary)
  })
})
