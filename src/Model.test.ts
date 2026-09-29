import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { talking, writing } from "./Model.ts"

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
})
