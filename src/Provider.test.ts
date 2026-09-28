import { describe, expect, test } from "bun:test"
import { providers } from "./Provider.ts"

const call = { prompt: "hi", model: undefined, effort: undefined, schema: { json: "{}", path: "/tmp/schema.json" } }
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

  test("finds the reply in prose or a code fence", () => {
    expect(providers.grok.reply(`Here you go:\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toEqual(summary)
  })

  test("reads replies wrapped in a JSON envelope", () => {
    expect(providers.claude.reply(JSON.stringify({ result: "", structured_output: summary }))).toEqual(summary)
    expect(providers.gemini.reply(JSON.stringify({ response: JSON.stringify(summary) }))).toEqual(summary)
  })
})
