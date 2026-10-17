import { describe, expect, test } from "bun:test"
import { json, providers } from "./Provider.ts"

const summary = { priority: "done", spoken: "All good." }

describe("Provider", () => {
  test("finds the reply in a code fence", () => {
    expect(json(`Here you go:\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toEqual(summary)
  })

  test("finds the reply after prose with braces in it", () => {
    expect(json(`The {config} loader is fixed. ${JSON.stringify(summary)} Done.`)).toEqual(summary)
  })

  test("reads replies wrapped in a JSON envelope", () => {
    expect(providers.claude.reply?.(JSON.stringify({ result: "", structured_output: summary }))).toEqual(summary)
    expect(providers.gemini.reply?.(JSON.stringify({ response: JSON.stringify(summary) }))).toEqual(summary)
  })
})
