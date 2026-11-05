import { expect, test } from "bun:test"
import { spokenText } from "./SpokenText.ts"

test("presentation is removed while technical values, negations and code contents are retained", () => {
  const spoken = spokenText("# Cryptio\n\n1. **Solana:** 17–32k errors became 170.\n2. *RTG:* do not merge __Unichain__; [DATA-3064](https://example.com/issue) blocks it.\n\n> `foo_bar`, `Map<string, int>` and `x**2` remain relevant.\n\n```ts\nconst x = 2 ** 3;\n```\n\n| Migration | State |\n|---|---|\n| TON | draft !272 |")
  expect(spoken).toContain("Cryptio")
  expect(spoken).toContain("Solana: 17–32k errors became 170.")
  expect(spoken).toContain("RTG: do not merge Unichain; DATA-3064 blocks it.")
  expect(spoken).toContain("foo_bar, Map<string, int> and x**2")
  expect(spoken).toContain("const x = 2 ** 3;")
  expect(spoken).toContain("TON; draft !272")
  expect(spoken).not.toMatch(/\*\*Solana|__Unichain__|```|https:\/\/|^\s*[>#|]/m)
  expect(spokenText("2 ** 3 and 2 **3, not 2 * 3.")).toBe("2 ** 3 and 2 **3, not 2 * 3.")
})
