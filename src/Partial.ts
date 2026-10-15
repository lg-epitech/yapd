import { TextSplitterStream } from "./vendor/kokoro/splitter.js"

// A model's JSON answer, read while it's still being written. Codex streams it
// in pieces that can end anywhere, even halfway through an escape, so yapd can
// act on the first fields and start saying the first sentence long before the
// last field is written.

/** A field's value: only flat ones are read, since the model's answers are flat objects. */
export type Value = string | number | boolean | null

/** What the scanner found in what the model wrote so far. */
export type Found =
  /** A top-level field, once its value is complete. */
  | { readonly _tag: "Field"; readonly key: string; readonly value: Value }
  /** A sentence of the field being read out, as soon as it's known to have ended. */
  | { readonly _tag: "Sentence"; readonly text: string }

/** The escapes JSON has besides \u. */
const escapes: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }

type Phase =
  /** Before the object's opening brace, past anything written ahead of it. */
  | "start"
  /** Expecting a key, or the end of the object. */
  | "key"
  | "colon"
  | "value"
  /** Within a number, true, false or null, which only ends at what follows it. */
  | "literal"
  /** Within an object or array, which isn't read but mustn't be mistaken for the end. */
  | "nested"
  /** Expecting a comma or the end of the object. */
  | "after"
  | "end"

/**
 * Reads a flat JSON object fed in pieces of any size. Each top-level string,
 * number, boolean or null is reported once complete, and the string field
 * named `readOut`, like "spoken", sentence by sentence too, split as
 * Voice.split splits what Kokoro reads, so the first sentence can be rendered
 * while the model writes the rest.
 */
export class Scanner {
  /** Every complete field so far. */
  readonly fields: Record<string, Value> = {}
  private phase: Phase = "start"
  /** Inside a string: a key, a value, or one within a nested value. */
  private inString = false
  /** After a backslash, or within \u's four digits, which a piece can end halfway through. */
  private escape: string | undefined
  private text = ""
  private key = ""
  private literal = ""
  /** How deep in a nested object or array. */
  private depth = 0
  private splitter: TextSplitterStream | undefined
  /** What's been read of the field read out since the last piece was handed to the splitter. */
  private unsplit = ""

  constructor(private readonly readOut?: string) {}

  /** Reads the next piece of what the model wrote and returns what it completed, in order. */
  feed(piece: string): ReadonlyArray<Found> {
    const found: Array<Found> = []
    for (const char of piece) this.read(char, found)
    // Sentences only end on later text, so the splitter gets a whole piece at a time.
    if (this.splitter !== undefined && this.unsplit !== "") {
      this.splitter.push(this.unsplit)
      this.unsplit = ""
      this.sentences(found)
    }
    return found
  }

  private read(char: string, found: Array<Found>) {
    if (this.inString) return this.readString(char, found)
    switch (this.phase) {
      case "start":
        if (char === "{") this.phase = "key"
        return
      case "key":
        if (char === '"') this.open()
        else if (char === "}") this.phase = "end"
        return
      case "colon":
        if (char === ":") this.phase = "value"
        return
      case "value":
        if (char === '"') {
          this.open()
          if (this.key === this.readOut) this.splitter = new TextSplitterStream()
        } else if (char === "{" || char === "[") {
          this.phase = "nested"
          this.depth = 1
        } else if (!/\s/.test(char)) {
          this.phase = "literal"
          this.literal = char
        }
        return
      case "literal":
        if (char === "," || char === "}" || /\s/.test(char)) {
          this.complete(this.parse(this.literal), found)
          this.phase = "after"
          this.read(char, found)
        } else this.literal += char
        return
      case "nested":
        if (char === '"') this.open()
        else if (char === "{" || char === "[") this.depth++
        else if ((char === "}" || char === "]") && --this.depth === 0) this.phase = "after"
        return
      case "after":
        if (char === ",") this.phase = "key"
        else if (char === "}") this.phase = "end"
        return
      case "end":
        return
    }
  }

  private open() {
    this.inString = true
    this.text = ""
  }

  private readString(char: string, found: Array<Found>) {
    if (this.escape !== undefined) {
      if (this.escape === "") {
        if (char !== "u") return this.add(escapes[char] ?? char)
        this.escape = "u"
        return
      }
      this.escape += char
      if (this.escape.length === 5) this.add(String.fromCharCode(Number.parseInt(this.escape.slice(1), 16)))
      return
    }
    if (char === "\\") this.escape = ""
    else if (char === '"') this.close(found)
    else this.add(char)
  }

  /** A character of the string being read, unescaped. */
  private add(char: string) {
    this.escape = undefined
    this.text += char
    if (this.splitter !== undefined) this.unsplit += char
  }

  private close(found: Array<Found>) {
    this.inString = false
    switch (this.phase) {
      case "key":
        this.key = this.text
        this.phase = "colon"
        return
      case "value":
        if (this.splitter !== undefined) {
          this.splitter.push(this.unsplit)
          this.unsplit = ""
          this.splitter.close()
          this.sentences(found)
          this.splitter = undefined
        }
        this.complete(this.text, found)
        this.phase = "after"
        return
      // A string inside a nested value, which is skipped.
      default:
        return
    }
  }

  private sentences(found: Array<Found>) {
    for (const text of this.splitter!.sentences.splice(0)) found.push({ _tag: "Sentence", text })
  }

  private complete(value: Value | undefined, found: Array<Found>) {
    // Something no JSON value looks like is left out rather than guessed at.
    if (value === undefined) return
    this.fields[this.key] = value
    found.push({ _tag: "Field", key: this.key, value })
  }

  private parse(literal: string): Value | undefined {
    try {
      const value: unknown = JSON.parse(literal)
      return typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined
    } catch {
      return undefined
    }
  }
}
