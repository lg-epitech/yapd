import { describe, expect, test } from "bun:test"
import { type Found, Scanner } from "./Partial.ts"
import { TextSplitterStream } from "./vendor/kokoro/splitter.js"

/** Everything the scanner reports, and the fields it has, once it was fed these pieces. */
const scan = (pieces: ReadonlyArray<string>) => {
  const scanner = new Scanner("spoken")
  return { found: pieces.flatMap((piece) => scanner.feed(piece)), fields: scanner.fields }
}

/** `text` in two pieces split at each place, then one character at a time. */
const splits = (text: string) => [
  ...Array.from({ length: text.length + 1 }, (_, at) => [text.slice(0, at), text.slice(at)]),
  [...text],
]

const sentences = (text: string) => {
  const splitter = new TextSplitterStream()
  splitter.push(text)
  splitter.close()
  return [...splitter]
}

describe("Scanner", () => {
  test("the scanner reads fields split across chunks", () => {
    const text = `{"act": "send", "target":"t4","sure":"high","count":-12.5e1,"quick":true,"rest":null,"skip":{"a":"}","b":[1,"]"]},"spoken":"On it, sir. I'll tell it to merge."}`
    for (const pieces of splits(text)) {
      const { found, fields } = scan(pieces)
      expect(found.filter((entry) => entry._tag === "Field")).toEqual([
        { _tag: "Field", key: "act", value: "send" },
        { _tag: "Field", key: "target", value: "t4" },
        { _tag: "Field", key: "sure", value: "high" },
        { _tag: "Field", key: "count", value: -125 },
        { _tag: "Field", key: "quick", value: true },
        { _tag: "Field", key: "rest", value: null },
        { _tag: "Field", key: "spoken", value: "On it, sir. I'll tell it to merge." },
      ])
      expect(fields).toEqual({ ...JSON.parse(text), skip: undefined })
    }
  })

  test("says each sentence as soon as the next one starts, before the field is done", () => {
    const text = `{"priority":"done","spoken":"yapd's tests pass. The loader is fixed, and nothing needs you."}`
    const scanner = new Scanner("spoken")
    const heard: Array<{ readonly at: number; readonly found: Found }> = []
    ;[...text].forEach((char, at) => {
      for (const found of scanner.feed(char)) heard.push({ at, found })
    })
    expect(heard.map(({ found }) => found)).toEqual([
      { _tag: "Field", key: "priority", value: "done" },
      { _tag: "Sentence", text: "yapd's tests pass." },
      { _tag: "Sentence", text: "The loader is fixed, and nothing needs you." },
      { _tag: "Field", key: "spoken", value: "yapd's tests pass. The loader is fixed, and nothing needs you." },
    ])
    // The first sentence is out as soon as the second one's first letter is written.
    expect(heard[1]?.at).toBe(text.indexOf("The"))
  })

  test("unescapes what's split across chunks, even halfway through an escape", () => {
    const spoken = `He said "stop".\nThen it’s done \\ 😀 for real.\tNext: the café's menu.`
    // As a model writes it, with the curly quote and the emoji as \u escapes.
    const text = `{"spoken":${JSON.stringify(spoken).replace("’", "\\u2019").replace("😀", "\\ud83d\\ude00")},"sure":"high"}`
    expect(text).toContain("\\u2019")
    for (const pieces of splits(text)) {
      const { found, fields } = scan(pieces)
      expect(fields).toEqual({ spoken, sure: "high" })
      expect(found.flatMap((entry) => (entry._tag === "Sentence" ? [entry.text] : []))).toEqual(sentences(spoken))
    }
  })
})
