import { expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { modelSettings } from "./ModelSettings.ts"

const resolve = (settings: Record<string, string>) => Effect.runSync(modelSettings.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(settings))))))

test("V2 uses its defaults without legacy model settings", () => {
  expect(resolve({})).toEqual({ model: "gpt-6.1-sol", effort: "low" })
})

test.each([undefined, "codex"])("legacy Codex settings remain compatible with provider %s", (provider) => {
  expect(resolve({ ...(provider === undefined ? {} : { YAPD_PROVIDER: provider }), YAPD_MODEL: "gpt-6-sol", YAPD_EFFORT: "high", YAPD_TIER: "priority" }))
    .toEqual({ model: "gpt-6-sol", effort: "high", tier: "priority" })
})

test.each(["claude", "opencode", "obsolete-provider"])("%s model settings cannot enter the V2 Codex session", (provider) => {
  expect(resolve({ YAPD_PROVIDER: provider, YAPD_MODEL: "sonnet", YAPD_EFFORT: "max", YAPD_TIER: "foreign-tier" }))
    .toEqual({ model: "gpt-6.1-sol", effort: "low" })
})

test.each(["codex", "claude", "obsolete-provider"])("explicit V2 settings win with legacy provider %s", (provider) => {
  expect(resolve({ YAPD_PROVIDER: provider, YAPD_MODEL: "old-model", YAPD_EFFORT: "max", YAPD_TIER: "old-tier", YAPD_BRAIN_MODEL: "gpt-6.1-sol", YAPD_BRAIN_EFFORT: "medium", YAPD_BRAIN_TIER: "priority" }))
    .toEqual({ model: "gpt-6.1-sol", effort: "medium", tier: "priority" })
})
