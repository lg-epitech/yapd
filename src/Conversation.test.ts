import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import * as Condenser from "./Condenser.ts"
import { cut } from "./Conversation.ts"
import * as Helper from "./Helper.ts"
import * as Responder from "./Responder.ts"
import { clean } from "./Transcriber.ts"

describe("Conversation", () => {
  test("keeps the part of a line that was heard", () => {
    expect(cut("one two three four", 0.5)).toBe("one two…")
    expect(cut("one two three four", 0)).toBe("one…")
    expect(cut("one two three four", 1)).toBe("one two three four")
  })
})

describe("Responder", () => {
  test("gives the model the update and the conversation so far", () => {
    const prompt = Responder.prompt(
      {
        project: "yapd",
        turn: { prompt: Option.some("Why do retries fail?"), message: "The secret was rotated." },
        needsYou: false,
        lines: [{ speaker: "yapd", text: "The secret…" }],
        heard: "When was it rotated?",
      },
      Option.none(),
    )
    expect(prompt).toContain("Project: yapd")
    expect(prompt).toContain("User's prompt to the agent:\nWhy do retries fail?")
    expect(prompt).toContain("Agent's message:\nThe secret was rotated.")
    expect(prompt).toContain("You: The secret…")
    expect(prompt.endsWith("What the user just said:\nWhen was it rotated?")).toBe(true)
  })

  test("leaves out the prompt when there was none", () => {
    const prompt = Responder.prompt(
      { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Got it." },
      Option.none(),
    )
    expect(prompt).not.toContain("User's prompt")
    expect(prompt).not.toContain("How the user wants you to talk")
  })

  test("talks the way the user asked", () => {
    const prompt = Responder.prompt(
      { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Which PR?" },
      Option.some("Call me sir."),
    )
    expect(prompt).toContain("How the user wants you to talk")
    expect(prompt).toContain("Call me sir.")
  })

  test("says whether the agent is waiting on the user", () => {
    const interruption = (needsYou: boolean) =>
      Responder.prompt(
        {
          project: "yapd",
          turn: { prompt: Option.none(), message: "Checks are running, I'll report back." },
          needsYou,
          lines: [],
          heard: "Sounds good.",
        },
        Option.none(),
      )
    expect(interruption(true)).toContain("The agent is waiting on the user")
    expect(interruption(false)).toContain("The agent isn't waiting on the user.")
  })

  test("only sends an acknowledgement that answers the agent", () => {
    const prompt = Responder.prompt(
      { project: "yapd", turn: { prompt: Option.none(), message: "Done." }, needsYou: false, lines: [], heard: "Okay." },
      Option.none(),
    )
    expect(prompt).toContain(`That includes acknowledging, like "sounds good"`)
    expect(prompt).toContain(`Agreeing with what the agent already said it would do changes nothing, so that's "dismiss".`)
  })
})

describe("Condenser", () => {
  test("gives the model the prompt, the message and the style", () => {
    const prompt = Condenser.prompt(
      { prompt: Option.some("Why do retries fail?"), message: "The secret was rotated." },
      Option.some("Call me sir."),
    )
    expect(prompt).toContain("Call me sir.")
    expect(prompt).toContain("User's prompt:\nWhy do retries fail?")
    expect(prompt.endsWith("Agent's message:\nThe secret was rotated.")).toBe(true)
  })

  test("counts a reply that only repeats what the user said as trivial", () => {
    const prompt = Condenser.prompt(
      { prompt: Option.some("Sounds good."), message: "Understood. The checks are still running." },
      Option.none(),
    )
    expect(prompt).toContain(`a reply that only confirms what the user just said or restates work they already know about`)
  })

  test("talks plainly without a style", () => {
    const prompt = Condenser.prompt({ prompt: Option.none(), message: "Done." }, Option.none())
    expect(prompt).not.toContain("How the user wants you to talk")
    expect(prompt).not.toContain("User's prompt")
  })
})

describe("Transcriber", () => {
  test("drops what Whisper writes for sounds that aren't words", () => {
    expect(clean(" [BLANK_AUDIO]")).toBe("")
    expect(clean(" (coughs) Merge it  now.")).toBe("Merge it now.")
  })
})

describe("Helper", () => {
  test("splits messages back out however the stream is chunked", () => {
    const first = Helper.encode({ type: "hello" })
    const pcm = new Uint8Array([Helper.Kind.pcm, 0, 0, 0, 8, ...new Uint8Array(new Float32Array([0.5, -0.25]).buffer)])
    const stream = new Uint8Array([...first, ...pcm])
    const decoder = new Helper.Decoder()
    const messages = [...decoder.push(stream.slice(0, 3)), ...decoder.push(stream.slice(3, 12)), ...decoder.push(stream.slice(12))]
    expect(messages.map(({ kind }) => kind)).toEqual([Helper.Kind.json, Helper.Kind.pcm])
    expect(JSON.parse(new TextDecoder().decode(messages[0]?.payload))).toEqual({ type: "hello" })
    expect([...new Float32Array(messages[1]!.payload.buffer)]).toEqual([0.5, -0.25])
  })
})
